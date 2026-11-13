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
  type FinalEvidenceReservation,
} from '../experiment/final-evidence'
import {
  compareCodeUnits,
  hashCanonical,
  LEDGER_HASH_PATTERN,
  type LedgerHash,
} from '../ledger-core/canonical'
import type { SearchClaimPlan } from './search-claim'
import { CLAIM_OPERATION, type RunSearchOptions } from './search-kernel-contract'
import type { SearchRecorder } from './search-ledger-recording'
import type { SearchTask } from './search-ledger-types'
import type { SearchStateView } from './search-state'
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

function finalEvidenceReservation<TScenario extends Scenario>(
  policy: FinalEvidencePolicy,
  claimInput: EvaluationClaim | undefined,
  scenarios: readonly TScenario[],
  developmentScenarios: readonly TScenario[],
  searchId?: string,
): { claim: EvaluationClaim; reservation: FinalEvidenceReservation } {
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
  return {
    claim,
    reservation: {
      requestId: policy.requestId,
      claimDigest: hashCanonical({
        claim,
        evaluatorDigest: policy.evaluatorDigest,
        ...(searchId === undefined ? {} : { searchId }),
      }),
      populationId: claim.population.id,
      inputDigest: hashCanonical([...scenarios].sort((a, b) => compareCodeUnits(a.id, b.id))),
      unitIds: [...finalUnitIds].sort(compareCodeUnits),
    },
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
  const { claim, reservation } = finalEvidenceReservation(
    policy,
    claimInput,
    scenarios,
    developmentScenarios,
  )
  const result = await policy.ledger.reserve(reservation)
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

type BeforeSearchClaim = NonNullable<RunSearchOptions<unknown>['beforeClaim']>
type SearchClaimExposure = Parameters<BeforeSearchClaim>[0]

function sealedSearchClaim(
  recorder: SearchRecorder,
  state: SearchStateView,
): SearchClaimExposure | null {
  const operation = state.operation(CLAIM_OPERATION)
  if (!operation) return null
  const reference = operation.artifacts.find((artifact) => artifact.role === 'claim-plan')
  if (!reference) throw new ValidationError('final evidence: search claim has no stored plan')
  const plan = recorder.readBlob(reference) as SearchClaimPlan
  if (plan.kind !== 'search-claim-plan') {
    throw new ValidationError('final evidence: search claim has an invalid plan')
  }
  if (plan.test !== 'run') return null
  return {
    searchId: recorder.searchId,
    claim: state.header!.objective.claim,
    plan,
    candidateDigests: [state.rootNodeId!, ...plan.finalists.map((finalist) => finalist.nodeId)].map(
      (nodeId) => {
        const node = state.node(nodeId)
        if (!node) throw new ValidationError('final evidence: sealed candidate is missing')
        return node.artifactDigest
      },
    ),
    tasks: state.header!.splits.test.tasks,
  }
}

function assertSearchScenarioUnits(
  units: ReadonlyMap<string, string>,
  tasks: readonly SearchTask[],
): void {
  if (units.size !== tasks.length || tasks.some((task) => units.get(task.taskId) !== task.unitId)) {
    throw new ValidationError('final evidence scenarios do not match the search task units')
  }
}

/** Reserve before development; expose only the recorder's durable sealed roster.
 * An exposed request can resume that exact search, never a fresh adaptive search. */
export async function prepareSearchFinalEvidence<TScenario extends Scenario>(input: {
  policy: FinalEvidencePolicy
  recorder: SearchRecorder
  claim: EvaluationClaim
  finalScenarios: readonly TScenario[]
  developmentScenarios: readonly TScenario[]
}): Promise<{ beforeClaim: BeforeSearchClaim; receipt: () => FinalEvidenceUse }> {
  const policy = captureFinalEvidencePolicy(input.policy)
  const { recorder } = input
  const { claim, reservation } = finalEvidenceReservation(
    policy,
    input.claim,
    input.finalScenarios,
    input.developmentScenarios,
    recorder.searchId,
  )
  const finalUnits = evaluationUnitMap(claim, input.finalScenarios)
  const developmentUnits = evaluationUnitMap(claim, input.developmentScenarios)
  const state = await recorder.state()
  const header = state.header
  if (!header || hashCanonical(header.objective.claim) !== hashCanonical(claim)) {
    throw new ValidationError('final evidence claim does not match the opened search')
  }
  assertSearchScenarioUnits(finalUnits, header.splits.test.tasks)
  assertSearchScenarioUnits(developmentUnits, [
    ...header.splits.train.tasks,
    ...header.splits.selection.tasks,
  ])
  const reserved = await policy.ledger.reserve(reservation)
  if (!reserved.succeeded) throw new FinalEvidenceError(reserved.error.kind, reserved.error.message)
  let use: FinalEvidenceUse = { claim, record: reserved.value.record }
  const expose = async (sealed: SearchClaimExposure): Promise<void> => {
    const exposed = await policy.ledger.expose(policy.requestId, {
      evaluatorDigest: policy.evaluatorDigest,
      candidateDigests: [...sealed.candidateDigests],
    })
    if (!exposed.succeeded) throw new FinalEvidenceError(exposed.error.kind, exposed.error.message)
    use = { claim, record: exposed.value.record }
  }
  if (use.record.exposure !== null) {
    const sealed = sealedSearchClaim(recorder, state)
    if (!sealed) {
      throw new FinalEvidenceConflictError('exposed final evidence requires the same sealed search')
    }
    await expose(sealed)
  } else if (state.cells().some((cell) => cell.split === 'test')) {
    throw new FinalEvidenceConflictError('search test cells exist without prior final exposure')
  }
  return {
    beforeClaim: async (descriptor) => {
      const sealed = sealedSearchClaim(recorder, await recorder.state())
      if (!sealed || hashCanonical(descriptor) !== hashCanonical(sealed)) {
        throw new FinalEvidenceConflictError(
          'final exposure does not match the sealed search claim',
        )
      }
      await expose(sealed)
    },
    receipt: () => structuredClone(use),
  }
}
