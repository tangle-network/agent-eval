/**
 * Register an experiment's rules as data, seal them, then execute only what
 * the seal contains.
 *
 * Run with: pnpm tsx examples/sealed-experiment/index.ts
 *
 * The execution surface takes a sealed rule plus evidence rows. It has no
 * parameter for a threshold, a metric, or a stopping rule, so the rule that
 * ran cannot differ from the rule that was registered.
 */

import {
  type EvidenceRecord,
  type ExperimentSpec,
  openSealedExperiment,
  renderFunnelTable,
  sealExperiment,
  verifySealedExperiment,
} from '../../src/experiment'

const spec: ExperimentSpec = {
  id: 'cite-the-ticket-20260815',
  hypothesis: 'Asking the agent to cite the ticket id raises the pass rate on failed cases.',
  arms: [
    { id: 'baseline', role: 'control', policyDigest: 'support-reply@v3' },
    { id: 'cite-ticket', role: 'treatment', policyDigest: 'support-reply@v3' },
  ],
  // A binary outcome: each row either passed its own suite or did not.
  outcome: { kind: 'binary', source: 'injected-suite', pass: 'exit-0' },
  admission: {
    population: 'support cases the baseline failed',
    stages: [
      {
        id: 'has-a-known-outcome',
        keep: { kind: 'compare', field: 'outcomeKnown', op: 'eq', value: true },
      },
      {
        id: 'baseline-failed-it',
        keep: { kind: 'compare', field: 'baselinePassed', op: 'eq', value: false },
      },
    ],
  },
  estimands: {
    pairedContrast: {
      kind: 'paired-mean-diff',
      armField: 'arm',
      treatment: 'cite-ticket',
      control: 'baseline',
      pairBy: 'caseId',
      // The outcome field is a boolean. It reads as 1 or 0, so the mean of
      // the paired differences is the risk difference.
      value: 'passed',
      missing: 'zero-diff',
    },
  },
  intervals: {
    pairedContrast95: {
      kind: 'cluster-bootstrap',
      clusterBy: 'queue',
      resamples: 2_000,
      seed: 20260815,
      level: 0.95,
      method: 'percentile',
    },
  },
  decision: {
    kind: 'table',
    branches: [
      {
        when: { kind: 'interval-excludes-zero', interval: 'pairedContrast95', sign: 'positive' },
        verdict: 'citation-helps',
        report: ['pairedContrast', 'pairedContrast95'],
      },
      {
        when: { kind: 'interval-excludes-zero', interval: 'pairedContrast95', sign: 'negative' },
        verdict: 'citation-hurts',
        report: ['pairedContrast', 'pairedContrast95'],
      },
      {
        when: { kind: 'interval-includes-zero', interval: 'pairedContrast95' },
        verdict: 'no-effect-resolved-at-this-n',
        report: ['pairedContrast', 'pairedContrast95'],
      },
    ],
  },
  seed: 20260815,
}

const sealed = await sealExperiment(spec, { sealedAt: '2026-08-15T00:00:00Z' })
console.log('seal digest:  ', sealed.digest)
console.log('seal verifies:', await verifySealedExperiment(sealed))

const registered = await openSealedExperiment(sealed)

// Eight recorded cases in two queues. Two of them do not belong in the
// population, and the funnel is where that is stated.
const cases = [
  { caseId: 'c0', queue: 'billing', outcomeKnown: true, baselinePassed: false },
  { caseId: 'c1', queue: 'billing', outcomeKnown: true, baselinePassed: false },
  { caseId: 'c2', queue: 'billing', outcomeKnown: true, baselinePassed: false },
  { caseId: 'c3', queue: 'shipping', outcomeKnown: true, baselinePassed: false },
  { caseId: 'c4', queue: 'shipping', outcomeKnown: true, baselinePassed: false },
  { caseId: 'c5', queue: 'shipping', outcomeKnown: true, baselinePassed: false },
  { caseId: 'c6', queue: 'billing', outcomeKnown: false, baselinePassed: false },
  { caseId: 'c7', queue: 'shipping', outcomeKnown: true, baselinePassed: true },
]

// The funnel is the denominator chain: every stage reports what it removed.
const admission = registered.admit(cases as EvidenceRecord[])
console.log(renderFunnelTable(admission.funnel))

/** The treatment recovered every admitted case except c2. */
const recovered = (caseId: string): boolean => caseId !== 'c2'

const outcomeRows: EvidenceRecord[] = admission.survivors.flatMap((row) => [
  { ...row, arm: 'baseline', passed: false },
  { ...row, arm: 'cite-ticket', passed: recovered(String(row.caseId)) },
])

const estimate = registered.estimate('pairedContrast', outcomeRows)
console.log('risk difference:', estimate.value)

// The bootstrap resamples whole queues of PAIR DIFFERENCES, not raw pass
// flags: the registered quantity is a contrast, so its interval is too.
const differenceRows: EvidenceRecord[] = admission.survivors.map((row) => ({
  ...row,
  diff: (recovered(String(row.caseId)) ? 1 : 0) - 0,
}))
const interval = registered.interval('pairedContrast95', {
  kind: 'rows',
  rows: differenceRows,
  value: 'diff',
})
console.log('95% interval:  ', [interval.lower, interval.upper])

const outcome = registered.decide({
  intervals: { pairedContrast95: { lower: interval.lower, upper: interval.upper } },
  quantities: {},
  obligationsMet: {},
})
console.log('verdict:       ', outcome.verdict)
