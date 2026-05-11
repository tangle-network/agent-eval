/**
 * `runPersonaEval` — the canonical end-to-end eval primitive.
 *
 * Every product agent (tax, legal, creative, gtm, forge-chat) reinvents
 * the same loop: iterate personas, run their multi-turn flow through a
 * backend, capture raws/traces/records, score, optionally compare two
 * variants. This primitive owns that loop. Consumers write a 5-line call
 * and a `PersonaRunner` + `PersonaScorer` — nothing else.
 *
 * What the primitive owns (so the consumer doesn't):
 *
 *   - Artifact directory layout: `${artifactDir}/${runId}/{raws,traces,records}.jsonl`
 *   - Capture integrity directives: `assertLlmRoute` at preflight (optional),
 *     `RawProviderSink` wired by construction, `assertRunCaptured` per persona
 *   - Trace emitter creation + `endRun` lifecycle
 *   - `RunRecord` assembly per persona with `scenarioId = persona.id`
 *   - RL-bridge analysis when a `comparator` is supplied
 *   - One audit-ready `manifest.json` at the end
 *
 * The runner contract is intentionally generic — it returns an async
 * iterable of normalised events, so chat-runtime, forge-builder-sim,
 * customer-sim, and forge-chat all wear the same shape.
 *
 * Capture integrity is wired by CONSTRUCTION (per `SKILL.md § Capture
 * integrity`): the runner can't accidentally evaluate without raws + traces
 * + records on disk. Skip the integrity directives only by passing
 * `captureIntegrity: { ... }` opt-outs explicitly.
 */

import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import {
  assertLlmRoute,
  type LlmClientOptions,
  type LlmRouteRequirements,
} from '../llm-client'
import {
  FileSystemRawProviderSink,
  type RawProviderSink,
} from '../trace/raw-provider-sink'
import {
  assertRunCaptured,
  type RunIntegrityExpectations,
  type RunIntegrityReport,
} from '../trace/integrity'
import { TraceEmitter, type RunCompleteHook } from '../trace/emitter'
import {
  InMemoryTraceStore,
  type TraceStore,
} from '../trace/store'
import type {
  RunJudgeMetadata,
  RunOutcome,
  RunRecord,
  RunSplitTag,
  RunTokenUsage,
} from '../run-record'
import { extractPreferences, type PreferenceExtractionReport } from '../rl/preferences'
import { extractVerifiableRewardsFromRecords, type VerifiableReward } from '../rl/verifiable-reward'
import { detectRewardHacking, type RewardHackingReport } from '../rl/reward-hacking'
import {
  evaluateInterimReleaseConfidence,
  type InterimReleaseConfidence,
} from '../sequential'
import type {
  PersonaOutcome,
  PersonaRunner,
  PersonaRunState,
  PersonaScorer,
  PersonaSpec,
  PersonaTurnHistory,
} from './types'

// ── Public types ─────────────────────────────────────────────────────────

export interface RunPersonaEvalCaptureIntegrity {
  /** Default true. Set false when there is no LLM backend. */
  assertLlmRoute?: boolean
  /** Default true. Set false when raws are intentionally absent (e.g. unit test). */
  assertRunCaptured?: boolean
  /** Default true. Set false when the runner does not call any LLM. */
  rawProviderSinkRequired?: boolean
  /** Override the integrity expectations applied per persona. */
  expectations?: RunIntegrityExpectations
  /** Optional route requirements passed to `assertLlmRoute`. */
  routeRequirements?: LlmRouteRequirements
}

export interface RunPersonaEvalManifestRunDefaults {
  /** Default model snapshot stamped on every `RunRecord`. Required for `RunRecord` to validate. */
  model?: string
  /** Default `promptHash` if the scorer doesn't supply one. */
  promptHash?: string
  /** Default `configHash` if the scorer doesn't supply one. */
  configHash?: string
  /** Default token usage when the runner does not emit a cost event. */
  tokenUsage?: RunTokenUsage
  /** Default cost in USD when the runner does not emit a cost event. */
  costUsd?: number
}

export interface RunPersonaEvalComparator {
  /** The control persona-variant the comparator analysis pairs against. */
  baseline: string
  /** The candidate persona-variant. */
  variant: string
}

export interface RunPersonaEvalOptions<TInput = unknown, TOutput = unknown> {
  /** Stable id for the eval. Used as `experimentId` on every record. */
  evalId?: string
  /** The persona corpus. */
  personas: PersonaSpec<TInput>[]
  /** Drives the system under test. */
  runner: PersonaRunner<TInput, TOutput>
  /** Scores one persona's transcript into a `PersonaOutcome`. */
  scorer: PersonaScorer<TOutput>
  /** Artifact root. The eval lands at `${artifactDir}/${runId}/`. */
  artifactDir: string
  /** Optional override; default = `${date}-${randomSuffix}`. */
  runId?: string
  /** Git SHA — defaults to `process.env.DEPLOY_SHA` or `git rev-parse HEAD`. */
  commitSha?: string
  /** Subset filter — used by `pnpm eval --persona <id>`. */
  personaFilter?: (p: PersonaSpec) => boolean
  /**
   * Variant id stamped on every `RunRecord.candidateId`. Default
   * `'baseline'`. Use the `variants` option below to run multiple
   * variants in one call.
   */
  variantId?: string
  /**
   * When provided, runs the same persona set across every variant and
   * emits an RL-bridge analysis pairing the baseline against each
   * non-baseline variant. The map's keys become `candidateId`s. Each
   * value is forwarded to the runner via `variantPayload` on the
   * persona run state.
   */
  variants?: Record<string, unknown>
  /** Comparator pair for RL-bridge interim verdict. Requires `variants`. */
  comparator?: RunPersonaEvalComparator
  /** LLM client options — preflight asserts the route is configured. */
  llmOpts?: LlmClientOptions
  /**
   * Optional trace store override. Defaults to a per-cell
   * `InMemoryTraceStore` (the framework flushes everything to
   * `traces.jsonl` at the end). Supply a shared store only if you
   * have an out-of-process trace pipeline that owns persistence.
   */
  traceStore?: TraceStore | ((personaId: string, variantId: string) => TraceStore)
  /** Optional raw provider sink override (default file-backed at the run dir). */
  rawSink?: RawProviderSink
  /** Capture integrity toggles. Defaults are all-on for full-grade evals. */
  captureIntegrity?: RunPersonaEvalCaptureIntegrity
  /** Defaults stamped on every `RunRecord` the scorer does not override. */
  recordDefaults?: RunPersonaEvalManifestRunDefaults
  /** Per-run `onRunComplete` hooks appended after the framework's own. */
  onRunComplete?: RunCompleteHook[]
  /** `splitTag` stamped on every `RunRecord`. Default `holdout`. */
  splitTag?: RunSplitTag
  /** Inject a clock for deterministic tests. */
  now?: () => number
  /** Maximum concurrent persona runs. Default 1 (sequential). */
  concurrency?: number
}

export interface PersonaEvalManifest {
  runId: string
  evalId: string
  startedAt: string
  endedAt: string
  commitSha: string
  personaCount: number
  variantIds: string[]
  passCount: number
  failCount: number
  artifactPaths: {
    raws: string
    traces: string
    records: string
    manifest: string
    rlBridge?: string
  }
}

export interface PersonaRunResult<TOutput = unknown> {
  personaId: string
  variantId: string
  runId: string
  outcome: PersonaOutcome
  record: RunRecord
  history: PersonaTurnHistory<TOutput>[]
  integrity: RunIntegrityReport
  durationMs: number
  /** Trace store the cell ran against (in-memory by default). */
  traceStore?: TraceStore
}

export interface AnalyzeRLBridgeReport {
  comparator: RunPersonaEvalComparator
  rewardSignals: Array<{ runId: string; reward: VerifiableReward | null }>
  preferences: PreferenceExtractionReport
  interimConfidence: InterimReleaseConfidence | null
  rewardHacking: RewardHackingReport
  summary: string
}

export interface PersonaEvalArtifact<TOutput = unknown> {
  runId: string
  artifactDir: string
  manifest: PersonaEvalManifest
  personas: PersonaRunResult<TOutput>[]
  rlBridge?: AnalyzeRLBridgeReport
}

// ── Implementation ───────────────────────────────────────────────────────

const DEFAULT_INTEGRITY: RunIntegrityExpectations = {
  llmSpansMin: 0,
  judgeSpansMin: 0,
  requireOutcome: true,
}

const ZERO_TOKENS: RunTokenUsage = { input: 0, output: 0 }
const DEFAULT_MODEL = 'unknown@1970-01-01'
const ZEROHASH64 = '0'.repeat(64)

export async function runPersonaEval<TInput = unknown, TOutput = unknown>(
  opts: RunPersonaEvalOptions<TInput, TOutput>,
): Promise<PersonaEvalArtifact<TOutput>> {
  if (opts.personas.length === 0) {
    throw new Error('runPersonaEval: personas must be non-empty.')
  }
  if (opts.comparator && !opts.variants) {
    throw new Error('runPersonaEval: comparator requires variants.')
  }

  const filter = opts.personaFilter ?? (() => true)
  const personas = opts.personas.filter(filter)
  if (personas.length === 0) {
    throw new Error('runPersonaEval: personaFilter removed every persona.')
  }

  const variants = resolveVariants(opts)
  const captureIntegrity = resolveCaptureIntegrity(opts.captureIntegrity)
  const now = opts.now ?? (() => Date.now())
  const evalId = opts.evalId ?? 'persona-eval'
  const runId = opts.runId ?? defaultRunId(now)
  const artifactDir = path.resolve(opts.artifactDir)
  const runDir = path.join(artifactDir, runId)
  await fs.mkdir(runDir, { recursive: true })

  // Initialise the three append-only files so consumers can `tail -f`
  // them while the eval runs.
  const rawsPath = path.join(runDir, 'raws.jsonl')
  const tracesPath = path.join(runDir, 'traces.jsonl')
  const recordsPath = path.join(runDir, 'records.jsonl')
  const manifestPath = path.join(runDir, 'manifest.json')
  await Promise.all([rawsPath, tracesPath, recordsPath].map((p) => fs.writeFile(p, '', 'utf8')))

  // Preflight: assert the LLM route. Pure function, no I/O.
  if (captureIntegrity.assertLlmRoute && opts.llmOpts) {
    assertLlmRoute(opts.llmOpts, captureIntegrity.routeRequirements ?? {
      requireExplicitBaseUrl: true,
      requireAuth: true,
    })
  }

  // Resolve commit SHA. Mandatory on `RunRecord`.
  const commitSha = await resolveCommitSha(opts.commitSha)
  const splitTag: RunSplitTag = opts.splitTag ?? 'holdout'
  const startedAt = new Date(now()).toISOString()

  // Construct the durable raw sink. Default: filesystem at <runDir>/raws.jsonl.
  const rawSink = opts.rawSink ?? new FileSystemRawProviderSink({
    dir: runDir,
    fileName: 'raws.jsonl',
  })

  // Trace stores are per-cell by default. An override can opt into a
  // shared store (e.g. an OpenTelemetry exporter) for out-of-process
  // pipelines that own persistence.
  const traceStoreFactory: (personaId: string, variantId: string) => TraceStore =
    typeof opts.traceStore === 'function'
      ? opts.traceStore
      : opts.traceStore
        ? () => opts.traceStore as TraceStore
        : () => new InMemoryTraceStore()

  // ── Run the matrix ───────────────────────────────────────────────────
  type Cell = { persona: PersonaSpec<TInput>; variantId: string; variantPayload: unknown }
  const cells: Cell[] = []
  for (const variantId of Object.keys(variants)) {
    for (const persona of personas) {
      cells.push({ persona, variantId, variantPayload: variants[variantId] })
    }
  }

  const results: PersonaRunResult<TOutput>[] = []
  const concurrency = Math.max(1, opts.concurrency ?? 1)
  let cursor = 0

  const recordsHandle = await fs.open(recordsPath, 'a')

  async function worker(): Promise<void> {
    while (true) {
      const idx = cursor++
      if (idx >= cells.length) return
      const cell = cells[idx]!
      const cellRunId = `${runId}-${cell.variantId}-${cell.persona.id}`
      const cellStore = traceStoreFactory(cell.persona.id, cell.variantId)
      const result = await runOneCell({
        cell,
        cellRunId,
        evalId,
        commitSha,
        splitTag,
        runDir,
        rawSink,
        traceStore: cellStore,
        captureIntegrity,
        recordDefaults: opts.recordDefaults ?? {},
        onRunComplete: opts.onRunComplete ?? [],
        llmOpts: opts.llmOpts,
        runner: opts.runner,
        scorer: opts.scorer,
        now,
      })
      result.traceStore = cellStore
      results.push(result)
      await recordsHandle.appendFile(JSON.stringify(result.record) + '\n', 'utf8')
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, cells.length) }, () => worker()))
  await recordsHandle.close()

  // Persist the trace events to traces.jsonl as a consolidated view
  // across every per-cell store.
  await flushTracesToFile(
    results.map((r) => ({ runId: r.runId, store: r.traceStore })),
    tracesPath,
  )

  // ── Optional RL-bridge analysis ──────────────────────────────────────
  let rlBridge: AnalyzeRLBridgeReport | undefined
  let rlBridgePath: string | undefined
  if (opts.comparator) {
    rlBridge = analyzeRLBridge(results.map((r) => r.record), opts.comparator)
    rlBridgePath = path.join(runDir, 'rl-bridge.json')
    await fs.writeFile(rlBridgePath, JSON.stringify(rlBridge, null, 2), 'utf8')
  }

  // ── Manifest ─────────────────────────────────────────────────────────
  const passCount = results.filter((r) => r.outcome.pass).length
  const failCount = results.length - passCount
  const endedAt = new Date(now()).toISOString()
  const manifest: PersonaEvalManifest = {
    runId,
    evalId,
    startedAt,
    endedAt,
    commitSha,
    personaCount: personas.length,
    variantIds: Object.keys(variants),
    passCount,
    failCount,
    artifactPaths: {
      raws: rawsPath,
      traces: tracesPath,
      records: recordsPath,
      manifest: manifestPath,
      rlBridge: rlBridgePath,
    },
  }
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8')

  return {
    runId,
    artifactDir,
    manifest,
    personas: results,
    rlBridge,
  }
}

interface RunOneCellArgs<TInput, TOutput> {
  cell: { persona: PersonaSpec<TInput>; variantId: string; variantPayload: unknown }
  cellRunId: string
  evalId: string
  commitSha: string
  splitTag: RunSplitTag
  runDir: string
  rawSink: RawProviderSink
  traceStore: TraceStore
  captureIntegrity: RunPersonaEvalCaptureIntegrity
  recordDefaults: RunPersonaEvalManifestRunDefaults
  onRunComplete: RunCompleteHook[]
  llmOpts?: LlmClientOptions
  runner: PersonaRunner<TInput, TOutput>
  scorer: PersonaScorer<TOutput>
  now: () => number
}

async function runOneCell<TInput, TOutput>(
  args: RunOneCellArgs<TInput, TOutput>,
): Promise<PersonaRunResult<TOutput>> {
  const {
    cell,
    cellRunId,
    evalId,
    commitSha,
    splitTag,
    rawSink,
    traceStore,
    captureIntegrity,
    recordDefaults,
    onRunComplete,
    runner,
    scorer,
    now,
  } = args

  const emitter = new TraceEmitter(traceStore, {
    runId: cellRunId,
    now: args.now,
    onRunComplete,
  })

  const state: PersonaRunState<TOutput> = {
    personaId: cell.persona.id,
    turnIndex: 0,
    history: [],
    variantId: cell.variantId,
    variantPayload: cell.variantPayload,
  }

  const wallStart = now()
  await emitter.startRun({
    scenarioId: cell.persona.id,
    layer: 'app-runtime',
    variantId: cell.variantId,
    tags: { evalId, variantId: cell.variantId, ...(cell.persona.tags ?? {}) },
  })

  let aggregateText = ''
  let aggregateCostUsd = 0
  let aggregateTokens: RunTokenUsage = { ...(recordDefaults.tokenUsage ?? ZERO_TOKENS) }
  let modelSeen = recordDefaults.model ?? DEFAULT_MODEL
  const rawEvents: unknown[] = []

  try {
    for (let i = 0; i < cell.persona.turns.length; i++) {
      const turn = cell.persona.turns[i]!
      state.turnIndex = i
      const turnStart = now()
      let turnText = ''
      let turnRawCount = 0
      let turnOutput: TOutput | undefined

      const capture = {
        runId: cellRunId,
        rawSink,
        llmOpts: {
          ...(args.llmOpts ?? {}),
          rawSink,
          traceContext: { runId: cellRunId },
        },
      }
      const iterable = runner({ persona: cell.persona, turn, state, capture })

      for await (const ev of iterable) {
        if (!ev || typeof ev !== 'object') continue
        const e = ev as { kind?: string }
        switch (e.kind) {
          case 'text': {
            const text = (ev as { text?: string }).text ?? ''
            turnText += text
            break
          }
          case 'tool_call': {
            const tc = ev as { name: string; args?: unknown; result?: unknown; durationMs?: number }
            const handle = await emitter.tool({
              name: tc.name,
              toolName: tc.name,
              args: tc.args ?? {},
              result: tc.result,
              latencyMs: tc.durationMs,
            })
            await handle.end()
            break
          }
          case 'output': {
            turnOutput = (ev as { output: TOutput }).output
            break
          }
          case 'cost': {
            const c = ev as { usd?: number; tokenUsage?: RunTokenUsage }
            aggregateCostUsd += c.usd ?? 0
            if (c.tokenUsage) {
              aggregateTokens = {
                input: aggregateTokens.input + c.tokenUsage.input,
                output: aggregateTokens.output + c.tokenUsage.output,
                cached: (aggregateTokens.cached ?? 0) + (c.tokenUsage.cached ?? 0),
              }
            }
            break
          }
          case 'model': {
            modelSeen = (ev as { model: string }).model
            break
          }
          case 'raw':
          default: {
            const data = e.kind === 'raw' ? (ev as { data: unknown }).data : ev
            rawEvents.push(data)
            await appendRawEvent(args.runDir, data)
            turnRawCount++
            break
          }
        }
      }

      const history: PersonaTurnHistory<TOutput> = {
        turnId: turn.id,
        input: turn.input,
        output: (turnOutput ?? (turnText as unknown)) as TOutput,
        durationMs: now() - turnStart,
        rawEventCount: turnRawCount,
      }
      state.history.push(history)
      aggregateText += turnText
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    await emitter.abortRun(`runner threw: ${msg}`)
    throw err
  }

  // Score the persona.
  const outcome = await scorer({
    persona: cell.persona,
    history: state.history,
    finalText: aggregateText,
    raws: rawEvents,
  })

  await emitter.endRun({ pass: outcome.pass, score: outcome.score, notes: outcome.notes })

  const wallMs = now() - wallStart

  // Build the `RunRecord`.
  const recordOutcome: RunOutcome = { raw: outcome.raw ?? {} }
  if (splitTag === 'holdout') recordOutcome.holdoutScore = outcome.score
  else recordOutcome.searchScore = outcome.score

  let judgeMetadata: RunJudgeMetadata | undefined
  if (recordDefaults && (recordDefaults as { judgeMetadata?: RunJudgeMetadata }).judgeMetadata) {
    judgeMetadata = (recordDefaults as { judgeMetadata?: RunJudgeMetadata }).judgeMetadata
  }

  const record: RunRecord = {
    runId: cellRunId,
    experimentId: evalId,
    candidateId: cell.variantId,
    seed: 0,
    model: modelSeen,
    promptHash: recordDefaults.promptHash ?? ZEROHASH64,
    configHash: recordDefaults.configHash ?? ZEROHASH64,
    commitSha,
    wallMs,
    costUsd: aggregateCostUsd || (recordDefaults.costUsd ?? 0),
    tokenUsage: aggregateTokens,
    outcome: recordOutcome,
    failureMode: outcome.failureMode,
    splitTag,
    scenarioId: cell.persona.id,
    judgeMetadata,
  }

  // Integrity check.
  const expectations: RunIntegrityExpectations = {
    ...DEFAULT_INTEGRITY,
    ...(captureIntegrity.expectations ?? {}),
    rawSink: captureIntegrity.rawProviderSinkRequired ? rawSink : undefined,
  }
  const integrity = captureIntegrity.assertRunCaptured
    ? await assertRunCaptured(traceStore, cellRunId, expectations)
    : {
        ok: true,
        runId: cellRunId,
        llmSpanCount: 0,
        judgeSpanCount: 0,
        toolSpanCount: 0,
        rawProviderEventCount: 0,
        rawSpanCoverage: { covered: 0, total: 0 },
        issues: [],
      } as RunIntegrityReport

  return {
    personaId: cell.persona.id,
    variantId: cell.variantId,
    runId: cellRunId,
    outcome,
    record,
    history: state.history,
    integrity,
    durationMs: wallMs,
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────

function resolveVariants<TInput, TOutput>(
  opts: RunPersonaEvalOptions<TInput, TOutput>,
): Record<string, unknown> {
  if (opts.variants && Object.keys(opts.variants).length > 0) return opts.variants
  return { [opts.variantId ?? 'baseline']: null }
}

function resolveCaptureIntegrity(
  ci: RunPersonaEvalCaptureIntegrity | undefined,
): Required<Pick<RunPersonaEvalCaptureIntegrity, 'assertLlmRoute' | 'assertRunCaptured' | 'rawProviderSinkRequired'>> &
  RunPersonaEvalCaptureIntegrity {
  return {
    assertLlmRoute: ci?.assertLlmRoute ?? true,
    assertRunCaptured: ci?.assertRunCaptured ?? true,
    rawProviderSinkRequired: ci?.rawProviderSinkRequired ?? false,
    expectations: ci?.expectations,
    routeRequirements: ci?.routeRequirements,
  }
}

async function resolveCommitSha(input: string | undefined): Promise<string> {
  if (input && input.length > 0) return input
  const env = process.env.DEPLOY_SHA ?? process.env.GIT_SHA ?? process.env.COMMIT_SHA
  if (env && env.length > 0) return env
  try {
    const { execSync } = await import('node:child_process')
    const sha = execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim()
    if (sha.length > 0) return sha
  } catch {
    // Not a git checkout — fall through.
  }
  return 'unknown'
}

function defaultRunId(now: () => number): string {
  const ts = new Date(now()).toISOString().replace(/[:.]/g, '-')
  const suffix = Math.random().toString(36).slice(2, 8)
  return `persona-${ts}-${suffix}`
}

async function appendRawEvent(runDir: string, data: unknown): Promise<void> {
  const line = JSON.stringify({ ts: Date.now(), data }) + '\n'
  // The framework's RawProviderSink owns the canonical raws.jsonl;
  // runner-emitted `kind:'raw'` events land in a sidecar so they
  // don't pollute the provider-event schema.
  await fs.appendFile(path.join(runDir, 'runner-raws.jsonl'), line, 'utf8')
}

async function flushTracesToFile(
  results: Array<{ runId: string; store: TraceStore | undefined }>,
  tracesPath: string,
): Promise<void> {
  const handle = await fs.open(tracesPath, 'a')
  try {
    for (const r of results) {
      const store = r.store
      if (!store) continue
      const run = await store.getRun(r.runId)
      if (run) await handle.appendFile(JSON.stringify({ kind: 'run', record: run }) + '\n', 'utf8')
      const spans = await store.spans({ runId: r.runId })
      for (const s of spans) {
        await handle.appendFile(JSON.stringify({ kind: 'span', record: s }) + '\n', 'utf8')
      }
      const events = await store.events({ runId: r.runId })
      for (const e of events) {
        await handle.appendFile(JSON.stringify({ kind: 'event', record: e }) + '\n', 'utf8')
      }
    }
  } finally {
    await handle.close()
  }
}

function analyzeRLBridge(
  runs: RunRecord[],
  comparator: RunPersonaEvalComparator,
): AnalyzeRLBridgeReport {
  const rewardSignals = extractVerifiableRewardsFromRecords(runs, {})
  const preferences = extractPreferences(runs, {
    strategy: 'paired-by-scenario-and-seed',
    minMargin: 0,
    splitTag: runs[0]?.splitTag ?? 'holdout',
  })
  const baseline = new Map<string, number>()
  for (const r of runs) {
    if (r.candidateId !== comparator.baseline) continue
    const sid = r.scenarioId ?? r.experimentId
    const score = r.outcome.holdoutScore ?? r.outcome.searchScore
    if (typeof score !== 'number' || !Number.isFinite(score)) continue
    baseline.set(`${sid}::${r.seed}`, score)
  }
  const deltas: number[] = []
  for (const r of runs) {
    if (r.candidateId !== comparator.variant) continue
    const sid = r.scenarioId ?? r.experimentId
    const score = r.outcome.holdoutScore ?? r.outcome.searchScore
    if (typeof score !== 'number' || !Number.isFinite(score)) continue
    const base = baseline.get(`${sid}::${r.seed}`)
    if (typeof base !== 'number') continue
    deltas.push(score - base)
  }
  let interimConfidence: InterimReleaseConfidence | null = null
  if (deltas.length > 0) {
    interimConfidence = evaluateInterimReleaseConfidence({
      deltaSeries: [{ candidateId: comparator.variant, deltas }],
    })
  }
  const rewardHacking = detectRewardHacking({ runs })
  const summary =
    `${runs.length} runs · ${preferences.pairs.length} preference pairs · ` +
    `${comparator.variant} vs ${comparator.baseline} interim=${interimConfidence?.recommendation.decision ?? 'no-data'} · ` +
    `reward-hacking=${rewardHacking.verdict}`
  return {
    comparator,
    rewardSignals,
    preferences,
    interimConfidence,
    rewardHacking,
    summary,
  }
}
