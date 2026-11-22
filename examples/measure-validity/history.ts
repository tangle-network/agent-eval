/**
 * The generated history the measure validity example reads: a flat table, one
 * row per change, and its mapping into changes and outcomes. A test replays the
 * same table, so it lives apart from the example's script.
 *
 * Each row has an id, a merge time, a repository, named measures (null where
 * unmeasured) and outcomes (null until their window closes). `toChange` and
 * `toOutcomes` are the whole mapping.
 */

import {
  type DeploymentOutcome,
  InMemoryOutcomeStore,
  type MeasuredChange,
} from '../../src/meta-eval'
import { mulberry32 } from '../../src/statistics'

export const HOUR = 3_600_000
export const DAY = 24 * HOUR

export type TableRow = Record<string, string | number | null>

export const NOISE = Array.from({ length: 20 }, (_, i) => `noise_${String(i).padStart(2, '0')}`)
export const MEASURES = [
  'review_depth',
  'review_depth_copy',
  'test_delta',
  'repo_size',
  'hotfix',
  ...NOISE,
]
/** Each outcome is decided when its window after the merge closes. */
export const OUTCOME_WINDOWS: Record<string, number> = { kept: 14 * DAY }
/** Columns holding a measure's value before the change, where recorded. */
const BEFORE_COLUMNS: Record<string, string> = { test_delta: 'test_delta_before' }

export function toChange(row: TableRow): MeasuredChange {
  const measures: Record<string, number> = {}
  const movements: Record<string, { before: number; after: number }> = {}
  for (const measure of MEASURES) {
    const value = row[measure]
    if (typeof value === 'number') measures[measure] = value
    const before = BEFORE_COLUMNS[measure] === undefined ? null : row[BEFORE_COLUMNS[measure]]
    if (typeof value === 'number' && typeof before === 'number') {
      movements[measure] = { before, after: value }
    }
  }
  return {
    id: String(row.id),
    at: Number(row.merged_at),
    unit: String(row.repository),
    measures,
    movements,
  }
}

export function toOutcomes(row: TableRow): DeploymentOutcome[] {
  return Object.entries(OUTCOME_WINDOWS).flatMap(([outcome, window]) => {
    const value = row[outcome]
    return typeof value === 'number'
      ? [
          {
            runId: String(row.id),
            capturedAt: Number(row.merged_at) + window,
            metrics: { [outcome]: value },
          },
        ]
      : []
  })
}

export async function storeOf(rows: readonly TableRow[]) {
  const outcomes = new InMemoryOutcomeStore()
  for (const outcome of rows.flatMap(toOutcomes)) await outcomes.append(outcome)
  return outcomes
}

/**
 * The truth is known: `review_depth` and `test_delta` predict whether a change
 * is kept, `repo_size` predicts it only by telling repositories apart,
 * `review_depth_copy` duplicates `review_depth`, `hotfix` is set on almost no
 * change, and the `noise_*` measures predict nothing. Successive `table` calls
 * continue one seeded stream.
 */
export function generatedHistory(seed = 2026) {
  const random = mulberry32(seed)
  const normal = () =>
    Math.sqrt(-2 * Math.log(Math.max(random(), Number.EPSILON))) * Math.cos(2 * Math.PI * random())
  const repositories = Array.from({ length: 60 }, (_, i) => ({ name: `repo-${i}`, size: normal() }))

  /** One merge an hour across 60 repositories; `now` hides outcomes whose window has not closed. */
  function table(count: number, start: number, now: number, gamed?: string): TableRow[] {
    return Array.from({ length: count }, (_, i) => {
      const mergedAt = start + i * HOUR
      const repository = repositories[Math.floor(random() * repositories.length)]!
      const quality = normal()
      const testsBefore = normal()
      const testsAdded = normal()
      const reviewDepth = quality + 0.6 * normal()
      const row: TableRow = {
        id: `${start}-${i}`,
        merged_at: mergedAt,
        repository: repository.name,
        review_depth: random() < 0.9 ? reviewDepth : null,
        review_depth_copy: reviewDepth + 0.02 * normal(),
        test_delta_before: testsBefore,
        test_delta: testsBefore + testsAdded,
        repo_size: repository.size,
        hotfix: i % 97 === 0 ? 1 : 0,
      }
      for (const id of NOISE) row[id] = normal()
      const pushed = gamed === undefined ? undefined : row[gamed]
      if (gamed && typeof pushed === 'number') row[gamed] = pushed + 2
      const logit = 1.5 * quality + 1.2 * testsAdded - 0.8 * repository.size
      const kept = random() < 1 / (1 + Math.exp(-logit)) ? 1 : 0
      row.kept = mergedAt + OUTCOME_WINDOWS.kept! <= now ? kept : null
      return row
    })
  }
  return { table }
}
