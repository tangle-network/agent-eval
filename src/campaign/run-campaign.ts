/**
 * `runCampaign` — Pass A substrate primitive. ONE function that orchestrates
 * scenarios → dispatch → artifacts → judges → aggregates, with full
 * reproducibility (seed + manifest hash), cell-level resumability, bootstrap
 * CIs, and the `LabeledScenarioStore` capture flywheel.
 *
 * Improvement loops (optimizer / gate / autoOnPromote) ride on top of this
 * primitive but live in `presets/run-improvement-loop.ts`. This file keeps
 * the core orchestrator minimal — Phase 1 of the Pass A track.
 */

import { join } from 'node:path'
import { BackendIntegrityError, type BackendIntegrityReport } from '../integrity/backend-integrity'
import { confidenceInterval } from '../statistics'
import { contentHash } from '../verdict-cache'
import { resolveRunDir } from './run-dir'
import { type CampaignStorage, fsCampaignStorage } from './storage'
import type {
  CampaignAggregates,
  CampaignArtifactWriter,
  CampaignCellResult,
  CampaignCostMeter,
  CampaignResult,
  CampaignTokenUsage,
  CampaignTraceWriter,
  DispatchContext,
  DispatchFn,
  JudgeAggregate,
  JudgeConfig,
  JudgeScore,
  LabeledScenarioStore,
  Scenario,
  ScenarioAggregate,
  TraceSpan,
} from './types'

export interface RunCampaignOptions<TScenario extends Scenario, TArtifact> {
  scenarios: TScenario[]
  dispatch: DispatchFn<TScenario, TArtifact>
  /**
   * Stable identity for the dispatch behavior, included in the manifest/cache
   * key. Set this when the same function name can run different models,
   * prompts, tools, or external config.
   */
  dispatchRef?: string
  judges?: JudgeConfig<TArtifact, TScenario>[]
  /** Required for reproducibility. Default 42. */
  seed?: number
  /** Per-scenario replicates for CI bands. Default 1; raise to 5+ for
   *  bootstrap-tight intervals on critical eval. */
  reps?: number
  /** When true (default), completed cells are cached by
   *  (manifestHash, scenarioId, rep, generation). Re-runs skip cached cells. */
  resumable?: boolean
  /** Optional store — when present, every artifact + judge score is captured
   *  with the configured `captureSource`. Capture is default ON; pass `'off'`
   *  to disable. */
  labeledStore?: LabeledScenarioStore | 'off'
  captureSource?: 'production-trace' | 'eval-run' | 'manual' | 'red-team' | 'synthetic'
  captureSourceVersionHash?: string
  /** Wall-clock cost cap across all cells. Cells beyond ceiling are skipped. */
  costCeiling?: number
  /** Max concurrent cells. Default 2. */
  maxConcurrency?: number
  /**
   * Per-cell dispatch deadline in ms. A `dispatch` that neither resolves nor
   * rejects within this window is a hang (a stalled model request, an
   * exhausted runtime resource, a backend that never closes its stream). When
   * set, the cell's `ctx.signal` is aborted and the cell is recorded as a LOUD
   * error (`dispatch exceeded <N>ms`) so the campaign proceeds and the failure
   * is visible — instead of one wedged cell silently hanging the whole run (and
   * every loop/CI job above it) forever. `undefined`/`0` = unbounded (legacy).
   */
  dispatchTimeoutMs?: number
  /** Required: where artifacts + traces land. A bare name (not an absolute path)
   *  resolves to the shared `~/.tangle/traces/<repo>/runs/<name>` root so run
   *  bundles never pollute a repo working tree. Pass an absolute path to override. */
  runDir: string
  /** Subject repo for the shared run-dir root (defaults to the CWD basename).
   *  Only consulted when `runDir` is a bare name. */
  repo?: string
  /** Tracing posture. Default is the substrate's `FileSystemTraceStore` rooted
   *  at `<runDir>/traces/`. `'off'` disables capture entirely — substrate
   *  refuses this when the caller wires `autoOnPromote !== 'none'`. */
  tracing?: 'on' | 'off'
  /**
   * Per-cell usage expectation — the early, fine-grained sibling of the
   * batch `assertRealBackend` guard. A cell that produced an artifact (no
   * error) but reported `costUsd === 0` AND zero tokens is a stub: the
   * dispatch never reported LLM activity via `ctx.cost`. Modes:
   *   - `'warn'` (default) — log the offending cell loudly, keep going.
   *   - `'assert'` — throw `BackendIntegrityError` on the first such cell
   *     (fail-fast; recommended for CI campaigns expecting real LLM calls).
   *   - `'off'` — no check (replay / deterministic-only / offline analysis).
   */
  expectUsage?: 'assert' | 'warn' | 'off'
  /** Test seam — override the wall clock for deterministic tests. */
  now?: () => Date
  /** Test seam — override per-cell trace writer factory. */
  buildTraceWriter?: (cellId: string, dir: string) => CampaignTraceWriter
  /** Storage backend for run/cell dirs, the resumability cache, artifacts,
   *  and trace spans. Default: the Node filesystem (`fsCampaignStorage`).
   *  Pass `inMemoryCampaignStorage()` to run in a filesystem-less runtime
   *  (Cloudflare Workers, Deno, edge) — the `CampaignResult` is still
   *  produced; artifacts/traces just aren't persisted to disk. */
  storage?: CampaignStorage
  /**
   * Optional per-cell placement strategy. Returns an opaque string the
   * substrate forwards as `ctx.placement` to the Dispatch — placement-aware
   * Dispatches (e.g. `httpDispatch` from `/adapters/http`) use it to route
   * each cell to the right worker, region, or sandbox. When unset, every
   * cell receives `ctx.placement = undefined` and behaves identically to
   * the in-process case.
   *
   * @example
   *   cellPlacement: ({ scenario }) => scenario.tags?.includes('eu') ? 'eu-west' : 'us-east'
   */
  cellPlacement?: (input: {
    scenario: TScenario
    rep: number
    generation?: number
  }) => string | undefined
}

/**
 * Core campaign orchestrator: fan scenarios through dispatch, score with judges, aggregate bootstrap CIs, and persist reproducible `CampaignResult` records.
 */
export async function runCampaign<TScenario extends Scenario, TArtifact>(
  opts: RunCampaignOptions<TScenario, TArtifact>,
): Promise<CampaignResult<TArtifact, TScenario>> {
  const seed = opts.seed ?? 42
  const reps = opts.reps ?? 1
  const resumable = opts.resumable ?? true
  const maxConcurrency = opts.maxConcurrency ?? 2
  const now = opts.now ?? (() => new Date())
  const judges = opts.judges ?? []
  const storage = opts.storage ?? fsCampaignStorage()

  if (typeof opts.runDir !== 'string' || opts.runDir.trim().length === 0) {
    throw new Error('runCampaign: runDir is required and must be a non-empty string')
  }
  opts.runDir = resolveRunDir(opts.runDir, opts.repo)
  storage.ensureDir(opts.runDir)

  const manifestHash = computeManifestHash({
    scenarios: opts.scenarios,
    judges: judges as unknown as JudgeConfig<unknown>[],
    dispatchRef: dispatchRefFor(opts.dispatch, opts.dispatchRef),
    seed,
    reps,
  })

  const startedAt = now()
  const cells: CampaignCellResult<TArtifact>[] = []
  const artifactsByPath: Record<string, string> = {}

  // Build the cell schedule (scenario × rep).
  const schedule = buildCellSchedule(opts.scenarios, seed, reps)

  // Concurrency-limited execution.
  let totalCostUsd = 0
  let costCeilingReached = false
  const abortController = new AbortController()
  // Concurrency lanes that drain the cell schedule. Named "lanes" — not
  // "workers" — to avoid clashing with the taxonomy's worker (= the agent
  // harness in a sandbox, invoked behind `dispatch`). See loop-taxonomy.md.
  const lanes: Promise<void>[] = []
  let nextIdx = 0
  const cellsRef = cells

  for (let i = 0; i < maxConcurrency; i++) {
    lanes.push(
      (async () => {
        while (true) {
          const myIdx = nextIdx++
          if (myIdx >= schedule.length) return
          const slot = schedule[myIdx]!
          if (costCeilingReached) {
            cellsRef.push(skippedCell(slot, 'cost_ceiling_reached'))
            continue
          }
          const result = await executeCell({
            slot,
            opts,
            manifestHash,
            resumable,
            now,
            storage,
            buildTraceWriter: opts.buildTraceWriter ?? defaultBuildTraceWriter(storage),
            signal: abortController.signal,
            dispatchTimeoutMs: opts.dispatchTimeoutMs,
          })
          cellsRef.push(result.cell)
          enforceCellUsage(result.cell, opts.expectUsage ?? 'warn')
          totalCostUsd += result.cell.costUsd
          Object.assign(artifactsByPath, result.artifactsByPath)
          if (opts.costCeiling !== undefined && totalCostUsd >= opts.costCeiling) {
            costCeilingReached = true
          }
          // Capture into LabeledScenarioStore unless explicitly disabled.
          if (opts.labeledStore && opts.labeledStore !== 'off' && !result.cell.error) {
            await captureToStore({
              store: opts.labeledStore,
              cell: result.cell,
              scenario: slot.scenario,
              opts,
              now,
            }).catch((err) => {
              // Capture failures are non-fatal — log but don't crash the campaign.
              // (Trace would normally land here.)
              console.warn(
                `[runCampaign] capture failed for ${result.cell.cellId}: ${err instanceof Error ? err.message : String(err)}`,
              )
            })
          }
        }
      })(),
    )
  }
  await Promise.all(lanes)

  const endedAt = now()
  cellsRef.sort((a, b) => a.cellId.localeCompare(b.cellId))

  const aggregates = computeAggregates(
    cellsRef,
    judges as unknown as JudgeConfig<TArtifact>[],
    seed,
  )

  return {
    manifestHash,
    seed,
    startedAt: startedAt.toISOString(),
    endedAt: endedAt.toISOString(),
    durationMs: endedAt.getTime() - startedAt.getTime(),
    cells: cellsRef,
    aggregates,
    runDir: opts.runDir,
    artifactsByPath,
    scenarios: opts.scenarios.map((s) => ({ id: s.id, kind: s.kind })),
  }
}

// ── Internals ─────────────────────────────────────────────────────────

interface ExecuteCellArgs<TScenario extends Scenario, TArtifact> {
  slot: { scenario: TScenario; rep: number; cellId: string; cellSeed: number }
  opts: RunCampaignOptions<TScenario, TArtifact>
  manifestHash: string
  resumable: boolean
  now: () => Date
  storage: CampaignStorage
  buildTraceWriter: (cellId: string, dir: string) => CampaignTraceWriter
  signal: AbortSignal
  dispatchTimeoutMs?: number
}

async function executeCell<TScenario extends Scenario, TArtifact>(
  args: ExecuteCellArgs<TScenario, TArtifact>,
): Promise<{ cell: CampaignCellResult<TArtifact>; artifactsByPath: Record<string, string> }> {
  const storage = args.storage
  const cellDir = join(args.opts.runDir, args.slot.cellId.replace(/[^a-zA-Z0-9_-]/g, '_'))
  storage.ensureDir(cellDir)

  // Resumability: cache key = (manifestHash, scenarioId, rep)
  const cachePath = join(cellDir, 'cached-result.json')
  if (args.resumable) {
    const cached = readCachedCell<TArtifact>({
      storage,
      cachePath,
      cellId: args.slot.cellId,
      manifestHash: args.manifestHash,
    })
    if (cached.status === 'hit') {
      return { cell: { ...cached.cell, cached: true }, artifactsByPath: {} }
    }
  }

  const startMs = Date.now()
  const trace = args.buildTraceWriter(args.slot.cellId, cellDir)
  const artifactsByPath: Record<string, string> = {}
  const artifacts: CampaignArtifactWriter = {
    async write(path, content) {
      const fullPath = join(cellDir, path)
      storage.ensureDir(join(fullPath, '..'))
      storage.write(fullPath, content)
      artifactsByPath[`${args.slot.cellId}/${path}`] = fullPath
      return fullPath
    },
    async writeJson(path, value) {
      return artifacts.write(path, JSON.stringify(value, null, 2))
    },
  }
  let costSoFar = 0
  const tokensSoFar: CampaignTokenUsage = { input: 0, output: 0 }
  let resolvedModel: string | undefined
  const cost: CampaignCostMeter = {
    observe(amount, source) {
      costSoFar += amount
      trace.span(`cost.${source}`, { amountUsd: amount }).end()
    },
    observeTokens(usage) {
      tokensSoFar.input += usage.input
      tokensSoFar.output += usage.output
      if (usage.cached) tokensSoFar.cached = (tokensSoFar.cached ?? 0) + usage.cached
    },
    observeModel(model) {
      const trimmed = model?.trim()
      if (trimmed) resolvedModel = trimmed
    },
    current() {
      return costSoFar
    },
    tokens() {
      return { ...tokensSoFar }
    },
    resolvedModel() {
      return resolvedModel
    },
  }

  const placement = args.opts.cellPlacement?.({
    scenario: args.slot.scenario,
    rep: args.slot.rep,
  })

  // Per-cell abort signal, chained to the campaign signal. The dispatch sees
  // THIS signal so a timeout (below) can abort just this cell's in-flight work
  // without tearing down sibling cells — and a signal-honoring dispatch
  // releases its open request instead of leaking it past the deadline.
  const cellAbort = new AbortController()
  const onCampaignAbort = () => cellAbort.abort((args.signal as { reason?: unknown }).reason)
  if (args.signal.aborted) cellAbort.abort((args.signal as { reason?: unknown }).reason)
  else args.signal.addEventListener('abort', onCampaignAbort, { once: true })

  const ctx: DispatchContext = {
    cellId: args.slot.cellId,
    rep: args.slot.rep,
    seed: args.slot.cellSeed,
    signal: cellAbort.signal,
    trace,
    artifacts,
    cost,
    placement,
  }

  let artifact: TArtifact | undefined
  let errorMessage: string | undefined
  const timeoutMs = args.dispatchTimeoutMs
  let timeoutTimer: ReturnType<typeof setTimeout> | undefined
  try {
    const dispatched = args.opts.dispatch(args.slot.scenario, ctx)
    if (timeoutMs !== undefined && timeoutMs > 0) {
      // A dispatch that never settles (stalled model request, exhausted runtime
      // resource, a stream that never closes) must NOT hang the cell — and with
      // it the lane, the campaign, the loop, the CI job — forever. Race it
      // against the deadline; on timeout, abort the cell and fail it LOUD.
      artifact = await Promise.race([
        dispatched,
        new Promise<never>((_, reject) => {
          timeoutTimer = setTimeout(() => {
            cellAbort.abort(new Error('dispatch timeout'))
            reject(
              new Error(
                `dispatch exceeded ${timeoutMs}ms for cell '${args.slot.cellId}' — aborted and failed loud (no silent hang)`,
              ),
            )
          }, timeoutMs)
          if (typeof (timeoutTimer as { unref?: () => void }).unref === 'function')
            (timeoutTimer as { unref: () => void }).unref()
        }),
      ])
    } else {
      artifact = await dispatched
    }
  } catch (err) {
    errorMessage = err instanceof Error ? err.message : String(err)
  } finally {
    if (timeoutTimer) clearTimeout(timeoutTimer)
    args.signal.removeEventListener('abort', onCampaignAbort)
  }

  // Run judges (only if we have an artifact). A judge that throws invalidates
  // the cell — recorded as `error`, NOT folded into a fake composite:0 (a fake
  // zero is indistinguishable from a real zero and poisons every aggregate).
  const judgeScores: Record<string, JudgeScore> = {}
  if (artifact !== undefined) {
    for (const judge of args.opts.judges ?? []) {
      if (judge.appliesTo && !judge.appliesTo(args.slot.scenario)) continue
      try {
        judgeScores[judge.name] = await runJudgeCell(judge, {
          artifact,
          scenario: args.slot.scenario,
          signal: args.signal,
        })
      } catch (err) {
        errorMessage = `judge '${judge.name}' failed: ${err instanceof Error ? err.message : String(err)}`
        break
      }
    }
  }

  await trace.flush()

  const cell: CampaignCellResult<TArtifact> = {
    manifestHash: args.manifestHash,
    cellId: args.slot.cellId,
    scenarioId: args.slot.scenario.id,
    rep: args.slot.rep,
    artifact: (artifact ?? null) as TArtifact,
    judgeScores,
    costUsd: costSoFar,
    tokenUsage: { ...tokensSoFar },
    ...(resolvedModel ? { resolvedModel } : {}),
    durationMs: Date.now() - startMs,
    seed: args.slot.cellSeed,
    cached: false,
    error: errorMessage,
  }

  if (!errorMessage && args.resumable) {
    storage.write(cachePath, JSON.stringify(cell))
  }

  return { cell, artifactsByPath }
}

export interface CampaignRunPlanCell {
  cellId: string
  scenarioId: string
  rep: number
  seed: number
  cachePath: string
  status: 'cached' | 'run'
  reason?: 'missing' | 'manifest-mismatch' | 'cell-mismatch' | 'corrupt' | 'resumable-off'
}

export interface CampaignRunPlan {
  manifestHash: string
  totalCells: number
  cellsCached: number
  cellsToRun: number
  cells: CampaignRunPlanCell[]
}

export interface PlanCampaignRunOptions<TScenario extends Scenario, TArtifact> {
  scenarios: TScenario[]
  dispatch?: DispatchFn<TScenario, TArtifact>
  dispatchRef?: string
  judges?: JudgeConfig<TArtifact, TScenario>[]
  seed?: number
  reps?: number
  resumable?: boolean
  runDir: string
  /** Subject repo for the shared run-dir root (see RunCampaignOptions.repo). */
  repo?: string
  storage?: CampaignStorage
}

export function planCampaignRun<TScenario extends Scenario, TArtifact>(
  opts: PlanCampaignRunOptions<TScenario, TArtifact>,
): CampaignRunPlan {
  const seed = opts.seed ?? 42
  const reps = opts.reps ?? 1
  const resumable = opts.resumable ?? true
  const storage = opts.storage ?? fsCampaignStorage()

  if (typeof opts.runDir !== 'string' || opts.runDir.trim().length === 0) {
    throw new Error('planCampaignRun: runDir is required and must be a non-empty string')
  }
  opts.runDir = resolveRunDir(opts.runDir, opts.repo)

  const manifestHash = computeManifestHash({
    scenarios: opts.scenarios,
    judges: (opts.judges ?? []) as unknown as JudgeConfig<unknown>[],
    dispatchRef: dispatchRefFor(opts.dispatch, opts.dispatchRef),
    seed,
    reps,
  })

  const cells = buildCellSchedule(opts.scenarios, seed, reps).map((slot): CampaignRunPlanCell => {
    const cachePath = join(
      opts.runDir,
      slot.cellId.replace(/[^a-zA-Z0-9_-]/g, '_'),
      'cached-result.json',
    )
    if (!resumable) {
      return {
        cellId: slot.cellId,
        scenarioId: slot.scenario.id,
        rep: slot.rep,
        seed: slot.cellSeed,
        cachePath,
        status: 'run',
        reason: 'resumable-off',
      }
    }

    const cached = readCachedCell<unknown>({
      storage,
      cachePath,
      cellId: slot.cellId,
      manifestHash,
    })
    if (cached.status === 'hit') {
      return {
        cellId: slot.cellId,
        scenarioId: slot.scenario.id,
        rep: slot.rep,
        seed: slot.cellSeed,
        cachePath,
        status: 'cached',
      }
    }

    return {
      cellId: slot.cellId,
      scenarioId: slot.scenario.id,
      rep: slot.rep,
      seed: slot.cellSeed,
      cachePath,
      status: 'run',
      reason: cached.reason,
    }
  })

  const cellsCached = cells.filter((cell) => cell.status === 'cached').length
  return {
    manifestHash,
    totalCells: cells.length,
    cellsCached,
    cellsToRun: cells.length - cellsCached,
    cells,
  }
}

/**
 * Per-cell stub guard. A cell that produced an artifact (no error) but reported
 * `costUsd === 0` AND zero tokens means the dispatch never called `ctx.cost` —
 * i.e. it ran against a stub or silently dropped its usage. `'warn'` logs it,
 * `'assert'` throws (fail-fast), `'off'` skips. An errored/skipped cell or a
 * deterministic judge-only run that genuinely made no LLM call is not flagged.
 */
function enforceCellUsage<TArtifact>(
  cell: CampaignCellResult<TArtifact>,
  mode: 'assert' | 'warn' | 'off',
): void {
  if (mode === 'off' || cell.error) return
  if (cell.artifact === null || cell.artifact === undefined) return
  const zeroTokens = cell.tokenUsage.input === 0 && cell.tokenUsage.output === 0
  if (cell.costUsd !== 0 || !zeroTokens) return
  const msg = `cell '${cell.cellId}' produced an artifact but reported zero cost and zero tokens — the dispatch never reported LLM usage via ctx.cost.observe/observeTokens (a stub cell)`
  if (mode === 'assert') {
    const report: BackendIntegrityReport = {
      totalRecords: 1,
      stubRecords: 1,
      realRecords: 0,
      uncostedRecords: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCostUsd: 0,
      verdict: 'stub',
      diagnosis: msg,
    }
    throw new BackendIntegrityError(`expectUsage: ${msg}`, report)
  }
  // eslint-disable-next-line no-console
  console.warn(`[runCampaign] expectUsage: ${msg}`)
}

async function runJudgeCell<TArtifact, TScenario extends Scenario>(
  judge: JudgeConfig<TArtifact, TScenario>,
  input: { artifact: TArtifact; scenario: TScenario; signal: AbortSignal },
): Promise<JudgeScore> {
  return judge.score(input)
}

function defaultBuildTraceWriter(
  storage: CampaignStorage,
): (cellId: string, dir: string) => CampaignTraceWriter {
  return (cellId, dir) => {
    const spans: Array<Record<string, unknown>> = []
    return {
      span(name, attributes) {
        const startMs = Date.now()
        const record: Record<string, unknown> = { name, cellId, startMs, ...(attributes ?? {}) }
        const finish: TraceSpan = {
          end(endAttrs) {
            record.durationMs = Date.now() - startMs
            if (endAttrs) Object.assign(record, endAttrs)
            spans.push(record)
          },
          setAttribute(key, value) {
            record[key] = value
          },
        }
        return finish
      },
      async flush() {
        storage.write(join(dir, 'spans.jsonl'), spans.map((s) => JSON.stringify(s)).join('\n'))
      },
    }
  }
}

function skippedCell<TScenario extends Scenario, TArtifact>(
  slot: { scenario: TScenario; rep: number; cellId: string; cellSeed: number },
  reason: string,
): CampaignCellResult<TArtifact> {
  return {
    cellId: slot.cellId,
    scenarioId: slot.scenario.id,
    rep: slot.rep,
    artifact: null as unknown as TArtifact,
    judgeScores: {},
    costUsd: 0,
    tokenUsage: { input: 0, output: 0 },
    durationMs: 0,
    seed: slot.cellSeed,
    cached: false,
    error: `skipped: ${reason}`,
  }
}

function buildCellSchedule<TScenario extends Scenario>(
  scenarios: TScenario[],
  seed: number,
  reps: number,
): Array<{ scenario: TScenario; rep: number; cellId: string; cellSeed: number }> {
  const schedule: Array<{ scenario: TScenario; rep: number; cellId: string; cellSeed: number }> = []
  let cellIndex = 0
  for (const scenario of scenarios) {
    for (let rep = 0; rep < reps; rep++) {
      const cellId = `${scenario.id}:${rep}`
      const cellSeed = seed + cellIndex
      schedule.push({ scenario, rep, cellId, cellSeed })
      cellIndex += 1
    }
  }
  return schedule
}

function dispatchRefFor<TScenario extends Scenario, TArtifact>(
  dispatch: DispatchFn<TScenario, TArtifact> | undefined,
  override: string | undefined,
): string {
  const ref = override ?? dispatch?.name ?? 'anonymous'
  if (typeof ref !== 'string' || ref.trim().length === 0) {
    throw new Error('runCampaign: dispatchRef must be a non-empty string when provided')
  }
  return ref
}

type CacheRead<TArtifact> =
  | { status: 'hit'; cell: CampaignCellResult<TArtifact> }
  | { status: 'miss'; reason: 'missing' | 'manifest-mismatch' | 'cell-mismatch' | 'corrupt' }

function readCachedCell<TArtifact>(args: {
  storage: CampaignStorage
  cachePath: string
  cellId: string
  manifestHash: string
}): CacheRead<TArtifact> {
  const raw = args.storage.read(args.cachePath)
  if (raw === undefined) return { status: 'miss', reason: 'missing' }

  try {
    const cached = JSON.parse(raw) as CampaignCellResult<TArtifact>
    if (cached.cellId !== args.cellId) return { status: 'miss', reason: 'cell-mismatch' }
    if (cached.manifestHash !== args.manifestHash) {
      return { status: 'miss', reason: 'manifest-mismatch' }
    }
    return { status: 'hit', cell: cached }
  } catch {
    return { status: 'miss', reason: 'corrupt' }
  }
}

interface CaptureArgs<TScenario extends Scenario, TArtifact> {
  store: LabeledScenarioStore
  cell: CampaignCellResult<TArtifact>
  scenario: TScenario
  opts: RunCampaignOptions<TScenario, TArtifact>
  now: () => Date
}

async function captureToStore<TScenario extends Scenario, TArtifact>(
  args: CaptureArgs<TScenario, TArtifact>,
): Promise<void> {
  await args.store.observe({
    scenario: args.scenario,
    artifact: args.cell.artifact,
    judgeScores: args.cell.judgeScores,
    source: args.opts.captureSource ?? 'eval-run',
    sourceVersionHash: args.opts.captureSourceVersionHash ?? 'unknown',
    capturedAt: args.now().toISOString(),
    redactionStatus: 'raw',
  })
}

// ── Aggregates + manifest hash ────────────────────────────────────────

function computeManifestHash(input: {
  scenarios: Scenario[]
  judges: JudgeConfig<unknown>[]
  dispatchRef: string
  seed: number
  reps: number
}): string {
  return contentHash({
    scenarios: input.scenarios,
    judges: input.judges.map((j) => ({ name: j.name, dims: j.dimensions })),
    dispatch: input.dispatchRef,
    seed: input.seed,
    reps: input.reps,
  })
}

function computeAggregates<TArtifact>(
  cells: CampaignCellResult<TArtifact>[],
  judges: JudgeConfig<TArtifact>[],
  seed: number,
): CampaignAggregates {
  const byJudge: Record<string, JudgeAggregate> = {}
  for (const judge of judges) {
    const scores: number[] = []
    for (const cell of cells) {
      const s = cell.judgeScores[judge.name]
      if (s !== undefined) scores.push(s.composite)
    }
    byJudge[judge.name] = aggregate(scores, seed)
  }
  const byScenario: Record<string, ScenarioAggregate> = {}
  const scenarioGroups = new Map<string, number[]>()
  for (const cell of cells) {
    const composites = Object.values(cell.judgeScores).map((s) => s.composite)
    if (composites.length === 0) continue
    const mean = composites.reduce((a, b) => a + b, 0) / composites.length
    const arr = scenarioGroups.get(cell.scenarioId) ?? []
    arr.push(mean)
    scenarioGroups.set(cell.scenarioId, arr)
  }
  for (const [scenarioId, samples] of scenarioGroups) {
    const ag = aggregate(samples, seed)
    byScenario[scenarioId] = { meanComposite: ag.mean, ci95: ag.ci95, n: ag.n }
  }
  return {
    byJudge,
    byScenario,
    totalCostUsd: cells.reduce((a, c) => a + c.costUsd, 0),
    cellsExecuted: cells.filter((c) => !c.error).length,
    cellsSkipped: cells.filter((c) => c.error?.startsWith('skipped:')).length,
    cellsCached: cells.filter((c) => c.cached).length,
    cellsFailed: cells.filter((c) => c.error && !c.error.startsWith('skipped:')).length,
  }
}

// Percentile bootstrap CI95 via seeded resampling. Deterministic for a given
// seed — same campaign re-run produces identical CI bands. Falls back to
// degenerate intervals at n<=1 (the bootstrap is undefined there).
function aggregate(samples: number[], seed: number): JudgeAggregate {
  const n = samples.length
  if (n === 0) return { mean: 0, stdev: 0, ci95: [0, 0], n: 0 }
  const mean = samples.reduce((a, b) => a + b, 0) / n
  const variance = samples.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, n - 1)
  const stdev = Math.sqrt(variance)
  const ci = confidenceInterval(samples, 0.95, { seed, resamples: 1000 })
  return { mean, stdev, ci95: [ci.lower, ci.upper], n }
}
