/**
 * Judge calibration gate: a judge may gate only while its measured agreement
 * with its owner's verdicts holds.
 *
 * A judge (a model judge or a deterministic grader) registers a calibration
 * set: items its owner has decided, each verdict with its provenance. A
 * calibration run replays the judge on those items, once or several times, and
 * `measureJudgeAgreement` reports how often it reached the owner's verdict
 * (accuracy, and Cohen's κ for the pass/fail pair), how much its own verdict
 * moves between runs and between samples, and where it disagreed.
 *
 * `judgeGateDecision` turns that report into the one decision a consumer acts
 * on. It refuses when the judge has no measured agreement, too few decided
 * items of either verdict, a report measured on a different model or rubric
 * than the one the judge now runs, a report older than the policy allows,
 * agreement below the policy floors, or an alarmed drift history. A refused
 * judge's verdict is advisory: the consumer reports it but does not let it
 * pass or block anything.
 *
 * Drift is the judge sentinel (`./sentinel`): `snapshotFromJudgeAgreement`
 * records accuracy as `sentinelPassRate` and κ as `calibrationKappa`, so each
 * calibration run appends one snapshot to a `SentinelStore` and the gate reads
 * the alarms `judgeSentinelReport` raises over that history.
 *
 * Every timestamp is caller-supplied ISO-8601, so decisions are reproducible.
 */

import { JudgeError, ValidationError } from '../errors'
import { type ComputedInterval, computeInterval } from '../experiment/ast'
import {
  judgeSentinelReport,
  type SentinelSnapshot,
  type SentinelThresholds,
  validateSentinelSnapshot,
} from './sentinel'

export type OwnerVerdict = 'pass' | 'fail'

/** One item the owner decided, with where that decision is recorded. */
export interface CalibrationExample {
  /** Stable id of the decided item; a judge run names it in `exampleId`. */
  id: string
  verdict: OwnerVerdict
  /** The person whose verdict this is. Never a model. */
  labeledBy: string
  /** ISO-8601 time the verdict was given. */
  labeledAt: string
  /** Where the verdict is recorded, e.g. `gtm:asset_decision:<id>`. */
  source: string
  /** What the owner judged (an image digest, a run id), so a replay judges the same thing. */
  evidenceRef?: string
  note?: string
}

export interface JudgeCalibrationSet {
  judgeId: string
  /** Whose verdicts the judge stands in for. */
  owner: string
  examples: readonly CalibrationExample[]
}

function parseIso(value: unknown, label: string): number {
  const ms = typeof value === 'string' ? Date.parse(value) : Number.NaN
  if (!Number.isFinite(ms)) {
    throw new ValidationError(
      `judge-gate: ${label} is not a parseable ISO timestamp: ${JSON.stringify(value)}`,
    )
  }
  return ms
}

function requireText(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ValidationError(`judge-gate: ${label} must be a non-empty string`)
  }
  return value
}

function requireVerdict(value: unknown, label: string): OwnerVerdict {
  if (value !== 'pass' && value !== 'fail') {
    throw new ValidationError(
      `judge-gate: ${label} must be 'pass' or 'fail', got ${JSON.stringify(value)}`,
    )
  }
  return value
}

function checkExample(example: CalibrationExample, label: string): CalibrationExample {
  if (example === null || typeof example !== 'object') {
    throw new ValidationError(`judge-gate: ${label} must be an object`)
  }
  requireText(example.id, `${label}.id`)
  requireVerdict(example.verdict, `${label}.verdict`)
  requireText(example.labeledBy, `${label}.labeledBy`)
  parseIso(example.labeledAt, `${label}.labeledAt`)
  requireText(example.source, `${label}.source`)
  if (example.evidenceRef !== undefined) requireText(example.evidenceRef, `${label}.evidenceRef`)
  const copy: CalibrationExample = {
    id: example.id,
    verdict: example.verdict,
    labeledBy: example.labeledBy,
    labeledAt: example.labeledAt,
    source: example.source,
  }
  if (example.evidenceRef !== undefined) copy.evidenceRef = example.evidenceRef
  if (example.note !== undefined) copy.note = example.note
  return copy
}

/**
 * Validate a calibration set and return a normalized copy ordered by example
 * id. Every verdict needs its person, time and source; ids are unique.
 */
export function registerCalibrationSet(set: JudgeCalibrationSet): JudgeCalibrationSet {
  if (set === null || typeof set !== 'object') {
    throw new ValidationError('judge-gate: calibration set must be an object')
  }
  const judgeId = requireText(set.judgeId, 'calibration set judgeId')
  const owner = requireText(set.owner, `calibration set "${judgeId}" owner`)
  if (!Array.isArray(set.examples)) {
    throw new ValidationError(`judge-gate: calibration set "${judgeId}" examples must be an array`)
  }
  const seen = new Set<string>()
  const examples = set.examples.map((example, index) => {
    const checked = checkExample(example, `calibration set "${judgeId}" example ${index}`)
    if (seen.has(checked.id)) {
      throw new ValidationError(
        `judge-gate: calibration set "${judgeId}" has duplicate example id "${checked.id}"`,
      )
    }
    seen.add(checked.id)
    return checked
  })
  examples.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  return { judgeId, owner, examples }
}

export interface CalibrationMerge {
  set: JudgeCalibrationSet
  /** Ids that joined the set. */
  added: string[]
  /** Ids whose verdict a later decision replaced. */
  superseded: string[]
  /** Ids whose incoming verdict was already recorded, or older than the recorded one. */
  unchanged: string[]
}

/**
 * Join new owner verdicts to a set. A verdict already recorded from the same
 * source is unchanged, so ingestion can rerun. A later verdict on an item
 * replaces an earlier one: the owner changed their mind, and the set keeps
 * what they decided last.
 */
export function addCalibrationVerdicts(
  set: JudgeCalibrationSet,
  verdicts: readonly CalibrationExample[],
): CalibrationMerge {
  const base = registerCalibrationSet(set)
  const byId = new Map(base.examples.map((example) => [example.id, example]))
  const added: string[] = []
  const superseded: string[] = []
  const unchanged: string[] = []
  for (const [index, verdict] of verdicts.entries()) {
    const incoming = checkExample(verdict, `incoming verdict ${index} for "${base.judgeId}"`)
    const current = byId.get(incoming.id)
    if (!current) {
      byId.set(incoming.id, incoming)
      added.push(incoming.id)
      continue
    }
    const sameDecision = current.source === incoming.source && current.verdict === incoming.verdict
    if (
      sameDecision ||
      parseIso(incoming.labeledAt, 'labeledAt') <= parseIso(current.labeledAt, 'labeledAt')
    ) {
      unchanged.push(incoming.id)
      continue
    }
    byId.set(incoming.id, incoming)
    superseded.push(incoming.id)
  }
  return {
    set: registerCalibrationSet({ ...base, examples: [...byId.values()] }),
    added,
    superseded,
    unchanged,
  }
}

/** One gate decision the judge made on a calibration example. */
export interface JudgeRun {
  exampleId: string
  /** The judge's decision after its own sample aggregation (median, majority). */
  verdict: OwnerVerdict
  /** The per-sample verdicts behind that decision, when the judge samples. */
  samples?: readonly OwnerVerdict[]
}

export interface JudgeRunMeta {
  judgeId: string
  /** Exact model identity, or `deterministic` for a grader without one. */
  judgeModel: string
  rubricVersion: string
  measuredAt: string
}

export interface JudgeConfusion {
  /** Judge pass, owner pass. */
  truePass: number
  /** Judge fail, owner fail. */
  trueFail: number
  /** Judge pass, owner fail: the judge let through what the owner rejected. */
  falsePass: number
  /** Judge fail, owner pass: the judge blocked what the owner accepted. */
  falseFail: number
}

export interface JudgeExampleAgreement {
  id: string
  verdict: OwnerVerdict
  runs: number
  /** Share of runs that passed. */
  passRate: number
  /** Share of runs that reached the owner's verdict. */
  agreement: number
}

export interface JudgeAgreement extends JudgeRunMeta {
  owner: string
  /** Examples in the calibration set. */
  examples: number
  /** Examples the judge ran on at least once. */
  judged: number
  /** Judged examples per owner verdict. */
  judgedByVerdict: Record<OwnerVerdict, number>
  runs: number
  /** Runs that reached the owner's verdict, over all runs; null with no runs. */
  accuracy: number | null
  /**
   * Exact (Clopper-Pearson) 95% interval for the share of judged examples on
   * which every run reached the owner's verdict. Examples, not runs, are the
   * independent units.
   */
  exampleAccuracy: { agreed: number; judged: number; interval: ComputedInterval } | null
  /**
   * Cohen's κ between the judge and the owner over runs. Null when undefined:
   * no runs, or both sides used a single verdict.
   */
  kappa: number | null
  confusion: JudgeConfusion
  variance: {
    /** Mean over judged examples of p(1 − p), p the example's run pass rate. 0 = no run changed its mind. */
    betweenRuns: number | null
    /** Mean over runs that reported samples of p(1 − p) across those samples; null when none did. */
    withinRun: number | null
    /** Examples whose runs disagree with each other. */
    unstable: string[]
  }
  /** Examples with at least one run against the owner, least agreement first. */
  disagreements: JudgeExampleAgreement[]
  /** Examples without any run. */
  unjudged: string[]
}

function bernoulliVariance(passes: number, n: number): number {
  const p = passes / n
  return p * (1 - p)
}

/** Cohen's κ for two raters over a binary pass/fail table. */
function binaryKappa(confusion: JudgeConfusion): number | null {
  const n = confusion.truePass + confusion.trueFail + confusion.falsePass + confusion.falseFail
  if (n === 0) return null
  const observed = (confusion.truePass + confusion.trueFail) / n
  const judgePass = (confusion.truePass + confusion.falsePass) / n
  const ownerPass = (confusion.truePass + confusion.falseFail) / n
  const expected = judgePass * ownerPass + (1 - judgePass) * (1 - ownerPass)
  if (expected === 1) return null
  return (observed - expected) / (1 - expected)
}

/**
 * Agreement between a judge's runs and the owner's verdicts on one
 * calibration set. A run that names an example outside the set is an error:
 * a silently dropped run would overstate agreement.
 */
export function measureJudgeAgreement(
  set: JudgeCalibrationSet,
  runs: readonly JudgeRun[],
  meta: JudgeRunMeta,
): JudgeAgreement {
  const registered = registerCalibrationSet(set)
  if (meta.judgeId !== registered.judgeId) {
    throw new ValidationError(
      `judge-gate: runs are for judge "${meta.judgeId}" but the set belongs to "${registered.judgeId}"`,
    )
  }
  requireText(meta.judgeModel, 'judgeModel')
  requireText(meta.rubricVersion, 'rubricVersion')
  parseIso(meta.measuredAt, 'measuredAt')
  const byId = new Map(registered.examples.map((example) => [example.id, example]))
  const runsById = new Map<string, JudgeRun[]>()
  const confusion: JudgeConfusion = { truePass: 0, trueFail: 0, falsePass: 0, falseFail: 0 }
  const withinRun: number[] = []
  for (const [index, run] of runs.entries()) {
    const example = byId.get(run?.exampleId)
    if (!example) {
      throw new ValidationError(
        `judge-gate: run ${index} names example ${JSON.stringify(run?.exampleId)}, which is not in "${registered.judgeId}"'s calibration set`,
      )
    }
    const verdict = requireVerdict(run.verdict, `run ${index} verdict`)
    if (run.samples !== undefined) {
      if (!Array.isArray(run.samples) || run.samples.length === 0) {
        throw new ValidationError(`judge-gate: run ${index} samples must be a non-empty array`)
      }
      const samples = run.samples.map((sample, s) =>
        requireVerdict(sample, `run ${index} sample ${s}`),
      )
      withinRun.push(
        bernoulliVariance(samples.filter((sample) => sample === 'pass').length, samples.length),
      )
    }
    const list = runsById.get(example.id) ?? []
    list.push({ ...run, verdict })
    runsById.set(example.id, list)
    if (verdict === 'pass') {
      if (example.verdict === 'pass') confusion.truePass++
      else confusion.falsePass++
    } else if (example.verdict === 'fail') confusion.trueFail++
    else confusion.falseFail++
  }

  const perExample: JudgeExampleAgreement[] = []
  const unjudged: string[] = []
  const judgedByVerdict: Record<OwnerVerdict, number> = { pass: 0, fail: 0 }
  for (const example of registered.examples) {
    const list = runsById.get(example.id)
    if (!list) {
      unjudged.push(example.id)
      continue
    }
    judgedByVerdict[example.verdict]++
    const passes = list.filter((run) => run.verdict === 'pass').length
    perExample.push({
      id: example.id,
      verdict: example.verdict,
      runs: list.length,
      passRate: passes / list.length,
      agreement: list.filter((run) => run.verdict === example.verdict).length / list.length,
    })
  }

  const total = runs.length
  const agreedRuns = confusion.truePass + confusion.trueFail
  const agreedExamples = perExample.filter((example) => example.agreement === 1).length
  const mean = (values: readonly number[]) =>
    values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length
  return {
    ...meta,
    owner: registered.owner,
    examples: registered.examples.length,
    judged: perExample.length,
    judgedByVerdict,
    runs: total,
    accuracy: total === 0 ? null : agreedRuns / total,
    exampleAccuracy:
      perExample.length === 0
        ? null
        : {
            agreed: agreedExamples,
            judged: perExample.length,
            interval: computeInterval(
              { kind: 'clopper-pearson', level: 0.95 },
              { kind: 'binomial', successes: agreedExamples, trials: perExample.length },
            ),
          },
    kappa: binaryKappa(confusion),
    confusion,
    variance: {
      betweenRuns: mean(perExample.map((example) => example.passRate * (1 - example.passRate))),
      withinRun: mean(withinRun),
      unstable: perExample
        .filter((example) => example.passRate > 0 && example.passRate < 1)
        .map((example) => example.id),
    },
    disagreements: perExample
      .filter((example) => example.agreement < 1)
      .sort((a, b) => a.agreement - b.agreement || (a.id < b.id ? -1 : 1)),
    unjudged,
  }
}

export interface JudgeGatePolicy {
  /** Judged examples required before the judge may gate. */
  minExamples: number
  /** Judged examples required of each owner verdict, so κ is defined. */
  minPerVerdict: number
  /** Floor on run accuracy. */
  minAccuracy: number
  /** Floor on Cohen's κ. */
  minKappa: number
  /** A report older than this (days, vs `asOf`) no longer calibrates the judge. */
  maxAgeDays: number
  /** Drift thresholds forwarded to `judgeSentinelReport` over the history. */
  drift?: SentinelThresholds
}

export const DEFAULT_JUDGE_GATE_POLICY: Readonly<JudgeGatePolicy> = Object.freeze({
  minExamples: 10,
  minPerVerdict: 1,
  minAccuracy: 0.9,
  minKappa: 0.6,
  maxAgeDays: 30,
})

export type JudgeGateStatus = 'calibrated' | 'uncalibrated' | 'below-threshold' | 'drifted'

export interface JudgeGateDecision {
  judgeId: string
  judgeModel: string
  rubricVersion: string
  /** True only for `calibrated`. */
  mayGate: boolean
  status: JudgeGateStatus
  /** Why the judge may not gate; empty when it may. */
  reasons: string[]
  agreement: JudgeAgreement | null
  policy: JudgeGatePolicy
}

export interface JudgeGateInput {
  judgeId: string
  /** The model the judge runs now. */
  judgeModel: string
  /** The rubric the judge runs now. */
  rubricVersion: string
  /** The latest calibration report; null when the judge was never measured. */
  agreement: JudgeAgreement | null
  asOf: string
  /** Sentinel snapshots for this judge, oldest first or in any order. */
  history?: readonly SentinelSnapshot[]
  policy?: Partial<JudgeGatePolicy>
}

const DAY_MS = 86_400_000

function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`
}

/** Whether a judge may gate now, and every reason it may not. */
export function judgeGateDecision(input: JudgeGateInput): JudgeGateDecision {
  const judgeId = requireText(input.judgeId, 'judgeId')
  const judgeModel = requireText(input.judgeModel, 'judgeModel')
  const rubricVersion = requireText(input.rubricVersion, 'rubricVersion')
  const asOf = parseIso(input.asOf, 'asOf')
  const policy: JudgeGatePolicy = { ...DEFAULT_JUDGE_GATE_POLICY, ...input.policy }
  const agreement = input.agreement
  const decide = (status: JudgeGateStatus, reasons: string[]): JudgeGateDecision => ({
    judgeId,
    judgeModel,
    rubricVersion,
    mayGate: status === 'calibrated',
    status,
    reasons,
    agreement,
    policy,
  })

  if (!agreement) return decide('uncalibrated', ['no measured agreement with owner verdicts'])
  if (agreement.judgeId !== judgeId) {
    throw new ValidationError(
      `judge-gate: agreement belongs to "${agreement.judgeId}", not "${judgeId}"`,
    )
  }

  const uncalibrated: string[] = []
  if (agreement.judgeModel !== judgeModel) {
    uncalibrated.push(
      `agreement was measured on model ${agreement.judgeModel}; the judge now runs ${judgeModel}`,
    )
  }
  if (agreement.rubricVersion !== rubricVersion) {
    uncalibrated.push(
      `agreement was measured on rubric ${agreement.rubricVersion}; the judge now runs ${rubricVersion}`,
    )
  }
  const ageDays = (asOf - parseIso(agreement.measuredAt, 'agreement.measuredAt')) / DAY_MS
  if (ageDays > policy.maxAgeDays) {
    uncalibrated.push(`agreement is ${ageDays.toFixed(1)} days old (limit ${policy.maxAgeDays})`)
  }
  if (agreement.judged < policy.minExamples) {
    uncalibrated.push(
      `${agreement.judged} judged ${agreement.judged === 1 ? 'example' : 'examples'}; at least ${policy.minExamples} required`,
    )
  }
  for (const verdict of ['pass', 'fail'] as const) {
    if (agreement.judgedByVerdict[verdict] < policy.minPerVerdict) {
      uncalibrated.push(
        `${agreement.judgedByVerdict[verdict]} judged examples the owner marked ${verdict}; at least ${policy.minPerVerdict} required`,
      )
    }
  }
  if (uncalibrated.length > 0) return decide('uncalibrated', uncalibrated)

  const below: string[] = []
  if (agreement.accuracy === null || agreement.accuracy < policy.minAccuracy) {
    below.push(
      `accuracy ${agreement.accuracy === null ? 'unmeasured' : percent(agreement.accuracy)} is below ${percent(policy.minAccuracy)}`,
    )
  }
  if (agreement.kappa === null || agreement.kappa < policy.minKappa) {
    below.push(
      `kappa ${agreement.kappa === null ? 'undefined' : agreement.kappa.toFixed(2)} is below ${policy.minKappa}`,
    )
  }
  if (below.length > 0) return decide('below-threshold', below)

  const history = (input.history ?? []).filter((snapshot) => snapshot.judgeId === judgeId)
  if (history.length > 0) {
    const report = judgeSentinelReport([...history], {
      asOf: input.asOf,
      ...(policy.drift ? { thresholds: policy.drift } : {}),
    })
    if (!report.healthy) return decide('drifted', report.alarms)
  }
  return decide('calibrated', [])
}

/** Thrown by `assertJudgeMayGate`; carries the refused decision. */
export class JudgeGateRefusedError extends JudgeError {
  readonly decision: JudgeGateDecision

  constructor(decision: JudgeGateDecision) {
    super(
      `judge "${decision.judgeId}" may not gate (${decision.status}): ${decision.reasons.join('; ')}`,
    )
    this.decision = decision
  }
}

/** Throw unless the decision lets the judge gate. */
export function assertJudgeMayGate(decision: JudgeGateDecision): void {
  if (!decision.mayGate) throw new JudgeGateRefusedError(decision)
}

/**
 * The sentinel snapshot for one calibration run: accuracy as
 * `sentinelPassRate`, κ as `calibrationKappa` when it is defined. Append it to
 * the judge's `SentinelStore`; the gate reads drift from that history.
 */
export function snapshotFromJudgeAgreement(agreement: JudgeAgreement): SentinelSnapshot {
  if (agreement.accuracy === null) {
    throw new ValidationError(
      `snapshotFromJudgeAgreement: judge "${agreement.judgeId}" has no runs to snapshot`,
    )
  }
  const snapshot: SentinelSnapshot = {
    at: agreement.measuredAt,
    judgeId: agreement.judgeId,
    judgeModel: agreement.judgeModel,
    metrics: {
      sentinelPassRate: agreement.accuracy,
      ...(agreement.kappa === null ? {} : { calibrationKappa: agreement.kappa }),
    },
  }
  validateSentinelSnapshot(snapshot)
  return snapshot
}
