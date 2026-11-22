/**
 * Find which recorded numbers predict a later outcome, on changes they were
 * not chosen on, and choose the few to climb.
 *
 * Run with: pnpm exec tsx examples/measure-validity/index.ts
 *
 * The history is generated, so the truth is known: `review_depth` and
 * `test_delta` predict whether a change is kept, `repo_size` predicts it but
 * no change moves it, `review_depth_copy` duplicates `review_depth`, and the
 * forty `noise_*` measures predict nothing.
 */

import {
  type MeasureValidityPlanInput,
  sealMeasureValidityPlan,
  verifyMeasureValidityPlan,
} from '../../src/experiment'
import {
  guardDrift,
  InMemoryOutcomeStore,
  type MeasuredChange,
  measureValidityStudy,
} from '../../src/meta-eval'
import { mulberry32 } from '../../src/statistics'

const HOUR = 3_600_000
const DAY = 24 * HOUR
const random = mulberry32(2026)
const normal = () =>
  Math.sqrt(-2 * Math.log(Math.max(random(), Number.EPSILON))) * Math.cos(2 * Math.PI * random())
const noiseIds = Array.from({ length: 40 }, (_, i) => `noise_${String(i).padStart(2, '0')}`)

interface Recorded {
  change: MeasuredChange
  kept: number
  capturedAt: number
}

/** One change an hour across 80 repositories; the outcome is decided 3 to 10 days later. */
function history(count: number, start: number, gamed?: string): Recorded[] {
  return Array.from({ length: count }, (_, i) => {
    const at = start + i * HOUR
    const size = normal()
    const quality = normal()
    const testsBefore = normal()
    const testsAdded = normal()
    const reviewDepth = quality + 0.6 * normal()
    const measures: Record<string, number> = {
      review_depth: reviewDepth,
      review_depth_copy: reviewDepth + 0.02 * normal(),
      test_delta: testsBefore + testsAdded,
      repo_size: size,
    }
    for (const id of noiseIds) measures[id] = normal()
    if (gamed) measures[gamed] = measures[gamed]! + 2
    const logit = 1.5 * quality + 1.2 * testsAdded - 0.8 * size
    return {
      change: {
        id: `${start}-${i}`,
        at,
        unit: `repo-${Math.floor(random() * 80)}`,
        measures,
        movements: {
          test_delta: { before: testsBefore, after: testsBefore + testsAdded },
          repo_size: { before: size, after: size },
        },
      },
      kept: random() < 1 / (1 + Math.exp(-logit)) ? 1 : 0,
      capturedAt: at + 3 * DAY + random() * 7 * DAY,
    }
  })
}

async function store(rows: readonly Recorded[]) {
  const outcomes = new InMemoryOutcomeStore()
  for (const row of rows) {
    await outcomes.append({
      runId: row.change.id,
      capturedAt: row.capturedAt,
      metrics: { kept: row.kept },
    })
  }
  return outcomes
}

// 1. At the cut, register what will be tested before any later change is read.
const cut = 800 * HOUR
const planInput: MeasureValidityPlanInput = {
  id: 'which-numbers-predict-kept-changes',
  cut,
  level: 0.05,
  outcomes: [{ id: 'kept', direction: 'higher-is-better', kind: 'binary' }],
  measures: [
    { id: 'review_depth', cost: 2 },
    { id: 'review_depth_copy', cost: 2 },
    { id: 'test_delta', noise: 0.1, cost: 1 },
    { id: 'repo_size', noise: 0.1, cost: 0 },
    ...noiseIds.map((id) => ({ id })),
  ],
  minJoined: 100,
  resamples: 400,
}
const sealed = sealMeasureValidityPlan(planInput, { sealedAt: '2026-11-22T00:00:00.000Z' })
console.log(`plan digest: ${sealed.digest}`)
console.log(`seal verifies: ${verifyMeasureValidityPlan(sealed)}`)

// 2. Later: every change and outcome recorded so far, before and after the cut.
const recorded = history(1600, 0)
const report = await measureValidityStudy({
  plan: sealed,
  changes: recorded.map((row) => row.change),
  outcomes: await store(recorded),
})
console.log(
  `changes: ${report.changes.preCut} before the cut, ${report.changes.postCut} after; pairs tested: ${report.tested}; admitted: ${report.admitted}`,
)
for (const pair of report.pairs.filter((row) => !row.measure.startsWith('noise_'))) {
  const association = pair.postCut.association
  console.log(
    [
      pair.measure.padEnd(18),
      pair.label.padEnd(10),
      `AUC after cut ${association ? association.estimate.toFixed(3) : 'n/a'}`,
      `q ${pair.postCut.qValue?.toExponential(1) ?? 'n/a'}`,
      `movement ${pair.movement?.label ?? 'not recorded'}`,
    ].join('  '),
  )
}
const noiseAdmitted = report.pairs.filter(
  (row) => row.measure.startsWith('noise_') && row.label === 'predicts',
).length
console.log(`noise measures admitted: ${noiseAdmitted} of ${noiseIds.length}`)

const selection = report.selections[0]!
console.log(`climb: ${selection.climb.map((row) => row.measure).join(', ')}`)
console.log(
  `guards: ${selection.guards.map((row) => `${row.measure} (${row.reason})`).join(', ')}`,
)
console.log(
  `not climbable: ${selection.excluded.map((row) => `${row.measure} (${row.reason})`).join(', ')}`,
)
console.log(
  `composite AUC after cut: ${selection.composite.postCut?.estimate.toFixed(3) ?? 'n/a'}`,
)

// 3. A later batch where the first climbed measure was pushed up without the work behind it.
const gamed = history(400, 3000 * HOUR, selection.climb[0]!.measure)
const drift = await guardDrift({
  report,
  outcome: 'kept',
  batch: gamed.map((row) => row.change),
  outcomes: await store(gamed),
  tolerance: 0.5,
})
for (const row of drift.measures) {
  console.log(
    `drift ${row.measure}: ${row.status}, divergence ${row.divergence?.estimate.toFixed(2) ?? 'n/a'} [${row.divergence?.low.toFixed(2)}, ${row.divergence?.high.toFixed(2)}]`,
  )
}
console.log(`kept-rate shift: ${drift.outcomeShift?.estimate.toFixed(3) ?? 'n/a'}`)
console.log(report.claim.causeRequires)
