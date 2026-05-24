/**
 * N-axis cartesian runner.
 *
 * Expansion order: cartesian over `axes` in declared order, then `reps` as the
 * inner-most dim → `ordinal = (cartIdx * reps) + rep`. The returned
 * `cells[]` is sorted by `ordinal` so concurrent execution does not reorder
 * the output.
 *
 * Scheduling is a sliding window of in-flight promises capped at
 * `maxConcurrency`. The window stops admitting new cells when the cost
 * ceiling trips or the abort signal fires; in-flight cells finish.
 */

import { buildByAxis } from './aggregation'
import type {
  CellResult,
  MatrixAxis,
  MatrixCell,
  MatrixResult,
  RunAgentMatrixOptions,
} from './types'

interface BaseCell {
  axes: Record<string, { id: string; value: unknown }>
}

function cartesian(axes: MatrixAxis<unknown>[]): BaseCell[] {
  // Empty axes (`values=[]`) collapse the whole product to zero cells. An
  // empty `axes` array yields a single empty-axes cell — degenerate but
  // valid (caller is iterating only reps).
  if (axes.length === 0) return [{ axes: {} }]
  for (const a of axes) if (a.values.length === 0) return []
  const out: BaseCell[] = []
  const idx = new Array(axes.length).fill(0)
  while (true) {
    const slot: Record<string, { id: string; value: unknown }> = {}
    for (let i = 0; i < axes.length; i++) {
      const axis = axes[i] as MatrixAxis<unknown>
      const v = axis.values[idx[i] as number] as { id: string; value: unknown }
      slot[axis.name] = { id: v.id, value: v.value }
    }
    out.push({ axes: slot })
    // Increment like an odometer, left-most axis is fastest.
    let i = 0
    while (i < axes.length) {
      const next = (idx[i] as number) + 1
      const axis = axes[i] as MatrixAxis<unknown>
      if (next < axis.values.length) {
        idx[i] = next
        break
      }
      idx[i] = 0
      i++
    }
    if (i === axes.length) break
  }
  return out
}

function makeMatrixId(): string {
  // Stable id-like string: time + 8 random hex chars. Avoids node:crypto
  // import to keep the matrix dep-free.
  const t = Date.now().toString(36)
  let r = ''
  for (let i = 0; i < 8; i++) r += Math.floor(Math.random() * 16).toString(16)
  return `mtx_${t}_${r}`
}

function makeErrorResult<Output>(err: unknown): CellResult<Output> {
  const e = err as { message?: string; name?: string }
  return {
    output: undefined as unknown as Output,
    verdict: { valid: false, score: 0 },
    costUsd: 0,
    durationMs: 0,
    error: {
      message: typeof e?.message === 'string' ? e.message : String(err),
      kind: typeof e?.name === 'string' ? e.name : 'Error',
    },
  }
}

export async function runAgentMatrix<Output>(
  opts: RunAgentMatrixOptions<Output>,
): Promise<MatrixResult<Output>> {
  const startedAt = Date.now()
  const reps = Math.max(1, opts.reps ?? 1)
  const maxConcurrency = Math.max(1, opts.maxConcurrency ?? 4)
  const costCeiling = opts.costCeiling ?? Number.POSITIVE_INFINITY
  const aggregateBy = opts.aggregateBy ?? opts.axes.map((a) => a.name)

  const base = cartesian(opts.axes)
  const filtered = opts.filter
    ? base.filter((c) => (opts.filter as (b: BaseCell) => boolean)(c))
    : base
  const filteredOut = base.length - filtered.length

  const planned: MatrixCell[] = []
  for (let i = 0; i < filtered.length; i++) {
    for (let r = 0; r < reps; r++) {
      planned.push({
        axes: (filtered[i] as BaseCell).axes,
        rep: r,
        ordinal: i * reps + r,
      })
    }
  }

  const cellRecords: Array<{ cell: MatrixCell; runs: CellResult<Output>[] }> = []
  let cumulativeCost = 0
  let costCeilingReached = false
  let runsExecuted = 0
  let cellsUnscheduled = 0

  const aborted = (): boolean => opts.signal?.aborted === true

  // Per-run abort controller forwards the external signal so cell executors
  // see cancellation. We don't expose it on `MatrixCell` — the signature on
  // `runCell` per the public API is `(cell) => Promise<...>`. Executors that
  // need cancellation use the external signal directly via closure.

  let inFlight = 0
  let cursor = 0
  let resolveAll: (() => void) | undefined
  const done = new Promise<void>((res) => {
    resolveAll = res
  })

  const pump = (): void => {
    while (inFlight < maxConcurrency && cursor < planned.length) {
      if (aborted() || costCeilingReached) {
        // Drain remaining as unscheduled.
        const left = planned.length - cursor
        cellsUnscheduled += left
        cursor = planned.length
        break
      }
      const cell = planned[cursor++] as MatrixCell
      inFlight++
      // Lazily allocate the record so cells appear in `cells[]` in any
      // arrival order; we sort by ordinal at the end.
      const record = { cell, runs: [] as CellResult<Output>[] }
      cellRecords.push(record)
      const promise: Promise<CellResult<Output>> = (async () => {
        try {
          return await opts.runCell(cell)
        } catch (err) {
          return makeErrorResult<Output>(err)
        }
      })()
      promise.then((result) => {
        record.runs.push(result)
        runsExecuted++
        cumulativeCost += result.costUsd
        if (cumulativeCost >= costCeiling && !costCeilingReached) {
          costCeilingReached = true
          // eslint-disable-next-line no-console
          console.warn('[matrix] cost ceiling reached')
        }
        try {
          opts.onCellComplete?.(cell, result)
        } catch {
          // onCellComplete is observational — swallow throws so a noisy
          // callback can't tank the run.
        }
        inFlight--
        if (cursor < planned.length) {
          pump()
        } else if (inFlight === 0) {
          resolveAll?.()
        }
      })
    }
    if (cursor >= planned.length && inFlight === 0) resolveAll?.()
  }

  const onAbort = (): void => {
    // External abort: stop scheduling. In-flight cells finish; their
    // executors observe `opts.signal.aborted` directly via closure.
    if (cursor < planned.length) {
      cellsUnscheduled += planned.length - cursor
      cursor = planned.length
    }
    if (inFlight === 0) resolveAll?.()
  }
  if (opts.signal) {
    if (opts.signal.aborted) {
      cellsUnscheduled = planned.length
      cursor = planned.length
      resolveAll?.()
    } else {
      opts.signal.addEventListener('abort', onAbort, { once: true })
    }
  }

  if (planned.length === 0) {
    resolveAll?.()
  } else {
    pump()
  }

  await done
  if (opts.signal) opts.signal.removeEventListener('abort', onAbort)

  cellRecords.sort((a, b) => a.cell.ordinal - b.cell.ordinal)

  let pass = 0
  let scoreSum = 0
  let totalCost = 0
  let runCount = 0
  for (const { runs } of cellRecords) {
    for (const r of runs) {
      runCount++
      const errored = r.error !== undefined
      if (!errored && r.verdict.valid) pass++
      scoreSum += errored ? 0 : r.verdict.score
      totalCost += r.costUsd
    }
  }

  const byAxis = buildByAxis(cellRecords, opts.axes, aggregateBy)

  return {
    cells: cellRecords,
    byAxis,
    summary: {
      totalCells: planned.length,
      runsExecuted,
      cellsSkipped: cellsUnscheduled + filteredOut * reps,
      overallPassRate: runCount === 0 ? 0 : pass / runCount,
      overallMeanScore: runCount === 0 ? 0 : scoreSum / runCount,
      totalCostUsd: totalCost,
      durationMs: Date.now() - startedAt,
    },
    matrixId: makeMatrixId(),
  }
}
