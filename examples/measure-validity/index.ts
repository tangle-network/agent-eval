/**
 * Find which recorded numbers predict a later outcome, on changes they were
 * not chosen on, and choose the few to climb.
 *
 * Run with: pnpm exec tsx examples/measure-validity/index.ts
 *
 * The input is a flat table, one row per change: an id, a merge time, a
 * repository, named measures (null where unmeasured) and outcomes (null until
 * their window closes). `toChange` and `toOutcomes` are the whole mapping.
 *
 * The table is generated, so the truth is known: `review_depth` and
 * `test_delta` predict whether a change is kept, `repo_size` predicts it only
 * by telling repositories apart, `review_depth_copy` duplicates `review_depth`,
 * `hotfix` is set on almost no change, and the `noise_*` measures predict nothing.
 */

import {
  type MeasureValidityPlanInput,
  sealMeasureValidityPlan,
  verifyMeasureValidityPlan,
} from '../../src/experiment'
import {
  type DeploymentOutcome,
  guardDrift,
  InMemoryOutcomeStore,
  type MeasuredChange,
  measureValidityStudy,
} from '../../src/meta-eval'
import { mulberry32 } from '../../src/statistics'

const HOUR = 3_600_000
const DAY = 24 * HOUR

// ── The table and its mapping ────────────────────────────────────────

type TableRow = Record<string, string | number | null>

const NOISE = Array.from({ length: 20 }, (_, i) => `noise_${String(i).padStart(2, '0')}`)
const MEASURES = [
  'review_depth',
  'review_depth_copy',
  'test_delta',
  'repo_size',
  'hotfix',
  ...NOISE,
]
/** Each outcome is decided when its window after the merge closes. */
const OUTCOME_WINDOWS: Record<string, number> = { kept: 14 * DAY }
/** Columns holding a measure's value before the change, where recorded. */
const BEFORE_COLUMNS: Record<string, string> = { test_delta: 'test_delta_before' }

function toChange(row: TableRow): MeasuredChange {
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

function toOutcomes(row: TableRow): DeploymentOutcome[] {
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

// ── Generated history ────────────────────────────────────────────────

const random = mulberry32(2026)
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

async function storeOf(rows: readonly TableRow[]) {
  const outcomes = new InMemoryOutcomeStore()
  for (const outcome of rows.flatMap(toOutcomes)) await outcomes.append(outcome)
  return outcomes
}

// ── 1. At the cut, register what will be tested ──────────────────────

const cut = 1000 * HOUR
const planInput: MeasureValidityPlanInput = {
  id: 'which-numbers-predict-kept-changes',
  cut,
  level: 0.05,
  outcomes: [{ id: 'kept', direction: 'higher-is-better', kind: 'binary' }],
  measures: MEASURES.map((id) => ({
    id,
    ...(id === 'test_delta' ? { noise: 0.1 } : {}),
    cost: id.startsWith('review') ? 2 : 1,
  })),
  minJoined: 100,
  minMinority: 20,
  resamples: 400,
}
const sealed = sealMeasureValidityPlan(planInput, { sealedAt: '2026-11-22T00:00:00.000Z' })
console.log(`plan digest: ${sealed.digest}`)
console.log(`seal verifies: ${verifyMeasureValidityPlan(sealed)}`)

// ── 2. Later: every change merged so far, with the outcomes whose window closed ──

const now = 2100 * HOUR
const rows = table(2100, 0, now)
const report = await measureValidityStudy({
  plan: sealed,
  changes: rows.map(toChange),
  outcomes: await storeOf(rows),
})
console.log(
  `changes: ${report.changes.preCut} before the cut, ${report.changes.postCut} after; pooled pairs tested: ${report.tested}; predicts: ${report.admitted}`,
)
for (const pair of report.pairs.filter((row) => !row.measure.startsWith('noise_'))) {
  const pooled = pair.postCut.association
  const within = pair.postCut.withinUnit
  console.log(
    [
      pair.measure.padEnd(18),
      `${pair.label}${pair.reason ? ` (${pair.reason})` : ''}`.padEnd(48),
      `AUC pooled ${pooled ? pooled.estimate.toFixed(3) : 'n/a  '}`,
      `within ${within ? within.estimate.toFixed(3) : 'n/a  '}`,
      `movement ${pair.movement?.label ?? 'not recorded'}`,
    ].join('  '),
  )
}
const coverage = report.coverage.find((row) => row.measure === 'review_depth')!
console.log(`review_depth measured on ${(100 * coverage.share).toFixed(1)}% of changes`)
const noiseAdmitted = report.pairs.filter(
  (row) => row.measure.startsWith('noise_') && row.label !== 'not-shown',
).length
console.log(`noise measures not 'not-shown': ${noiseAdmitted} of ${NOISE.length}`)

const selection = report.selections[0]!
const list = (items: readonly { measure: string; reason?: string }[]) =>
  items.map((row) => (row.reason ? `${row.measure} (${row.reason})` : row.measure)).join(', ')
console.log(`climb: ${list(selection.climb)}`)
console.log(`guards: ${list(selection.guards)}`)
console.log(`not climbable: ${list(selection.excluded)}`)
console.log(`composite AUC after cut: ${selection.composite.postCut?.estimate.toFixed(3) ?? 'n/a'}`)

// ── 3. A later batch in which the first climbed measure was pushed up without the work ──

const gamed = table(400, 2200 * HOUR, 3000 * HOUR, selection.climb[0]!.measure)
const drift = await guardDrift({
  report,
  outcome: 'kept',
  batch: gamed.map(toChange),
  outcomes: await storeOf(gamed),
  tolerance: 0.5,
})
for (const row of drift.measures) {
  const divergence = row.divergence
  console.log(
    `drift ${row.measure}: ${row.status}, rise over guards ${divergence ? `${divergence.estimate.toFixed(2)} [${divergence.low.toFixed(2)}, ${divergence.high.toFixed(2)}]` : 'n/a'}`,
  )
}
console.log(`kept-rate shift: ${drift.outcomeShift?.estimate.toFixed(3) ?? 'n/a'}`)
console.log(report.hypothesis)
console.log(`cause requires: ${report.claim.causeRequires}`)
