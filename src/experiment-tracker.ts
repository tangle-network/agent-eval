/**
 * Experiment tracker — git-provenanced experiment log with N-rep stats and a
 * KEEP / REGRESSION / NOISE verdict against a parent.
 *
 * Every loop the fleet runs reduces to the same question: "I ran the candidate
 * N times — is the median measurably better than the parent, or is the delta
 * inside the noise band?" The hand-rolled copies bake a fixed score scale
 * (percentage points), a fixed store path (`.evolve/experiments-v2.json`), and
 * `execSync('git …')` straight into the module. This is the canonical version:
 * provenance and persistence are injected, thresholds are configurable, and the
 * stats + verdict are pure functions you can unit-test without a git repo or a
 * filesystem.
 *
 * Stats per experiment: median / mean / min / max / iqr / stddev / passRate /
 * n, plus a `stable` flag (`iqr < iqrUnstableAbove && stddev < stddevUnstableAbove`).
 *
 * Verdict against a parent (both must have `n >= minRepsForVerdict`):
 *   - NOISE       — the candidate is too unstable to judge (`!stable`)
 *   - KEEP        — `medianDelta >  keepThreshold`
 *   - REGRESSION  — `medianDelta < -regressionThreshold`
 *   - NOISE       — otherwise (delta inside the band)
 * With no parent (or insufficient reps) the verdict is the neutral ITERATE.
 */

import { execSync } from 'node:child_process'
import { iqr } from './baseline'
import { ValidationError } from './errors'

/** Verdict for one experiment relative to its parent. ITERATE is the neutral
 *  "keep collecting reps / no parent to compare against" state. */
export type ExperimentVerdict = 'KEEP' | 'ITERATE' | 'NOISE' | 'REGRESSION'

/** Git provenance for the working tree an experiment was run from. */
export interface ExperimentProvenance {
  /** Commit sha (short or full — the tracker does not interpret it). */
  commit: string
  /** First line of the commit message. */
  message: string
  /** Files changed vs the parent commit, or a marker like 'uncommitted'. */
  changedFiles: string[]
}

/** A single repetition of an experiment, carrying the score the verdict is
 *  computed on plus any free-form per-rep metrics the consumer wants kept. */
export interface ExperimentRep {
  /** 0-indexed repetition number within the experiment. */
  rep: number
  /** The score this rep is judged on (same scale as the thresholds). */
  score: number
  /** ISO timestamp the rep completed. */
  timestamp: string
  /** Whether this rep passed the consumer's own gate — folded into `passRate`. */
  passed?: boolean
  /** Free-form numeric metrics retained for later analysis. */
  metrics?: Record<string, number>
}

export interface ExperimentStats {
  median: number
  mean: number
  min: number
  max: number
  /** Inter-quartile range of the rep scores. */
  iqr: number
  /** Population standard deviation of the rep scores. */
  stddev: number
  /** Fraction of reps with `passed === true`, over reps that set `passed`.
   *  null when no rep declared a pass/fail outcome. */
  passRate: number | null
  /** Number of reps. */
  n: number
  /** True when the sample is tight enough to trust for a verdict. */
  stable: boolean
}

export interface Experiment {
  /** Stable id for the experiment. */
  id: string
  /** Free-form label / config descriptor. */
  label: string
  /** Git provenance captured when the experiment was created. */
  provenance: ExperimentProvenance
  /** Parent experiment id this candidate is compared against, if any. */
  parentId?: string
  /** One-line summary of what changed from the parent. */
  changeSummary: string
  reps: ExperimentRep[]
  stats: ExperimentStats
  verdict: ExperimentVerdict
  /** ISO timestamp the experiment was created. */
  createdAt: string
}

export interface ImprovementThresholds {
  /** medianDelta strictly above this ⇒ KEEP. Default 5. */
  keepThreshold?: number
  /** medianDelta strictly below the negative of this ⇒ REGRESSION. Default 5. */
  regressionThreshold?: number
  /** iqr at or above this ⇒ unstable. Default 10. */
  iqrUnstableAbove?: number
  /** stddev at or above this ⇒ unstable. Default Infinity (iqr-only stability). */
  stddevUnstableAbove?: number
  /** Reps required on BOTH candidate and parent before a verdict is rendered.
   *  Default 3. */
  minRepsForVerdict?: number
}

export interface ImprovementVerdictResult {
  verdict: ExperimentVerdict
  /** candidate.median − parent.median; null when no parent or insufficient reps. */
  medianDelta: number | null
  /** Human-readable reason for the verdict — for dashboards and logs. */
  reason: string
}

const DEFAULTS: Required<ImprovementThresholds> = {
  keepThreshold: 5,
  regressionThreshold: 5,
  iqrUnstableAbove: 10,
  stddevUnstableAbove: Number.POSITIVE_INFINITY,
  minRepsForVerdict: 3,
}

function resolveThresholds(t: ImprovementThresholds | undefined): Required<ImprovementThresholds> {
  const r = { ...DEFAULTS, ...(t ?? {}) }
  if (r.keepThreshold < 0) {
    throw new ValidationError(
      `experiment-tracker: keepThreshold must be >= 0, got ${r.keepThreshold}`,
    )
  }
  if (r.regressionThreshold < 0) {
    throw new ValidationError(
      `experiment-tracker: regressionThreshold must be >= 0, got ${r.regressionThreshold}`,
    )
  }
  if (r.minRepsForVerdict < 1) {
    throw new ValidationError(
      `experiment-tracker: minRepsForVerdict must be >= 1, got ${r.minRepsForVerdict}`,
    )
  }
  return r
}

function median(sorted: number[]): number {
  const n = sorted.length
  if (n === 0) return 0
  const mid = Math.floor(n / 2)
  return n % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!
}

/** Population standard deviation (÷n). 0 for fewer than 2 values. */
function stddev(values: number[], mean: number): number {
  if (values.length < 2) return 0
  const variance = values.reduce((acc, v) => acc + (v - mean) ** 2, 0) / values.length
  return Math.sqrt(variance)
}

/**
 * Compute the N-rep statistics for a set of reps. Pure — no I/O. The `stable`
 * flag is the trust gate the verdict depends on: a sample whose spread exceeds
 * the configured bounds can't distinguish a real delta from run-to-run noise.
 */
export function computeExperimentStats(
  reps: ExperimentRep[],
  thresholds?: ImprovementThresholds,
): ExperimentStats {
  const t = resolveThresholds(thresholds)
  const n = reps.length
  if (n === 0) {
    return {
      median: 0,
      mean: 0,
      min: 0,
      max: 0,
      iqr: 0,
      stddev: 0,
      passRate: null,
      n: 0,
      stable: false,
    }
  }
  const scores = reps.map((r) => {
    if (!Number.isFinite(r.score)) {
      throw new ValidationError(`experiment-tracker: rep ${r.rep} has non-finite score ${r.score}`)
    }
    return r.score
  })
  const sorted = [...scores].sort((a, b) => a - b)
  const mean = scores.reduce((s, v) => s + v, 0) / n
  const sd = stddev(scores, mean)
  const spread = iqr(scores)
  const rated = reps.filter((r) => typeof r.passed === 'boolean')
  const passRate = rated.length === 0 ? null : rated.filter((r) => r.passed).length / rated.length
  const stable = spread < t.iqrUnstableAbove && sd < t.stddevUnstableAbove
  return {
    median: median(sorted),
    mean,
    min: sorted[0]!,
    max: sorted[n - 1]!,
    iqr: spread,
    stddev: sd,
    passRate,
    n,
    stable,
  }
}

/**
 * Verdict for a candidate against its parent. Pure — operates on already-computed
 * stats. KEEP/REGRESSION require both sides to have `>= minRepsForVerdict` reps
 * AND the candidate to be `stable`; otherwise the result is NOISE (unstable) or
 * ITERATE (not enough reps / no parent).
 */
export function improvementVerdict(
  candidate: ExperimentStats,
  parent: ExperimentStats | null,
  thresholds?: ImprovementThresholds,
): ImprovementVerdictResult {
  const t = resolveThresholds(thresholds)
  if (!parent) {
    return {
      verdict: 'ITERATE',
      medianDelta: null,
      reason: 'no parent experiment to compare against',
    }
  }
  if (candidate.n < t.minRepsForVerdict || parent.n < t.minRepsForVerdict) {
    return {
      verdict: 'ITERATE',
      medianDelta: null,
      reason: `need >= ${t.minRepsForVerdict} reps on both sides (candidate n=${candidate.n}, parent n=${parent.n})`,
    }
  }
  if (!candidate.stable) {
    return {
      verdict: 'NOISE',
      medianDelta: candidate.median - parent.median,
      reason: `candidate unstable (iqr=${candidate.iqr}, stddev=${candidate.stddev.toFixed(2)})`,
    }
  }
  const medianDelta = candidate.median - parent.median
  if (medianDelta > t.keepThreshold) {
    return { verdict: 'KEEP', medianDelta, reason: `median +${medianDelta} > +${t.keepThreshold}` }
  }
  if (medianDelta < -t.regressionThreshold) {
    return {
      verdict: 'REGRESSION',
      medianDelta,
      reason: `median ${medianDelta} < -${t.regressionThreshold}`,
    }
  }
  return {
    verdict: 'NOISE',
    medianDelta,
    reason: `median delta ${medianDelta} inside noise band [-${t.regressionThreshold}, +${t.keepThreshold}]`,
  }
}

// ── Provenance + persistence seams ───────────────────────────────────

/** Reads git provenance for the working tree. Inject a fake in tests; the
 *  default implementation shells out to `git`. */
export type ProvenanceReader = () => ExperimentProvenance | Promise<ExperimentProvenance>

/** Persistence seam for the experiment log. Inject in-memory in tests; the
 *  filesystem implementation is `fileExperimentStore`. */
export interface ExperimentStore {
  load(): Promise<Experiment[]>
  save(experiments: Experiment[]): Promise<void>
}

/**
 * Default provenance reader: `git rev-parse HEAD`, the subject line, and the
 * files changed vs `HEAD~1`. Fail-loud — a tracker that silently logs
 * `commit: 'unknown'` corrupts the provenance the whole point of the log is to
 * carry. When the working tree genuinely has no parent commit, pass an override.
 */
export const gitProvenanceReader: ProvenanceReader = () => {
  const run = (cmd: string): string => execSync(cmd, { encoding: 'utf8' }).trim()
  const commit = run('git rev-parse --short HEAD')
  const message = run('git log -1 --format=%s')
  const changedRaw = run('git diff --name-only HEAD~1')
  const changedFiles = changedRaw.length === 0 ? [] : changedRaw.split('\n').filter(Boolean)
  return { commit, message, changedFiles }
}

/** In-memory store — the default when no persistence is wanted (tests, ephemeral
 *  runs). State lives on the instance. */
export function inMemoryExperimentStore(initial: Experiment[] = []): ExperimentStore {
  let state = initial.map((e) => structuredClone(e))
  return {
    async load() {
      return state.map((e) => structuredClone(e))
    },
    async save(experiments) {
      state = experiments.map((e) => structuredClone(e))
    },
  }
}

/** Filesystem store — a single JSON array at `path`, created on first save. */
export function fileExperimentStore(path: string): ExperimentStore {
  return {
    async load() {
      const fs = await import('node:fs/promises')
      try {
        const raw = await fs.readFile(path, 'utf8')
        const parsed = JSON.parse(raw)
        if (!Array.isArray(parsed)) {
          throw new ValidationError(`experiment-tracker: store at ${path} is not a JSON array`)
        }
        return parsed as Experiment[]
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
        throw err
      }
    },
    async save(experiments) {
      const fs = await import('node:fs/promises')
      const pathMod = await import('node:path')
      await fs.mkdir(pathMod.dirname(path), { recursive: true })
      await fs.writeFile(path, JSON.stringify(experiments, null, 2), 'utf8')
    },
  }
}

export interface ExperimentTrackerOptions {
  store?: ExperimentStore
  provenanceReader?: ProvenanceReader
  thresholds?: ImprovementThresholds
  /** Clock seam for deterministic timestamps in tests. Default `Date.now`. */
  now?: () => number
}

export interface CreateExperimentInput {
  id: string
  label: string
  changeSummary: string
  parentId?: string
  /** Override provenance instead of reading from git (e.g. CI metadata). */
  provenance?: ExperimentProvenance
}

/**
 * Stateful tracker over an `ExperimentStore`. Create an experiment (provenance
 * is captured once), append reps as they complete (stats + verdict recompute on
 * every append), and read the log back for a dashboard. All persistence and git
 * access flow through the injected seams, so the tracker is fully testable
 * without a repo or disk.
 */
export class ExperimentTracker {
  private readonly store: ExperimentStore
  private readonly provenanceReader: ProvenanceReader
  private readonly thresholds: Required<ImprovementThresholds>
  private readonly now: () => number

  constructor(options: ExperimentTrackerOptions = {}) {
    this.store = options.store ?? inMemoryExperimentStore()
    this.provenanceReader = options.provenanceReader ?? gitProvenanceReader
    this.thresholds = resolveThresholds(options.thresholds)
    this.now = options.now ?? Date.now
  }

  async create(input: CreateExperimentInput): Promise<Experiment> {
    const experiments = await this.store.load()
    if (experiments.some((e) => e.id === input.id)) {
      throw new ValidationError(`experiment-tracker: experiment id "${input.id}" already exists`)
    }
    if (input.parentId && !experiments.some((e) => e.id === input.parentId)) {
      throw new ValidationError(
        `experiment-tracker: parent experiment "${input.parentId}" not found`,
      )
    }
    const provenance = input.provenance ?? (await this.provenanceReader())
    const experiment: Experiment = {
      id: input.id,
      label: input.label,
      provenance,
      parentId: input.parentId,
      changeSummary: input.changeSummary,
      reps: [],
      stats: computeExperimentStats([], this.thresholds),
      verdict: 'ITERATE',
      createdAt: new Date(this.now()).toISOString(),
    }
    experiments.push(experiment)
    await this.store.save(experiments)
    return structuredClone(experiment)
  }

  /** Append a rep (its `rep` index defaults to the current rep count) and
   *  recompute stats + verdict. Returns the updated experiment. */
  async addRep(
    experimentId: string,
    rep: Omit<ExperimentRep, 'rep' | 'timestamp'> & { rep?: number; timestamp?: string },
  ): Promise<Experiment> {
    const experiments = await this.store.load()
    const exp = experiments.find((e) => e.id === experimentId)
    if (!exp)
      throw new ValidationError(`experiment-tracker: experiment "${experimentId}" not found`)
    const fullRep: ExperimentRep = {
      rep: rep.rep ?? exp.reps.length,
      score: rep.score,
      passed: rep.passed,
      metrics: rep.metrics,
      timestamp: rep.timestamp ?? new Date(this.now()).toISOString(),
    }
    exp.reps.push(fullRep)
    exp.stats = computeExperimentStats(exp.reps, this.thresholds)
    const parent = exp.parentId ? experiments.find((e) => e.id === exp.parentId) : undefined
    exp.verdict = improvementVerdict(exp.stats, parent?.stats ?? null, this.thresholds).verdict
    await this.store.save(experiments)
    return structuredClone(exp)
  }

  async get(experimentId: string): Promise<Experiment | undefined> {
    const experiments = await this.store.load()
    const found = experiments.find((e) => e.id === experimentId)
    return found ? structuredClone(found) : undefined
  }

  async list(): Promise<Experiment[]> {
    return this.store.load()
  }

  /** Full verdict (not just the enum) for an experiment vs its parent. */
  async verdictFor(experimentId: string): Promise<ImprovementVerdictResult> {
    const experiments = await this.store.load()
    const exp = experiments.find((e) => e.id === experimentId)
    if (!exp)
      throw new ValidationError(`experiment-tracker: experiment "${experimentId}" not found`)
    const parent = exp.parentId ? experiments.find((e) => e.id === exp.parentId) : undefined
    return improvementVerdict(exp.stats, parent?.stats ?? null, this.thresholds)
  }
}
