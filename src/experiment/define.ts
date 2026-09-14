/**
 * Define, seal, and execute experiments whose every rule is registered data.
 *
 * `defineExperiment` validates the cross-references inside a spec and freezes
 * it. `sealExperiment` canonicalizes and hashes the whole tree — arms, row
 * admission, selection, estimands, intervals, decision rule, gates, halt,
 * budget — into one digest that lands on every downstream artifact. Changing
 * what is decided requires a new digest: an amendment is a re-seal with a
 * reason and blindness attestations, and the digest history is the audit
 * trail.
 *
 * `openSealedExperiment` is the only execution surface. It verifies the seal
 * and returns executors bound to the sealed spec; none of them takes a
 * parameter for alpha, threshold, metric, or stopping rule, so
 * registered-vs-ran drift is unrepresentable rather than checked.
 */

import { ValidationError } from '../errors'
import { hashCanonical } from '../ledger-core/canonical'
import {
  type AdmissionRule,
  type BudgetRule,
  type ComputedInterval,
  type Condition,
  computeEstimand,
  computeInterval,
  type DecisionOutcome,
  type DecisionRule,
  type DerivedQuantities,
  type Estimand,
  type EstimandResult,
  type EvidenceRecord,
  evaluateHaltRule,
  evaluateIdentityGate,
  evaluateOracleDeterminismGate,
  evaluatePopulationReproducibilityGate,
  evaluatePowerFloorGate,
  evaluateProvenanceGate,
  executeDecisionRule,
  type GateResult,
  type HaltOutcome,
  type HaltRule,
  type IntervalSpec,
  intervalSpecProblems,
  type JsonValue,
  type MatchedBudgetRule,
  type NLadderProjection,
  type Obligation,
  powerFloorProblems,
  projectNLadderBudget,
  type ReissuePolicy,
  runSelectionRule,
  runUniformPassBudget,
  type SelectionRule,
  type UniformPassSchedule,
  type ValidityGate,
} from './ast'
import { type ArmRealizedBudget, type MatchedBudgetVerdict, verifyMatchedBudgets } from './budget'
import {
  defineEvaluationClaim,
  type EvaluationClaim,
  type EvaluationUnitSummary,
  summarizeEvaluationUnits,
} from './claim'
import { type AdmissionExecution, executeAdmissionRule } from './funnel'

/** A sealed experiment whose digest no longer matches its spec. */
export class SealIntegrityError extends ValidationError {}

// ── Spec ─────────────────────────────────────────────────────────────

export interface ArmSpec {
  id: string
  role: 'treatment' | 'control'
  /** Digest of the AgentProfile the arm runs under. */
  profileDigest?: string
  /** Digest of the pinned execution policy the arm runs under. */
  policyDigest?: string
  /** Registered arm pins (model, seed, step budget, ...) as data. */
  pins?: Record<string, JsonValue>
}

export type OutcomeSpec =
  | {
      kind: 'binary'
      /** Where the pass verdict comes from, e.g. 'injected-suite'. */
      source?: string
      digestVerified?: boolean
      /** What counts as a pass, e.g. 'exit-0' or 'reward-file-contains-1'. */
      pass?: string
      /** Errored rollouts stay in the denominator; dropping them is unregistered. */
      droppedRollouts?: 'forbidden'
    }
  | {
      kind: 'bounded-score'
      min: number
      max: number
      orientation: 'higher-is-better' | 'lower-is-better'
    }

/**
 * Per-rollout seed derivation as a closed source list. `arm` is not in the
 * union, so arm-dependent seeding is unrepresentable.
 */
export interface SeedDerivation {
  from: ('seed' | 'rowId' | 'rolloutIndex')[]
}

export interface ExperimentSpec {
  id: string
  /** Population and independent observation unit for the intended use of this result. */
  claim?: EvaluationClaim
  /** Human prose for the audit trail — never executable. */
  hypothesis?: string
  arms: ArmSpec[]
  outcome: OutcomeSpec
  admission?: AdmissionRule
  /** Named deterministic subset rules. */
  selections?: Record<string, SelectionRule>
  /**
   * Selection OUTPUTS pinned into the seal. A filter-of base resolves here, so
   * reusing an earlier draw is registered and a re-draw is a new digest.
   */
  sealedSubsets?: Record<string, string[]>
  estimands?: Record<string, Estimand>
  intervals?: Record<string, IntervalSpec>
  decision: DecisionRule
  obligations?: Obligation[]
  /** Named pre-spend validity gates; the halt rule references these names. */
  gates?: Record<string, ValidityGate>
  halt?: HaltRule
  budget?: BudgetRule
  matchedBudget?: MatchedBudgetRule
  reissue?: ReissuePolicy
  seedDerivation?: SeedDerivation
  seed?: number
}

// ── Validation ───────────────────────────────────────────────────────

function conditionRefs(condition: Condition): {
  intervals: string[]
  quantities: string[]
  obligations: string[]
} {
  switch (condition.kind) {
    case 'interval-excludes-zero':
    case 'interval-includes-zero':
      return { intervals: [condition.interval], quantities: [], obligations: [] }
    case 'quantity-threshold':
      return { intervals: [], quantities: [condition.quantity], obligations: [] }
    case 'obligation-met':
      return { intervals: [], quantities: [], obligations: [condition.obligation] }
    case 'all':
    case 'any': {
      const nested = condition.of.map(conditionRefs)
      return {
        intervals: nested.flatMap((r) => r.intervals),
        quantities: nested.flatMap((r) => r.quantities),
        obligations: nested.flatMap((r) => r.obligations),
      }
    }
    case 'not':
      return conditionRefs(condition.of)
  }
}

/**
 * Validate every cross-reference inside a spec and freeze it.
 *
 * A decision condition may only read a registered interval, a registered
 * estimand, or a registered obligation; a halt rule may only reference
 * registered gates; a filter-of base must resolve to a registered selection
 * or sealed subset. Anything else is refused here, before sealing.
 */
export function defineExperiment(spec: ExperimentSpec): ExperimentSpec {
  const problems: string[] = []
  const claim = spec.claim === undefined ? undefined : defineEvaluationClaim(spec.claim)
  if (!spec.id || spec.id.trim().length === 0) problems.push('id is empty')
  if (spec.arms.length === 0) problems.push('at least one arm is required')
  const armIds = new Set<string>()
  for (const arm of spec.arms) {
    if (armIds.has(arm.id)) problems.push(`duplicate arm id '${arm.id}'`)
    armIds.add(arm.id)
  }
  if (!spec.arms.some((arm) => arm.role === 'treatment')) {
    problems.push('at least one arm must have role treatment')
  }

  const intervalNames = new Set(Object.keys(spec.intervals ?? {}))
  const estimandNames = new Set(Object.keys(spec.estimands ?? {}))
  const obligationIds = new Set((spec.obligations ?? []).map((o) => o.id))
  const gateNames = new Set(Object.keys(spec.gates ?? {}))
  const selectionNames = new Set(Object.keys(spec.selections ?? {}))
  const sealedSubsetNames = new Set(Object.keys(spec.sealedSubsets ?? {}))

  for (const [name, interval] of Object.entries(spec.intervals ?? {})) {
    problems.push(
      ...intervalSpecProblems(interval).map((problem) => `interval '${name}': ${problem}`),
    )
  }

  for (const [name, gate] of Object.entries(spec.gates ?? {})) {
    if (gate.kind !== 'power-floor') continue
    problems.push(...powerFloorProblems(gate).map((problem) => `gate '${name}': ${problem}`))
    if (claim?.minimumEffect !== undefined && gate.minimumEffect !== claim.minimumEffect) {
      problems.push(`gate '${name}' minimumEffect differs from the evaluation claim`)
    }
  }
  if (claim?.generalization === 'new-units') {
    for (const [name, interval] of Object.entries(spec.intervals ?? {})) {
      if (interval?.kind === 'cluster-bootstrap' && interval.clusterBy !== claim.independentUnit) {
        problems.push(
          `interval '${name}' must resample '${claim.independentUnit}' from the evaluation claim`,
        )
      }
    }
  }

  const checkCondition = (condition: Condition, where: string): void => {
    const refs = conditionRefs(condition)
    for (const name of refs.intervals) {
      if (!intervalNames.has(name)) problems.push(`${where} reads unregistered interval '${name}'`)
    }
    for (const name of refs.quantities) {
      if (!estimandNames.has(name)) problems.push(`${where} reads unregistered quantity '${name}'`)
    }
    for (const name of refs.obligations) {
      if (!obligationIds.has(name))
        problems.push(`${where} reads unregistered obligation '${name}'`)
    }
  }

  if (spec.decision.kind === 'table') {
    if (spec.decision.branches.length === 0) problems.push('decision table has no branches')
    spec.decision.branches.forEach((branch, index) => {
      checkCondition(branch.when, `decision branch ${index} ('${branch.verdict}')`)
    })
  } else {
    for (const name of spec.decision.estimands) {
      if (!estimandNames.has(name)) {
        problems.push(`report-only decision names unregistered estimand '${name}'`)
      }
    }
    for (const name of spec.decision.intervals) {
      if (!intervalNames.has(name)) {
        problems.push(`report-only decision names unregistered interval '${name}'`)
      }
    }
  }

  if (spec.decision.kind === 'table' && spec.obligations) {
    const verdicts = new Set(spec.decision.branches.map((b) => b.verdict))
    for (const obligation of spec.obligations) {
      for (const verdict of obligation.appliesToVerdicts) {
        if (!verdicts.has(verdict)) {
          problems.push(
            `obligation '${obligation.id}' applies to verdict '${verdict}' which no branch produces`,
          )
        }
      }
    }
  }

  if (spec.halt) {
    for (const gate of spec.halt.when.gates) {
      if (!gateNames.has(gate)) problems.push(`halt rule references unregistered gate '${gate}'`)
    }
  }

  for (const [name, selection] of Object.entries(spec.selections ?? {})) {
    if (selection.kind === 'filter-of') {
      if (!selectionNames.has(selection.base) && !sealedSubsetNames.has(selection.base)) {
        problems.push(
          `selection '${name}' filters unregistered base '${selection.base}' (not a selection or sealed subset)`,
        )
      }
    }
  }

  if (spec.admission) {
    const stageIds = new Set<string>()
    for (const stage of spec.admission.stages) {
      if (stageIds.has(stage.id)) problems.push(`duplicate admission stage id '${stage.id}'`)
      stageIds.add(stage.id)
    }
    for (const partition of spec.admission.partitions ?? []) {
      if (!stageIds.has(partition.from)) {
        problems.push(
          `admission partition '${partition.id}' draws from unknown stage '${partition.from}'`,
        )
      }
    }
  }

  if (problems.length > 0) {
    throw new ValidationError(`defineExperiment('${spec.id}'): ${problems.join('; ')}`)
  }
  return deepFreeze(structuredClone({ ...spec, ...(claim ? { claim } : {}) }))
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const key of Object.keys(value as object)) {
      deepFreeze((value as Record<string, unknown>)[key])
    }
    Object.freeze(value)
  }
  return value
}

// ── Seal ─────────────────────────────────────────────────────────────

export interface SealAmendment {
  /** ISO8601 timestamp of the re-seal. */
  at: string
  reason: string
  /** Blindness attestations: what was verifiably unseen when the amendment was made. */
  blind: string[]
  /** Digest of the spec after this amendment. */
  digest: string
}

/** SHA-256 over the RFC 8785 canonical JSON encoding of the experiment. */
export type SealAlgo = 'sha256-rfc8785'

export interface SealedExperiment {
  spec: ExperimentSpec
  /** sha256 over the serialized spec, under the scheme `algo` names. */
  digest: string
  /** Required digest scheme. Unsupported or missing schemes cannot execute. */
  algo: SealAlgo
  sealedAt: string
  /** Digest of the original registration, before any amendment. */
  initialDigest: string
  amendments: SealAmendment[]
}

/** Validate, canonicalize, and hash a spec into its registration. */
export async function sealExperiment(
  spec: ExperimentSpec,
  options: { sealedAt?: string } = {},
): Promise<SealedExperiment> {
  const validated = defineExperiment(spec)
  const digest = specDigest(validated)
  return {
    spec: validated,
    digest,
    algo: 'sha256-rfc8785',
    sealedAt: options.sealedAt ?? new Date().toISOString(),
    initialDigest: digest,
    amendments: [],
  }
}

/**
 * Amend a sealed experiment. The current seal is verified first, the new spec
 * is validated and re-hashed, and the amendment appends to the digest chain.
 * There is no way to change what is decided without producing a new digest.
 */
export async function amendExperiment(
  sealed: SealedExperiment,
  amendment: { spec: ExperimentSpec; reason: string; blind: string[]; at?: string },
): Promise<SealedExperiment> {
  const captured = structuredClone(sealed)
  const requested = structuredClone(amendment)
  await assertSealIntact(captured)
  const validated = defineExperiment(requested.spec)
  const digest = specDigest(validated)
  return {
    spec: validated,
    digest,
    algo: 'sha256-rfc8785',
    sealedAt: captured.sealedAt,
    initialDigest: captured.initialDigest,
    amendments: [
      ...captured.amendments,
      {
        at: requested.at ?? new Date().toISOString(),
        reason: requested.reason,
        blind: [...requested.blind],
        digest,
      },
    ],
  }
}

/** True when the supported seal matches its canonical spec. */
export async function verifySealedExperiment(sealed: SealedExperiment): Promise<boolean> {
  if (sealed.algo !== 'sha256-rfc8785') return false
  try {
    return specDigest(sealed.spec) === sealed.digest
  } catch {
    return false
  }
}

function specDigest(spec: ExperimentSpec): string {
  return hashCanonical(spec).slice('sha256:'.length)
}

async function assertSealIntact(sealed: SealedExperiment): Promise<void> {
  if (!(await verifySealedExperiment(sealed))) {
    throw new SealIntegrityError(
      `sealed experiment '${sealed.spec.id}' has an unsupported digest scheme or its digest does not match its canonical spec`,
    )
  }
}

// ── Sealed execution ─────────────────────────────────────────────────

/** Evidence a gate executor consumes, discriminated to match the gate kind. */
export type GateEvidence =
  | { kind: 'oracle-determinism'; repsByState: Record<string, readonly boolean[]> }
  | {
      kind: 'population-reproducibility'
      left: readonly EvidenceRecord[]
      right: readonly EvidenceRecord[]
    }
  | { kind: 'provenance-assertion'; provenance: EvidenceRecord }
  | { kind: 'identity'; pinned: string; served: string }
  | { kind: 'power-floor'; curve: readonly { effect: number; power: number }[] }

/**
 * Executors bound to one verified seal. Every method reads its rule from the
 * sealed spec; evidence is the only argument anywhere.
 */
export interface RegisteredExperiment {
  readonly sealed: SealedExperiment
  /** Count independent units separately from repeated observations under the sealed claim. */
  units(records: readonly EvidenceRecord[]): EvaluationUnitSummary
  /** Execute the registered decision rule on derived quantities. */
  decide(evidence: DerivedQuantities): DecisionOutcome
  /** Run the registered admission funnel over evidence rows. */
  admit(records: readonly EvidenceRecord[]): AdmissionExecution
  /** Run a registered selection rule. Filter-of bases resolve to sealed subsets. */
  select(name: string, records: readonly EvidenceRecord[], options: { idField: string }): string[]
  /** Evaluate a registered validity gate on evidence of the matching kind. */
  gate(name: string, evidence: GateEvidence): GateResult
  /** Evaluate the registered halt rule over gate results. */
  halt(gates: readonly GateResult[]): HaltOutcome
  /** Execute the registered uniform-pass budget schedule. */
  runUniformPassBudget(measuredPassCosts: readonly number[]): UniformPassSchedule
  /** Project the registered n-ladder budget. */
  projectNLadderBudget(measured: { unitCostUsd: number; rows: number }): NLadderProjection
  /** Verify realized arm budgets under the registered matched-budget rule. */
  matchedBudgets(arms: readonly ArmRealizedBudget[]): MatchedBudgetVerdict
  /** Compute a registered estimand over evidence rows. */
  estimate(name: string, rows: readonly EvidenceRecord[]): EstimandResult
  /** Compute a registered interval spec. */
  interval(
    name: string,
    evidence:
      | { kind: 'rows'; rows: readonly EvidenceRecord[] }
      | { kind: 'binomial'; successes: number; trials: number; unitIds?: readonly string[] },
  ): ComputedInterval & { units?: EvaluationUnitSummary }
}

/**
 * Verify the seal and return executors bound to it. This is the module's only
 * execution surface: a rule that is not in the sealed spec cannot run, and a
 * rule that is cannot run differently.
 */
export async function openSealedExperiment(
  sealed: SealedExperiment,
): Promise<RegisteredExperiment> {
  const captured = structuredClone(sealed)
  await assertSealIntact(captured)
  const spec = defineExperiment(captured.spec)
  const frozenSeal = deepFreeze({ ...captured, spec })
  const need = <T>(value: T | undefined, what: string): T => {
    if (value === undefined) {
      throw new ValidationError(`experiment '${spec.id}' registered no ${what}`)
    }
    return value
  }
  return {
    sealed: frozenSeal,
    units: (records) => summarizeEvaluationUnits(need(spec.claim, 'evaluation claim'), records),
    decide: (evidence) => executeDecisionRule(spec.decision, evidence),
    admit: (records) => executeAdmissionRule(need(spec.admission, 'admission rule'), records),
    select: (name, records, options) => {
      const rule = need(spec.selections?.[name], `selection '${name}'`)
      return runSelectionRule(rule, records, {
        idField: options.idField,
        bases: spec.sealedSubsets,
      })
    },
    gate: (name, evidence) => {
      const gate = need(spec.gates?.[name], `gate '${name}'`)
      if (gate.kind !== evidence.kind) {
        throw new ValidationError(
          `gate '${name}' is registered as ${gate.kind} but received ${evidence.kind} evidence`,
        )
      }
      switch (gate.kind) {
        case 'oracle-determinism':
          return evaluateOracleDeterminismGate(
            name,
            gate,
            (evidence as Extract<GateEvidence, { kind: 'oracle-determinism' }>).repsByState,
          )
        case 'population-reproducibility': {
          const populations = evidence as Extract<
            GateEvidence,
            { kind: 'population-reproducibility' }
          >
          return evaluatePopulationReproducibilityGate(name, gate, populations)
        }
        case 'provenance-assertion':
          return evaluateProvenanceGate(
            name,
            gate,
            (evidence as Extract<GateEvidence, { kind: 'provenance-assertion' }>).provenance,
          )
        case 'identity':
          return evaluateIdentityGate(
            name,
            gate,
            evidence as Extract<GateEvidence, { kind: 'identity' }>,
          )
        case 'power-floor':
          return evaluatePowerFloorGate(
            name,
            gate,
            (evidence as Extract<GateEvidence, { kind: 'power-floor' }>).curve,
          )
      }
    },
    halt: (gates) => evaluateHaltRule(need(spec.halt, 'halt rule'), gates),
    runUniformPassBudget: (measuredPassCosts) => {
      const budget = need(spec.budget, 'budget rule')
      if (budget.kind !== 'uniform-pass') {
        throw new ValidationError(
          `experiment '${spec.id}' registered a ${budget.kind} budget, not uniform-pass`,
        )
      }
      return runUniformPassBudget(budget, measuredPassCosts)
    },
    projectNLadderBudget: (measured) => {
      const budget = need(spec.budget, 'budget rule')
      if (budget.kind !== 'n-ladder') {
        throw new ValidationError(
          `experiment '${spec.id}' registered a ${budget.kind} budget, not n-ladder`,
        )
      }
      return projectNLadderBudget(budget, measured)
    },
    matchedBudgets: (arms) =>
      verifyMatchedBudgets(need(spec.matchedBudget, 'matched-budget rule'), arms),
    estimate: (name, rows) =>
      computeEstimand(need(spec.estimands?.[name], `estimand '${name}'`), rows),
    interval: (name, evidence) => {
      const interval = need(spec.intervals?.[name], `interval '${name}'`)
      const claim = spec.claim
      let units: EvaluationUnitSummary | undefined
      if (claim && evidence.kind === 'rows') {
        units = summarizeEvaluationUnits(claim, evidence.rows)
      } else if (claim?.generalization === 'new-units' && evidence.kind === 'binomial') {
        if (
          evidence.unitIds === undefined ||
          evidence.unitIds.length !== evidence.trials ||
          new Set(evidence.unitIds).size !== evidence.trials ||
          evidence.unitIds.some((id) => typeof id !== 'string' || !id.trim() || id.trim() !== id)
        ) {
          throw new ValidationError(
            'claimed binomial interval needs one unique unitId per independent trial',
          )
        }
        units = {
          observations: evidence.trials,
          independentUnits: evidence.trials,
          units: evidence.unitIds.map((id) => ({ id, observations: 1 })),
        }
      }
      return { ...computeInterval(interval, evidence), ...(units ? { units } : {}) }
    },
  }
}
