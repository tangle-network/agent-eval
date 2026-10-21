import { ValidationError } from '../../errors'
import type { EvidenceRecord, JsonValue } from './evidence'
import { evaluatePredicate, type Predicate, readField } from './predicate'

/** A registered control that must exist before a class of verdicts is read. */
export interface Obligation {
  id: string
  appliesToVerdicts: string[]
  control: string
}

// ── Validity gates and halt ──────────────────────────────────────────

/** Pre-spend design checks. Each returns pass/fail plus its evidence. */
export type ValidityGate =
  | {
      kind: 'oracle-determinism'
      unit: 'suite' | 'assertion'
      replicates: number
      maxFlipRate: number
    }
  | {
      kind: 'population-reproducibility'
      joinOn: string
      compare: string[]
      maxChangedRows: number
    }
  | { kind: 'provenance-assertion'; claim: Predicate }
  | {
      kind: 'power-floor'
      target: number
      /** Minimum worthwhile effect; must be represented exactly in effectGrid. */
      minimumEffect: number
      effectGrid: number[]
      sim: { trials: number; resamples: number; seed: number }
    }
  | { kind: 'identity'; field: 'served-model'; op: 'basename-eq'; onFail: 'abort' }

export interface GateResult {
  id: string
  passed: boolean
  evidence: JsonValue
}

/**
 * Replicate-flip counting over graded states. A state whose replicates split
 * between pass and fail is flipping; its flip rate is the minority share.
 */
export function evaluateOracleDeterminismGate(
  id: string,
  gate: Extract<ValidityGate, { kind: 'oracle-determinism' }>,
  repsByState: Record<string, readonly boolean[]>,
): GateResult {
  const evidence: Record<string, JsonValue> = {}
  let passed = true
  for (const [state, reps] of Object.entries(repsByState)) {
    const passes = reps.filter(Boolean).length
    const flipRate = reps.length === 0 ? 0 : Math.min(passes, reps.length - passes) / reps.length
    evidence[state] = { passes, replicates: reps.length, flipRate }
    if (flipRate > gate.maxFlipRate) passed = false
  }
  return { id, passed, evidence }
}

/**
 * Join two population snapshots on `joinOn` and compare the registered fields.
 * Only rows present in both snapshots are compared; a presence change is a
 * different failure and needs its own gate.
 */
export function evaluatePopulationReproducibilityGate(
  id: string,
  gate: Extract<ValidityGate, { kind: 'population-reproducibility' }>,
  populations: { left: readonly EvidenceRecord[]; right: readonly EvidenceRecord[] },
): GateResult {
  const rightByKey = new Map(populations.right.map((r) => [String(readField(r, gate.joinOn)), r]))
  const changed: string[] = []
  for (const left of populations.left) {
    const key = String(readField(left, gate.joinOn))
    const right = rightByKey.get(key)
    if (!right) continue
    const moved = gate.compare.filter((f) => readField(left, f) !== readField(right, f))
    if (moved.length > 0) {
      changed.push(
        `${key} ${moved.map((f) => `${f}:${String(readField(left, f))}->${String(readField(right, f))}`).join(' ')}`,
      )
    }
  }
  return { id, passed: changed.length <= gate.maxChangedRows, evidence: changed }
}

/** The registered claim about provenance must hold on the provenance record. */
export function evaluateProvenanceGate(
  id: string,
  gate: Extract<ValidityGate, { kind: 'provenance-assertion' }>,
  provenance: EvidenceRecord,
): GateResult {
  const passed = evaluatePredicate(gate.claim, provenance)
  return { id, passed, evidence: { claimHolds: passed } }
}

/** Final path segment equality between the pinned and the served identity. */
export function evaluateIdentityGate(
  id: string,
  _gate: Extract<ValidityGate, { kind: 'identity' }>,
  identities: { pinned: string; served: string },
): GateResult {
  const basename = (s: string): string => s.split('/').pop() ?? s
  const passed = basename(identities.pinned) === basename(identities.served)
  return {
    id,
    passed,
    evidence: { pinned: identities.pinned, served: identities.served, matched: passed },
  }
}

/**
 * The design's power at minimumEffect must reach the registered target.
 * The curve must cover the registered effect grid exactly — a curve
 * computed on a different grid is different evidence and is refused.
 */
export function evaluatePowerFloorGate(
  id: string,
  gate: Extract<ValidityGate, { kind: 'power-floor' }>,
  curve: readonly { effect: number; power: number }[],
): GateResult {
  const problems = powerFloorProblems(gate)
  if (problems.length > 0) {
    throw new ValidationError(`evaluatePowerFloorGate: ${problems.join('; ')}`)
  }
  if (curve.some((point) => !Number.isFinite(point.power) || point.power < 0 || point.power > 1)) {
    throw new ValidationError('evaluatePowerFloorGate: powers must be finite and in [0,1]')
  }
  const byEffect = new Map(curve.map((point) => [point.effect, point.power]))
  if (byEffect.size !== curve.length) {
    throw new ValidationError('evaluatePowerFloorGate: curve contains duplicate effects')
  }
  const missing = gate.effectGrid.filter((effect) => !byEffect.has(effect))
  if (missing.length > 0) {
    throw new ValidationError(
      `evaluatePowerFloorGate: curve does not cover registered effects [${missing.join(', ')}]`,
    )
  }
  const extra = curve.filter((point) => !gate.effectGrid.includes(point.effect))
  if (extra.length > 0) {
    throw new ValidationError(
      `evaluatePowerFloorGate: curve contains unregistered effects [${extra.map((point) => point.effect).join(', ')}]`,
    )
  }
  const powers = gate.effectGrid.map((effect) => byEffect.get(effect)!)
  const maxPower = Math.max(...powers)
  const powerAtMinimumEffect = byEffect.get(gate.minimumEffect)!
  return {
    id,
    passed: powerAtMinimumEffect >= gate.target,
    evidence: {
      target: gate.target,
      minimumEffect: gate.minimumEffect,
      powerAtMinimumEffect,
      maxPower,
      curve: gate.effectGrid.map((effect) => ({ effect, power: byEffect.get(effect)! })),
    },
  }
}

/** Shared by seal validation and direct execution; malformed designs never pass. */
export function powerFloorProblems(gate: Extract<ValidityGate, { kind: 'power-floor' }>): string[] {
  const problems: string[] = []
  if (!Number.isFinite(gate.target) || gate.target <= 0 || gate.target > 1) {
    problems.push('power target must be in (0,1]')
  }
  if (!Number.isFinite(gate.minimumEffect) || gate.minimumEffect <= 0) {
    problems.push('minimumEffect must be positive and finite')
  }
  if (gate.effectGrid.length === 0 || gate.effectGrid.some((effect) => !Number.isFinite(effect))) {
    problems.push('effectGrid must contain finite effects')
  }
  if (new Set(gate.effectGrid).size !== gate.effectGrid.length) {
    problems.push('effectGrid contains duplicate effects')
  }
  if (!gate.effectGrid.includes(gate.minimumEffect)) {
    problems.push('effectGrid must contain minimumEffect exactly; no interpolation is assumed')
  }
  for (const field of ['trials', 'resamples'] as const) {
    if (!Number.isInteger(gate.sim[field]) || gate.sim[field] <= 0) {
      problems.push(`power simulation ${field} must be a positive integer`)
    }
  }
  if (!Number.isInteger(gate.sim.seed)) problems.push('power simulation seed must be an integer')
  return problems
}
