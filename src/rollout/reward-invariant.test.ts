import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { HeldOutGate } from '../held-out-gate'
import { evaluateReleaseConfidence } from '../release-confidence'
import { appendToCorpus, buildDatasetFromCorpus } from '../rl/corpus'
import { buildRlDataset, type RlDatasetConfig } from '../rl/dataset'
import { type GrpoLookups, type SftLookups, toGrpoRows, toSftRows } from '../rl/exporters'
import { extractPreferences } from '../rl/preferences'
import { detectRewardHacking } from '../rl/reward-hacking'
import { extractVerifiableRewardsFromRecords } from '../rl/verifiable-reward'
import type { RunRecord } from '../run-record'
import { InMemoryTraceStore } from '../trace/store'
import { mintRolloutRows } from './mint'
import { observedScore, trainingReward, trainingScore } from './reward'
import {
  countRawScoreReads,
  findRawScoreReads,
  findRawScoreReadsInSource,
} from './score-derivation-guard'

// The anti-Goodhart gate is a whole-codebase invariant, not a function. Before
// this suite existed, `rolloutReward` enforced it at exactly ONE of the two
// doors into training data while 20 hand-rolled copies of the same derivation
// walked around it — so a run flagged as gamed exported at full positive reward
// through every RL path. Both halves below exist to keep that from regrowing:
// the source check stops a 21st copy from being written, the behavioural check
// proves the gate actually reaches each exported artifact.

const SOURCE_ROOT = new URL('..', import.meta.url).pathname

/**
 * Every file allowed to read `outcome.holdoutScore` / `outcome.searchScore`
 * raw, with the exact number of reads and the reason each is legitimate.
 *
 * Counted, not just listed: an allowlist of FILES would let a new hand-rolled
 * derivation hide inside a file that already has a legitimate one. The count is
 * stable under unrelated edits (it does not name line numbers) and moves the
 * moment somebody adds a read.
 */
const ALLOWED_RAW_READS: ReadonlyArray<{ file: string; reads: number; reason: string }> = [
  {
    file: 'rollout/reward.ts',
    reads: 2,
    reason:
      'THE owner. `observedSplitScore` is the single expression that reads either field; every other accessor in the package is built from it.',
  },
  {
    file: 'rollout/score-derivation-guard.ts',
    reads: 2,
    reason: 'the guard itself, naming the two field names it searches for.',
  },
  {
    file: 'run-record.ts',
    reads: 6,
    reason:
      'the RunRecord validator: presence/finiteness checks on an unknown object, before any score exists to derive. It computes nothing from the values.',
  },
]

describe('score derivation is centralized (AST source check)', () => {
  it('reads the raw split-score fields only in the files that declare why', () => {
    const counts = countRawScoreReads(findRawScoreReads(SOURCE_ROOT))
    const expected = Object.fromEntries(ALLOWED_RAW_READS.map((e) => [e.file, e.reads]))
    expect(
      counts,
      [
        'An invariant enforced on one path is not an invariant.',
        '',
        "Something re-derives a run's score by hand. A hand-rolled derivation cannot apply",
        'the anti-Goodhart gate, so whichever one feeds training data exports runs flagged',
        'as gamed (`outcome.realness.gated`) at full positive reward — which is exactly the',
        'defect this test was written for.',
        '',
        'Pick the intent by name instead, from `src/rollout/reward.ts`:',
        '  - `trainingScore` / `trainingReward` — gated; required for anything a trainer',
        '    or an exported dataset consumes.',
        '  - `observedScore` / `observedSplitScore` — raw; for analysis, reporting, and',
        '    reward-hack DETECTION, which needs the ungated number to see a gamed run.',
        '',
        'If a new raw read is genuinely correct, add it to ALLOWED_RAW_READS with a reason.',
      ].join('\n'),
    ).toEqual(expected)
  })

  // Every entry below is a working re-derivation that the previous line-regex
  // guard (/holdoutScore\s*\?\?\s*.*searchScore/) let through. They are kept as
  // a permanent fixture: the guard's whole claim is that it holds under
  // reformatting and restructuring, and this is the evidence for that claim.
  const PLANTED_BYPASSES: ReadonlyArray<{ name: string; source: string }> = [
    {
      name: '1. single-line ??',
      source: `export function s(r: RunRecord) {
  return r.outcome.holdoutScore ?? r.outcome.searchScore
}`,
    },
    {
      name: '2. destructured single-line ??',
      source: `export function s(r: RunRecord) {
  const { holdoutScore, searchScore } = r.outcome
  return holdoutScore ?? searchScore
}`,
    },
    {
      name: '3. two-line ?? wrap (what biome emits past 100 cols)',
      source: `export function s(r: RunRecord) {
  return (
    r.outcome.holdoutScore ??
    r.outcome.searchScore
  )
}`,
    },
    {
      name: "4. split === 'holdout' ternary",
      source: `export function s(r: RunRecord, split: string) {
  return split === 'holdout' ? r.outcome.holdoutScore : r.outcome.searchScore
}`,
    },
    {
      name: '5. dynamic scoreField string',
      source: `export function s(r: RunRecord, split: string) {
  const scoreField = split === 'holdout' ? 'holdoutScore' : 'searchScore'
  return r.outcome[scoreField]
}`,
    },
    {
      name: '6. if/return chain',
      source: `export function s(r: RunRecord) {
  if (typeof r.outcome.holdoutScore === 'number') return r.outcome.holdoutScore
  if (typeof r.outcome.searchScore === 'number') return r.outcome.searchScore
  return null
}`,
    },
    {
      name: '7. || instead of ??',
      source: `export function s(r: RunRecord) {
  return r.outcome.holdoutScore || r.outcome.searchScore
}`,
    },
  ]

  it.each(PLANTED_BYPASSES)('catches bypass $name', ({ source }) => {
    expect(findRawScoreReadsInSource('planted.ts', source).length).toBeGreaterThan(0)
  })

  it('does not flag WRITES — constructing a RunRecord is not a derivation', () => {
    const writes = `const outcome: RunOutcome = { holdoutScore: 0.9, raw: {} }
outcome.searchScore = 0.5
interface Shape { holdoutScore?: number; searchScore?: number }`
    expect(findRawScoreReadsInSource('writes.ts', writes)).toEqual([])
  })
})

const GAMED_SCORE = 0.95
const HONEST_SCORE = 0.9

function record(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    runId: 'run-honest',
    experimentId: 'exp-1',
    candidateId: 'cand-honest',
    seed: 7,
    model: 'glm-5.2@2026-05-01',
    promptHash: 'p'.repeat(64),
    configHash: 'c'.repeat(64),
    commitSha: 'deadbeef',
    wallMs: 1000,
    costUsd: 0.12,
    tokenUsage: { input: 900, output: 100 },
    splitTag: 'holdout',
    scenarioId: 'checkout-session',
    outcome: { holdoutScore: HONEST_SCORE, raw: {} },
    ...overrides,
  }
}

/** A run the authenticity gate flagged as gamed, claiming a near-perfect score. */
function gamedRecord(): RunRecord {
  return record({
    runId: 'run-gamed',
    candidateId: 'cand-gamed',
    outcome: {
      holdoutScore: GAMED_SCORE,
      raw: {},
      realness: { score: 0.1, gated: true, reason: 'stubbed the integration' },
    },
  })
}

const honest = record()
const gamed = gamedRecord()
const lookups: GrpoLookups & SftLookups = {
  promptOf: (runId) => `prompt-for-${runId}`,
  completionOf: (runId) => `completion-for-${runId}`,
}

const datasetConfig: RlDatasetConfig = {
  name: 'gate-regression',
  version: '0.1.0',
  domain: 'checkout',
  license: 'Tangle Commercial',
  createdAtIso: '2026-07-24T00:00:00Z',
  reward: { kind: 'probabilistic', source: 'judge', description: 'headline score' },
  intendedUse: 'regression fixture',
  outOfScope: 'anything real',
  limitations: 'two records',
}

describe('a realness-gated run exports at reward 0 on every training path', () => {
  it('trainingScore / trainingReward zero it while observedScore keeps it visible', () => {
    expect(trainingScore(gamed)).toBe(0)
    expect(trainingReward(gamed)).toEqual({ reward: 0, gated: true })
    // The detector's axis must NOT be gated, or it goes blind to the very runs
    // it exists to catch.
    expect(observedScore(gamed)).toBe(GAMED_SCORE)
    expect(trainingReward(honest)).toEqual({ reward: HONEST_SCORE, gated: false })
  })

  it('mintRolloutRows carries the gate into the rollout line', async () => {
    const { rows } = await mintRolloutRows([gamed], new InMemoryTraceStore(), {
      now: () => new Date('2026-07-24T00:00:00Z'),
    })
    expect(rows[0]!.outcome.reward).toBe(0)
    expect(rows[0]!.outcome.realness_gated).toBe(true)
  })

  it('mints an UNSCORED record to reward null — a labeled gap, not a measured 0', async () => {
    const unscored = record({ runId: 'run-unscored', outcome: { raw: {} } })
    expect(trainingReward(unscored)).toEqual({ reward: null, gated: false })
    const { rows } = await mintRolloutRows([unscored], new InMemoryTraceStore(), {
      now: () => new Date('2026-07-24T00:00:00Z'),
    })
    expect(rows[0]!.outcome.reward).toBeNull()
    expect(rows[0]!.outcome.reward_source).toBe('run-record/unscored')
    // A gated run is still 0: the gate IS a verdict, so it is not a gap.
    expect(trainingReward(gamed).reward).toBe(0)
  })

  it('excludes gated runs from the release pass rate and says how many', () => {
    const scorecard = (runs: RunRecord[]) => evaluateReleaseConfidence({ target: 'checkout', runs })
    const honestOnly = scorecard([honest, record({ runId: 'r2' })])
    const withGamed = scorecard([honest, record({ runId: 'r2' }), gamed])
    // The gamed run neither raises the rate nor lowers it — it is not in it.
    expect(withGamed.metrics.passRate).toBe(honestOnly.metrics.passRate)
    expect(withGamed.metrics.realnessGatedRuns).toBe(1)
    expect(honestOnly.metrics.realnessGatedRuns).toBe(0)
  })

  it('drops gated runs from the held-out promotion gate and surfaces the count', () => {
    const gate = new HeldOutGate({ baselineKey: 'base', minProductiveRuns: 1 })
    const holdout = (over: Partial<RunRecord>): RunRecord =>
      record({ splitTag: 'holdout', ...over })
    const baseline = [
      holdout({
        runId: 'b1',
        candidateId: 'base',
        seed: 1,
        outcome: { holdoutScore: 0.5, raw: {} },
      }),
    ]
    const candidateRuns = [
      holdout({
        runId: 'c1',
        candidateId: 'cand',
        seed: 1,
        outcome: { holdoutScore: 0.6, raw: {} },
      }),
      holdout({
        runId: 'c2',
        candidateId: 'cand',
        seed: 1,
        outcome: {
          holdoutScore: 1,
          raw: {},
          realness: { score: 0, gated: true, reason: 'stubbed the integration' },
        },
      }),
    ]
    const decision = gate.evaluate(candidateRuns, baseline)
    expect(decision.evidence.realnessGatedRuns).toBe(1)
    // Only the honest pair counted; the 1.0 claim bought nothing.
    expect(decision.evidence.productiveRuns).toBe(1)
    expect(decision.evidence.holdoutScore).toBe(0.6)
  })

  it('toGrpoRows gives it reward 0 inside its scenario group', async () => {
    const rows = await toGrpoRows([honest, gamed], lookups)
    expect(rows).toHaveLength(1)
    const byRun = new Map(rows[0]!.runIds.map((id, i) => [id, rows[0]!.rewards[i]]))
    expect(byRun.get('run-gamed')).toBe(0)
    expect(byRun.get('run-honest')).toBe(HONEST_SCORE)
  })

  it('toSftRows never emits the gamed trajectory as an imitation target', async () => {
    const rows = await toSftRows([honest, gamed], lookups)
    // SFT rows are targets to copy, so the gate may drop the row outright
    // rather than zero it. Either is correct; a positive score is not.
    const gamedRow = rows.find((r) => r.meta?.runId === 'run-gamed')
    expect(gamedRow?.meta?.score ?? 0).toBe(0)
    expect(rows.some((r) => r.meta?.runId === 'run-honest')).toBe(true)
  })

  it('extractPreferences makes it the rejected side, never the chosen one', () => {
    const report = extractPreferences([honest, gamed])
    expect(report.pairs).toHaveLength(1)
    expect(report.pairs[0]!.chosenRunId).toBe('run-honest')
    expect(report.pairs[0]!.rejectedRunId).toBe('run-gamed')
    expect(report.pairs[0]!.scores).toEqual({ chosen: HONEST_SCORE, rejected: 0 })
  })

  it('the probabilistic verifiable-reward fallback yields 0', () => {
    const [signal] = extractVerifiableRewardsFromRecords([gamed])
    expect(signal!.reward?.determinism).toBe('probabilistic')
    expect(signal!.reward?.value).toBe(0)
  })

  it('buildRlDataset reports 0 in the datasheet stats and the trainer rows', async () => {
    const bundle = await buildRlDataset([honest, gamed], lookups, datasetConfig)
    expect(bundle.manifest.stats.reward.min).toBe(0)
    expect(bundle.manifest.stats.reward.max).toBe(HONEST_SCORE)
    const grpo = JSON.parse(bundle.files['train.grpo.jsonl']!.trim())
    const byRun = new Map(grpo.runIds.map((id: string, i: number) => [id, grpo.rewards[i]]))
    expect(byRun.get('run-gamed')).toBe(0)
  })

  it('the corpus minScore filter drops it from the publishable bundle', async () => {
    const dir = join(tmpdir(), 'agent-eval-reward-gate-test')
    rmSync(dir, { recursive: true, force: true })
    const corpus = join(dir, 'corpus.jsonl')
    appendToCorpus(
      [
        { ...honest, prompt: 'p-honest', completion: 'c-honest' },
        { ...gamed, prompt: 'p-gamed', completion: 'c-gamed' },
      ],
      corpus,
    )
    const bundle = await buildDatasetFromCorpus(corpus, datasetConfig, { minScore: 0.5 })
    expect(bundle.manifest.stats.records).toBe(1)
    expect(bundle.files['train.sft.jsonl']).toContain('run-honest')
    expect(bundle.files['train.sft.jsonl']).not.toContain('run-gamed')
    rmSync(dir, { recursive: true, force: true })
  })

  it('the reward-hacking detector still SEES the gamed score (raw by design)', () => {
    // Gating the detector's proxy would collapse it toward ground truth and make
    // it report "clean" on the gamed population. n counts the gated run.
    const runs = [honest, gamed, record({ runId: 'r3' }), record({ runId: 'r4' })]
    expect(detectRewardHacking({ runs }).n).toBe(4)
  })
})
