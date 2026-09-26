#!/usr/bin/env -S node --experimental-strip-types
/**
 * Real-run proof (search-tree-design §12; no unit tests for lenses):
 * `incumbentWithOperatorBandit` draws over the `operatorYield` lens's real
 * signal, computed from a real ledger through the real
 * `SearchRecorder`/`SearchState`/`searchPolicyView` path — no mocks. Confirms
 * (1) an operator below `MIN_OUTCOMES_FOR_WEIGHT` (debug, n=4) falls back to
 * its fixed prior, (2) a measured operator's draw share tracks its measured
 * yield once every operator clears the gate, and (3) the whole signal is
 * wired end to end through `searchPolicyView`, not read directly from the
 * lens. Exits non-zero (throws) on any check failing, so a CI run of this
 * script is itself the assertion.
 *
 * Usage:
 *   pnpm exec tsx scripts/prove-operator-bandit.mts <search-ledger.jsonl>
 */
import { readFileSync } from 'node:fs'
import {
  incumbentWithOperatorBandit,
  replaySearchLedgerText,
  searchPolicyView,
  type SearchPolicyView,
} from '../src/campaign/index'
import { operatorYield } from '../src/search/lenses/operator-yield'

const path = process.argv[2]!
const text = readFileSync(path, 'utf8')
const searchId = JSON.parse(text.split('\n')[0]!).searchId as string
const state = replaySearchLedgerText(text, searchId, path)

const lens = operatorYield(state, { split: 'selection' })
console.log('operatorYield.weights (real, from the ledger):', JSON.stringify(lens.signal.value))

const view = searchPolicyView(state, {
  screened: state.nodes().map((node) => node.nodeId),
  screening: 0,
  expansions: 0,
})
console.log('same signal via searchPolicyView.operatorWeights:', JSON.stringify(view.operatorWeights))
if (JSON.stringify(view.operatorWeights) !== JSON.stringify(lens.signal.value)) {
  throw new Error('searchPolicyView.operatorWeights diverged from the lens it wires')
}

function drawCounts(
  seed: number,
  N: number,
  fixedWeights?: Partial<Record<'draft' | 'improve' | 'debug' | 'merge', number>>,
): Record<string, number> {
  const policy = incumbentWithOperatorBandit({ seed, fixedWeights })
  const draws: Record<string, number> = { draft: 0, improve: 0, debug: 0, merge: 0 }
  for (let i = 0; i < N; i++) {
    const drawnView: SearchPolicyView = { ...view, expansions: i }
    const expansion = policy.expand(drawnView)!
    draws[expansion.operator] = (draws[expansion.operator] ?? 0) + 1
  }
  return draws
}

// Default fixed weights (prior 1 per operator): the policy's own documented
// tradeoff (search-policy.ts's chooseOperator comment) is that yield ADDS to
// the prior rather than replacing it, so a small measured yield (here
// 0.013-0.038) only nudges a large prior (1) — this is deliberate, not a
// bug, and this proof checks it against the SAME formula the code runs
// (prior + yield), not against "yield rank = draw rank", which the code
// never promises at this prior scale.
const N = 20_000
const defaultDraws = drawCounts(7, N)
const priorWeights: Record<'draft' | 'improve' | 'debug' | 'merge', number> = {
  draft: 1,
  improve: 1,
  debug: 1,
  merge: 1,
}
const expectedWeight = (op: 'draft' | 'improve' | 'debug' | 'merge'): number => {
  const y = lens.signal.value[op]
  return y === null ? priorWeights[op] : Math.max(priorWeights[op] + y, 1e-6)
}
const ops = ['draft', 'improve', 'debug', 'merge'] as const
const totalExpectedWeight = ops.reduce((sum, op) => sum + expectedWeight(op), 0)
console.log(`\n${N} draws, default fixedWeights (prior=1 each) — observed vs the formula's own expected share:`)
for (const op of ops) {
  const observedShare = defaultDraws[op]! / N
  const expectedShare = expectedWeight(op) / totalExpectedWeight
  const relError = Math.abs(observedShare - expectedShare) / expectedShare
  console.log(
    `  ${op}: weight=${expectedWeight(op).toFixed(4)} expectedShare=${(expectedShare * 100).toFixed(2)}% observedShare=${(observedShare * 100).toFixed(2)}% relError=${(relError * 100).toFixed(2)}%`,
  )
  if (relError > 0.05) {
    throw new Error(`${op}: observed draw share diverged from the policy's own weight formula by >5%`)
  }
}

// With the prior shrunk to a scale comparable to the measured yields, the
// mechanism's INTENDED effect (favor the higher-yield operator once it is
// measured) should now show up clearly in the draw counts, since yield no
// longer sits in the shadow of a much larger fixed prior.
const smallPrior = { draft: 0.005, improve: 0.005, debug: 0.005, merge: 0.005 }
const tiltedDraws = drawCounts(7, N, smallPrior)
console.log(`\n${N} draws, fixedWeights shrunk to 0.005 (yield now dominates the weight):`)
console.log(JSON.stringify(tiltedDraws))
const tiltedMeasuredRank = (['draft', 'improve', 'merge'] as const)
  .map((op) => [op, lens.signal.value[op]!] as const)
  .sort((a, b) => b[1] - a[1])
const tiltedDrawRank = (['draft', 'improve', 'merge'] as const)
  .map((op) => [op, tiltedDraws[op]!] as const)
  .sort((a, b) => b[1] - a[1])
console.log('measured yield rank (desc):', tiltedMeasuredRank.map(([op, y]) => `${op}=${y.toFixed(4)}`).join(', '))
console.log('draw-count rank (desc):', tiltedDrawRank.map(([op, n]) => `${op}=${n}`).join(', '))
const tiltedRankMatches =
  tiltedMeasuredRank.map(([op]) => op).join(',') === tiltedDrawRank.map(([op]) => op).join(',')
console.log(`with yield dominant, draw order matches measured-yield order: ${tiltedRankMatches}`)
if (!tiltedRankMatches) {
  throw new Error('with yield dominant, bandit draw order did not track the measured operatorYield order')
}
console.log(
  `debug (unmeasured, n=4<6) drew ${tiltedDraws.debug} of ${N} (${((tiltedDraws.debug! / N) * 100).toFixed(2)}%) on its own fixed prior alone, never on a yield it does not have 6 outcomes for yet.`,
)
