import { canonicalString, type LedgerProjector } from '../ledger-core'
import { SearchLedgerIntegrityError } from './search-ledger-errors'
import { artifactKey, compareStrings } from './search-ledger-ordering'
import type {
  SearchAccountingAudit,
  SearchCandidateDecidedEvent,
  SearchCandidateRegisteredEvent,
  SearchCandidateSlot,
  SearchCandidateSlotClosedEvent,
  SearchCompletedEvent,
  SearchLedgerAudit,
  SearchLedgerEntry,
  SearchLedgerReplay,
  SearchOperationRecordedEvent,
  SearchPlanExtendedEvent,
  SearchPlannedEvent,
  SearchPlannedOperation,
  SearchTaskAttemptedEvent,
} from './search-ledger-types'

interface CandidateState {
  registered: SearchCandidateRegisteredEvent
  attempts: SearchTaskAttemptedEvent[]
  decision: SearchCandidateDecidedEvent | null
}

/** Replay the campaign search state machine over chain-verified entries. The
 * generic journal owns sequence, hash, and eventId-uniqueness checks; this
 * projector owns every campaign invariant and builds the replay projection. */
export function createSearchLedgerProjector(
  campaignId: string,
): LedgerProjector<SearchLedgerEntry, SearchLedgerReplay> {
  const candidates = new Map<string, CandidateState>()
  // The effective plan: the first plan event merged with every later
  // extension. Every slot and operation lookup reads these, so a rolling
  // search that appends slots keeps one plan, one denominator, one audit.
  const plannedSlots = new Map<string, SearchCandidateSlot>()
  const plannedOperations = new Map<string, SearchPlannedOperation>()
  const planExtensions: SearchPlanExtendedEvent[] = []
  const candidateBySlot = new Map<string, string>()
  const closedSlots = new Map<string, SearchCandidateSlotClosedEvent>()
  const lineageNodes = new Map<string, string>()
  const runIds = new Set<string>()
  const attemptKeys = new Set<string>()
  const candidateEvents: SearchCandidateRegisteredEvent[] = []
  const closedSlotEvents: SearchCandidateSlotClosedEvent[] = []
  const attempts: SearchTaskAttemptedEvent[] = []
  const operationEvents: SearchOperationRecordedEvent[] = []
  const operationsById = new Map<string, SearchOperationRecordedEvent>()
  const decisions: SearchCandidateDecidedEvent[] = []
  let planEvent: SearchPlannedEvent | null = null
  let completion: SearchCompletedEvent | null = null
  let previousOccurredAt = Number.NEGATIVE_INFINITY

  const apply = (entry: SearchLedgerEntry, index: number): void => {
    const event = entry.event
    if (completion) {
      throw new SearchLedgerIntegrityError(
        `event ${event.eventId} appears after terminal event ${completion.eventId}`,
      )
    }
    const occurredAt = Date.parse(event.occurredAt)
    if (occurredAt < previousOccurredAt) {
      throw new SearchLedgerIntegrityError(
        `event ${event.eventId} occurred before the preceding durable event`,
      )
    }
    previousOccurredAt = occurredAt
    assertUnique(event.artifacts.map(artifactKey), 'artifact receipt', event.eventId)

    if (event.kind === 'search-planned') {
      if (index !== 0 || planEvent) {
        throw new SearchLedgerIntegrityError('search plan must be the first and only plan event')
      }
      assertUnique(
        event.plan.candidateSlots.map((slot) => slot.slotId),
        'candidate slot',
        event.eventId,
      )
      assertUnique(
        event.plan.tasks.map((task) => task.taskId),
        'planned taskId',
        event.eventId,
      )
      assertUnique(
        event.plan.operations.map((operation) => operation.operationId),
        'planned operationId',
        event.eventId,
      )
      for (const operation of event.plan.operations) {
        plannedOperations.set(operation.operationId, operation)
      }
      for (const slot of event.plan.candidateSlots) {
        assertSlotGenerationOperation(slot, plannedOperations)
        plannedSlots.set(slot.slotId, slot)
      }
      planEvent = event
      return
    }

    if (!planEvent) {
      throw new SearchLedgerIntegrityError(
        `event ${event.eventId} appears before the required search plan`,
      )
    }

    if (event.kind === 'search-plan-extended') {
      assertUnique(
        event.extension.candidateSlots.map((slot) => slot.slotId),
        'candidate slot',
        event.eventId,
      )
      assertUnique(
        event.extension.operations.map((operation) => operation.operationId),
        'planned operationId',
        event.eventId,
      )
      for (const operation of event.extension.operations) {
        if (plannedOperations.has(operation.operationId)) {
          throw new SearchLedgerIntegrityError(
            `plan extension ${event.eventId} re-plans operation ${operation.operationId}`,
          )
        }
        plannedOperations.set(operation.operationId, operation)
      }
      for (const slot of event.extension.candidateSlots) {
        if (plannedSlots.has(slot.slotId)) {
          throw new SearchLedgerIntegrityError(
            `plan extension ${event.eventId} re-plans candidate slot ${slot.slotId}`,
          )
        }
        assertSlotGenerationOperation(slot, plannedOperations)
        plannedSlots.set(slot.slotId, slot)
      }
      planExtensions.push(event)
      return
    }

    if (event.kind === 'candidate-registered') {
      if (candidates.has(event.candidateId)) {
        throw new SearchLedgerIntegrityError(`candidate ${event.candidateId} was registered twice`)
      }
      const plannedSlot = plannedSlots.get(event.slotId)
      if (!plannedSlot) {
        throw new SearchLedgerIntegrityError(
          `candidate ${event.candidateId} binds unknown slot ${event.slotId}`,
        )
      }
      if (candidateBySlot.has(event.slotId)) {
        throw new SearchLedgerIntegrityError(`candidate slot ${event.slotId} was bound twice`)
      }
      if (closedSlots.has(event.slotId)) {
        throw new SearchLedgerIntegrityError(`candidate slot ${event.slotId} was already closed`)
      }
      if (event.generationOperationId !== plannedSlot.generationOperationId) {
        throw new SearchLedgerIntegrityError(
          `candidate ${event.candidateId} generation operation ${event.generationOperationId} does not match slot ${event.slotId} plan ${plannedSlot.generationOperationId}`,
        )
      }
      const generationOperation = operationsById.get(event.generationOperationId)
      if (!generationOperation) {
        throw new SearchLedgerIntegrityError(
          `candidate ${event.candidateId} precedes generation operation ${event.generationOperationId}`,
        )
      }
      if (generationOperation.outcome.status === 'failed') {
        throw new SearchLedgerIntegrityError(
          `candidate ${event.candidateId} cannot bind failed generation operation ${event.generationOperationId}`,
        )
      }
      const previousCandidate = lineageNodes.get(event.lineage.lineageNodeId)
      if (previousCandidate) {
        throw new SearchLedgerIntegrityError(
          `lineage node ${event.lineage.lineageNodeId} is already bound to ${previousCandidate}`,
        )
      }
      assertUnique(event.lineage.parentCandidateIds, 'parentCandidateId', event.eventId)
      const parents = event.lineage.parentCandidateIds.map((id) => {
        const parent = candidates.get(id)
        if (!parent) {
          throw new SearchLedgerIntegrityError(
            `candidate ${event.candidateId} references unknown parent ${id}`,
          )
        }
        return parent
      })
      const expectedGeneration =
        parents.length === 0
          ? 0
          : Math.max(...parents.map((parent) => parent.registered.lineage.generation)) + 1
      if (event.lineage.generation !== expectedGeneration) {
        throw new SearchLedgerIntegrityError(
          `candidate ${event.candidateId} generation ${event.lineage.generation} does not follow its parents (expected ${expectedGeneration})`,
        )
      }
      assertUnique(
        event.surfaces.map((surface) => surface.surfaceId),
        'surfaceId',
        event.eventId,
      )
      candidates.set(event.candidateId, { registered: event, attempts: [], decision: null })
      candidateBySlot.set(event.slotId, event.candidateId)
      lineageNodes.set(event.lineage.lineageNodeId, event.candidateId)
      candidateEvents.push(event)
      return
    }

    if (event.kind === 'task-attempted') {
      const candidate = candidates.get(event.candidateId)
      if (!candidate) {
        throw new SearchLedgerIntegrityError(
          `attempt ${event.eventId} references unknown candidate ${event.candidateId}`,
        )
      }
      if (candidate.decision) {
        throw new SearchLedgerIntegrityError(
          `attempt ${event.eventId} appears after candidate ${event.candidateId} was decided`,
        )
      }
      const plannedTask = planEvent.plan.tasks.find((task) => task.taskId === event.task.taskId)
      if (!plannedTask) {
        throw new SearchLedgerIntegrityError(
          `attempt ${event.eventId} references unplanned task ${event.task.taskId}`,
        )
      }
      if (
        canonicalString(plannedTask.source) !== canonicalString(event.task.source) ||
        canonicalString(plannedTask.benchmark) !== canonicalString(event.identity.benchmark)
      ) {
        throw new SearchLedgerIntegrityError(
          `task ${event.task.taskId} does not match its planned source identity`,
        )
      }
      if (event.attemptIndex >= plannedTask.maxAttempts) {
        throw new SearchLedgerIntegrityError(
          `task ${event.task.taskId} attempt ${event.attemptIndex} exceeds planned maxAttempts ${plannedTask.maxAttempts}`,
        )
      }
      if (runIds.has(event.runId)) {
        throw new SearchLedgerIntegrityError(`runId ${event.runId} was recorded twice`)
      }
      runIds.add(event.runId)
      const attemptKey = canonicalString([event.candidateId, event.task.taskId, event.attemptIndex])
      if (attemptKeys.has(attemptKey)) {
        throw new SearchLedgerIntegrityError(
          `candidate ${event.candidateId} task ${event.task.taskId} attempt ${event.attemptIndex} was recorded twice`,
        )
      }
      const expectedAttemptIndex = candidate.attempts.filter(
        (attempt) => attempt.task.taskId === event.task.taskId,
      ).length
      if (event.attemptIndex !== expectedAttemptIndex) {
        throw new SearchLedgerIntegrityError(
          `candidate ${event.candidateId} task ${event.task.taskId} attempt index ${event.attemptIndex} is not contiguous (expected ${expectedAttemptIndex})`,
        )
      }
      const previousAttempt = candidate.attempts.find(
        (attempt) => attempt.task.taskId === event.task.taskId,
      )
      if (
        previousAttempt?.outcome.status !== undefined &&
        previousAttempt.outcome.status !== 'errored'
      ) {
        throw new SearchLedgerIntegrityError(
          `task ${event.task.taskId} was retried after a measured outcome`,
        )
      }
      if (
        previousAttempt &&
        canonicalString({ task: previousAttempt.task, identity: previousAttempt.identity }) !==
          canonicalString({ task: event.task, identity: event.identity })
      ) {
        throw new SearchLedgerIntegrityError(
          `candidate ${event.candidateId} task ${event.task.taskId} changed immutable execution identity between attempts`,
        )
      }
      attemptKeys.add(attemptKey)

      const declared = candidate.registered.surfaces.map((surface) => surface.surfaceId).sort()
      const observed = event.surfaceEvidence.map((surface) => surface.surfaceId).sort()
      assertUnique(observed, 'surface evidence', event.eventId)
      for (const evidence of event.surfaceEvidence) {
        assertUnique(evidence.evidence.map(artifactKey), 'surface evidence receipt', event.eventId)
      }
      if (canonicalString(declared) !== canonicalString(observed)) {
        throw new SearchLedgerIntegrityError(
          `attempt ${event.eventId} surface evidence does not exactly cover candidate ${event.candidateId}`,
        )
      }
      candidate.attempts.push(event)
      attempts.push(event)
      return
    }

    if (event.kind === 'search-operation-recorded') {
      const plannedOperation = plannedOperations.get(event.operationId)
      if (!plannedOperation) {
        throw new SearchLedgerIntegrityError(
          `operation ${event.operationId} was not declared in the search plan`,
        )
      }
      if (plannedOperation.kind !== event.operationKind) {
        throw new SearchLedgerIntegrityError(
          `operation ${event.operationId} kind ${event.operationKind} does not match planned ${plannedOperation.kind}`,
        )
      }
      if (operationsById.has(event.operationId)) {
        throw new SearchLedgerIntegrityError(`operation ${event.operationId} was recorded twice`)
      }
      operationsById.set(event.operationId, event)
      operationEvents.push(event)
      return
    }

    if (event.kind === 'candidate-slot-closed') {
      const plannedSlot = plannedSlots.get(event.slotId)
      if (!plannedSlot) {
        throw new SearchLedgerIntegrityError(
          `candidate slot closure ${event.eventId} references unknown slot ${event.slotId}`,
        )
      }
      if (event.generationOperationId !== plannedSlot.generationOperationId) {
        throw new SearchLedgerIntegrityError(
          `candidate slot closure ${event.eventId} generation operation ${event.generationOperationId} does not match slot ${event.slotId} plan ${plannedSlot.generationOperationId}`,
        )
      }
      if (candidateBySlot.has(event.slotId)) {
        throw new SearchLedgerIntegrityError(
          `candidate slot ${event.slotId} was already bound to a candidate`,
        )
      }
      if (closedSlots.has(event.slotId)) {
        throw new SearchLedgerIntegrityError(`candidate slot ${event.slotId} was closed twice`)
      }
      const operation = operationsById.get(event.generationOperationId)
      if (!operation) {
        throw new SearchLedgerIntegrityError(
          `candidate slot closure ${event.eventId} precedes operation ${event.generationOperationId}`,
        )
      }
      if (operation.outcome.status === 'completed') {
        throw new SearchLedgerIntegrityError(
          `candidate slot ${event.slotId} cannot close from completed operation ${event.generationOperationId}`,
        )
      }
      closedSlots.set(event.slotId, event)
      closedSlotEvents.push(event)
      return
    }

    if (event.kind === 'candidate-decided') {
      const candidate = candidates.get(event.candidateId)
      if (!candidate) {
        throw new SearchLedgerIntegrityError(
          `decision ${event.eventId} references unknown candidate ${event.candidateId}`,
        )
      }
      if (candidate.decision) {
        throw new SearchLedgerIntegrityError(`candidate ${event.candidateId} was decided twice`)
      }
      if (event.decision.status === 'selected') {
        if (!candidate.attempts.some((attempt) => attempt.outcome.status !== 'errored')) {
          throw new SearchLedgerIntegrityError(
            `candidate ${event.candidateId} cannot be selected without a measured task outcome`,
          )
        }
        if (decisions.some((decision) => decision.decision.status === 'selected')) {
          throw new SearchLedgerIntegrityError('more than one candidate was selected')
        }
      }
      candidate.decision = event
      decisions.push(event)
      return
    }

    const missingCandidateSlots = [...plannedSlots.values()]
      .filter((slot) => !candidateBySlot.has(slot.slotId) && !closedSlots.has(slot.slotId))
      .map((slot) => slot.slotId)
    if (missingCandidateSlots.length > 0) {
      throw new SearchLedgerIntegrityError(
        `search completed with missing candidate slots: ${missingCandidateSlots.join(', ')}`,
      )
    }
    const missingTaskOutcomes = plannedTaskOutcomeKeys(planEvent, candidates)
    if (missingTaskOutcomes.length > 0) {
      throw new SearchLedgerIntegrityError(
        `search completed with missing task outcomes: ${missingTaskOutcomes.join(', ')}`,
      )
    }
    const missingOperations = [...plannedOperations.values()]
      .filter((operation) => !operationsById.has(operation.operationId))
      .map((operation) => operation.operationId)
    if (missingOperations.length > 0) {
      throw new SearchLedgerIntegrityError(
        `search completed with missing search operations: ${missingOperations.join(', ')}`,
      )
    }
    for (const operation of plannedOperations.values()) {
      if (operation.kind !== 'candidate-generation') continue
      const generationOutcome = operationsById.get(operation.operationId)!.outcome.status
      const slots = [...plannedSlots.values()].filter(
        (slot) => slot.generationOperationId === operation.operationId,
      )
      if (slots.length === 0) continue
      const registeredCount = slots.filter((slot) => candidateBySlot.has(slot.slotId)).length
      const closedCount = slots.filter((slot) => closedSlots.has(slot.slotId)).length
      if (generationOutcome === 'completed' && closedCount > 0) {
        throw new SearchLedgerIntegrityError(
          `completed generation operation ${operation.operationId} contains ${closedCount} closed slot(s)`,
        )
      }
      if (generationOutcome === 'failed' && registeredCount > 0) {
        throw new SearchLedgerIntegrityError(
          `failed generation operation ${operation.operationId} contains ${registeredCount} registered candidate(s)`,
        )
      }
      if (generationOutcome === 'partial' && (registeredCount === 0 || closedCount === 0)) {
        throw new SearchLedgerIntegrityError(
          `partial generation operation ${operation.operationId} must contain both a registered candidate and a closed slot`,
        )
      }
    }
    const pending = [...candidates.values()].filter((candidate) => candidate.decision === null)
    if (pending.length > 0) {
      throw new SearchLedgerIntegrityError(
        `search completed with ${pending.length} candidate decision(s) missing`,
      )
    }
    const selected = decisions.filter((decision) => decision.decision.status === 'selected')
    if (event.result.status === 'selected') {
      if (selected.length !== 1 || selected[0]!.candidateId !== event.result.candidateId) {
        throw new SearchLedgerIntegrityError(
          `search completion winner ${event.result.candidateId} does not match candidate decisions`,
        )
      }
    } else if (selected.length !== 0) {
      throw new SearchLedgerIntegrityError('all-rejected completion contains a selected candidate')
    }
    completion = event
  }

  const finish = (entries: SearchLedgerEntry[]): SearchLedgerReplay => {
    const selectedDecisions = decisions.filter(
      (decision) => decision.decision.status === 'selected',
    )
    const rejectedDecisions = decisions.filter(
      (decision) => decision.decision.status === 'rejected',
    )
    const outcomeCounts = { passed: 0, failed: 0, errored: 0 }
    const operationOutcomeCounts = { completed: 0, partial: 0, failed: 0 }
    let inputTokens = 0
    let outputTokens = 0
    let cachedTokens = 0
    let costUsd = 0
    const unknownTokenEventIds: string[] = []
    const unknownCostEventIds: string[] = []
    for (const attempt of attempts) {
      outcomeCounts[attempt.outcome.status] += 1
    }
    for (const operation of operationEvents) {
      operationOutcomeCounts[operation.outcome.status] += 1
    }
    for (const costedEvent of [...attempts, ...operationEvents]) {
      if (costedEvent.accounting.tokens.status === 'known') {
        inputTokens += costedEvent.accounting.tokens.inputTokens
        outputTokens += costedEvent.accounting.tokens.outputTokens
        cachedTokens += costedEvent.accounting.tokens.cachedTokens
      } else {
        unknownTokenEventIds.push(costedEvent.eventId)
      }
      if (costedEvent.accounting.cost.status === 'known') {
        costUsd += costedEvent.accounting.cost.usd
      } else {
        costUsd += costedEvent.accounting.cost.knownLowerBoundUsd
        unknownCostEventIds.push(costedEvent.eventId)
      }
    }
    const accounting: SearchAccountingAudit =
      unknownTokenEventIds.length === 0 && unknownCostEventIds.length === 0
        ? {
            status: 'known',
            inputTokens,
            outputTokens,
            cachedTokens,
            costUsd,
          }
        : {
            status: 'partial',
            knownInputTokens: inputTokens,
            knownOutputTokens: outputTokens,
            knownCachedTokens: cachedTokens,
            knownCostUsd: costUsd,
            unknownTokenEventIds,
            unknownCostEventIds,
          }

    const selectedCandidateId =
      completion?.result.status === 'selected' ? completion.result.candidateId : null
    const status: SearchLedgerAudit['status'] =
      completion?.result.status === 'selected'
        ? 'selected'
        : completion?.result.status === 'all-rejected'
          ? 'all-rejected'
          : 'in-progress'
    const missingCandidateSlots = [...plannedSlots.values()]
      .filter((slot) => !candidateBySlot.has(slot.slotId) && !closedSlots.has(slot.slotId))
      .map((slot) => slot.slotId)
    const missingTaskOutcomes = planEvent ? plannedTaskOutcomeKeys(planEvent, candidates) : []
    const missingOperations = [...plannedOperations.values()]
      .filter((operation) => !operationsById.has(operation.operationId))
      .map((operation) => operation.operationId)
    return {
      entries: [...entries],
      plan: planEvent,
      planExtensions,
      candidates: candidateEvents,
      closedCandidateSlots: closedSlotEvents,
      attempts,
      operations: operationEvents,
      decisions,
      completion,
      audit: {
        campaignId,
        eventCount: entries.length,
        candidateCount: candidates.size,
        closedCandidateSlotCount: closedSlots.size,
        attemptCount: attempts.length,
        operationCount: operationEvents.length,
        outcomes: outcomeCounts,
        operationOutcomes: operationOutcomeCounts,
        decisions: {
          selected: selectedDecisions.length,
          rejected: rejectedDecisions.length,
          pending: candidates.size - decisions.length,
        },
        expected: {
          candidateSlots: plannedSlots.size,
          taskOutcomes: candidates.size * (planEvent?.plan.tasks.length ?? 0),
          operations: plannedOperations.size,
          missingCandidateSlots,
          missingTaskOutcomes,
          missingOperations,
        },
        status,
        selectedCandidateId,
        accounting,
        headHash: entries.at(-1)?.entryHash ?? null,
      },
    }
  }

  return { apply, finish }
}

/** Every candidate slot must name a planned candidate-generation operation,
 * whether it arrives with the plan or with a later extension. */
function assertSlotGenerationOperation(
  slot: SearchCandidateSlot,
  plannedOperations: ReadonlyMap<string, SearchPlannedOperation>,
): void {
  if (plannedOperations.get(slot.generationOperationId)?.kind !== 'candidate-generation') {
    throw new SearchLedgerIntegrityError(
      `candidate slot ${slot.slotId} references unplanned candidate-generation operation ${slot.generationOperationId}`,
    )
  }
}

function plannedTaskOutcomeKeys(
  planEvent: SearchPlannedEvent,
  candidates: Map<string, CandidateState>,
): string[] {
  const missing: string[] = []
  const registeredCandidates = [...candidates.values()].sort((a, b) =>
    compareStrings(a.registered.slotId, b.registered.slotId),
  )
  for (const candidate of registeredCandidates) {
    const slotId = candidate.registered.slotId
    for (const task of planEvent.plan.tasks) {
      const measured = candidate.attempts.some(
        (attempt) => attempt.task.taskId === task.taskId && attempt.outcome.status !== 'errored',
      )
      if (!measured) missing.push(`${slotId}/${task.taskId}`)
    }
  }
  return missing
}

function assertUnique(values: string[], label: string, eventId: string): void {
  if (new Set(values).size !== values.length) {
    throw new SearchLedgerIntegrityError(`event ${eventId} contains duplicate ${label} values`)
  }
}
