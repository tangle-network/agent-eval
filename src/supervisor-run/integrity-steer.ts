import { evidence, issue, MAX_EXAMPLES } from './integrity-issues'
import type { JoinedWorker } from './integrity-source'
import type { SupervisorRunIntegrityIssue } from './integrity-types'

function idListDetail(ids: readonly string[]): string {
  const examples = ids
    .slice(0, MAX_EXAMPLES)
    .map((id) => JSON.stringify(id))
    .join(', ')
  return ids.length <= MAX_EXAMPLES
    ? examples
    : `${examples}, and ${ids.length - MAX_EXAMPLES} more`
}

export function steerIssues(
  joined: JoinedWorker,
  rootCompleted: boolean,
): SupervisorRunIntegrityIssue[] {
  const { facts } = joined
  const subject = facts.workerId ?? joined.spawn.id
  const prefix = `workers/${facts.sourceIndex}`
  const out: SupervisorRunIntegrityIssue[] = []
  if (
    !facts.inboxCaptured ||
    !facts.eventsCaptured ||
    facts.inboxInvalidRows > 0 ||
    facts.eventsInvalidRows > 0
  ) {
    const missing = [
      ...(facts.inboxCaptured ? [] : ['inbox']),
      ...(facts.eventsCaptured ? [] : ['events']),
    ]
    const malformed = [
      ...(facts.inboxInvalidRows > 0 ? [`inbox:${facts.inboxInvalidRows}`] : []),
      ...(facts.eventsInvalidRows > 0 ? [`events:${facts.eventsInvalidRows}`] : []),
    ]
    out.push(
      issue({
        code: 'worker-controls-unavailable',
        area: 'capture-integrity',
        severity: 'medium',
        subject,
        claim:
          'Steer delivery integrity is unavailable for a worker with missing control artifacts',
        detail:
          missing.length > 0
            ? `${JSON.stringify(subject)} is missing ${missing.join(' and ')}.`
            : `${JSON.stringify(subject)} has malformed control rows (${malformed.join(', ')}).`,
        evidence: [
          ...missing.map((artifact) => evidence(`${prefix}/${artifact}`, null)),
          ...(facts.inboxInvalidRows > 0
            ? [evidence(`${prefix}/inbox/malformed-rows/count`, facts.inboxInvalidRows)]
            : []),
          ...(facts.eventsInvalidRows > 0
            ? [evidence(`${prefix}/events/malformed-rows/count`, facts.eventsInvalidRows)]
            : []),
        ],
        recommendedAction:
          'Retain both control artifacts and repair malformed rows before correlating requests.',
        metadata: {
          assessment: 'unavailable',
          missing_artifacts: missing,
          malformed_rows: malformed,
        },
      }),
    )
    return out
  }

  const requestsById = new Map<string, typeof facts.steerRequests>()
  const unidentifiedRequests = facts.steerRequests.filter((request) => request.requestId === null)
  for (const request of facts.steerRequests) {
    if (request.requestId === null) continue
    const rows = requestsById.get(request.requestId) ?? []
    rows.push(request)
    requestsById.set(request.requestId, rows)
  }
  if (unidentifiedRequests.length > 0) {
    out.push(
      issue({
        code: 'steer-request-id-unavailable',
        area: 'capture-integrity',
        severity: 'high',
        subject,
        claim: 'Some queued steer requests cannot be correlated because their ids are missing',
        detail: `${unidentifiedRequests.length} queued request(s) omit id.`,
        evidence: unidentifiedRequests
          .slice(0, MAX_EXAMPLES)
          .map((request) => evidence(`${prefix}/inbox/${request.row}/id`, null)),
        recommendedAction: 'Assign one stable request id before appending a steer to the inbox.',
        metadata: { assessment: 'unavailable', unavailable_count: unidentifiedRequests.length },
      }),
    )
  }
  const duplicateRequestIds = [...requestsById]
    .filter(([, rows]) => rows.length > 1)
    .map(([id]) => id)
  if (duplicateRequestIds.length > 0) {
    out.push(
      issue({
        code: 'duplicate-steer-request-id',
        area: 'control-integrity',
        severity: 'high',
        subject,
        claim: 'A worker inbox contains duplicate steer request ids',
        detail: `${duplicateRequestIds.length} duplicate id(s): ${idListDetail(duplicateRequestIds)}.`,
        evidence: [
          evidence(
            `${prefix}/inbox/duplicate-request-ids`,
            duplicateRequestIds.slice(0, MAX_EXAMPLES),
          ),
        ],
        recommendedAction: 'Generate a unique request id for every queued steer.',
      }),
    )
  }

  const acknowledgementsById = new Map<string, typeof facts.steerAcknowledgements>()
  const unidentifiedAcks = facts.steerAcknowledgements.filter((ack) => ack.requestId === null)
  for (const ack of facts.steerAcknowledgements) {
    if (ack.requestId === null) continue
    const rows = acknowledgementsById.get(ack.requestId) ?? []
    rows.push(ack)
    acknowledgementsById.set(ack.requestId, rows)
  }
  if (unidentifiedAcks.length > 0) {
    out.push(
      issue({
        code: 'steer-ack-id-unavailable',
        area: 'capture-integrity',
        severity: 'high',
        subject,
        claim: 'Some steer acknowledgements cannot be correlated because requestId is missing',
        detail: `${unidentifiedAcks.length} down-leg event(s) omit requestId.`,
        evidence: unidentifiedAcks
          .slice(0, MAX_EXAMPLES)
          .map((ack) => evidence(`${prefix}/events/${ack.row}/requestId`, null)),
        recommendedAction: 'Echo the queued request id on every worker acknowledgement.',
        metadata: { assessment: 'unavailable', unavailable_count: unidentifiedAcks.length },
      }),
    )
  }

  const unknownAckIds = [...acknowledgementsById.keys()].filter((id) => !requestsById.has(id))
  if (unknownAckIds.length > 0) {
    out.push(
      issue({
        code: 'unknown-steer-ack',
        area: 'control-integrity',
        severity: 'high',
        subject,
        claim: 'A worker acknowledged steer request ids absent from its captured inbox',
        detail: `${unknownAckIds.length} unknown id(s): ${idListDetail(unknownAckIds)}.`,
        evidence: [
          evidence(`${prefix}/events/unknown-request-ids`, unknownAckIds.slice(0, MAX_EXAMPLES)),
        ],
        recommendedAction:
          'Reject acknowledgements whose request id was not queued for this worker.',
      }),
    )
  }

  const duplicateAckIds = [...acknowledgementsById]
    .filter(([, rows]) => rows.length > 1)
    .map(([id]) => id)
  if (duplicateAckIds.length > 0) {
    out.push(
      issue({
        code: 'duplicate-steer-ack',
        area: 'control-integrity',
        severity: 'high',
        subject,
        claim: 'A worker emitted duplicate acknowledgements for steer request ids',
        detail: `${duplicateAckIds.length} duplicated id(s): ${idListDetail(duplicateAckIds)}.`,
        evidence: [
          evidence(
            `${prefix}/events/duplicate-request-ids`,
            duplicateAckIds.slice(0, MAX_EXAMPLES),
          ),
        ],
        recommendedAction: 'Make steer acknowledgement append idempotent by request id.',
      }),
    )
  }

  const missingAckIds = [...requestsById.keys()].filter((id) => !acknowledgementsById.has(id))
  if (rootCompleted && missingAckIds.length > 0) {
    out.push(
      issue({
        code: 'missing-steer-ack',
        area: 'control-integrity',
        severity: 'high',
        subject,
        claim: 'A completed supervisor run has queued steer requests without acknowledgements',
        detail: `${missingAckIds.length}/${requestsById.size} request id(s) are unacknowledged: ${idListDetail(missingAckIds)}.`,
        evidence: [
          evidence(
            `${prefix}/inbox/unacknowledged-request-ids`,
            missingAckIds.slice(0, MAX_EXAMPLES),
          ),
        ],
        recommendedAction:
          'Record one delivered or failed acknowledgement for every queued request id.',
      }),
    )
  }

  const statusUnavailableIds: string[] = []
  const notDeliveredIds: string[] = []
  for (const [id, acknowledgements] of acknowledgementsById) {
    if (!requestsById.has(id) || acknowledgements.length !== 1) continue
    const delivered = acknowledgements[0]?.delivered
    if (delivered === null || delivered === undefined) statusUnavailableIds.push(id)
    else if (!delivered) notDeliveredIds.push(id)
  }
  if (statusUnavailableIds.length > 0) {
    out.push(
      issue({
        code: 'steer-ack-status-unavailable',
        area: 'capture-integrity',
        severity: 'high',
        subject,
        claim: 'Some steer acknowledgements omit delivery status',
        detail: `${statusUnavailableIds.length} id(s): ${idListDetail(statusUnavailableIds)}.`,
        evidence: [
          evidence(
            `${prefix}/events/status-unavailable-request-ids`,
            statusUnavailableIds.slice(0, MAX_EXAMPLES),
          ),
        ],
        recommendedAction: 'Record delivered: true or delivered: false on each acknowledgement.',
        metadata: { assessment: 'unavailable', unavailable_count: statusUnavailableIds.length },
      }),
    )
  }
  if (notDeliveredIds.length > 0) {
    out.push(
      issue({
        code: 'steer-not-delivered',
        area: 'control-integrity',
        severity: 'high',
        subject,
        claim: 'Queued steer requests were acknowledged but not delivered',
        detail: `${notDeliveredIds.length} id(s): ${idListDetail(notDeliveredIds)}.`,
        evidence: [
          evidence(
            `${prefix}/events/not-delivered-request-ids`,
            notDeliveredIds.slice(0, MAX_EXAMPLES),
          ),
        ],
        recommendedAction:
          'Retry or explicitly fail the control request instead of treating it as delivered.',
      }),
    )
  }
  return out
}
