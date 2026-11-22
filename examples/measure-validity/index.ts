/**
 * Find which recorded numbers predict a later outcome, on changes they were
 * not chosen on, and choose the few to climb.
 *
 * Run with: pnpm exec tsx examples/measure-validity/index.ts
 *
 * The input is the flat table in `history.ts`, one row per change, generated so
 * the truth is known: `review_depth` and `test_delta` predict whether a change
 * is kept, `repo_size` predicts it only by telling repositories apart,
 * `review_depth_copy` duplicates `review_depth`, `hotfix` is set on almost no
 * change, and the `noise_*` measures predict nothing.
 */

import {
  type MeasureValidityPlanInput,
  sealMeasureValidityPlan,
  verifyMeasureValidityPlan,
} from '../../src/experiment'
import { guardDrift, measureValidityStudy } from '../../src/meta-eval'
import {
  generatedHistory,
  HOUR,
  MEASURES,
  NOISE,
  OUTCOME_WINDOWS,
  storeOf,
  toChange,
} from './history'

const history = generatedHistory()

// ── 1. At the cut, register what will be tested ──────────────────────

const cut = 1000 * HOUR
const planInput: MeasureValidityPlanInput = {
  id: 'which-numbers-predict-kept-changes',
  cut,
  level: 0.05,
  // Declare the window: a change before the cut counts only once its window has closed.
  outcomes: [
    { id: 'kept', direction: 'higher-is-better', kind: 'binary', windowMs: OUTCOME_WINDOWS.kept! },
  ],
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
const rows = history.table(2100, 0, now)
const report = await measureValidityStudy({
  plan: sealed,
  changes: rows.map(toChange),
  outcomes: await storeOf(rows),
  // When the outcomes were read: a change after the cut counts once its window closed by then.
  asOf: now,
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

const gamed = history.table(400, 2200 * HOUR, 3000 * HOUR, selection.climb[0]!.measure)
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
