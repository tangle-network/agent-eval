import { ValidationError } from '../errors'
import {
  defineEvaluationClaim,
  type EvaluationClaim,
  summarizeEvaluationUnits,
} from '../experiment/claim'
import {
  FinalEvidenceConflictError,
  FinalEvidenceError,
  type FinalEvidenceLedger,
  type FinalEvidenceRecord,
} from '../experiment/final-evidence'
import {
  compareCodeUnits,
  hashCanonical,
  LEDGER_HASH_PATTERN,
  type LedgerHash,
} from '../ledger-core/canonical'
import type { MutableSurface, Scenario } from './types'

/** Durable final-data policy. Keep its ledger shared across related campaigns. */
export interface FinalEvidencePolicy {
  ledger: FinalEvidenceLedger
  requestId: string
  evaluatorDigest: LedgerHash
}

export interface FinalEvidenceUse {
  claim: EvaluationClaim
  record: FinalEvidenceRecord
}

/** Capture identities before an asynchronous search can mutate its caller's options. */
export function captureFinalEvidencePolicy(policy: FinalEvidencePolicy): FinalEvidencePolicy {
  return Object.freeze({
    ledger: policy.ledger,
    requestId: policy.requestId,
    evaluatorDigest: policy.evaluatorDigest,
  })
}

export function evaluationUnitMap<TScenario extends Scenario>(
  claim: EvaluationClaim,
  scenarios: readonly TScenario[],
): ReadonlyMap<string, string> {
  const map = new Map<string, string>()
  for (const scenario of scenarios) {
    const summary = summarizeEvaluationUnits(claim, [scenario])
    const unit = summary.units[0]
    if (!unit)
      throw new ValidationError('final evidence has a scenario without an independent unit')
    if (map.has(scenario.id)) throw new ValidationError(`duplicate final scenario '${scenario.id}'`)
    map.set(scenario.id, unit.id)
  }
  return map
}

/** Shared source variants cannot serve as unseen-unit evidence after development. */
export function assertIndependentEvaluationSplit<TScenario extends Scenario>(
  claim: EvaluationClaim,
  finalScenarios: readonly TScenario[],
  developmentScenarios: readonly TScenario[],
): void {
  const finalUnitIds = new Set(evaluationUnitMap(claim, finalScenarios).values())
  const developmentUnits = summarizeEvaluationUnits(claim, developmentScenarios)
  const overlap = developmentUnits.units.filter((unit) => finalUnitIds.has(unit.id))
  if (overlap.length) {
    throw new ValidationError(
      `development and final evidence share independent units: ${overlap.map((unit) => unit.id).join(', ')}`,
    )
  }
}

/** Reserve before search. An identical retry may resume until final data is exposed. */
export async function reserveFinalEvidence<TScenario extends Scenario>(
  policy: FinalEvidencePolicy,
  claimInput: EvaluationClaim | undefined,
  scenarios: readonly TScenario[],
  developmentScenarios: readonly TScenario[] = [],
): Promise<FinalEvidenceUse> {
  policy = captureFinalEvidencePolicy(policy)
  if (claimInput === undefined)
    throw new ValidationError('fresh final evidence requires an evaluation claim')
  const claim = defineEvaluationClaim(claimInput)
  if (claim.use === 'development') {
    throw new ValidationError('final evidence requires a comparison or certification claim')
  }
  if (!LEDGER_HASH_PATTERN.test(policy.evaluatorDigest)) {
    throw new ValidationError('final evidence requires the evaluator content digest')
  }
  const units = evaluationUnitMap(claim, scenarios)
  const finalUnitIds = new Set(units.values())
  assertIndependentEvaluationSplit(claim, scenarios, developmentScenarios)
  const result = await policy.ledger.reserve({
    requestId: policy.requestId,
    claimDigest: hashCanonical({ claim, evaluatorDigest: policy.evaluatorDigest }),
    populationId: claim.population.id,
    inputDigest: hashCanonical([...scenarios].sort((a, b) => compareCodeUnits(a.id, b.id))),
    unitIds: [...finalUnitIds].sort(compareCodeUnits),
  })
  if (!result.succeeded) throw new FinalEvidenceError(result.error.kind, result.error.message)
  if (result.value.record.exposure !== null) {
    throw new FinalEvidenceConflictError(
      `final evidence for '${policy.requestId}' was already exposed; read its recorded result or use fresh evidence`,
    )
  }
  return { claim, record: result.value.record }
}

/** Append exposure before dispatch, so a failed or interrupted measurement still consumes evidence. */
export async function exposeFinalEvidence<TScenario extends Scenario>(
  policy: FinalEvidencePolicy,
  claim: EvaluationClaim | undefined,
  scenarios: readonly TScenario[],
  surfaces: readonly MutableSurface[],
): Promise<FinalEvidenceUse> {
  policy = captureFinalEvidencePolicy(policy)
  const measurement = {
    evaluatorDigest: policy.evaluatorDigest,
    candidateDigests: surfaces.map((surface) => hashCanonical(surface)),
  }
  const reserved = await reserveFinalEvidence(policy, claim, scenarios)
  const result = await policy.ledger.expose(policy.requestId, measurement)
  if (!result.succeeded) throw new FinalEvidenceError(result.error.kind, result.error.message)
  if (result.value.replayed) {
    throw new FinalEvidenceConflictError(
      `final evidence for '${policy.requestId}' is already being measured`,
    )
  }
  return { claim: reserved.claim, record: result.value.record }
}
