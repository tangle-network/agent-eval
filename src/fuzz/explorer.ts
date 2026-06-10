/**
 * The exploration engine — a stateful session over a behavior space.
 *
 * Each `step()`: allocate budget across INPUT cells (floor first, then variance
 * steering toward the least-certain cells), propose candidates (the proposer
 * reads current elites + findings, so the search deepens generationally),
 * evaluate with bounded concurrency, archive the most interesting scenario per
 * input×measured bin, and admit notable candidates that pass the validity gates.
 * `run()` loops to budget. `coverage()`/`findings()`/`capsule()` read live state —
 * the surface `makeExploreTools` exposes so an agent can drive the session.
 *
 * One evaluation log (`EvalRecord[]`) is the source of truth; allocation
 * observations and coverage are projections of it.
 */

import { varianceBasedCurriculum } from '../rl/active-curriculum'
import { buildCapsule } from './capsule'
import type { EvalRecord } from './cube'
import { enumerateCells } from './cube'
import { adversarialObjective } from './policies'
import type {
  ArchiveEntry,
  CapsuleData,
  Cell,
  CoverageCell,
  ExploreOptions,
  Finding,
  Objective,
} from './types'

async function pMap<T>(
  items: T[],
  fn: (item: T) => Promise<void>,
  concurrency: number,
  signal?: AbortSignal,
): Promise<void> {
  let i = 0
  const workers = Array.from(
    { length: Math.max(1, Math.min(concurrency, items.length)) },
    async () => {
      while (i < items.length) {
        if (signal?.aborted) return
        const item = items[i++]
        if (item === undefined) return
        await fn(item)
      }
    },
  )
  await Promise.all(workers)
}

export class BehaviorExplorer<S> {
  private readonly cells: Cell[]
  private readonly cellById: Map<string, Cell>
  private readonly objective: Objective
  private readonly threshold: number
  private readonly floorPerCell: number
  private readonly perRoundBudget: number

  /** The single evaluation log — coverage + allocation are projections of it. */
  private readonly log: Array<EvalRecord & { scenarioId: string }> = []
  /** binId (input × measured coords) → the most interesting entry seen. */
  private readonly archiveByBin = new Map<string, ArchiveEntry<S>>()
  private readonly _findings: Finding<S>[] = []
  private runsUsed = 0
  private candidateFindings = 0
  private rngState: number

  constructor(private readonly opts: ExploreOptions<S>) {
    this.cells = enumerateCells(opts.space)
    if (this.cells.length === 0)
      throw new Error('BehaviorExplorer: space has no cells — every axis needs ≥1 value')
    this.cellById = new Map(this.cells.map((c) => [c.id, c]))
    this.objective = opts.objective ?? adversarialObjective(0.5)
    this.threshold = this.objective.threshold ?? 0.5
    this.floorPerCell = opts.floorPerCell ?? 2
    this.perRoundBudget = Math.max(
      this.cells.length * this.floorPerCell,
      Math.ceil(opts.budget / 4),
    )
    this.rngState = (opts.seed ?? 1) >>> 0
  }

  // mulberry32 — deterministic per session.
  private rng = (): number => {
    this.rngState = (this.rngState + 0x6d2b79f5) | 0
    let t = this.rngState
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }

  private binId(cell: Cell, descriptor: Record<string, string> | undefined): string {
    if (!descriptor || Object.keys(descriptor).length === 0) return cell.id
    const measured = Object.keys(descriptor)
      .sort()
      .map((k) => `${k}=${descriptor[k]}`)
      .join('|')
    return `${cell.id}|${measured}`
  }

  private allocate(budget: number): Array<{ cellId: string; count: number }> {
    if ((this.opts.allocation ?? 'variance') === 'uniform') {
      const per = Math.max(this.floorPerCell, Math.floor(budget / this.cells.length))
      return this.cells.map((c) => ({ cellId: c.id, count: per }))
    }
    return varianceBasedCurriculum(
      this.log.map((r) => ({
        variantId: r.cell.id,
        scenarioId: r.scenarioId,
        score: r.ev.score,
        pass: r.ev.valid && r.ev.score >= 0.5,
      })),
      this.cells.map((c) => ({ variantId: c.id, scenarioId: '*' })),
      { budget, floorPerCell: this.floorPerCell },
    ).map((a) => ({ cellId: a.variantId, count: a.count }))
  }

  private objectiveContext() {
    const entries = [...this.archiveByBin.values()]
    return {
      archiveScores: entries.map((e) => e.evaluation.score),
      archiveDescriptors: entries.map((e) => e.evaluation.descriptor),
    }
  }

  /** Elites whose INPUT cell matches — what the proposer mutates/deepens from. */
  private elitesFor(cellId: string): S[] {
    const out: S[] = []
    for (const e of this.archiveByBin.values()) if (e.cell.id === cellId) out.push(e.scenario)
    return out
  }

  /** One allocate → propose → evaluate → gate → archive round. */
  async step(): Promise<{ runs: number; findings: Finding<S>[] }> {
    const remaining = this.opts.budget - this.runsUsed
    if (remaining <= 0 || this.opts.signal?.aborted) return { runs: 0, findings: [] }

    const allocations = this.allocate(Math.min(this.perRoundBudget, remaining))
    const newFindings: Finding<S>[] = []
    let runsThisStep = 0

    for (const alloc of allocations) {
      if (this.runsUsed >= this.opts.budget || this.opts.signal?.aborted) break
      const cell = this.cellById.get(alloc.cellId)
      if (!cell) continue
      const cap = Math.min(alloc.count, this.opts.budget - this.runsUsed)
      if (cap <= 0) continue
      this.opts.onProgress?.({ type: 'cell-allocated', cell, count: cap })

      const seeds = await this.opts.seedsFor(cell)
      const elites = this.elitesFor(cell.id)
      const proposed = await this.opts.proposer({
        cell,
        seeds,
        elites,
        findings: this._findings,
        count: cap,
        rng: this.rng,
      })
      // Cold cells evaluate their seeds first (the coverage floor); warm cells
      // trust the proposer, which already saw the elites.
      const cold = this.log.every((r) => r.cell.id !== cell.id)
      const toEval = [...(cold ? seeds : []), ...proposed].slice(0, cap)

      await pMap(
        toEval,
        async (scenario) => {
          if (this.runsUsed >= this.opts.budget || this.opts.signal?.aborted) return
          const ev = await this.opts.evaluate(scenario, cell)
          this.runsUsed++
          runsThisStep++
          const interest = this.objective.interest(ev, this.objectiveContext())
          this.log.push({ cell, ev, interest, scenarioId: this.opts.scenarioId(scenario) })
          this.opts.onProgress?.({ type: 'evaluated', cell, scenario, evaluation: ev })

          const bin = this.binId(cell, ev.descriptor)
          const cur = this.archiveByBin.get(bin)
          if (!cur || interest > cur.interest)
            this.archiveByBin.set(bin, { binId: bin, cell, scenario, evaluation: ev, interest })

          if (interest < this.threshold) return
          this.candidateFindings++
          if (this.opts.gates?.isValid && !(await this.opts.gates.isValid(scenario, ev, cell)))
            return
          if (
            this.opts.gates?.isUncontaminated &&
            !(await this.opts.gates.isUncontaminated(scenario, ev, cell))
          )
            return

          const minimized = this.opts.minimize
            ? await this.opts.minimize(scenario, this.opts.evaluate, cell)
            : scenario
          const finding: Finding<S> = {
            id: this.opts.scenarioId(scenario),
            cell,
            scenario,
            minimized,
            text: this.opts.scenarioText?.(minimized),
            evaluation: ev,
            interest,
            objective: this.objective.kind,
          }
          this._findings.push(finding)
          newFindings.push(finding)
          this.opts.onProgress?.({ type: 'finding', finding })
        },
        this.opts.concurrency ?? 1,
        this.opts.signal,
      )
    }

    this.opts.onProgress?.({ type: 'round', runsUsed: this.runsUsed, budget: this.opts.budget })
    return { runs: runsThisStep, findings: newFindings }
  }

  /** Loop `step()` until budget is spent, the signal aborts, or no progress is made. */
  async run(): Promise<CapsuleData<S>> {
    while (this.runsUsed < this.opts.budget && !this.opts.signal?.aborted) {
      const { runs } = await this.step()
      if (runs === 0) break
    }
    return this.capsule()
  }

  coverage(): CoverageCell[] {
    return this.capsule().coverage
  }

  findings(): Finding<S>[] {
    return [...this._findings].sort((a, b) => b.interest - a.interest)
  }

  capsule(): CapsuleData<S> {
    return buildCapsule({
      target: this.opts.target,
      objective: this.objective.kind,
      cells: this.cells,
      log: this.log,
      threshold: this.threshold,
      archive: [...this.archiveByBin.values()],
      findings: this._findings,
      candidateFindings: this.candidateFindings,
      runsUsed: this.runsUsed,
    })
  }
}
