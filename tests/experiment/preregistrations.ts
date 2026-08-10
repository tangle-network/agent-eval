/**
 * The week's three hand-written preregistrations, re-derived as sealed
 * experiment specs. Every registered rule is a typed node; no opaque node, no
 * lambda, no rule dropped. The acceptance suite executes these sealed objects
 * against the recorded evidence and requires each recorded decision to
 * reproduce.
 *
 * Sources:
 *   ~/bench-cache/killtest-20260810/PREREG.md
 *   ~/bench-cache/freelunch-20260810/PREREG.md (+ amendments 1-6)
 *   ~/bench-cache/tbench-20260808/MILESTONE-2.md (+ m3/row-subset-m3.json)
 */

import type { BudgetRule, DecisionRule, ExperimentSpec } from '../../src/experiment/index'
import { rowSubsetM2 } from './recorded-fixtures'

export const certifiedDeterministicTasks = [
  'password-recovery',
  'sanitize-git-repo',
  'count-dataset-tokens',
]

// ── Fixture 1: killtest-20260810 ─────────────────────────────────────

const killtestDecision: DecisionRule = {
  kind: 'table',
  branches: [
    {
      when: { kind: 'quantity-threshold', quantity: 'free-lunch-fraction', op: 'gte', value: 0.7 },
      verdict: 'thesis-dies-free-lunch',
      report: ['free-lunch-fraction'],
    },
    {
      when: {
        kind: 'all',
        of: [
          { kind: 'interval-excludes-zero', interval: 'task-clustered-95', sign: 'positive' },
          { kind: 'obligation-met', obligation: 'b-best-intermediate-grade' },
        ],
      },
      verdict: 'thesis-survives-at-this-n',
      report: ['task-clustered-95'],
    },
    {
      when: {
        kind: 'all',
        of: [
          { kind: 'interval-excludes-zero', interval: 'task-clustered-95', sign: 'positive' },
          { kind: 'not', of: { kind: 'obligation-met', obligation: 'b-best-intermediate-grade' } },
        ],
      },
      verdict: 'blocked-pending-registered-control',
      report: ['task-clustered-95'],
    },
    {
      when: { kind: 'interval-excludes-zero', interval: 'task-clustered-95', sign: 'negative' },
      verdict: 'thesis-dies',
      report: ['task-clustered-95'],
    },
    {
      when: { kind: 'interval-includes-zero', interval: 'task-clustered-95' },
      verdict: 'not-settled-at-this-n',
      report: ['task-clustered-95', 'settling-n'],
    },
  ],
}

export const killtestSpec: ExperimentSpec = {
  id: 'killtest-20260810',
  hypothesis:
    'Reallocating a fixed continuation budget toward earlier stop decisions (arm C) ' +
    'recovers more failed rows than spending it uniformly (arm B).',
  arms: [
    { id: 'B', role: 'control', policyDigest: 'pinned-continuation@v2' },
    { id: 'C', role: 'treatment', policyDigest: 'pinned-continuation@v2' },
  ],
  outcome: { kind: 'binary', source: 'injected-suite', digestVerified: true, pass: 'exit-0' },
  admission: {
    population: 'pre-admission clean-exit replayable failed rows',
    stages: [
      { id: 'sampled', keep: { kind: 'compare', field: 'rowId', op: 'ne', value: null } },
      {
        id: 'clean-exit',
        keep: { kind: 'compare', field: 'stratum', op: 'eq', value: 'clean-exit' },
      },
      {
        id: 'replayable',
        keep: { kind: 'compare', field: 'prefixDivergenceRatio', op: 'lte', value: 0.1 },
        // Admission condition 3 is deliberately waived: rows the continuation
        // rescues unassisted are the rows a stop-gate wins.
        waives: ['no-fix-control-passed'],
      },
    ],
  },
  estimands: {
    'paired-contrast': {
      kind: 'paired-mean-diff',
      armField: 'arm',
      treatment: 'C',
      control: 'B',
      pairBy: 'rowId',
      value: 'score',
      missing: 'zero-diff',
    },
    'free-lunch-fraction': {
      kind: 'set-ratio',
      armField: 'arm',
      idField: 'rowId',
      numerator: {
        kind: 'intersect',
        of: [
          {
            kind: 'rows-where',
            arm: 'B',
            event: { kind: 'compare', field: 'passed', op: 'eq', value: true },
          },
          {
            kind: 'rows-where',
            arm: 'C',
            event: { kind: 'compare', field: 'passed', op: 'eq', value: true },
          },
        ],
      },
      denominator: {
        kind: 'rows-where',
        arm: 'C',
        event: { kind: 'compare', field: 'passed', op: 'eq', value: true },
      },
    },
  },
  intervals: {
    'task-clustered-95': {
      kind: 'cluster-bootstrap',
      clusterBy: 'taskName',
      resamples: 4000,
      seed: 20260810,
      level: 0.95,
      method: 'percentile',
    },
  },
  decision: killtestDecision,
  obligations: [
    {
      id: 'b-best-intermediate-grade',
      appliesToVerdicts: ['thesis-survives-at-this-n'],
      control: 'grade arm B at its best intermediate state',
    },
  ],
  gates: {
    'oracle-determinism': {
      kind: 'oracle-determinism',
      unit: 'suite',
      replicates: 15,
      maxFlipRate: 0,
    },
    // 7.2: a row's verdict is the pair (admitted, no-fix pass count); either
    // moving between runs makes the population an unstable object.
    'population-reproducibility': {
      kind: 'population-reproducibility',
      joinOn: 'rowId',
      compare: ['admitted', 'noFixPasses'],
      maxChangedRows: 0,
    },
    // 7.3: the motivating control must have had model calls to make.
    'provenance-assertion': {
      kind: 'provenance-assertion',
      claim: { kind: 'compare', field: 'policy.modelCallBudget', op: 'gt', value: 0 },
    },
    'power-floor': {
      kind: 'power-floor',
      target: 0.8,
      effectGrid: [0, 0.1, 0.3, 0.5, 0.9, 1],
      sim: { trials: 2000, resamples: 4000, seed: 20260810 },
    },
  },
  halt: {
    when: {
      kind: 'any-gate-failed',
      gates: [
        'oracle-determinism',
        'population-reproducibility',
        'provenance-assertion',
        'power-floor',
      ],
    },
    action: 'refuse-spend',
    report: 'settling-n',
  },
  matchedBudget: { measure: 'realized-tokens', tolerance: 0.05, onFail: 'refuse-contrast' },
  seed: 20260810,
}

// ── Fixture 2: freelunch-20260810 ────────────────────────────────────

/** Amendment 3+4+5 schedule as executed: gate on priced per-call cost. */
export function freelunchBudget(
  ledger: { id: string; usd: number }[],
): Extract<BudgetRule, { kind: 'uniform-pass' }> {
  return {
    kind: 'uniform-pass',
    ceilingUsd: 10,
    maxPasses: 3,
    projection: 'last-pass-cost',
    costSource: 'priced-per-call',
    ledger,
    partialPass: 'report-never-lift',
  }
}

export function freelunchSpec(ledger: { id: string; usd: number }[]): ExperimentSpec {
  return {
    id: 'freelunch-20260810',
    hypothesis:
      'Blind continuation under the pinned policy rescues a nontrivial fraction of ' +
      'admitted failed rows without any intervention.',
    arms: [{ id: 'continuation', role: 'treatment', policyDigest: 'pinned-continuation@v2' }],
    outcome: { kind: 'binary', pass: 'reward-file-contains-1', droppedRollouts: 'forbidden' },
    admission: {
      population: 'primary denominator',
      stages: [
        {
          id: 'evaluated-sample',
          keep: { kind: 'compare', field: 'rowId', op: 'ne', value: null },
        },
        {
          id: 'deterministic-oracle',
          keep: { kind: 'in', field: 'taskName', values: certifiedDeterministicTasks },
        },
        {
          id: 'clean-exit',
          keep: { kind: 'compare', field: 'stratum', op: 'eq', value: 'clean-exit' },
        },
        {
          id: 'failed-end-state',
          keep: { kind: 'compare', field: 'noFixPasses', op: 'eq', value: 0 },
        },
        {
          id: 'prefix-fidelity',
          keep: { kind: 'compare', field: 'prefixDivergenceRatio', op: 'lte', value: 0.1 },
        },
      ],
      partitions: [
        {
          id: 'secondary-prefix-divergent',
          from: 'prefix-fidelity',
          keep: { kind: 'compare', field: 'prefixDivergenceRatio', op: 'gt', value: 0.1 },
          pooling: 'never',
        },
      ],
    },
    estimands: {
      'rollout-rescue-rate': {
        kind: 'rate',
        event: { kind: 'compare', field: 'passed', op: 'eq', value: true },
        over: 'rollouts',
      },
      'row-rescue-rate': {
        kind: 'rate-at-least-once',
        event: { kind: 'compare', field: 'passed', op: 'eq', value: true },
        groupBy: 'rowId',
      },
    },
    intervals: {
      'task-clustered-95': {
        kind: 'cluster-bootstrap',
        clusterBy: 'taskName',
        resamples: 10000,
        seed: 7,
        level: 0.95,
        method: 'percentile',
      },
      'row-clustered-95': {
        kind: 'cluster-bootstrap',
        clusterBy: 'rowId',
        resamples: 10000,
        seed: 7,
        level: 0.95,
        method: 'percentile',
      },
      'clopper-pearson-95': { kind: 'clopper-pearson', level: 0.95 },
    },
    // The registration explicitly declines a threshold: the interval and the
    // per-row table ARE the finding. The HIGH/LOW meaning map rides as
    // non-executable interpretation data.
    decision: {
      kind: 'report-only',
      estimands: ['rollout-rescue-rate', 'row-rescue-rate'],
      intervals: ['task-clustered-95', 'row-clustered-95', 'clopper-pearson-95'],
      perRow: [
        'rollouts',
        'passes',
        'exitStatus',
        'steps',
        'promptTokens',
        'completionTokens',
        'reasoningTokens',
        'cachedTokens',
        'wallMs',
        'costUsd',
      ],
      interpretation: [
        { onQualitative: 'high', consequence: 'gated-stop thesis dead; publish' },
        {
          onQualitative: 'low',
          consequence: 'licenses the paired study; proves nothing about a gate',
        },
      ],
    },
    gates: {
      identity: { kind: 'identity', field: 'served-model', op: 'basename-eq', onFail: 'abort' },
      'oracle-determinism': {
        kind: 'oracle-determinism',
        unit: 'suite',
        replicates: 16,
        maxFlipRate: 0,
      },
    },
    budget: freelunchBudget(ledger),
    seedDerivation: { from: ['seed', 'rowId', 'rolloutIndex'] },
    seed: 7,
  }
}

/** The ledger the executed gate read: the pilot only. */
export const freelunchLedgerAsExecuted = [{ id: 'glm-pilot', usd: 0.1594 }]

/** The amendment-6 ledger: pilot + aborted substitution + zombie run. */
export const freelunchLedgerAmendment6 = [
  { id: 'glm-pilot', usd: 0.1594 },
  { id: 'aborted-substitution-seconds', usd: 0.0175 },
  { id: 'zombie-substituted-run', usd: 1.0305 },
]

/** Measured pass costs, priced per call, from the finished passes' own reports. */
export const freelunchMeasuredPassCosts = [4.4985, 4.9821]

// ── Fixture 3: tbench-20260808 milestone 2 (+ m3 provenance) ─────────

export const milestone2Spec: ExperimentSpec = {
  id: 'tbench-m2-20260808',
  hypothesis: 'The prime harness beats bare framing on the certified Terminal-Bench-2 subset.',
  arms: [
    { id: 'bare-framing', role: 'control' },
    { id: 'prime', role: 'treatment' },
  ],
  outcome: { kind: 'bounded-score', min: 0, max: 1, orientation: 'higher-is-better' },
  selections: {
    // Fixed before any answer: reads only the task name and the row id — no
    // oracle result, no control rate, no wall time.
    'm2-subset': {
      kind: 'round-robin',
      groupBy: 'taskName',
      groupOrder: 'lex-asc',
      withinOrder: { field: 'rowId', dir: 'asc' },
      take: 20,
      reads: ['taskName', 'rowId'],
    },
    // m3 answers the m2 subset minus the oracle-decertified task.
    'm3-subset': {
      kind: 'filter-of',
      base: 'm2-subset',
      keep: { kind: 'in', field: 'taskName', values: certifiedDeterministicTasks },
      order: { field: 'rowId', dir: 'asc' },
    },
  },
  // The m2 draw is sealed: reusing it is registered, a re-draw is a new digest.
  sealedSubsets: { 'm2-subset': rowSubsetM2 },
  estimands: {
    'prime-vs-bare': {
      kind: 'paired-mean-diff',
      armField: 'arm',
      treatment: 'prime',
      control: 'bare-framing',
      pairBy: 'rowId',
      value: 'score',
      missing: 'zero-diff',
    },
  },
  intervals: {
    'task-clustered-95': {
      kind: 'cluster-bootstrap',
      clusterBy: 'taskName',
      resamples: 10000,
      seed: 7,
      level: 0.95,
      method: 'percentile',
    },
  },
  decision: {
    kind: 'table',
    branches: [
      {
        when: { kind: 'interval-excludes-zero', interval: 'task-clustered-95', sign: 'positive' },
        verdict: 'harness-beats-inline-certified',
        report: ['task-clustered-95'],
      },
      {
        when: { kind: 'interval-excludes-zero', interval: 'task-clustered-95', sign: 'negative' },
        verdict: 'inline-beats-harness-certified',
        report: ['task-clustered-95'],
      },
      {
        when: { kind: 'interval-includes-zero', interval: 'task-clustered-95' },
        verdict: 'not-certified-at-this-n',
        report: ['task-clustered-95', 'point-estimate', 'wins-losses-ties'],
      },
    ],
  },
  reissue: {
    carrierEvents: ['http-status', 'transport-error', 'deadline', 'empty-content'],
    modelOutcomesStand: true,
    maxIssues: 3,
  },
  seed: 7,
}
