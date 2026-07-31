import { evidence, issue, MAX_EXAMPLES } from './integrity-issues'
import { steerIssues } from './integrity-steer'
import type { SupervisorRunIntegrityIssue } from './integrity-types'
import type { SpawnRow, SupervisorTreeFacts, WorkerLogFacts } from './source-facts'
import type { SupervisorRunSources, SupervisorRunTree } from './types'

function sourceIdentityIssues(facts: SupervisorTreeFacts): SupervisorRunIntegrityIssue[] {
  const out: SupervisorRunIntegrityIssue[] = []
  const malformedSpawns = facts.spawns.filter((spawn) => !spawn.valid)
  if (facts.journalInvalidRows > 0 || malformedSpawns.length > 0) {
    out.push(
      issue({
        code: 'source-row-malformed',
        area: 'capture-integrity',
        severity: 'high',
        subject: 'journal-rows',
        claim: 'Some supervisor journal rows could not be interpreted',
        detail: `${facts.journalInvalidRows} of ${facts.journalRows} row(s) could not be interpreted (${facts.journalMalformedJsonRows} were not JSON objects) and ${malformedSpawns.length} malformed spawn row(s) were excluded from structural conclusions.`,
        evidence: [
          evidence('journal/uninterpretable-rows/count', facts.journalInvalidRows),
          evidence('journal/malformed-json-rows/count', facts.journalMalformedJsonRows),
          evidence('journal/rows/count', facts.journalRows),
          evidence('journal/dialect', facts.journalDialect),
          ...malformedSpawns
            .slice(0, MAX_EXAMPLES)
            .map((spawn) =>
              evidence(`journal/spawns/${spawn.sourceRow}/invalid-fields`, spawn.invalidFields),
            ),
        ],
        recommendedAction:
          'Repair the rows, or teach the parser the shape they are in, before using the run for structural analysis. A row nobody can read must never be silently absent from the tree.',
        metadata: {
          assessment: 'unavailable',
          journal_rows: facts.journalRows,
          uninterpretable_rows: facts.journalInvalidRows,
          malformed_json_rows: facts.journalMalformedJsonRows,
          malformed_spawn_rows: malformedSpawns.length,
          journal_dialect: facts.journalDialect,
        },
      }),
    )
  }
  const unidentifiedSpawns = malformedSpawns.filter((spawn) => spawn.id.length === 0)
  const unidentifiedCloses = facts.closes.filter((close) => close.id.length === 0)
  if (unidentifiedSpawns.length + unidentifiedCloses.length > 0) {
    out.push(
      issue({
        code: 'source-event-identity-unavailable',
        area: 'capture-integrity',
        severity: 'high',
        subject: 'journal-event-identity',
        claim: 'Some supervisor journal events have no usable invocation id',
        detail: `${unidentifiedSpawns.length} spawn and ${unidentifiedCloses.length} terminal event(s) lack an id.`,
        evidence: [
          evidence('journal/unidentified-spawns/count', unidentifiedSpawns.length),
          evidence('journal/unidentified-terminals/count', unidentifiedCloses.length),
        ],
        recommendedAction: 'Reject or repair control events that omit their stable invocation id.',
        metadata: { assessment: 'unavailable', checks: ['journal-event-linkage'] },
      }),
    )
  }

  const spawnCounts = new Map<string, number>()
  for (const spawn of facts.spawns) {
    if (!spawn.valid || spawn.id.length === 0) continue
    spawnCounts.set(spawn.id, (spawnCounts.get(spawn.id) ?? 0) + 1)
  }
  for (const [id, count] of spawnCounts) {
    if (count < 2) continue
    out.push(
      issue({
        code: 'duplicate-spawn',
        area: 'control-integrity',
        severity: 'critical',
        subject: id,
        claim: 'An invocation has more than one spawned control event',
        detail: `${count} spawned events name invocation ${JSON.stringify(id)}.`,
        evidence: [evidence(`journal/spawn-count/${encodeURIComponent(id)}`, count)],
        recommendedAction: 'Make spawn event append idempotent.',
      }),
    )
  }

  const closeCounts = new Map<string, number>()
  for (const close of facts.closes) {
    if (close.id.length === 0) continue
    closeCounts.set(close.id, (closeCounts.get(close.id) ?? 0) + 1)
  }
  const uncertainSpawnIds = new Set(
    malformedSpawns.filter((spawn) => spawn.id.length > 0).map((spawn) => spawn.id),
  )
  if (unidentifiedSpawns.length === 0 && facts.journalInvalidRows === 0) {
    const orphanCloses = new Map<string, Array<(typeof facts.closes)[number]>>()
    for (const close of facts.closes) {
      if (close.id.length === 0 || spawnCounts.has(close.id) || uncertainSpawnIds.has(close.id)) {
        continue
      }
      const rows = orphanCloses.get(close.id) ?? []
      rows.push(close)
      orphanCloses.set(close.id, rows)
    }
    for (const [id, closes] of orphanCloses) {
      out.push(
        issue({
          code: 'orphan-terminal',
          area: 'control-integrity',
          severity: 'critical',
          subject: id,
          claim: 'A terminal control event names an invocation that was never spawned',
          detail: `${closes.length} terminal event(s) for ${JSON.stringify(id)} have no matching spawn.`,
          evidence: [
            evidence(`journal/closes/${encodeURIComponent(id)}/count`, closes.length),
            ...closes
              .slice(0, MAX_EXAMPLES)
              .map((close, index) =>
                evidence(`journal/closes/${encodeURIComponent(id)}/${index}`, close),
              ),
          ],
          recommendedAction: 'Retain the matching spawn event or reject the orphan terminal event.',
        }),
      )
    }
  }
  for (const [id, count] of closeCounts) {
    if (count < 2) continue
    out.push(
      issue({
        code: 'duplicate-terminal',
        area: 'control-integrity',
        severity: 'critical',
        subject: id,
        claim: 'An invocation has more than one terminal control event',
        detail: `${count} settled/cancelled events name invocation ${JSON.stringify(id)}.`,
        evidence: [evidence(`journal/terminal-count/${encodeURIComponent(id)}`, count)],
        recommendedAction: 'Make terminal event append idempotent.',
      }),
    )
  }
  return out
}

export interface JoinedWorker {
  readonly spawn: SpawnRow
  readonly facts: WorkerLogFacts
}

function joinWorkerControls(facts: SupervisorTreeFacts): {
  joined: JoinedWorker[]
  issue: SupervisorRunIntegrityIssue | null
} {
  const spawnsById = new Map<string, SpawnRow[]>()
  const spawnsByLabel = new Map<string, SpawnRow[]>()
  for (const spawn of facts.workerSpawns) {
    const ids = spawnsById.get(spawn.id) ?? []
    ids.push(spawn)
    spawnsById.set(spawn.id, ids)
    const labels = spawnsByLabel.get(spawn.label) ?? []
    labels.push(spawn)
    spawnsByLabel.set(spawn.label, labels)
  }
  const rowsWithoutIdByLabel = new Map<string, WorkerLogFacts[]>()
  for (const row of facts.workerLogRows) {
    if (row.workerId !== null && row.workerId.length > 0) continue
    const matches = rowsWithoutIdByLabel.get(row.label) ?? []
    matches.push(row)
    rowsWithoutIdByLabel.set(row.label, matches)
  }

  const rowsBySpawn = new Map<string, WorkerLogFacts[]>()
  const unmatchedRows: number[] = []
  const ambiguousRows: number[] = []
  for (const row of facts.workerLogRows) {
    const matches =
      row.workerId !== null && row.workerId.length > 0
        ? (spawnsById.get(row.workerId) ?? [])
        : (rowsWithoutIdByLabel.get(row.label)?.length ?? 0) === 1
          ? (spawnsByLabel.get(row.label) ?? [])
          : []
    if (matches.length === 0) {
      unmatchedRows.push(row.sourceIndex)
      continue
    }
    if (matches.length !== 1) {
      ambiguousRows.push(row.sourceIndex)
      continue
    }
    const spawn = matches[0] as SpawnRow
    const joined = rowsBySpawn.get(spawn.id) ?? []
    joined.push(row)
    rowsBySpawn.set(spawn.id, joined)
  }

  const joined: JoinedWorker[] = []
  const missingSpawnIds: string[] = []
  const duplicateSpawnIds: string[] = []
  for (const spawn of facts.workerSpawns) {
    if ((spawnsById.get(spawn.id)?.length ?? 0) !== 1) continue
    const rows = rowsBySpawn.get(spawn.id) ?? []
    if (rows.length === 0) missingSpawnIds.push(spawn.id)
    else if (rows.length > 1) duplicateSpawnIds.push(spawn.id)
    else joined.push({ spawn, facts: rows[0] as WorkerLogFacts })
  }

  if (
    missingSpawnIds.length === 0 &&
    duplicateSpawnIds.length === 0 &&
    unmatchedRows.length === 0 &&
    ambiguousRows.length === 0
  ) {
    return { joined, issue: null }
  }
  return {
    joined,
    issue: issue({
      code: 'worker-control-join-unavailable',
      area: 'capture-integrity',
      severity: 'high',
      subject: 'worker-control-join',
      claim: 'Worker control-log coverage does not match recorded child invocations',
      detail: `${missingSpawnIds.length} spawn(s) have no log, ${duplicateSpawnIds.length} have duplicate logs, ${unmatchedRows.length} log row(s) match no spawn, and ${ambiguousRows.length} row(s) are ambiguous.`,
      evidence: [
        evidence('workers/join/missing-spawn-ids', missingSpawnIds.slice(0, MAX_EXAMPLES)),
        evidence('workers/join/duplicate-spawn-ids', duplicateSpawnIds.slice(0, MAX_EXAMPLES)),
        evidence('workers/join/unmatched-source-rows', unmatchedRows.slice(0, MAX_EXAMPLES)),
        evidence('workers/join/ambiguous-source-rows', ambiguousRows.slice(0, MAX_EXAMPLES)),
      ],
      recommendedAction:
        'Retain exactly one worker control row with workerId for every spawned invocation.',
      metadata: {
        assessment: 'unavailable',
        missing_count: missingSpawnIds.length,
        duplicate_count: duplicateSpawnIds.length,
        unmatched_count: unmatchedRows.length,
        ambiguous_count: ambiguousRows.length,
      },
    }),
  }
}

export function sourceIssues(
  source: SupervisorRunSources,
  facts: SupervisorTreeFacts,
  tree: SupervisorRunTree,
): SupervisorRunIntegrityIssue[] {
  const out = sourceIdentityIssues(facts)
  if (source.workers === null) {
    const reason = source.workersMissingReason ?? 'worker control-log store was not captured'
    out.push(
      issue({
        code: 'worker-controls-unavailable',
        area: 'capture-integrity',
        severity: 'medium',
        subject: 'steer-delivery',
        claim:
          'Steer delivery integrity is unavailable because worker control logs were not captured',
        detail: reason,
        evidence: [evidence('sources/workers', null)],
        recommendedAction: 'Retain each worker inbox and event stream.',
        metadata: { assessment: 'unavailable', reason },
      }),
    )
    return out
  }

  const joined = joinWorkerControls(facts)
  if (joined.issue !== null) out.push(joined.issue)
  const rootCompleted =
    tree.rootId !== null &&
    tree.nodes.filter((node) => node.rollout_id === tree.rootId).length === 1 &&
    tree.nodes.find((node) => node.rollout_id === tree.rootId)?.outcome.is_completed === true
  for (const row of joined.joined) out.push(...steerIssues(row, rootCompleted))
  return out
}
