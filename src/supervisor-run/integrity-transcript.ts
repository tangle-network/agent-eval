import { evidence, issue, MAX_EXAMPLES } from './integrity-issues'
import type { SupervisorRunIntegrityIssue } from './integrity-types'
import type { SupervisorTreeFacts } from './source-facts'
import type { SupervisorRunSources, WorkerLogSource } from './types'

/**
 * Transcript coverage a tree row cannot show: turns a closed worker dispatched whose record was
 * not retained, and native harness sessions the store has no copy of. Both are judged only for
 * workers with a terminal event, because a live worker's current turn and session are still
 * being written. A worker whose store records neither fact is not counted either way.
 */
export function transcriptIssues(
  source: SupervisorRunSources,
  facts: SupervisorTreeFacts,
): SupervisorRunIntegrityIssue[] {
  if (source.workers === null) return []
  const closed = new Set(facts.closes.map((close) => close.id).filter((id) => id.length > 0))
  const closedWorkers = source.workers.filter(
    (worker): worker is WorkerLogSource & { workerId: string } =>
      worker.workerId !== undefined && closed.has(worker.workerId),
  )
  const out: SupervisorRunIntegrityIssue[] = []

  const lost = closedWorkers.flatMap((worker) => {
    const turns = worker.turns
    if (turns == null || turns.retained >= turns.dispatched) return []
    return [{ id: worker.workerId, lost: turns.dispatched - turns.retained, turns }]
  })
  if (lost.length > 0) {
    const lostTurns = lost.reduce((sum, row) => sum + row.lost, 0)
    out.push(
      issue({
        code: 'transcript-incomplete',
        area: 'capture-integrity',
        severity: 'medium',
        subject: 'turn-transcripts',
        claim: 'Some closed workers dispatched turns whose record was not retained',
        detail: `${lost.length}/${closedWorkers.length} closed worker(s) lost ${lostTurns} dispatched turn record(s).`,
        evidence: [
          evidence('capture/lost-turns/count', lostTurns),
          ...lost
            .slice(0, MAX_EXAMPLES)
            .map((row) => evidence(`workers/${encodeURIComponent(row.id)}/turns`, row.turns)),
        ],
        recommendedAction:
          "Persist each turn's output before the worker settles, including a turn that ends in failure.",
        metadata: {
          assessment: 'unavailable',
          unavailable_count: lost.length,
          lost_turns: lostTurns,
        },
      }),
    )
  }

  const unavailable = closedWorkers.flatMap((worker) =>
    worker.nativeSession?.status === 'unavailable'
      ? [{ id: worker.workerId, reason: worker.nativeSession.reason }]
      : [],
  )
  if (unavailable.length > 0) {
    const reasons: Record<string, number> = {}
    for (const row of unavailable) reasons[row.reason] = (reasons[row.reason] ?? 0) + 1
    out.push(
      issue({
        code: 'native-session-unavailable',
        area: 'capture-integrity',
        severity: 'medium',
        subject: 'native-harness-sessions',
        claim: 'Some closed workers have no retained native harness session',
        detail: `${unavailable.length}/${closedWorkers.length} closed worker(s) have no native session; reasons: ${Object.entries(
          reasons,
        )
          .map(([reason, count]) => `${reason} ${count}`)
          .join(', ')}. What their harness-native subagents did is unobserved.`,
        evidence: [
          evidence('capture/native-sessions-unavailable/reasons', reasons),
          ...unavailable
            .slice(0, MAX_EXAMPLES)
            .map((row) =>
              evidence(`workers/${encodeURIComponent(row.id)}/nativeSession/reason`, row.reason),
            ),
        ],
        recommendedAction:
          'Capture the harness session store from the box before it is released, at the path the harness actually wrote.',
        metadata: { assessment: 'unavailable', unavailable_count: unavailable.length, reasons },
      }),
    )
  }
  return out
}
