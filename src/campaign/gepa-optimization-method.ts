import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  costFromLedgerSummary,
  type OptimizationMethod,
  type OptimizationMethodInput,
} from './presets/compare-optimization-methods'
import { runCampaign } from './run-campaign'
import { campaignBreakdown } from './score-utils'
import { createRunCostLedger, fsCampaignStorage } from './storage'
import { surfaceContentHash } from './surface-identity'
import type { Scenario } from './types'

/** One bounded GEPA engine invocation inside a GEPA recipe. */
export interface GepaEngineRun {
  /** GEPA engine name. GEPA validates names available in its Python runtime. */
  engine: string
  /** Maximum callback evaluations this engine may consume. */
  maxEvaluations: number
  /** Required cap for this engine's own model or CLI spend. */
  maxProposerCostUsd: number
  /** GEPA engine-specific configuration. Passed through without interpretation. */
  engineConfig?: Record<string, unknown>
}

/**
 * A direct mapping to a GEPA optimization recipe.
 *
 * `best-of-then-continue` calls GEPA's `optimize_best_of`, then calls its
 * `optimize_anything` once more with the winning candidate. This is the
 * published Omni shape when `explore` contains GEPA, AutoResearch, and
 * Meta-Harness. Its total callback limit is the sum of the bounded runs.
 */
export type GepaOptimizationRecipe =
  | {
      kind: 'engine'
      run: GepaEngineRun
    }
  | {
      kind: 'best-of-then-continue'
      explore: readonly GepaEngineRun[]
      continueWith: GepaEngineRun
    }

/** The command that runs the optional Python GEPA bridge. */
export interface GepaRunnerCommand {
  /** Default: `python`. */
  command?: string
  /** Default: `['-m', 'agent_eval_rpc.gepa_bridge']`. */
  args?: readonly string[]
  cwd?: string
  env?: NodeJS.ProcessEnv
}

export interface GepaOptimizationMethodConfig<TScenario extends Scenario> {
  /** Unique comparison-method name. Default identifies the GEPA recipe. */
  name?: string
  /** A direct GEPA recipe. */
  recipe: GepaOptimizationRecipe
  /** Plain-language goal shown to the external optimizer. */
  objective: string
  /** Optional bounded context about the surface and task. */
  background?: string
  /** Reject external candidates longer than this. Default: 200,000 characters. */
  maxCandidateChars?: number
  /** End the bridge process after this many milliseconds. Default: 30 minutes. */
  timeoutMs?: number
  /**
   * Decide what the external optimizer may read for a train or selection case.
   * The returned value must be JSON-serializable. The final comparison cases
   * are not accepted by this API and cannot be serialized here.
   */
  describeScenario?: (scenario: TScenario) => unknown
  runner?: GepaRunnerCommand
}

interface GepaBridgeInput {
  version: 2
  callbackUrl: string
  callbackToken: string
  recipe: GepaOptimizationRecipe
  objective: string
  background?: string
  seedCandidate: string
  trainSet: GepaExample[]
  selectionSet: GepaExample[]
  maxCandidateChars: number
  outputDir: string
}

interface GepaExample {
  id: string
  data: unknown
}

interface GepaBridgeOutput {
  bestCandidate: string
  bestScore: number
  totalEvaluations: number
  recipeKind: GepaOptimizationRecipe['kind']
  proposerCostUsd?: number
  /** GEPA reports this value; it is not a receipt in agent-eval's cost log. */
  proposerCostAccounting?: 'reported' | 'unavailable'
}

interface GepaEvaluationRequest {
  candidate: string
  exampleId: string
}

interface GepaEvaluationResponse {
  score: number
  info: {
    scenarioId: string
    dimensions: Record<string, number>
    notes?: string
  }
}

const DEFAULT_MAX_CANDIDATE_CHARS = 200_000
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000
const MAX_CALLBACK_BODY_BYTES = 1_000_000
const MAX_PROCESS_OUTPUT_CHARS = 64_000
const PROCESS_TERMINATION_GRACE_MS = 5_000

/**
 * Turn an optional GEPA installation into an `OptimizationMethod`.
 *
 * GEPA receives only serialized train and selection cases. The caller's final
 * test partition stays inside `compareOptimizationMethods`, which invokes this
 * method without a test-set field. The local callback routes every candidate
 * evaluation through the same dispatch and judges used by other methods.
 */
export function gepaOptimizationMethod<TScenario extends Scenario, TArtifact>(
  config: GepaOptimizationMethodConfig<TScenario>,
): OptimizationMethod<TScenario, TArtifact> {
  assertConfig(config)
  const name = config.name ?? defaultMethodName(config.recipe)

  return {
    name,
    async optimize(input) {
      if (typeof input.baselineSurface !== 'string') {
        throw new Error(`${name}: GEPA bridge requires a string baselineSurface`)
      }

      const started = Date.now()
      const maxCandidateChars = config.maxCandidateChars ?? DEFAULT_MAX_CANDIDATE_CHARS
      const storage = input.runOptions.storage ?? fsCampaignStorage()
      const runDir = `${input.runDir}/gepa`
      storage.ensureDir(runDir)
      const costLedger = createRunCostLedger({
        storage,
        runDir,
        costCeilingUsd: input.runOptions.costCeiling,
      })
      const scenarioById = scenarioMap(input.trainScenarios, input.selectionScenarios)
      const evaluate = createEvaluationFunction({
        input,
        config,
        runDir,
        costLedger,
        scenarioById,
        maxCandidateChars,
      })
      const callback = await startCallbackServer({
        token: randomBytes(32).toString('hex'),
        maxEvaluations: recipeEvaluationLimit(config.recipe),
        evaluate,
      })

      try {
        const outputDir = `${runDir}/external`
        await mkdir(outputDir, { recursive: true })
        const result = await runGepaBridge(
          {
            version: 2,
            callbackUrl: callback.url,
            callbackToken: callback.token,
            recipe: config.recipe,
            objective: config.objective,
            ...(config.background ? { background: config.background } : {}),
            seedCandidate: input.baselineSurface,
            trainSet: input.trainScenarios.map((scenario) => describeScenario(config, scenario)),
            selectionSet: input.selectionScenarios.map((scenario) =>
              describeScenario(config, scenario),
            ),
            maxCandidateChars,
            outputDir,
          },
          config.runner,
          config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        )
        assertBridgeOutput(
          result,
          name,
          maxCandidateChars,
          config.recipe.kind,
          recipeEvaluationLimit(config.recipe),
        )

        const evaluationCost = costFromLedgerSummary(costLedger.summary())
        const reportedProposerCost = result.proposerCostUsd ?? 0
        return {
          winnerSurface: result.bestCandidate,
          cost: {
            totalCostUsd: evaluationCost.totalCostUsd + reportedProposerCost,
            accountingComplete: false,
            incompleteReasons: [
              ...evaluationCost.incompleteReasons,
              result.proposerCostAccounting === 'reported'
                ? 'GEPA proposer cost is externally reported and has no agent-eval receipt'
                : 'GEPA proposer cost is unavailable',
            ],
          },
          durationMs: Date.now() - started,
        }
      } finally {
        await callback.close()
      }
    },
  }
}

function createEvaluationFunction<TScenario extends Scenario, TArtifact>(args: {
  input: OptimizationMethodInput<TScenario, TArtifact>
  config: GepaOptimizationMethodConfig<TScenario>
  runDir: string
  costLedger: ReturnType<typeof createRunCostLedger>
  scenarioById: ReadonlyMap<string, TScenario>
  maxCandidateChars: number
}): (request: GepaEvaluationRequest) => Promise<GepaEvaluationResponse> {
  const cached = new Map<string, Promise<GepaEvaluationResponse>>()
  return async ({ candidate, exampleId }) => {
    if (!args.scenarioById.has(exampleId)) {
      throw new Error(`GEPA requested unknown train or selection case '${exampleId}'`)
    }
    if (!isCandidateText(candidate, args.maxCandidateChars)) {
      throw new Error('GEPA submitted an invalid candidate')
    }
    const scenario = args.scenarioById.get(exampleId)!
    const cacheKey = `${surfaceContentHash(candidate)}:${exampleId}`
    const existing = cached.get(cacheKey)
    if (existing) return existing

    const result = scoreOneScenario({
      input: args.input,
      candidate,
      scenario,
      runDir: args.runDir,
      costLedger: args.costLedger,
    })
    cached.set(cacheKey, result)
    return result
  }
}

async function scoreOneScenario<TScenario extends Scenario, TArtifact>(args: {
  input: OptimizationMethodInput<TScenario, TArtifact>
  candidate: string
  scenario: TScenario
  runDir: string
  costLedger: ReturnType<typeof createRunCostLedger>
}): Promise<GepaEvaluationResponse> {
  const campaign = await runCampaign<TScenario, TArtifact>({
    ...args.input.runOptions,
    scenarios: [structuredClone(args.scenario)],
    dispatch: (scenario, context) =>
      args.input.dispatchWithSurface(args.candidate, scenario, context),
    judges: [...args.input.judges],
    runDir: `${args.runDir}/evaluations/${safePathComponent(surfaceContentHash(args.candidate))}/${safePathComponent(args.scenario.id)}`,
    seed: args.input.seed,
    costLedger: args.costLedger,
    costPhase: 'gepa.external-evaluation',
    maxConcurrency: 1,
  })
  const breakdown = campaignBreakdown(campaign)
  const row = breakdown.scenarios[0]
  if (!row) throw new Error(`GEPA evaluation produced no score for '${args.scenario.id}'`)
  return {
    score: row.composite,
    info: {
      scenarioId: row.scenarioId,
      dimensions: breakdown.dimensions,
      ...(row.notes ? { notes: row.notes } : {}),
    },
  }
}

function scenarioMap<TScenario extends Scenario>(
  train: readonly TScenario[],
  selection: readonly TScenario[],
): Map<string, TScenario> {
  const out = new Map<string, TScenario>()
  for (const scenario of [...train, ...selection]) {
    if (out.has(scenario.id)) {
      throw new Error(
        `GEPA bridge requires unique train and selection ids; duplicate '${scenario.id}'`,
      )
    }
    out.set(scenario.id, scenario)
  }
  return out
}

function describeScenario<TScenario extends Scenario>(
  config: GepaOptimizationMethodConfig<TScenario>,
  scenario: TScenario,
): GepaExample {
  const data = config.describeScenario ? config.describeScenario(scenario) : { id: scenario.id }
  assertJsonValue(data, `GEPA scenario '${scenario.id}'`)
  return { id: scenario.id, data }
}

async function startCallbackServer(args: {
  token: string
  maxEvaluations: number
  evaluate: (request: GepaEvaluationRequest) => Promise<GepaEvaluationResponse>
}): Promise<{ url: string; token: string; close: () => Promise<void> }> {
  let evaluations = 0
  const server = createServer((request, response) => {
    void handleCallback(request, response, args, () => {
      evaluations += 1
      return evaluations
    })
  })
  const port = await listen(server)
  return {
    url: `http://127.0.0.1:${port}/evaluate`,
    token: args.token,
    close: () => closeServer(server),
  }
}

async function handleCallback(
  request: IncomingMessage,
  response: ServerResponse,
  args: {
    token: string
    maxEvaluations: number
    evaluate: (request: GepaEvaluationRequest) => Promise<GepaEvaluationResponse>
  },
  nextEvaluation: () => number,
): Promise<void> {
  try {
    if (request.method !== 'POST' || request.url !== '/evaluate') {
      sendJson(response, 404, { error: 'not found' })
      return
    }
    if (request.headers.authorization !== `Bearer ${args.token}`) {
      sendJson(response, 401, { error: 'unauthorized' })
      return
    }
    const body = await readJson(request)
    if (
      !isRecord(body) ||
      typeof body.candidate !== 'string' ||
      typeof body.exampleId !== 'string'
    ) {
      sendJson(response, 400, { error: 'candidate and exampleId are required strings' })
      return
    }
    const count = nextEvaluation()
    if (count > args.maxEvaluations) {
      sendJson(response, 429, { error: 'evaluation limit reached' })
      return
    }
    const result = await args.evaluate({ candidate: body.candidate, exampleId: body.exampleId })
    sendJson(response, 200, result)
  } catch {
    sendJson(response, 500, { error: 'evaluation failed' })
  }
}

async function runGepaBridge(
  input: GepaBridgeInput,
  runner: GepaRunnerCommand | undefined,
  timeoutMs: number,
): Promise<GepaBridgeOutput> {
  const dir = await mkdtemp(join(tmpdir(), 'agent-eval-gepa-'))
  const inputPath = join(dir, 'input.json')
  const outputPath = join(dir, 'output.json')
  try {
    await writeFile(inputPath, `${JSON.stringify(input)}\n`)
    const command = runner?.command ?? 'python'
    const args = [
      ...(runner?.args ?? ['-m', 'agent_eval_rpc.gepa_bridge']),
      '--input',
      inputPath,
      '--output',
      outputPath,
    ]
    await runProcess(command, args, runner?.cwd ?? dir, runner?.env, timeoutMs)
    const raw = JSON.parse(await readFile(outputPath, 'utf8')) as unknown
    if (!isRecord(raw)) throw new Error('GEPA bridge output must be a JSON object')
    return raw as unknown as GepaBridgeOutput
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

function runProcess(
  command: string,
  args: string[],
  cwd: string | undefined,
  env: NodeJS.ProcessEnv | undefined,
  timeoutMs: number,
): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    let timedOut = false
    let timeout: NodeJS.Timeout | undefined
    let terminationGrace: NodeJS.Timeout | undefined
    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      if (timeout) clearTimeout(timeout)
      if (terminationGrace) clearTimeout(terminationGrace)
      if (error) reject(error)
      else resolvePromise()
    }
    timeout = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
      terminationGrace = setTimeout(() => {
        child.kill('SIGKILL')
        finish(new Error(`GEPA bridge exceeded ${timeoutMs}ms`))
      }, PROCESS_TERMINATION_GRACE_MS)
    }, timeoutMs)
    child.stdout.on('data', (chunk: Buffer) => {
      stdout = appendProcessOutput(stdout, chunk)
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = appendProcessOutput(stderr, chunk)
    })
    child.on('error', (error) => finish(new Error(`GEPA bridge could not start: ${error.message}`)))
    child.on('close', (code) => {
      if (timedOut) {
        finish(new Error(`GEPA bridge exceeded ${timeoutMs}ms`))
        return
      }
      if (code === 0) {
        finish()
        return
      }
      finish(
        new Error(
          `GEPA bridge exited ${String(code)}. stderr=${truncate(stderr)} stdout=${truncate(stdout)}`,
        ),
      )
    })
  })
}

function appendProcessOutput(current: string, chunk: Buffer): string {
  if (current.length >= MAX_PROCESS_OUTPUT_CHARS) return current
  return `${current}${chunk.toString()}`.slice(0, MAX_PROCESS_OUTPUT_CHARS)
}

function readJson(request: IncomingMessage): Promise<unknown> {
  return new Promise((resolvePromise, reject) => {
    let size = 0
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_CALLBACK_BODY_BYTES) {
        reject(new Error('callback body too large'))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('error', reject)
    request.on('end', () => {
      try {
        resolvePromise(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch (error) {
        reject(error)
      }
    })
  })
}

function listen(server: Server): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      const address = server.address()
      if (!address || typeof address === 'string') {
        reject(new Error('GEPA callback did not bind a TCP port'))
        return
      }
      resolvePromise(address.port)
    })
  })
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    server.close((error) => (error ? reject(error) : resolvePromise()))
  })
}

function assertConfig<TScenario extends Scenario>(
  config: GepaOptimizationMethodConfig<TScenario>,
): void {
  if (!config.objective || config.objective.trim() !== config.objective) {
    throw new Error('gepaOptimizationMethod: objective must be trimmed and non-empty')
  }
  assertRecipe(config.recipe)
  if (
    config.maxCandidateChars !== undefined &&
    (!Number.isSafeInteger(config.maxCandidateChars) || config.maxCandidateChars <= 0)
  ) {
    throw new Error('gepaOptimizationMethod: maxCandidateChars must be a positive safe integer')
  }
  if (
    config.timeoutMs !== undefined &&
    (!Number.isSafeInteger(config.timeoutMs) || config.timeoutMs <= 0)
  ) {
    throw new Error('gepaOptimizationMethod: timeoutMs must be a positive safe integer')
  }
}

function assertRecipe(recipe: GepaOptimizationRecipe): void {
  if (!recipe || typeof recipe !== 'object') {
    throw new Error('gepaOptimizationMethod: recipe is required')
  }
  if (recipe.kind === 'engine') {
    assertEngineRun(recipe.run, 'recipe.run')
    return
  }
  if (recipe.kind === 'best-of-then-continue') {
    if (!Array.isArray(recipe.explore) || recipe.explore.length < 2) {
      throw new Error(
        'gepaOptimizationMethod: recipe.explore must contain at least two bounded engine runs',
      )
    }
    for (const [index, run] of recipe.explore.entries()) {
      assertEngineRun(run, `recipe.explore[${index}]`)
    }
    assertEngineRun(recipe.continueWith, 'recipe.continueWith')
    return
  }
  throw new Error('gepaOptimizationMethod: unsupported recipe')
}

function assertEngineRun(run: GepaEngineRun, label: string): void {
  if (!run || typeof run !== 'object') {
    throw new Error(`gepaOptimizationMethod: ${label} is required`)
  }
  if (typeof run.engine !== 'string' || !run.engine.trim() || run.engine.trim() !== run.engine) {
    throw new Error(`gepaOptimizationMethod: ${label}.engine must be a trimmed non-empty string`)
  }
  if (!Number.isSafeInteger(run.maxEvaluations) || run.maxEvaluations <= 0) {
    throw new Error(
      `gepaOptimizationMethod: ${label}.maxEvaluations must be a positive safe integer`,
    )
  }
  if (!Number.isFinite(run.maxProposerCostUsd) || run.maxProposerCostUsd <= 0) {
    throw new Error(
      `gepaOptimizationMethod: ${label}.maxProposerCostUsd must be a positive finite number`,
    )
  }
  assertJsonValue(run.engineConfig ?? {}, `gepaOptimizationMethod: ${label}.engineConfig`)
}

function recipeEvaluationLimit(recipe: GepaOptimizationRecipe): number {
  const runs = recipe.kind === 'engine' ? [recipe.run] : [...recipe.explore, recipe.continueWith]
  let total = 0
  for (const run of runs) {
    total += run.maxEvaluations
    if (!Number.isSafeInteger(total)) {
      throw new Error('gepaOptimizationMethod: recipe evaluation limit exceeds safe integer range')
    }
  }
  return total
}

function defaultMethodName(recipe: GepaOptimizationRecipe): string {
  if (recipe.kind === 'engine') return `gepa:${recipe.run.engine}`
  return `gepa:best-of-then-continue:${recipe.continueWith.engine}`
}

function assertBridgeOutput(
  result: GepaBridgeOutput,
  name: string,
  maxCandidateChars: number,
  recipeKind: GepaOptimizationRecipe['kind'],
  maxEvaluations: number,
): asserts result is GepaBridgeOutput {
  if (result.recipeKind !== recipeKind)
    throw new Error(`${name}: GEPA bridge reported recipe '${String(result.recipeKind)}'`)
  if (!isCandidateText(result.bestCandidate, maxCandidateChars)) {
    throw new Error(`${name}: GEPA bridge returned an invalid candidate`)
  }
  if (!Number.isFinite(result.bestScore))
    throw new Error(`${name}: GEPA bridge returned an invalid bestScore`)
  if (
    !Number.isSafeInteger(result.totalEvaluations) ||
    result.totalEvaluations < 0 ||
    result.totalEvaluations > maxEvaluations
  ) {
    throw new Error(`${name}: GEPA bridge returned an invalid totalEvaluations`)
  }
  if (
    result.proposerCostUsd !== undefined &&
    (!Number.isFinite(result.proposerCostUsd) || result.proposerCostUsd < 0)
  ) {
    throw new Error(`${name}: GEPA bridge returned an invalid proposerCostUsd`)
  }
}

function isCandidateText(value: unknown, maxChars: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maxChars
}

function assertJsonValue(value: unknown, label: string, seen = new Set<object>()): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return
  if (typeof value === 'number' && Number.isFinite(value)) return
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new Error(`${label} must be JSON-serializable`)
    seen.add(value)
    for (const item of value) assertJsonValue(item, label, seen)
    seen.delete(value)
    return
  }
  if (typeof value === 'object') {
    if (seen.has(value)) throw new Error(`${label} must be JSON-serializable`)
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error(`${label} must be JSON-serializable`)
    }
    seen.add(value)
    for (const item of Object.values(value)) assertJsonValue(item, label, seen)
    seen.delete(value)
    return
  }
  throw new Error(`${label} must be JSON-serializable`)
}

function safePathComponent(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, '_')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  response.end(JSON.stringify(body))
}

function truncate(value: string, max = 1000): string {
  const compact = value.trim().replace(/\s+/g, ' ')
  return compact.length <= max ? compact : `${compact.slice(0, max)}…`
}
