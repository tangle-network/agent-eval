/**
 * @experimental
 *
 * `runCampaign` — Pass A substrate primitive. ONE function that orchestrates
 * scenarios → dispatch → artifacts → judges → aggregates, with full
 * reproducibility (seed + manifest hash), cell-level resumability, bootstrap
 * CIs, and the `LabeledScenarioStore` capture flywheel.
 *
 * Improvement loops (optimizer / gate / autoOnPromote) ride on top of this
 * primitive but live in `presets/run-improvement-loop.ts`. This file keeps
 * the core orchestrator minimal — Phase 1 of the Pass A track.
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { confidenceInterval } from '../statistics'
import type {
  CampaignAggregates,
  CampaignArtifactWriter,
  CampaignCellResult,
  CampaignCostMeter,
  CampaignResult,
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
  /** Required: where artifacts + traces land. */
  runDir: string
  /** Tracing posture. Default is the substrate's `FileSystemTraceStore` rooted
   *  at `<runDir>/traces/`. `'off'` disables capture entirely — substrate
   *  refuses this when the caller wires `autoOnPromote !== 'none'`. */
  tracing?: 'on' | 'off'
  /** Test seam — override the wall clock for deterministic tests. */
  now?: () => Date
  /** Test seam — override per-cell trace writer factory. */
  buildTraceWriter?: (cellId: string, dir: string) => CampaignTraceWriter
}

export async function runCampaign<TScenario extends Scenario, TArtifact>(
  opts: RunCampaignOptions<TScenario, TArtifact>,
): Promise<CampaignResult<TArtifact, TScenario>> {
  const seed = opts.seed ?? 42
  const reps = opts.reps ?? 1
  const resumable = opts.resumable ?? true
  const maxConcurrency = opts.maxConcurrency ?? 2
  const now = opts.now ?? (() => new Date())
  const judges = opts.judges ?? []

  if (!existsSync(opts.runDir)) mkdirSync(opts.runDir, { recursive: true })

  const manifestHash = computeManifestHash({
    scenarios: opts.scenarios,
    judges: judges as unknown as JudgeConfig<unknown>[],
    dispatchRef: opts.dispatch.name || 'anonymous',
    seed,
    reps,
  })

  const startedAt = now()
  const cells: CampaignCellResult<TArtifact>[] = []
  const artifactsByPath: Record<string, string> = {}

  // Build the cell schedule (scenario × rep).
  const schedule: Array<{ scenario: TScenario; rep: number; cellId: string; cellSeed: number }> = []
  let cellIndex = 0
  for (const scenario of opts.scenarios) {
    for (let rep = 0; rep < reps; rep++) {
      const cellId = `${scenario.id}:${rep}`
      const cellSeed = seed + cellIndex
      schedule.push({ scenario, rep, cellId, cellSeed })
      cellIndex += 1
    }
  }

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
            buildTraceWriter: opts.buildTraceWriter ?? defaultBuildTraceWriter,
            signal: abortController.signal,
          })
          cellsRef.push(result.cell)
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
  buildTraceWriter: (cellId: string, dir: string) => CampaignTraceWriter
  signal: AbortSignal
}

async function executeCell<TScenario extends Scenario, TArtifact>(
  args: ExecuteCellArgs<TScenario, TArtifact>,
): Promise<{ cell: CampaignCellResult<TArtifact>; artifactsByPath: Record<string, string> }> {
  const cellDir = join(args.opts.runDir, args.slot.cellId.replace(/[^a-zA-Z0-9_-]/g, '_'))
  if (!existsSync(cellDir)) mkdirSync(cellDir, { recursive: true })

  // Resumability: cache key = (manifestHash, scenarioId, rep)
  const cachePath = join(cellDir, 'cached-result.json')
  if (args.resumable && existsSync(cachePath)) {
    try {
      const cached = JSON.parse(readFileSync(cachePath, 'utf8')) as CampaignCellResult<TArtifact>
      if (cached.cellId === args.slot.cellId) {
        return { cell: { ...cached, cached: true }, artifactsByPath: {} }
      }
    } catch {
      // Corrupt cache — fall through to re-run.
    }
  }

  const startMs = Date.now()
  const trace = args.buildTraceWriter(args.slot.cellId, cellDir)
  const artifactsByPath: Record<string, string> = {}
  const artifacts: CampaignArtifactWriter = {
    async write(path, content) {
      const fullPath = join(cellDir, path)
      const dir = join(fullPath, '..')
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
      writeFileSync(fullPath, content as Uint8Array)
      artifactsByPath[`${args.slot.cellId}/${path}`] = fullPath
      return fullPath
    },
    async writeJson(path, value) {
      return artifacts.write(path, JSON.stringify(value, null, 2))
    },
  }
  let costSoFar = 0
  const cost: CampaignCostMeter = {
    observe(amount, source) {
      costSoFar += amount
      trace.span(`cost.${source}`, { amountUsd: amount }).end()
    },
    current() {
      return costSoFar
    },
  }

  const ctx: DispatchContext = {
    cellId: args.slot.cellId,
    rep: args.slot.rep,
    seed: args.slot.cellSeed,
    signal: args.signal,
    trace,
    artifacts,
    cost,
  }

  let artifact: TArtifact | undefined
  let errorMessage: string | undefined
  try {
    artifact = await args.opts.dispatch(args.slot.scenario, ctx)
  } catch (err) {
    errorMessage = err instanceof Error ? err.message : String(err)
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
    cellId: args.slot.cellId,
    scenarioId: args.slot.scenario.id,
    rep: args.slot.rep,
    artifact: (artifact ?? null) as TArtifact,
    judgeScores,
    costUsd: costSoFar,
    durationMs: Date.now() - startMs,
    seed: args.slot.cellSeed,
    cached: false,
    error: errorMessage,
  }

  if (!errorMessage && args.resumable) {
    writeFileSync(cachePath, JSON.stringify(cell))
  }

  return { cell, artifactsByPath }
}

async function runJudgeCell<TArtifact, TScenario extends Scenario>(
  judge: JudgeConfig<TArtifact, TScenario>,
  input: { artifact: TArtifact; scenario: TScenario; signal: AbortSignal },
): Promise<JudgeScore> {
  return judge.score(input)
}

function defaultBuildTraceWriter(cellId: string, dir: string): CampaignTraceWriter {
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
      const path = join(dir, 'spans.jsonl')
      writeFileSync(path, spans.map((s) => JSON.stringify(s)).join('\n'))
    },
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
    durationMs: 0,
    seed: slot.cellSeed,
    cached: false,
    error: `skipped: ${reason}`,
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
  const canonical = {
    scenarios: input.scenarios.map((s) => ({ id: s.id, kind: s.kind })),
    judges: input.judges.map((j) => ({ name: j.name, dims: j.dimensions.map((d) => d.key) })),
    dispatch: input.dispatchRef,
    seed: input.seed,
    reps: input.reps,
  }
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex')
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
