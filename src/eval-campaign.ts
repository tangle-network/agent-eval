/**
 * EvalCampaign — opinionated matrix runner that wires the four
 * capture-integrity directives by construction.
 *
 * Every consumer that ran a launch-grade benchmark before 0.22 reinvented
 * the same shape: matrix runner → for each (variant, scenario, seed) →
 * start a TraceEmitter → call LLMs → end the run → maybe analyze.
 * The bug class blueprint-agent reported (raw events not captured, route
 * silently wrong, integrity not asserted, analyst never ran) lives at the
 * integration boundary — not the agent-eval API surface. The four
 * directives in `SKILL.md § Capture integrity` are mitigations.
 *
 * `EvalCampaign` is the structural fix. Consumers don't wire the integrity
 * surface anymore; the campaign owns it. Specifically, the campaign:
 *
 *   - calls `assertLlmRoute` once at preflight before any work runs
 *   - constructs a per-run `TraceStore` and `RawProviderSink` via factories
 *   - constructs the `TraceEmitter` with `onRunComplete: [analyst hook]`
 *   - hands the runner an `LlmClientOptions` pre-wired with the sink and
 *     trace context — the runner can't accidentally call an LLM without
 *     capturing the raw HTTP envelope
 *   - calls `assertRunCaptured` after every `endRun` and routes failures
 *     through a configurable policy (`throw` / `mark_failed` / `log`)
 *   - assembles per-run `RunRecord`s and runs `researchReport` at the end
 *     so the campaign artifact is launch-decision-grade by default
 *   - embeds the campaign fingerprint (a SHA-256 over the canonicalised
 *     run set) and optional `preregistrationHash` in the report
 *
 * The runner contract is intentionally narrow: produce a `CampaignRunOutcome`
 * given a fully-wired `CampaignRunContext`. Everything orchestration-shaped
 * lives in the campaign. This is the inversion-of-control point — consumers
 * stop writing matrix runners and start writing scenario-runners.
 *
 * Out of scope for v1 (tracked in `docs/research-report-methodology.md`):
 *
 *   - Distributed/cluster execution (concurrency is local async)
 *   - Adaptive sampling / sequential interim looks
 *   - Resume from partial state across crashes
 *   - LLM-call retry beyond what `LlmClient` already does
 */

import { assertLlmRoute, type LlmClientOptions, type LlmRouteRequirements } from './llm-client'
import { canonicalize, hashJson } from './pre-registration'
import type {
  RunJudgeMetadata,
  RunOutcome,
  RunRecord,
  RunSplitTag,
  RunTokenUsage,
} from './run-record'
import { type ResearchReport, type ResearchReportOptions, researchReport } from './summary-report'
import type { RunCompleteHook } from './trace/emitter'
import { TraceEmitter } from './trace/emitter'
import {
  assertRunCaptured,
  RunIntegrityError,
  type RunIntegrityExpectations,
  type RunIntegrityReport,
} from './trace/integrity'
import { FileSystemRawProviderSink, type RawProviderSink } from './trace/raw-provider-sink'
import type { TraceStore } from './trace/store'

// ── Public types ─────────────────────────────────────────────────────────

export interface CampaignVariant<V> {
  id: string
  payload: V
}

export interface CampaignScenario {
  scenarioId: string
  /** Free-form metadata propagated to runs and reports. */
  tags?: Record<string, string>
}

export interface CampaignRunContext<V> {
  /** Stable run id. The campaign generates this; the runner does not. */
  runId: string
  /** Logical experiment id (campaignId by default; overridable per-run via opts). */
  experimentId: string
  variant: V
  variantId: string
  scenarioId: string
  scenarioTags: Record<string, string>
  seed: number
  splitTag: RunSplitTag
  /**
   * The TraceEmitter for this run, with `onRunComplete` hooks pre-wired
   * (analyst auto-execution if configured, plus integrity check). The
   * runner MUST call `emitter.startRun` before doing any work and either
   * `emitter.endRun` or `emitter.abortRun` before returning.
   */
  emitter: TraceEmitter
  store: TraceStore
  rawSink: RawProviderSink
  /**
   * Pre-wired LLM client options — `rawSink` and `traceContext` are populated
   * so any `callLlm(req, ctx.llmOpts)` automatically captures raw HTTP. The
   * runner can spread additional fields if needed.
   */
  llmOpts: LlmClientOptions
}

export interface CampaignRunOutcome {
  /** Did the run pass? Mirrors `RunOutcome.pass` semantics. */
  pass: boolean
  /** Score for the run on its split. Maps to `searchScore` or `holdoutScore`. */
  score: number
  /** Mandatory cost in USD. Use 0 + raw.cost_unknown=1 only if truly unknown. */
  costUsd: number
  tokenUsage: RunTokenUsage
  /** Snapshot model id (e.g. `claude-sonnet-4-6@2025-04-15`). */
  model: string
  /** sha256 of the effective prompt sent to the model. */
  promptHash: string
  /** sha256 of the effective config (model, temperature, tools, judges, splits). */
  configHash: string
  /** Optional extra numeric metrics to land in `outcome.raw`. */
  raw?: Record<string, number>
  /** Optional failure-taxonomy tag if the run failed. */
  failureMode?: string
  /** Optional judge metadata when a judge was used. */
  judgeMetadata?: RunJudgeMetadata
}

export type CampaignRunner<V> = (ctx: CampaignRunContext<V>) => Promise<CampaignRunOutcome>

export type CampaignIntegrityPolicy = 'throw' | 'mark_failed' | 'log'

export interface EvalCampaignOptions<V> {
  /**
   * Stable id for the campaign. Used as the default `experimentId` on
   * every run, and folded into the campaign fingerprint.
   */
  campaignId: string
  variants: CampaignVariant<V>[]
  scenarios: CampaignScenario[]
  /** Default `[0, 1, 2]`. */
  seeds?: number[]
  /** Default `'holdout'` — the split that anchors a launch decision. */
  splitTag?: RunSplitTag
  /** Git SHA the campaign is run against. Mandatory; `RunRecord` rejects unset. */
  commitSha: string
  /**
   * LLM client config. Augmented per-run with `rawSink` and `traceContext`
   * before being passed to the runner. The campaign asserts this config
   * matches `routeRequirements` once at preflight.
   */
  llmOpts: LlmClientOptions
  /**
   * Default `{ requireExplicitBaseUrl: true, requireAuth: true }` — fail
   * loud if the campaign would silently fall back to the public router or
   * run unauthenticated. Override with an empty object to disable.
   */
  routeRequirements?: LlmRouteRequirements
  /**
   * Per-run TraceStore factory. Common shape: a fresh store per run keyed
   * on `runId`. Implementations that share a store across the campaign
   * are valid — the campaign only writes through `emitter`.
   */
  storeFactory: (params: CampaignFactoryParams) => TraceStore
  /**
   * Per-run RawProviderSink factory. Defaults to `FileSystemRawProviderSink`
   * rooted at `${workDir}/raw-events/${runId}` if `workDir` is supplied;
   * otherwise required. Forensic capture is non-negotiable in a campaign
   * run — pass `NoopRawProviderSink` explicitly if you want to opt out.
   */
  rawSinkFactory?: (params: CampaignFactoryParams) => RawProviderSink
  /**
   * Filesystem root for default `rawSinkFactory`. Ignored if
   * `rawSinkFactory` is supplied.
   */
  workDir?: string
  /**
   * Extra `onRunComplete` hooks the campaign appends (after its own
   * integrity-check hook). Pass `traceAnalystOnRunComplete(...)` here.
   */
  onRunComplete?: RunCompleteHook[]
  /**
   * Per-run integrity expectations. Defaults to:
   *   `{ llmSpansMin: 1, requireRawCoverageOfLlmSpans: true, requireOutcome: true }`.
   * Override (e.g. `{ llmSpansMin: 0 }`) for runs that don't call LLMs.
   */
  integrity?: RunIntegrityExpectations
  /** Behaviour when integrity fails. Default `'mark_failed'`. */
  onIntegrityFailure?: CampaignIntegrityPolicy
  /**
   * Per-run runner. Receives a fully-wired context; produces an outcome
   * the campaign converts into a `RunRecord`.
   */
  runner: CampaignRunner<V>
  /**
   * If set, the campaign computes `researchReport` at the end. `comparator`
   * is a `variantId`. Other fields are forwarded verbatim.
   */
  report?: { comparator?: string } & Omit<
    ResearchReportOptions,
    'comparator' | 'preregistrationHash' | 'generatedAt'
  >
  /**
   * Hash of a signed `HypothesisManifest` (see `pre-registration.ts`).
   * Embedded in the campaign fingerprint and the research report.
   */
  preregistrationHash?: string
  /** Local concurrency. Default `1` (sequential). */
  concurrency?: number
  /**
   * Override the time source. Tests pass a mock to make wallMs deterministic.
   */
  now?: () => number
  /** Override the runId generator. Tests pin this. */
  runId?: (params: CampaignFactoryParams) => string
}

export interface CampaignFactoryParams {
  campaignId: string
  runId: string
  variantId: string
  scenarioId: string
  seed: number
}

export interface FailedRun {
  runId: string
  variantId: string
  scenarioId: string
  seed: number
  reason: string
  error?: string
}

export interface EvalCampaignResult {
  campaignId: string
  /** SHA-256 over canonicalised `(variantIds, scenarioIds, seeds, comparator, splitTag, baseUrl, provider, preregistrationHash)`. */
  campaignFingerprint: string
  preregistrationHash: string | null
  /** Successful runs only. Failed runs land in `failedRuns`. */
  runs: RunRecord[]
  /** Integrity reports for every successful run. */
  integrityReports: RunIntegrityReport[]
  failedRuns: FailedRun[]
  /** Computed when `report` is set on options. */
  report?: ResearchReport
  startedAt: string
  endedAt: string
}

// ── Implementation ───────────────────────────────────────────────────────

const DEFAULT_INTEGRITY: RunIntegrityExpectations = {
  llmSpansMin: 1,
  requireRawCoverageOfLlmSpans: true,
  requireOutcome: true,
}

const DEFAULT_ROUTE: LlmRouteRequirements = {
  requireExplicitBaseUrl: true,
  requireAuth: true,
}

export async function runEvalCampaign<V>(
  opts: EvalCampaignOptions<V>,
): Promise<EvalCampaignResult> {
  // ── Preflight ──────────────────────────────────────────────────────
  assertLlmRoute(opts.llmOpts, opts.routeRequirements ?? DEFAULT_ROUTE)

  if (opts.variants.length === 0) {
    throw new Error('runEvalCampaign: variants must be non-empty.')
  }
  if (opts.scenarios.length === 0) {
    throw new Error('runEvalCampaign: scenarios must be non-empty.')
  }
  const variantIds = new Set<string>()
  for (const v of opts.variants) {
    if (variantIds.has(v.id)) {
      throw new Error(`runEvalCampaign: duplicate variant id "${v.id}".`)
    }
    variantIds.add(v.id)
  }
  const scenarioIds = new Set<string>()
  for (const s of opts.scenarios) {
    if (scenarioIds.has(s.scenarioId)) {
      throw new Error(`runEvalCampaign: duplicate scenarioId "${s.scenarioId}".`)
    }
    scenarioIds.add(s.scenarioId)
  }
  if (opts.report?.comparator && !variantIds.has(opts.report.comparator)) {
    throw new Error(
      `runEvalCampaign: report.comparator "${opts.report.comparator}" is not a configured variantId.`,
    )
  }
  if (!opts.commitSha) {
    throw new Error('runEvalCampaign: commitSha is required (every RunRecord needs it).')
  }

  const seeds = opts.seeds ?? [0, 1, 2]
  const splitTag: RunSplitTag = opts.splitTag ?? 'holdout'
  const concurrency = Math.max(1, opts.concurrency ?? 1)
  const integrity = { ...DEFAULT_INTEGRITY, ...(opts.integrity ?? {}) }
  const onIntegrityFailure: CampaignIntegrityPolicy = opts.onIntegrityFailure ?? 'mark_failed'
  const now = opts.now ?? (() => Date.now())
  const baseUrl = (opts.llmOpts.baseUrl ?? '').replace(/\/+$/, '')
  const provider = opts.llmOpts.provider ?? null
  const preregistrationHash = opts.preregistrationHash ?? null

  const rawSinkFactory = opts.rawSinkFactory ?? defaultRawSinkFactory(opts.workDir)

  // ── Fingerprint ────────────────────────────────────────────────────
  const campaignFingerprint = await hashJson(
    canonicalize({
      campaignId: opts.campaignId,
      variants: opts.variants.map((v) => v.id).sort(),
      scenarios: opts.scenarios.map((s) => s.scenarioId).sort(),
      seeds: [...seeds].sort((a, b) => a - b),
      splitTag,
      comparator: opts.report?.comparator ?? null,
      baseUrl,
      provider,
      preregistrationHash,
    }),
  )

  // ── Plan the matrix ────────────────────────────────────────────────
  type Cell = { variant: CampaignVariant<V>; scenario: CampaignScenario; seed: number }
  const cells: Cell[] = []
  for (const variant of opts.variants) {
    for (const scenario of opts.scenarios) {
      for (const seed of seeds) {
        cells.push({ variant, scenario, seed })
      }
    }
  }

  const startedAt = new Date(now()).toISOString()
  const runs: RunRecord[] = []
  const integrityReports: RunIntegrityReport[] = []
  const failedRuns: FailedRun[] = []

  // ── Execute (bounded-concurrency worker pool) ──────────────────────
  let cursor = 0
  async function worker(): Promise<void> {
    while (true) {
      const i = cursor++
      if (i >= cells.length) return
      const cell = cells[i]!
      try {
        const result = await runOneCell(cell)
        runs.push(result.record)
        integrityReports.push(result.integrity)
      } catch (err) {
        if (err instanceof CellExecutionError) {
          failedRuns.push(err.failed)
          if (err.integrity) integrityReports.push(err.integrity)
        } else {
          // Genuine bug — not a runner failure, not an integrity failure.
          // Surface it; don't silently mask.
          throw err
        }
      }
    }
  }

  async function runOneCell(
    cell: Cell,
  ): Promise<{ record: RunRecord; integrity: RunIntegrityReport }> {
    const runId = (opts.runId ?? defaultRunId)({
      campaignId: opts.campaignId,
      runId: '', // unused by default generator
      variantId: cell.variant.id,
      scenarioId: cell.scenario.scenarioId,
      seed: cell.seed,
    })
    const factoryParams: CampaignFactoryParams = {
      campaignId: opts.campaignId,
      runId,
      variantId: cell.variant.id,
      scenarioId: cell.scenario.scenarioId,
      seed: cell.seed,
    }
    const store = opts.storeFactory(factoryParams)
    const rawSink = rawSinkFactory(factoryParams)

    const emitter = new TraceEmitter(store, {
      runId,
      now: opts.now,
      onRunComplete: opts.onRunComplete,
    })

    const llmOpts: LlmClientOptions = {
      ...opts.llmOpts,
      rawSink,
      traceContext: { runId },
    }

    const ctx: CampaignRunContext<V> = {
      runId,
      experimentId: opts.campaignId,
      variant: cell.variant.payload,
      variantId: cell.variant.id,
      scenarioId: cell.scenario.scenarioId,
      scenarioTags: cell.scenario.tags ?? {},
      seed: cell.seed,
      splitTag,
      emitter,
      store,
      rawSink,
      llmOpts,
    }

    const wallStart = now()
    let outcome: CampaignRunOutcome
    try {
      outcome = await opts.runner(ctx)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      // The runner threw mid-execution; give it a chance to have aborted.
      try {
        await emitter.abortRun(message)
      } catch {
        // Already aborted/ended; ignore.
      }
      throw new CellExecutionError({
        runId,
        variantId: cell.variant.id,
        scenarioId: cell.scenario.scenarioId,
        seed: cell.seed,
        reason: 'runner_threw',
        error: message,
      })
    }
    const wallMs = now() - wallStart

    const integrityReport = await assertRunCaptured(store, runId, { ...integrity, rawSink })
    if (!integrityReport.ok) {
      switch (onIntegrityFailure) {
        case 'throw':
          throw new RunIntegrityError(integrityReport)
        case 'mark_failed':
          throw new CellExecutionError(
            {
              runId,
              variantId: cell.variant.id,
              scenarioId: cell.scenario.scenarioId,
              seed: cell.seed,
              reason: 'integrity_failed',
              error: integrityReport.issues.map((i) => i.code).join(', '),
            },
            integrityReport,
          )
        case 'log':
          // Caller wants the run admitted with a flagged report; fall through.
          break
      }
    }

    const recordOutcome: RunOutcome = {
      raw: outcome.raw ?? {},
    }
    if (splitTag === 'holdout') recordOutcome.holdoutScore = outcome.score
    else recordOutcome.searchScore = outcome.score

    const record: RunRecord = {
      runId,
      experimentId: opts.campaignId,
      candidateId: cell.variant.id,
      seed: cell.seed,
      model: outcome.model,
      promptHash: outcome.promptHash,
      configHash: outcome.configHash,
      commitSha: opts.commitSha,
      wallMs,
      costUsd: outcome.costUsd,
      tokenUsage: outcome.tokenUsage,
      judgeMetadata: outcome.judgeMetadata,
      outcome: recordOutcome,
      failureMode: outcome.failureMode,
      splitTag,
      scenarioId: cell.scenario.scenarioId,
    }
    return { record, integrity: integrityReport }
  }

  const workers = Array.from({ length: Math.min(concurrency, cells.length) }, () => worker())
  await Promise.all(workers)

  // ── Optional research report ───────────────────────────────────────
  let report: ResearchReport | undefined
  if (opts.report) {
    const reportOpts: ResearchReportOptions = {
      ...opts.report,
      comparator: opts.report.comparator,
      split: splitTag === 'dev' ? 'search' : splitTag,
      generatedAt: new Date(now()).toISOString(),
      preregistrationHash: preregistrationHash ?? undefined,
    }
    report = await researchReport(runs, reportOpts)
  }

  const endedAt = new Date(now()).toISOString()

  return {
    campaignId: opts.campaignId,
    campaignFingerprint,
    preregistrationHash,
    runs,
    integrityReports,
    failedRuns,
    report,
    startedAt,
    endedAt,
  }
}

// ── Internal ─────────────────────────────────────────────────────────────

class CellExecutionError extends Error {
  readonly failed: FailedRun
  readonly integrity?: RunIntegrityReport
  constructor(failed: FailedRun, integrity?: RunIntegrityReport) {
    super(`cell ${failed.variantId}/${failed.scenarioId}@${failed.seed} failed: ${failed.reason}`)
    this.failed = failed
    this.integrity = integrity
  }
}

function defaultRawSinkFactory(workDir: string | undefined) {
  return (params: CampaignFactoryParams): RawProviderSink => {
    if (!workDir) {
      throw new Error(
        'runEvalCampaign: rawSinkFactory not supplied and workDir not set. Pass either to enable raw provider capture, or pass `new NoopRawProviderSink()` via rawSinkFactory to opt out explicitly.',
      )
    }
    return new FileSystemRawProviderSink({
      dir: `${workDir}/raw-events/${params.runId}`,
    })
  }
}

function defaultRunId(params: CampaignFactoryParams): string {
  // Stable across re-runs: fingerprint of (campaignId, variantId, scenarioId, seed).
  // Caller can override via opts.runId for non-deterministic IDs.
  const base = `${params.campaignId}::${params.variantId}::${params.scenarioId}::${params.seed}`
  // Lightweight hex: we don't need crypto-grade here, just stability + uniqueness.
  let h1 = 0x811c9dc5
  let h2 = 0x12345678
  for (let i = 0; i < base.length; i++) {
    const c = base.charCodeAt(i)
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0
    h2 = Math.imul(h2 ^ c, 0x9e3779b1) >>> 0
  }
  return `run-${h1.toString(16).padStart(8, '0')}${h2.toString(16).padStart(8, '0')}`
}
