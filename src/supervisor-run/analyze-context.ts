import { parseJsonRecord, parseSupervisorTree, type SpawnRow } from './source-facts'
import { readTerminalRecord } from './terminal-record'
import { type SupervisorRunSources, type Unavailable, unavailable } from './types'

/** The parsed sources and shared lookups every metric group reads. `gap` records an unavailable measurement on the report. */
export function createAnalysis(src: SupervisorRunSources) {
  const gaps: string[] = []
  const gap = (what: string, reason: string): Unavailable => {
    gaps.push(`${what}: ${reason}`)
    return unavailable(reason)
  }

  const journalMissing =
    src.journalMissingReason ??
    (src.supRunDir === null ? 'no Runtime supervisor run directory' : 'journal.jsonl absent')
  const haveJournal = src.journal !== null
  const tree = parseSupervisorTree(src)
  const state = tree.state
  const result = parseJsonRecord(src.result)
  const judge = parseJsonRecord(src.judge)
  // Runtime's terminal record is named on the report so a status never arrives unlabeled.
  const terminal = readTerminalRecord({
    state,
    result,
    failure: src.failure === undefined ? undefined : parseJsonRecord(src.failure),
  })
  const { rootId, workerSpawns, workerCloses, startedAt, completedAt } = tree
  const rootSpawn =
    rootId === null ? null : (tree.spawns.find((spawn) => spawn.id === rootId) ?? null)
  const spawnById = new Map(workerSpawns.map((spawn) => [spawn.id, spawn]))
  const spawnsByLabel = new Map<string, SpawnRow[]>()
  for (const spawn of workerSpawns) {
    const matches = spawnsByLabel.get(spawn.label) ?? []
    matches.push(spawn)
    spawnsByLabel.set(spawn.label, matches)
  }
  const spawnsForSource = (
    worker: NonNullable<SupervisorRunSources['workers']>[number],
  ): readonly SpawnRow[] => {
    if (worker.workerId === undefined) return spawnsByLabel.get(worker.label) ?? []
    const spawn = spawnById.get(worker.workerId)
    return spawn === undefined ? [] : [spawn]
  }
  const spawnForSource = (
    worker: NonNullable<SupervisorRunSources['workers']>[number],
  ): SpawnRow | null => {
    const matches = spawnsForSource(worker)
    return matches.length === 1 ? (matches[0] ?? null) : null
  }
  const closeById = new Map(workerCloses.map((close) => [close.id, close]))
  const workersGapReason = src.workersMissingReason ?? 'workers/ directory absent'
  return {
    src,
    gaps,
    gap,
    journalMissing,
    haveJournal,
    tree,
    state,
    result,
    judge,
    terminal,
    rootId,
    rootSpawn,
    workerSpawns,
    workerCloses,
    startedAt,
    completedAt,
    spawnsForSource,
    spawnForSource,
    closeById,
    workersGapReason,
  }
}

export type Analysis = ReturnType<typeof createAnalysis>
