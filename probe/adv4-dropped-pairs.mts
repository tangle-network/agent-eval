/**
 * ROUND-4 ADVERSARY PROBE B — the items the candidate never answered.
 *
 * The gate's whole round-3 thesis is "unknown must mean no". Every rule it
 * added is about the STATISTIC. Nothing is about the SET the statistic runs on.
 * `scoredRuns` keeps only rows with a finite split score, `pairRunRecords`
 * drops the rest into `unpairedBaseline`, and `unpairedBaselineRuns` is
 * reported in the evidence but read by no decision.
 *
 * So: a candidate that produces no score at all on the hard items — crashed,
 * timed out, refused, empty output — is judged only on the items it did answer.
 */
import { HeldOutGate } from '../src/held-out-gate'
import { rec } from './fixtures'
import type { RunRecord } from '../src/run-record'

const ANSWERED = 6
const CRASHED = 20

function scenarioSet(mode: 'crash-missing' | 'crash-errored' | 'honest-zero') {
  const candidate: RunRecord[] = []
  const baseline: RunRecord[] = []
  // Items the candidate answered — small genuine improvements, all distinct.
  for (let i = 0; i < ANSWERED; i++) {
    const sid = `ok${i}`
    const b = 0.5
    const a = 0.5 + 0.01 + i * 0.002
    baseline.push(rec('base', sid, 'search', b), rec('base', sid, 'holdout', b))
    candidate.push(rec('cand', sid, 'search', a), rec('cand', sid, 'holdout', a))
  }
  // Items the candidate did NOT answer. Baseline scored 0.5 on all of them.
  for (let i = 0; i < CRASHED; i++) {
    const sid = `hard${i}`
    baseline.push(rec('base', sid, 'search', 0.5), rec('base', sid, 'holdout', 0.5))
    if (mode === 'crash-missing') continue // no candidate row at all
    if (mode === 'crash-errored') {
      // a row exists, but carries no score
      const s = rec('cand', sid, 'search', 0)
      const h = rec('cand', sid, 'holdout', 0)
      ;(s as unknown as { outcome: unknown }).outcome = { raw: {} }
      ;(h as unknown as { outcome: unknown }).outcome = { raw: {} }
      ;(s as unknown as { terminalOutcome: string }).terminalOutcome = 'errored'
      ;(h as unknown as { terminalOutcome: string }).terminalOutcome = 'errored'
      candidate.push(s, h)
      continue
    }
    // honest-zero: the same failure, scored as the 0 it actually earned
    candidate.push(rec('cand', sid, 'search', 0), rec('cand', sid, 'holdout', 0))
  }
  return { candidate, baseline }
}

function report(label: string, mode: 'crash-missing' | 'crash-errored' | 'honest-zero', thr: number) {
  const { candidate, baseline } = scenarioSet(mode)
  const g = new HeldOutGate({
    baselineKey: 'base',
    pairedDeltaThreshold: thr,
    confidence: 0.95,
    seed: 1234,
    overfitGapThreshold: 1e9,
  })
  const d = g.evaluate(candidate, baseline)
  const e = d.evidence
  console.log(
    `${label.padEnd(34)} thr=${String(thr).padStart(5)}  promote=${String(d.promote).padEnd(5)} ` +
      `code=${String(d.rejectionCode ?? 'null').padEnd(20)} n=${String(e.productiveRuns).padStart(2)} ` +
      `unpairedBaseline=${String(e.unpairedBaselineRuns).padStart(2)} ` +
      `Δ=${e.decidingDelta === null ? 'null' : e.decidingDelta.toFixed(4)} ` +
      `CI=[${e.pairedCI ? e.pairedCI.low.toFixed(4) : 'n'},${e.pairedCI ? e.pairedCI.high.toFixed(4) : 'n'}] ` +
      `signFlipP=${e.signFlip ? e.signFlip.pValue.toExponential(2) : 'n/a'}`,
  )
}

const trueMean = (ANSWERED * 0.015 + CRASHED * -0.5) / (ANSWERED + CRASHED)
console.log(
  `Ground truth: candidate improves ${ANSWERED} items by ~+0.015 and produces NOTHING on ${CRASHED} ` +
    `items the baseline scored 0.5 on.\nIf the unanswered items count as the 0 they earned, the true ` +
    `mean paired delta is ${trueMean.toFixed(4)} over 26 items.\n`,
)
for (const thr of [0, -0.05]) {
  report('candidate row simply absent', 'crash-missing', thr)
  report('candidate row present, no score', 'crash-errored', thr)
  report('CONTROL: failures scored as 0', 'honest-zero', thr)
  console.log()
}
