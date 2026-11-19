import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  compareOptimizationMethods,
  fsCampaignStorage,
  gepaOptimizationMethod,
  type JudgeConfig,
  type MutableSurface,
  type ProposeContext,
  readExternalOptimizerObservationArtifact,
  replaySearchLedgerText,
  runOptimization,
  type Scenario,
  type SearchRunIdentity,
} from '../../src/campaign'
import { openExternalOptimizerObservationLog } from '../../src/campaign/external-optimizer-observations'
import { recordGepaSearch } from '../../src/campaign/gepa-search-import'
import type { DispatchContext } from '../../src/campaign/types'
import { buildReflectionPrompt } from '../../src/reflective-mutation'
import { contentHash } from '../../src/verdict-cache'

// Each test runs a real campaign per evaluation, the real loopback callback,
// a deterministic optimizer process, and a real search ledger.
vi.setConfig({ testTimeout: 60_000 })

const GEPA_RUNTIME_IDENTITY = {
  python: { implementation: 'CPython', version: '3.12.0' },
  bridge: {
    package: 'agent-eval-rpc',
    version: 'test-bridge',
    sourceUrl: 'https://github.com/tangle-network/agent-eval',
    revision: 'test-bridge-revision',
    sourceSha256: 'a'.repeat(64),
  },
  optimizer: {
    package: 'gepa',
    version: 'test',
    sourceUrl: 'https://github.com/gepa-ai/gepa',
    revision: 'test-revision',
    sourceSha256: 'b'.repeat(64),
  },
  engineModules: [],
} as const

const identity: SearchRunIdentity = {
  agent: { uri: 'fixture:agent', revision: 'a'.repeat(40) },
  proposer: { kind: 'deterministic', source: { uri: 'fixture:optimizer', revision: 'b'.repeat(40) } },
  search: { uri: 'fixture:search', revision: 'c'.repeat(40) },
  model: { provider: 'fixture', alias: 'gpt-4.1', unknown: 'the fixture declares an alias' },
}

const SNAPSHOT = 'gpt-4.1-2025-04-14'

interface TextArtifact {
  text: string
}

/** Scores `better` 1 and anything else 0, on two dimensions. */
const betterJudge: JudgeConfig<TextArtifact, Scenario> = {
  name: 'better',
  dimensions: [
    { key: 'correct', description: 'the output is the known better answer' },
    { key: 'concise', description: 'the output is short' },
  ],
  score: ({ artifact }) => {
    const correct = artifact.text === 'better' ? 1 : 0
    return { composite: correct, dimensions: { correct, concise: 0.5 }, notes: '' }
  },
}

/** Scores every output 0.25 with a note, like a judge that found a late failure. */
const lateFailureJudge: JudgeConfig<string, Scenario> = {
  name: 'quality',
  dimensions: [{ key: 'correct', description: 'the output finishes correctly' }],
  score: () => ({
    composite: 0.25,
    dimensions: { correct: 0.25 },
    notes: 'the output fails at its end',
  }),
}

/** A 10,000-character output whose final 500 characters appear nowhere else. */
const TAIL = '0123456789'.repeat(50)
const LONG_OUTPUT = `${'a'.repeat(9_500)}${TAIL}`

let runDir: string
beforeEach(() => {
  runDir = mkdtempSync(join(tmpdir(), 'search-ledger-measurement-'))
})
afterEach(() => {
  rmSync(runDir, { recursive: true, force: true })
})

interface LedgerEvent {
  kind: string
  cellId?: string
  taskId?: string
  rep?: number
  stage?: string
  outcome?: { status: string; score?: number; metrics: Record<string, number> }
  accounting?: {
    tokens: Record<string, unknown>
    cost: Record<string, unknown>
  }
  identity?: { model: Record<string, unknown> }
  wallMs?: number | null
  traceRef?: Record<string, unknown>
}

function readLedger(path: string): LedgerEvent[] {
  const text = readFileSync(path, 'utf8')
  const entries = text
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as { searchId: string; event: LedgerEvent })
  // The chain and every invariant must verify before any field is read.
  replaySearchLedgerText(text, entries[0]!.searchId, path)
  return entries.map((entry) => entry.event)
}

function settledCells(events: LedgerEvent[], taskId: string) {
  const allocated = events.filter(
    (event) => event.kind === 'cell-allocated' && event.taskId === taskId,
  )
  const settled = events.filter(
    (event) =>
      event.kind === 'cell-settled' && allocated.some((cell) => cell.cellId === event.cellId),
  )
  return { allocated, settled }
}

function findFiles(root: string, name: string): string[] {
  const found: string[] = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name)
    if (entry.isFile() && entry.name === name) found.push(path)
    if (entry.isDirectory()) found.push(...findFiles(path, name))
  }
  return found
}

/**
 * A deterministic stand-in for the GEPA bridge: it posts `requests` to the
 * evaluation callback in order, keeps every response it received, and
 * returns `best`. It reports no population, as a composed recipe does.
 */
function scriptedOptimizer(
  requests: ReadonlyArray<{ candidate: string; split: 'train' | 'selection' }>,
  best: string,
  responsesPath: string,
) {
  const source = [
    "const fs = require('node:fs')",
    "const inputPath = process.argv[process.argv.indexOf('--input') + 1]",
    "const outputPath = process.argv[process.argv.indexOf('--output') + 1]",
    'const input = JSON.parse(fs.readFileSync(inputPath, "utf8"))',
    `const runtime = ${JSON.stringify(GEPA_RUNTIME_IDENTITY)}`,
    'if (input.operation === "inspect") {',
    '  fs.writeFileSync(outputPath, JSON.stringify({ runtime }))',
    '  process.exit(0)',
    '}',
    ';(async () => {',
    `  const requests = ${JSON.stringify(requests)}`,
    '  const responses = []',
    '  for (const request of requests) {',
    '    const example = request.split === "selection" ? input.selectionSet[0] : input.trainSet[0]',
    '    const response = await fetch(input.callbackUrl, {',
    '      method: "POST",',
    '      headers: { authorization: "Bearer " + input.callbackToken, "content-type": "application/json" },',
    '      body: JSON.stringify({ candidate: request.candidate, exampleId: example.id }),',
    '    })',
    '    if (!response.ok) throw new Error("callback failed: " + response.status)',
    '    responses.push(await response.json())',
    '  }',
    `  fs.writeFileSync(${JSON.stringify(responsesPath)}, JSON.stringify(responses))`,
    '  fs.writeFileSync(outputPath, JSON.stringify({',
    `    bestCandidate: ${JSON.stringify(best)},`,
    '    bestScore: responses[responses.length - 1].score,',
    '    totalEvaluations: requests.length,',
    '    recipeKind: input.recipe.kind,',
    '    seedApplied: false,',
    '    proposerCostAccounting: "unavailable",',
    '    upstream: runtime.optimizer,',
    '    runId: input.runId,',
    '    resumed: false,',
    '  }))',
    '})().catch((error) => { console.error(error); process.exit(1) })',
  ].join('\n')
  return { command: process.execPath, args: ['-e', source, '--'] }
}

async function runScriptedGepa<TArtifact>(input: {
  requests: ReadonlyArray<{ candidate: string; split: 'train' | 'selection' }>
  best: string
  maxEvaluations: number
  dispatchWithSurface: (
    surface: MutableSurface,
    scenario: Scenario,
    ctx: DispatchContext,
  ) => Promise<TArtifact>
  judge: JudgeConfig<TArtifact, Scenario>
  reps?: number
  describeArtifact?: (artifact: TArtifact, scenario: Scenario) => unknown
}) {
  const responsesPath = join(runDir, 'optimizer-responses.json')
  const ledgerPath = join(runDir, 'gepa-search-ledger.jsonl')
  const method = gepaOptimizationMethod<Scenario, TArtifact>({
    recipe: {
      kind: 'engine',
      run: { engine: 'best_of_n', maxEvaluations: input.maxEvaluations, maxProposerCostUsd: 1 },
    },
    objective: 'Return the better policy.',
    evaluationId: 'search-ledger-measurement',
    runner: scriptedOptimizer(input.requests, input.best, responsesPath),
    searchLedger: { identity, path: ledgerPath },
    ...(input.describeArtifact ? { describeArtifact: input.describeArtifact } : {}),
  })
  const result = await compareOptimizationMethods<Scenario, TArtifact>({
    methods: [method],
    baselineSurface: 'baseline',
    trainScenarios: [{ id: 'train', kind: 'qa' }],
    selectionScenarios: [{ id: 'selection', kind: 'qa' }],
    testScenarios: [
      { id: 'final', kind: 'qa' },
      { id: 'final-2', kind: 'qa' },
    ],
    dispatchWithSurface: input.dispatchWithSurface,
    judges: [input.judge],
    optimizationRunOptions: {
      expectUsage: 'off',
      ...(input.reps === undefined ? {} : { reps: input.reps }),
    },
    runDir,
    seed: 11,
    resamples: 40,
    expectUsage: 'off',
  })
  const provenance = result.scores[0]!.provenance!
  const observations = readFileSync(provenance.observations!.path, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>)
  const responses = JSON.parse(readFileSync(responsesPath, 'utf8')) as Array<{
    score: number
    info: Record<string, unknown>
  }>
  return { events: readLedger(ledgerPath), observations, responses }
}

/** The reflection prompt a reflective proposer builds from its parent's measured scenarios. */
function reflectionPrompt(ctx: ProposeContext): string {
  return buildReflectionPrompt({
    target: 'prompt',
    parentPayload: ctx.currentSurface,
    topTrials: [],
    bottomTrials: (ctx.parentOutcome?.scenarios ?? []).map((row) => ({
      id: row.scenarioId,
      score: row.composite,
      ...(row.emitted === undefined ? {} : { emitted: row.emitted }),
      ...(row.notes === undefined ? {} : { failureNote: row.notes }),
    })),
    childCount: 1,
  })
}

/** One native optimization round: the baseline is measured, then the proposer reads it and stops. */
async function runNative<TArtifact>(input: {
  scenarioId: string
  output: TArtifact
  judge: JudgeConfig<TArtifact, Scenario>
  describeArtifact?: (artifact: TArtifact, scenario: Scenario) => unknown
}) {
  const seen: ProposeContext[] = []
  const nativeDir = join(runDir, 'native')
  await runOptimization<Scenario, TArtifact>({
    scenarios: [{ id: input.scenarioId, kind: 'qa' }],
    baselineSurface: 'BASE',
    dispatchWithSurface: async () => input.output,
    judges: [input.judge],
    proposer: {
      kind: 'reflection-probe',
      async propose(ctx) {
        seen.push(ctx)
        return []
      },
    },
    populationSize: 1,
    maxGenerations: 1,
    expectUsage: 'off',
    runDir: nativeDir,
    ...(input.describeArtifact ? { describeArtifact: input.describeArtifact } : {}),
  })
  expect(seen).toHaveLength(1)
  return { ctx: seen[0]!, nativeDir, events: readLedger(join(nativeDir, 'search', 'ledger.jsonl')) }
}

describe('external evaluations import as the measured campaign cells', () => {
  it('records a repeated request for a cached evaluation once, and keeps the repeat in the observation log', async () => {
    const { events, observations, responses } = await runScriptedGepa({
      requests: [
        { candidate: 'better', split: 'train' },
        { candidate: 'better', split: 'train' },
      ],
      best: 'better',
      maxEvaluations: 2,
      dispatchWithSurface: async (surface) => ({ text: String(surface) }),
      judge: betterJudge,
    })

    // One measurement ran, so one ledger cell holds it.
    const { allocated, settled } = settledCells(events, 'train')
    expect(allocated).toHaveLength(1)
    expect(settled).toHaveLength(1)
    expect(settled[0]!.outcome).toMatchObject({ status: 'passed', score: 1 })

    // The repeat is still in the observation log, marked as a reuse.
    const evaluations = observations.filter((observation) => observation.kind === 'evaluation')
    expect(evaluations).toHaveLength(2)
    const sources = evaluations.map(
      (observation) => (observation.measurement as { source?: string } | undefined)?.source,
    )
    expect(sources.sort()).toEqual(['measured', 'reused'])

    // The optimizer received the same response twice, with no accounting fields.
    expect(responses).toHaveLength(2)
    expect(responses[1]).toEqual(responses[0])
    expect(Object.keys(responses[0]!).sort()).toEqual(['info', 'score'])
    for (const key of Object.keys(responses[0]!.info)) {
      expect(['artifact', 'dimensions', 'notes', 'scenarioId', 'scores', 'status']).toContain(key)
    }
  })

  it('records the measured cost, tokens, model, duration and dimensions of every imported cell', async () => {
    const { events } = await runScriptedGepa({
      requests: [{ candidate: 'better', split: 'train' }],
      best: 'better',
      maxEvaluations: 1,
      dispatchWithSurface: async (surface, _scenario, ctx) => {
        const call = await ctx.cost.runPaidCall({
          actor: 'agent',
          model: SNAPSHOT,
          execute: async () => ({ text: String(surface) }),
          receipt: () => ({
            model: SNAPSHOT,
            inputTokens: 120,
            outputTokens: 30,
            actualCostUsd: 0.0042,
          }),
        })
        if (!call.succeeded) throw call.error
        return call.value
      },
      judge: betterJudge,
    })

    const { settled } = settledCells(events, 'train')
    expect(settled).toHaveLength(1)
    const cell = settled[0]!
    expect(cell.accounting).toEqual({
      tokens: { status: 'known', inputTokens: 120, outputTokens: 30, cachedTokens: 0 },
      cost: { status: 'known', usd: 0.0042, source: 'provider' },
    })
    expect(cell.identity?.model).toEqual({ provider: 'fixture', snapshot: SNAPSHOT })
    expect(typeof cell.wallMs).toBe('number')
    expect(cell.outcome?.metrics).toMatchObject({
      composite: 1,
      'judge.better': 1,
      'dimension.better.correct': 1,
      'dimension.better.concise': 0.5,
    })

    // The ledger's numbers are the campaign cell's own, read from the result
    // the evaluation callback's campaign stored on disk.
    const evaluationResults = findFiles(runDir, 'cached-result.json')
      .filter((path) => path.includes(`${sep}evaluations${sep}`))
      .map((path) => JSON.parse(readFileSync(path, 'utf8')) as { scenarioId: string })
      .filter((stored) => stored.scenarioId === 'train')
    expect(evaluationResults).toHaveLength(1)
    const measured = evaluationResults[0] as {
      costUsd: number
      tokenUsage: { input: number; output: number }
      attempt: { runAttemptId: string }
    }
    expect(cell.accounting?.cost).toMatchObject({ usd: measured.costUsd })
    expect(cell.accounting?.tokens).toMatchObject({
      inputTokens: measured.tokenUsage.input,
      outputTokens: measured.tokenUsage.output,
    })
    // runCampaign assigns no trace id; the reason names the attempt whose trace writer ran.
    expect(cell.traceRef?.unknown).toEqual(expect.stringContaining(measured.attempt.runAttemptId))
  })

  it('imports every repeat of a multi-rep evaluation as its own cell', async () => {
    const { events, observations } = await runScriptedGepa({
      requests: [{ candidate: 'better', split: 'train' }],
      best: 'better',
      maxEvaluations: 1,
      reps: 2,
      dispatchWithSurface: async (surface) => ({ text: String(surface) }),
      judge: betterJudge,
    })

    const { allocated, settled } = settledCells(events, 'train')
    expect(allocated.map((cell) => cell.rep).sort()).toEqual([0, 1])
    expect(settled).toHaveLength(2)
    const evaluation = observations.find((observation) => observation.kind === 'evaluation')!
    expect((evaluation.measurement as { cells: unknown[] }).cells).toHaveLength(2)
  })

  it('imports an observation log written before measurements were recorded exactly as before', async () => {
    const storage = fsCampaignStorage()
    const path = join(runDir, 'observations-legacy.jsonl')
    const log = openExternalOptimizerObservationLog({ storage, path })
    const candidateHash = contentHash({ kind: 'external-text-candidate', candidate: 'better' })
    const response = {
      score: 1,
      info: { scenarioId: 'train', dimensions: { correct: 1 }, scores: { correct: 1 }, status: 'scored' },
    }
    log.observe({ kind: 'proposal', sequence: 1, candidate: 'better', candidateHash })
    for (const [index, sequence] of [2, 3].entries()) {
      log.observe({
        kind: 'evaluation',
        sequence,
        candidate: 'better',
        candidateHash,
        exampleId: 'train',
        evaluationNumber: index + 1,
        response,
      })
    }
    const observations = readExternalOptimizerObservationArtifact({ summary: log.summary(), storage })
    const ledgerPath = join(runDir, 'legacy-ledger.jsonl')
    await recordGepaSearch({
      name: 'legacy-gepa',
      path: ledgerPath,
      searchId: 'legacy-search',
      identity,
      storage,
      seed: 1,
      baselineSurface: 'baseline',
      trainScenarios: [{ id: 'train', kind: 'qa' }],
      selectionScenarios: [{ id: 'selection', kind: 'qa' }],
      evaluationLimit: 2,
      observations,
      population: null,
      selected: 'better',
      generationAccounting: {
        tokens: { status: 'unknown', reason: 'the fixture reports no optimizer usage' },
        cost: {
          status: 'unknown',
          knownLowerBoundUsd: 0,
          reason: 'the fixture reports no optimizer cost',
        },
      },
    })

    const { allocated, settled } = settledCells(readLedger(ledgerPath), 'train')
    expect(allocated.map((cell) => cell.rep)).toEqual([0, 1])
    for (const cell of settled) {
      expect(cell.outcome).toEqual({ status: 'passed', score: 1, metrics: { score: 1 } })
      expect(cell.accounting).toEqual({
        tokens: { status: 'unknown', reason: 'the evaluation callback meters tokens per run' },
        cost: {
          status: 'unknown',
          knownLowerBoundUsd: 0,
          reason: 'the evaluation callback meters cost per run, not per evaluation',
        },
      })
    }
  })
})

describe('the native path records and shows what each cell measured', () => {
  it('shows the reflective proposer the end of a long output', async () => {
    const { ctx } = await runNative({
      scenarioId: 'long',
      output: LONG_OUTPUT,
      judge: lateFailureJudge,
    })
    const prompt = reflectionPrompt(ctx)
    // The failure is at the end of the output, so the end must reach the prompt.
    expect(prompt).toContain(TAIL)
    expect(prompt).toContain(LONG_OUTPUT.slice(0, 500))
    expect(prompt).toMatch(/\d+ characters omitted/)
  })

  it('records every judge dimension and the measuring attempt on each native cell', async () => {
    const { events, nativeDir } = await runNative({
      scenarioId: 'long',
      output: LONG_OUTPUT,
      judge: lateFailureJudge,
    })
    const { settled } = settledCells(events, 'long')
    expect(settled).toHaveLength(1)
    expect(settled[0]!.outcome?.metrics).toEqual({
      composite: 0.25,
      'judge.quality': 0.25,
      'dimension.quality.correct': 0.25,
    })
    const [latest] = findFiles(nativeDir, 'latest-attempt.json')
    const attempt = JSON.parse(readFileSync(latest!, 'utf8')) as { runAttemptId: string }
    expect(settled[0]!.traceRef?.unknown).toEqual(expect.stringContaining(attempt.runAttemptId))
  })
})

describe('the native and external paths see the same evidence', () => {
  it('gives both optimizers the same excerpt of a string output', async () => {
    const native = await runNative({
      scenarioId: 'train',
      output: LONG_OUTPUT,
      judge: lateFailureJudge,
    })
    const nativeEvidence = native.ctx.parentOutcome?.scenarios.find(
      (row) => row.scenarioId === 'train',
    )?.emitted
    const external = await runScriptedGepa<string>({
      requests: [{ candidate: 'better', split: 'train' }],
      best: 'better',
      maxEvaluations: 1,
      dispatchWithSurface: async () => LONG_OUTPUT,
      judge: lateFailureJudge,
    })
    expect(nativeEvidence).toBeDefined()
    expect(nativeEvidence!.endsWith(TAIL)).toBe(true)
    expect(external.responses[0]!.info.artifact).toBe(nativeEvidence)
  })

  it('gives both optimizers the described evidence of a structured output', async () => {
    const describeArtifact = (artifact: TextArtifact) => ({ answer: artifact.text })
    const native = await runNative<TextArtifact>({
      scenarioId: 'train',
      output: { text: 'better' },
      judge: betterJudge,
      describeArtifact,
    })
    const nativeEvidence = native.ctx.parentOutcome?.scenarios.find(
      (row) => row.scenarioId === 'train',
    )?.emitted
    const external = await runScriptedGepa<TextArtifact>({
      requests: [{ candidate: 'better', split: 'train' }],
      best: 'better',
      maxEvaluations: 1,
      dispatchWithSurface: async () => ({ text: 'better' }),
      judge: betterJudge,
      describeArtifact,
    })
    expect(external.responses[0]!.info.artifact).toEqual({ answer: 'better' })
    expect(nativeEvidence).toBe(JSON.stringify({ answer: 'better' }))
  })
})
