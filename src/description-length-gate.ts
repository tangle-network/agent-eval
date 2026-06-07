import { gzipSync } from 'node:zlib'
import type { RunRecord } from './run-record'

/**
 * DescriptionLengthGate — a Minimum-Description-Length promotion gate, the
 * Builder/Breaker acceptance rule from Wang & Buehler, "Self-Revising Discovery
 * Systems for Science" (arXiv:2606.01444, MIT LAMM), eq. 5:
 *
 *     L(M, D) = L_model(M) + L_data(D | M)
 *     accept M' over M  iff  L(M', D∪E) < L(M, D∪E)
 *
 * Both candidate and baseline are scored on the SAME enlarged evidence set
 * (every accumulated task — NOT just the held-out split), and the candidate is
 * accepted only if it lowers the TOTAL bit cost. This is the gate's whole
 * point and what distinguishes it from a monotone held-out delta:
 *
 *   - L_model(M)  — the candidate's own description length: the compressed size
 *     of its model text (a prompt, skill, profile, or symbolic model). A bigger
 *     model pays more bits.
 *   - L_data(D|M) — the residual: bits of "surprise" that the model did not
 *     simply succeed, −Σ_i log2(s_i) over the model's per-task score s_i.
 *     Perfect scores cost 0 bits; failure costs a lot (capped, not infinite).
 *
 * A candidate that merely memorizes new counterexamples grows L_model faster
 * than it shrinks L_data and LOSES — a principled, complexity-penalized
 * alternative to HeldOutGate's held-out paired delta. Use this gate
 * when the model text whose size you want to penalize is available; use
 * HeldOutGate when promotion should turn on held-out generalization with an
 * overfit-gap check instead.
 *
 * Scale / calibration: a gzip'd prose model is hundreds–thousands of bits;
 * a single task contributes at most −log2(scoreFloor) data bits (≈10). So with
 * little evidence the model term dominates and the gate is conservative about
 * model GROWTH — it promotes a larger model only once accumulated evidence
 * genuinely pays for the added bits (exactly the paper's regime, where D∪E
 * grows). `lambda` is the lever: λ<1 discounts model bits (more permissive),
 * λ>1 is stricter. A shrinking-or-equal model that does no worse always wins.
 *
 * Stateless: construct once with the description-length budget, call
 * `evaluate` per (candidate, baseline) pair.
 */

export type DescriptionLengthRejectionCode = 'few_tasks' | 'no_total_gain' | 'model_bloat'

export interface DescriptionLengthConfig {
  /** Stable label of the baseline. Required — paper-grade evaluation never
   *  compares two unlabelled candidates. */
  baselineKey: string
  /** Weight on model bits relative to data bits (the description-length
   *  budget λ). 1 = bits are bits. >1 = more complexity-averse. Default 1. */
  lambda?: number
  /** The candidate must beat the baseline by at least this many bits to
   *  promote — a robustness margin against measurement noise. Default 0
   *  (strict `<`, as the paper). */
  marginBits?: number
  /** Per-task score floor for the residual code: −log2(max(s, floor)). Caps a
   *  total-failure task's surprise instead of letting it diverge. Default
   *  2^-10 (a failed task costs 10 bits, not ∞). */
  scoreFloor?: number
  /** Minimum number of shared (candidate, baseline) tasks before the gate will
   *  consider promoting. Default 3. */
  minTasks?: number
}

export interface DescriptionLengthEvidence {
  /** Shared tasks scored on both sides (the enlarged evidence D∪E). */
  tasks: number
  /** Compressed-model bits — L_model. */
  modelBits: { candidate: number; baseline: number }
  /** Residual surprise bits — L_data(D|M). */
  dataBits: { candidate: number; baseline: number }
  /** λ·L_model + L_data — the quantity the gate minimizes. */
  totalBits: { candidate: number; baseline: number }
  /** candidate − baseline total. Negative = candidate compresses better. */
  deltaBits: number
  /** Per-component deltas, for audit: did the win come from a smaller model,
   *  better outcomes, or both? */
  modelBitsDelta: number
  dataBitsDelta: number
}

export interface DescriptionLengthDecision {
  promote: boolean
  candidateId: string
  baselineId: string
  evidence: DescriptionLengthEvidence
  reason: string
  rejectionCode: DescriptionLengthRejectionCode | null
}

export interface DescriptionLengthCandidate {
  /** The model text whose size is L_model (a prompt, skill, profile, or
   *  symbolic model; concatenated if several files). */
  content: string
  /** Runs whose per-task scores form L_data. */
  runs: RunRecord[]
}

/** Score a single run, preferring the held-out score, then search, then the
 *  raw `score` metric. Returns undefined when the run carries no score. */
function runScore(run: RunRecord): number | undefined {
  const o = run.outcome
  const s = o.holdoutScore ?? o.searchScore ?? o.raw?.score
  return typeof s === 'number' && Number.isFinite(s) ? s : undefined
}

/** Pairing key — the same scenario/experiment identity HeldOutGate pairs on. */
function taskKey(run: RunRecord): string {
  return run.scenarioId ?? run.experimentId
}

/** Mean per-task score for a model: { taskKey -> mean(score over its runs) }. */
function perTaskMeanScore(runs: RunRecord[]): Map<string, number> {
  const acc = new Map<string, { sum: number; n: number }>()
  for (const run of runs) {
    const s = runScore(run)
    if (s === undefined) continue
    const key = taskKey(run)
    const cur = acc.get(key) ?? { sum: 0, n: 0 }
    cur.sum += s
    cur.n += 1
    acc.set(key, cur)
  }
  return new Map([...acc].map(([k, v]) => [k, v.sum / v.n]))
}

/** Compressed-model bits — the model's description length L_model. gzip is a
 *  deterministic, dependency-free stand-in for Kolmogorov complexity; it
 *  rewards genuine compactness and penalizes boilerplate padding. */
export function modelDescriptionBits(content: string): number {
  return gzipSync(Buffer.from(content, 'utf8')).byteLength * 8
}

/** Residual surprise L_data(D|M) = −Σ_i log2(max(s_i, floor)) over the given
 *  per-task scores. Lower = the model more reliably succeeds. */
export function dataDescriptionBits(
  scoreByTask: Map<string, number>,
  keys: Iterable<string>,
  scoreFloor: number,
): number {
  let bits = 0
  for (const key of keys) {
    const s = scoreByTask.get(key)
    if (s === undefined) continue
    bits += -Math.log2(Math.max(s, scoreFloor))
  }
  return bits
}

export class DescriptionLengthGate {
  private readonly baselineKey: string
  private readonly lambda: number
  private readonly marginBits: number
  private readonly scoreFloor: number
  private readonly minTasks: number

  constructor(config: DescriptionLengthConfig) {
    if (!config.baselineKey) throw new Error('DescriptionLengthGate: baselineKey is required')
    this.baselineKey = config.baselineKey
    this.lambda = config.lambda ?? 1
    this.marginBits = config.marginBits ?? 0
    this.scoreFloor = config.scoreFloor ?? 2 ** -10
    this.minTasks = config.minTasks ?? 3
    if (!(this.lambda >= 0)) throw new Error('DescriptionLengthGate: lambda must be ≥ 0')
    if (!(this.scoreFloor > 0 && this.scoreFloor < 1))
      throw new Error('DescriptionLengthGate: scoreFloor must be in (0,1)')
  }

  /** Decide whether `candidate` should replace `baseline`. Both are scored on
   *  the shared task set (the enlarged evidence); the candidate promotes only
   *  if λ·L_model + L_data is strictly lower by at least `marginBits`. */
  evaluate(
    candidate: DescriptionLengthCandidate,
    baseline: DescriptionLengthCandidate,
  ): DescriptionLengthDecision {
    const candidateId = inferCandidateId(candidate.runs, this.baselineKey)
    const candScores = perTaskMeanScore(candidate.runs)
    const baseScores = perTaskMeanScore(baseline.runs)
    // Enlarged evidence = tasks scored on BOTH sides (paired, like the paper's
    // "both models refit on the same accumulated evidence").
    const shared = [...candScores.keys()].filter((k) => baseScores.has(k))

    const modelBits = {
      candidate: this.lambda * modelDescriptionBits(candidate.content),
      baseline: this.lambda * modelDescriptionBits(baseline.content),
    }
    const dataBits = {
      candidate: dataDescriptionBits(candScores, shared, this.scoreFloor),
      baseline: dataDescriptionBits(baseScores, shared, this.scoreFloor),
    }
    const totalBits = {
      candidate: modelBits.candidate + dataBits.candidate,
      baseline: modelBits.baseline + dataBits.baseline,
    }
    const evidence: DescriptionLengthEvidence = {
      tasks: shared.length,
      modelBits,
      dataBits,
      totalBits,
      deltaBits: totalBits.candidate - totalBits.baseline,
      modelBitsDelta: modelBits.candidate - modelBits.baseline,
      dataBitsDelta: dataBits.candidate - dataBits.baseline,
    }
    const base = { candidateId, baselineId: this.baselineKey, evidence }
    const fmt = (n: number) => n.toFixed(1)

    if (shared.length < this.minTasks) {
      return {
        ...base,
        promote: false,
        reason: `few_tasks: ${shared.length} shared task(s) < min ${this.minTasks}`,
        rejectionCode: 'few_tasks',
      }
    }
    if (!(evidence.deltaBits < -this.marginBits)) {
      // No net compression. Name the cause: did the model bloat eat a real
      // data gain, or was there no data gain at all?
      const code: DescriptionLengthRejectionCode =
        evidence.dataBitsDelta < 0 ? 'model_bloat' : 'no_total_gain'
      const why =
        code === 'model_bloat'
          ? `model grew ${fmt(evidence.modelBitsDelta)} bits, outpacing a ${fmt(-evidence.dataBitsDelta)}-bit data gain`
          : `outcomes did not improve (data Δ=${fmt(evidence.dataBitsDelta)} bits)`
      return {
        ...base,
        promote: false,
        reason: `${code}: total Δ=${fmt(evidence.deltaBits)} bits does not clear the ${fmt(this.marginBits)}-bit margin — ${why}`,
        rejectionCode: code,
      }
    }
    return {
      ...base,
      promote: true,
      reason: `promote: total Δ=${fmt(evidence.deltaBits)} bits (model Δ=${fmt(evidence.modelBitsDelta)}, data Δ=${fmt(evidence.dataBitsDelta)}) over ${shared.length} tasks`,
      rejectionCode: null,
    }
  }
}

function inferCandidateId(runs: RunRecord[], baselineKey: string): string {
  for (const run of runs)
    if (run.candidateId && run.candidateId !== baselineKey) return run.candidateId
  return runs[0]?.candidateId ?? '(unknown candidate)'
}
