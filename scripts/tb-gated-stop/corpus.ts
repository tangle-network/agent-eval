import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { type EvidenceRecord } from '../../src/experiment'
import { stratumOf } from '../../src/trace-repair/admission-records'
import { WORK, ROWS_PATH } from './settings'

// ── Rows ─────────────────────────────────────────────────────────────

export interface CorpusRow {
  rowId: string
  taskName: string
  recordedModel: string
  trialName: string
  trialId: string
  recordedCommands: number
  placeholderCommands: number
  formatErrorTurns: number
  unknownReturncodes: number
  unknownRatio: number
  finalReturncode: number | null
  finalOutcome: string
  endedOnSubmitSentinel: boolean
  imageLocal: boolean
  /** The task's image is pinned by digest in the checked-in lock. */
  imagePinned: boolean
  steps: { step_id: number; action: string; observation: string | null }[]
}

export function loadCorpus(): CorpusRow[] {
  return JSON.parse(readFileSync(ROWS_PATH, 'utf8')) as CorpusRow[]
}

/** The evidence record the sealed admission funnel reads. Never the outcome. */
export function admissionRecord(
  row: CorpusRow,
  clusterSize: number,
  recordedEndStateFails: boolean,
  canonicalTrialRow: boolean,
  prefixDivergenceRatio: number,
): EvidenceRecord {
  return {
    rowId: row.rowId,
    taskName: row.taskName,
    placeholderCommands: row.placeholderCommands,
    finalReturncodeKnown: row.finalReturncode !== null,
    stratum: stratumOf(row.finalReturncode) ?? 'unreadable',
    unknownRatio: row.unknownRatio,
    recordedCommands: row.recordedCommands,
    imagePinned: row.imagePinned,
    canonicalTrialRow,
    prefixDivergenceRatio,
    clusterSize,
    recordedEndStateFails,
  }
}

/**
 * Row ids the dump holds twice.
 *
 * 885 mini-swe-agent trials appear in the published dump under both an empty
 * and a populated trial id, and the two copies are the same recorded run. A
 * cluster that pairs them carries one trajectory twice, which the bootstrap
 * reads as two independent rows. The copy carrying the trial id is canonical
 * because it identifies the run; the other is dropped.
 */
export function canonicalTrialRowIds(rows: readonly CorpusRow[]): Set<string> {
  const canonical = new Map<string, CorpusRow>()
  for (const row of rows) {
    const trial = `${row.taskName}::${row.trialName}`
    const held = canonical.get(trial)
    if (held === undefined || (row.trialId !== '' && held.trialId === '')) canonical.set(trial, row)
  }
  return new Set([...canonical.values()].map((row) => row.rowId))
}

/** What the end-state screen measured about one row. */
export interface EndStateMeasurement {
  endStatePassed: boolean
  replayedCommands: number
  replayDivergences: number
}

/**
 * What the end-state screen measured, by row id.
 *
 * A row whose end state already passes cannot measure a repair — every arm
 * wins it for free — so it is excluded. A row the screen has not reached is
 * excluded too, and so is a row whose screen hit a boundary failure: neither
 * produced a verdict, and an unmeasured row that reads as failing is admitted
 * on a check that never ran.
 */
export function endStateScreen(): Record<string, EndStateMeasurement> {
  try {
    return JSON.parse(readFileSync(join(WORK, 'end-state-screen.json'), 'utf8')) as Record<
      string,
      EndStateMeasurement
    >
  } catch {
    return {}
  }
}

/** Share of replayed steps whose exit differed from the recording. */
export function divergenceRatio(measurement: EndStateMeasurement | undefined): number {
  if (measurement === undefined || measurement.replayedCommands === 0) return 1
  return measurement.replayDivergences / measurement.replayedCommands
}

// ── Entry points ─────────────────────────────────────────────────────

/**
 * Row ids the pilot already ran on.
 *
 * The pilot wrote ids under the corpus's earlier key, which named a trial by
 * its name alone. Names repeat across trials, so an exposed id resolves to
 * every current id that extends it — the conservative reading, which excludes
 * a sibling rather than risk reusing an exposed trajectory.
 */
export function pilotExposedRowIds(currentIds: readonly string[]): string[] {
  const recorded = new Set<string>()
  for (const file of ['pilot.json', 'mechanism-pilot.json']) {
    let parsed: { results?: { rowId?: string }[] }
    try {
      parsed = JSON.parse(readFileSync(join(WORK, file), 'utf8')) as { results?: { rowId?: string }[] }
    } catch {
      continue
    }
    for (const result of parsed.results ?? []) if (result.rowId) recorded.add(result.rowId)
  }
  return currentIds
    .filter((id) => [...recorded].some((exposedId) => id === exposedId || id.startsWith(`${exposedId}::`)))
    .sort()
}
