import { rmSync } from 'node:fs'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { HeldOutGate } from '../held-out-gate'
import { evaluateReleaseConfidence } from '../release-confidence'
import { appendToCorpus, buildDatasetFromCorpus } from '../rl/corpus'
import { buildRlDataset, type RlDatasetConfig } from '../rl/dataset'
import {
  type GrpoLineLookups,
  type GrpoLookups,
  type SftLineLookups,
  type SftLookups,
  stepRewardsToJsonl,
  toDpoRows,
  toGrpoRows,
  toPrmRows,
  toSftRows,
} from '../rl/exporters'
import {
  extractPreferences,
  type PreferenceTriple,
  toAnthropicFormat,
  toTRLFormat,
} from '../rl/preferences'
import type { PrmTrainingTriple, StepReward } from '../rl/process-reward'
import { detectRewardHacking } from '../rl/reward-hacking'
import {
  extractVerifiableReward,
  extractVerifiableRewardsFromRecords,
} from '../rl/verifiable-reward'
import type { RunRecord } from '../run-record'
import { InMemoryTraceStore } from '../trace/store'
import {
  toRewardRows,
  toRftItem,
  toRftItems,
  toVerifiersRolloutOutput,
  toVerifiersRolloutOutputs,
  toSftRows as toWaistSftRows,
} from './exporters'
import { fixtureRolloutLine, malformedRolloutLine } from './fixtures'
import { fromHarborTrajectory, toHarborTrajectory } from './interchange/harbor'
import { readRolloutLedger } from './ledger'
import { mintRolloutRows } from './mint'
import { FORMAT_FILES } from './release/card'
import { assertGateReport } from './release/gate-report'
import { buildHfDataset } from './release/hf-dataset'
import {
  observedScore,
  rolloutRewardFields,
  trainingReward,
  trainingScore,
  unscreenedRewardFields,
} from './reward'
import { assertMinted, type MintedRolloutLine, validateRolloutLine } from './schema'
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
    reads: 4,
    reason:
      'the RunRecord validator: finiteness checks on an unknown object, before any score exists to derive. It computes nothing from the values; `runTaskScore` itself goes through `observedScore`.',
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
    costProvenance: { kind: 'observed', usd: 0.12 },
    tokenUsage: { input: 900, output: 100 },
    terminalOutcome: 'succeeded',
    // `search` — the split the training exporters admit by default (0.127.0).
    splitTag: 'search',
    scenarioId: 'checkout-session',
    outcome: { searchScore: HONEST_SCORE, raw: {} },
    ...overrides,
  }
}

/** A run the authenticity gate flagged as gamed, claiming a near-perfect score. */
function gamedRecord(): RunRecord {
  return record({
    runId: 'run-gamed',
    candidateId: 'cand-gamed',
    outcome: {
      searchScore: GAMED_SCORE,
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

/** The same lookups typed for the `MintedRolloutLine[]` (non-deprecated) path. */
const lineLookups: GrpoLineLookups & SftLineLookups = {
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

  it('never turns an UNSCORED record into a measured 0 — null from trainingReward, refusal at mint', async () => {
    const unscored = record({ runId: 'run-unscored', outcome: { raw: {} } })
    // The derivation labels the gap instead of inventing a zero…
    expect(trainingReward(unscored)).toEqual({ reward: null, gated: false })
    // …and the mint door refuses the record outright: an execution-only run
    // has no training label, so it cannot become a rollout line at all.
    await expect(
      mintRolloutRows([unscored], new InMemoryTraceStore(), {
        now: () => new Date('2026-07-24T00:00:00Z'),
      }),
    ).rejects.toThrow(/run-unscored: task score is missing/)
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

  it('toGrpoRows: reward 0 in the group on the line path, dropped outright on the record path', async () => {
    const { rows: lines } = await mintRolloutRows([honest, gamed], new InMemoryTraceStore(), {
      now: () => new Date('2026-07-24T00:00:00Z'),
    })
    const fromLines = await toGrpoRows(lines, lookups)
    expect(fromLines).toHaveLength(1)
    const byRun = new Map(fromLines[0]!.runIds.map((id, i) => [id, fromLines[0]!.rewards[i]]))
    expect(byRun.get('run-gamed')).toBe(0)
    expect(byRun.get('run-honest')).toBe(HONEST_SCORE)
    // The record path removes the gamed run before grouping, which leaves the
    // honest sibling alone (<2 rewarded completions) — no row, no gamed reward.
    expect(await toGrpoRows([honest, gamed], lookups)).toEqual([])
  })

  it('toSftRows never emits the gamed trajectory as an imitation target', async () => {
    const rows = await toSftRows([honest, gamed], lookups)
    // SFT rows are targets to copy, so the gate may drop the row outright
    // rather than zero it. Either is correct; a positive score is not.
    const gamedRow = rows.find((r) => r.meta?.runId === 'run-gamed')
    expect(gamedRow?.meta?.score ?? 0).toBe(0)
    expect(rows.some((r) => r.meta?.runId === 'run-honest')).toBe(true)
  })

  it('extractPreferences never makes it the chosen side on either path', async () => {
    // Line path: the gated line arrives scored 0 and sinks to `rejected`.
    const { rows: lines } = await mintRolloutRows([honest, gamed], new InMemoryTraceStore(), {
      now: () => new Date('2026-07-24T00:00:00Z'),
    })
    const fromLines = extractPreferences(lines, {})
    expect(fromLines.pairs).toHaveLength(1)
    expect(fromLines.pairs[0]!.chosenRunId).toBe('run-honest')
    expect(fromLines.pairs[0]!.rejectedRunId).toBe('run-gamed')
    expect(fromLines.pairs[0]!.scores).toEqual({ chosen: HONEST_SCORE, rejected: 0 })
    // Record path: the shared eligibility rule drops the gamed run before
    // pairing, so its 0.95 claim bought it nothing — it appears on NO side.
    const fromRecords = extractPreferences([honest, gamed])
    expect(fromRecords.pairs).toHaveLength(0)
    expect(fromRecords.cellsSingleton).toBe(1)
  })

  it('the probabilistic verifiable-reward fallback yields 0', () => {
    const [signal] = extractVerifiableRewardsFromRecords([gamed])
    expect(signal!.reward?.determinism).toBe('probabilistic')
    expect(signal!.reward?.value).toBe(0)
  })

  it('buildRlDataset reports 0 in the datasheet stats and the trainer rows', async () => {
    const { rows: lines } = await mintRolloutRows([honest, gamed], new InMemoryTraceStore(), {
      now: () => new Date('2026-07-24T00:00:00Z'),
    })
    const bundle = await buildRlDataset(lines, lineLookups, {
      ...datasetConfig,
      formats: ['grpo', 'sft'],
    })
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

/**
 * The scalar was zeroed and the COMPONENTS it was computed from shipped anyway.
 *
 * `mintRolloutRows` bulk-copied `RunRecord.outcome.raw` into `outcome.metrics`,
 * which holds the per-layer verifier scores `rl/verifiable-reward.ts` reads as
 * the RL training signal — so a gated run exported `reward: 0` beside
 * `layer.tests: 1`, in the top-level `metrics` dict that IS the per-rubric score
 * dict of the Prime Intellect verifiers format. `outcome.verdict` leaked the
 * same way into `toRftItem`'s `reference.verdict`, where a grader author reads
 * `resolved: true`.
 */
const LAYER_SCORES = { 'layer.tests': 1, 'layer.compile': 1, patch_lines: 12 }

function gamedWithLayerScores(): RunRecord {
  return record({
    runId: 'run-gamed-layers',
    candidateId: 'cand-gamed',
    outcome: {
      holdoutScore: GAMED_SCORE,
      raw: { ...LAYER_SCORES },
      realness: { score: 0.1, gated: true, reason: 'stubbed the integration' },
    },
  })
}

async function mintOne(run: RunRecord): Promise<MintedRolloutLine> {
  const { rows } = await mintRolloutRows([run], new InMemoryTraceStore(), {
    now: () => new Date('2026-07-24T00:00:00Z'),
  })
  return rows[0]!
}

describe('a gated run exports none of the numbers its reward was computed from', () => {
  it('mint moves outcome.metrics off the outcome and onto provenance.gated_evidence', async () => {
    const line = await mintOne(gamedWithLayerScores())
    expect(line.outcome.reward).toBe(0)
    expect(line.outcome.metrics).toEqual({})
    expect(line.outcome.verdict).toBeNull()
    // Relocated, not destroyed: the audit trail that shows WHAT the run claimed
    // is exactly the row an auditor wants and the labeled example a gaming
    // detector trains on.
    expect(line.provenance.gated_evidence?.metrics).toEqual(LAYER_SCORES)
  })

  it('leaves an ungated run untouched — this is a gate, not a scrubber', async () => {
    const clean = record({ runId: 'run-clean', outcome: { holdoutScore: 0.9, raw: LAYER_SCORES } })
    const line = await mintOne(clean)
    expect(line.outcome.metrics).toEqual(LAYER_SCORES)
    expect(line.provenance.gated_evidence).toBeUndefined()
  })

  it('the verifiers per-rubric score dict is empty for a gated line', async () => {
    const line = await mintOne(gamedWithLayerScores())
    const out = toVerifiersRolloutOutput(line)
    expect(out.reward).toBe(0)
    expect(out.metrics).toEqual({})
    expect(JSON.stringify(out)).not.toContain('layer.tests')
    expect(out.info.realness_gated).toBe(true)
  })

  it('the RFT grader reference carries no verdict claiming the faked success', () => {
    const withVerdict = assertMinted(
      malformedRolloutLine({
        outcome: {
          reward: 0,
          reward_source: 'judge',
          verdict: { resolved: true, score: GAMED_SCORE },
          metrics: { ...LAYER_SCORES },
          is_completed: true,
          is_truncated: false,
          error: null,
          realness_gated: true,
        },
      }),
    )
    const item = toRftItem(withVerdict)
    expect(item.reference.reward).toBe(0)
    expect(item.reference.verdict).toBeNull()
    expect(item.reference.realness_gated).toBe(true)
    expect(withVerdict.provenance.gated_evidence?.verdict).toEqual({
      resolved: true,
      score: GAMED_SCORE,
    })
  })

  it('re-gates a line read back off a ledger written by the pre-fix mint', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-eval-gate-evidence-'))
    const path = join(dir, 'legacy.jsonl')
    const leaked = {
      ...malformedRolloutLine({ rollout_id: 'legacy-gamed' }),
      outcome: {
        reward: 0,
        reward_source: 'run-record/holdout-score',
        verdict: { resolved: true },
        metrics: { ...LAYER_SCORES },
        is_completed: true,
        is_truncated: false,
        error: null,
        realness_gated: true,
      },
    }
    await writeFile(path, `${JSON.stringify(leaked)}\n`)
    const [read] = await readRolloutLedger(path)
    expect(read!.outcome.metrics).toEqual({})
    expect(read!.outcome.verdict).toBeNull()
    expect(read!.provenance.gated_evidence?.metrics).toEqual(LAYER_SCORES)
    rmSync(dir, { recursive: true, force: true })
  })

  it('is idempotent — re-minting never clobbers evidence already relocated', async () => {
    const once = await mintOne(gamedWithLayerScores())
    const twice = assertMinted(once)
    expect(twice.provenance.gated_evidence?.metrics).toEqual(LAYER_SCORES)
    expect(twice).toEqual(once)
  })

  it('survives an ATIF round trip with the outcome empty and the audit trail intact', async () => {
    const line = await mintOne(gamedWithLayerScores())
    const [restored] = fromHarborTrajectory(toHarborTrajectory([line]), {
      now: () => new Date('2026-07-24T00:00:00Z'),
    })
    expect(restored!.outcome.metrics).toEqual({})
    expect(restored!.outcome.realness_gated).toBe(true)
    // Diagnostics, not a label: dropping them here would destroy the audit
    // trail on exactly the population an auditor most wants to inspect.
    expect(restored!.provenance.gated_evidence?.metrics).toEqual(LAYER_SCORES)
  })

  it('the exporter-layer runtime check refuses a hand-built JS line carrying the components', () => {
    const forged = {
      ...malformedRolloutLine(),
      outcome: {
        reward: 0,
        reward_source: 'judge',
        verdict: null,
        metrics: { 'layer.tests': 1 },
        is_completed: true,
        is_truncated: false,
        error: null,
        realness_gated: true,
      },
    } as unknown as MintedRolloutLine
    expect(() => toVerifiersRolloutOutput(forged)).toThrow(/outcome\.metrics is populated/)
    expect(() => toRewardRows([forged])).toThrow(/outcome\.metrics is populated/)
  })

  it('assertGateReport now certifies the whole outcome, not just outcome.reward', () => {
    // The exact shape that certified CLEAN while leaking: reward 0, components 1.
    expect(() =>
      assertGateReport({
        gatedLines: 1,
        byFormat: {
          verifiers: {
            input: 1,
            emitted: 1,
            excluded: 0,
            maxEmittedReward: 0,
            maxEmittedEvidence: { path: 'layer.tests', value: 1 },
            unscreenedPositiveRows: 0,
            maxUnscreenedReward: null,
            maxEmittedStepEvidence: null,
          },
        },
      }),
    ).toThrow(/positive reward-derived number \(layer\.tests = 1\)/)
  })

  it('measures the leak end to end through the published release build', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-eval-gate-release-'))
    const ledger = join(dir, 'rollouts.jsonl')
    // Written as raw JSONL exactly as the pre-fix mint would have: gated, reward
    // 0, and the per-layer scores still sitting in `outcome.metrics`. The
    // release build reads this through `readRolloutLedger`, so this is the real
    // published path over an artifact that already exists on disk.
    const base = malformedRolloutLine()
    const leaky = {
      ...base,
      rollout_id: 'run-gamed-layers',
      run_id: 'run-gamed-layers',
      outcome: {
        reward: 0,
        reward_source: 'run-record/holdout-score',
        verdict: { resolved: true, score: GAMED_SCORE },
        metrics: { ...LAYER_SCORES },
        is_completed: true,
        is_truncated: false,
        error: null,
        realness_gated: true,
      },
    }
    await writeFile(ledger, `${JSON.stringify(base)}\n${JSON.stringify(leaky)}\n`)
    const out = join(dir, 'dataset')
    const summary = await buildHfDataset([ledger], {
      out,
      formats: ['verifiers', 'rft', 'raw'],
      includeProposers: false,
    })
    expect(summary.gate.gatedLines).toBe(1)
    for (const format of ['verifiers', 'rft', 'raw'] as const) {
      expect(summary.gate.byFormat[format]?.maxEmittedEvidence).toBeNull()
      const text = await readFile(join(out, FORMAT_FILES[format]), 'utf8')
      const gatedRows = text
        .split('\n')
        .filter((l) => l.includes('run-gamed-layers'))
        .map((l) => JSON.parse(l) as Record<string, unknown>)
      expect(gatedRows.length).toBeGreaterThan(0)
      // `raw` keeps the relocated evidence on purpose — it is the audit dump.
      const trainingFacing = format === 'raw' ? gatedRows.map(stripGatedEvidence) : gatedRows
      expect(JSON.stringify(trainingFacing)).not.toContain('layer.tests')
    }
    rmSync(dir, { recursive: true, force: true })
  })
})

function stripGatedEvidence(row: Record<string, unknown>): Record<string, unknown> {
  const { gated_evidence: _dropped, ...provenance } = (row.provenance ?? {}) as Record<
    string,
    unknown
  >
  return { ...row, provenance }
}

/**
 * A `PreferenceTriple` is line-less: two run ids and a margin, with nothing on
 * it that says either run faked its success. `toPrmRows` was hardened for
 * exactly that reason while its sibling `toDpoRows` over the identical input
 * class was left with no gate at all — reachable through the published bundle
 * builder, writing the gamed run onto the CHOSEN side of every pair.
 */
describe('the line-less preference exporters cannot ship a gamed run as the preferred one', () => {
  const triple: PreferenceTriple = {
    scenarioId: 'checkout-session',
    chosenRunId: 'run-gamed',
    rejectedRunId: 'run-honest',
    chosenVariantId: 'cand-gamed',
    rejectedVariantId: 'cand-honest',
    marginScore: 0.05,
    scores: { chosen: GAMED_SCORE, rejected: HONEST_SCORE },
    meta: {
      chosenPromptHash: 'p-gamed',
      rejectedPromptHash: 'p-honest',
      chosenConfigHash: 'c',
      rejectedConfigHash: 'c',
      chosenModel: 'm',
      rejectedModel: 'm',
    },
  }

  async function context(): Promise<{ lines: MintedRolloutLine[] }> {
    const { rows } = await mintRolloutRows([honest, gamed], new InMemoryTraceStore(), {
      now: () => new Date('2026-07-24T00:00:00Z'),
    })
    return { lines: rows }
  }

  it('toDpoRows drops the pair instead of writing the gamed trajectory as chosen', async () => {
    expect(await toDpoRows([triple], lookups, await context())).toEqual([])
  })

  it('toTRLFormat and toAnthropicFormat drop it too', async () => {
    const ctx = await context()
    expect(toTRLFormat([triple], (hash) => `prompt:${hash}`, ctx)).toEqual([])
    expect(toAnthropicFormat([triple], ctx)).toEqual([])
  })

  it('buildRlDataset fails loudly rather than writing the gamed pair', async () => {
    // 0.127.0: a requested format that produces no trainable rows aborts the
    // build. With every pair dropped by the gate, nothing ships AND the caller
    // is told — an empty train.dpo.jsonl would hide that the corpus was gamed.
    const { lines } = await context()
    await expect(
      buildRlDataset(
        lines,
        lineLookups,
        { ...datasetConfig, formats: ['dpo'] },
        { triples: [triple], lookups },
      ),
    ).rejects.toThrow(/'dpo' format produced no trainable rows/)
    // Symmetric with `toPrmRows`: a gamed trajectory ships on NEITHER side.
    const honestPair = { ...triple, chosenRunId: 'run-honest', rejectedRunId: 'run-gamed' }
    await expect(
      buildRlDataset(
        lines,
        lineLookups,
        { ...datasetConfig, formats: ['dpo'] },
        { triples: [honestPair], lookups },
      ),
    ).rejects.toThrow(/'dpo' format produced no trainable rows/)
  })

  it('still exports a pair where neither side was flagged', async () => {
    const { rows } = await mintRolloutRows(
      [honest, record({ runId: 'run-honest-2', outcome: { searchScore: 0.2, raw: {} } })],
      new InMemoryTraceStore(),
      { now: () => new Date('2026-07-24T00:00:00Z') },
    )
    const clean = { ...triple, chosenRunId: 'run-honest', rejectedRunId: 'run-honest-2' }
    // A DPO pair must share its prompt; the per-run lookup above would name
    // two different ones, which `toDpoRows` now rejects.
    const sharedPrompt = {
      promptOf: () => 'prompt-shared',
      completionOf: (id: string) => `completion-for-${id}`,
    }
    expect(await toDpoRows([clean], sharedPrompt, { lines: rows })).toHaveLength(1)
  })
})

/**
 * `realness_gated: false` is the gate's VERDICT. A producer with no gate at all
 * was writing it, so a never-screened reward was indistinguishable on the wire
 * from a screened-clean one.
 */
describe('"never screened" is represented distinctly from "screened and clean"', () => {
  it('unscreenedRewardFields says so explicitly instead of claiming a clean verdict', () => {
    expect(unscreenedRewardFields(1)).toEqual({
      reward: 1,
      realness_gated: false,
      realness_screened: false,
    })
  })

  it('mint claims realness_screened only when the record actually carries a verdict', () => {
    expect(rolloutRewardFields(gamed).realness_screened).toBe(true)
    // No `outcome.realness` at all: the record cannot tell "screened elsewhere"
    // from "never screened", so the field is ABSENT — unknown, not `false`.
    expect(rolloutRewardFields(honest).realness_screened).toBeUndefined()
    expect('realness_screened' in rolloutRewardFields(honest)).toBe(false)
  })

  it('assertMinted refuses a never-screened POSITIVE reward', () => {
    const unscreened = malformedRolloutLine({
      outcome: {
        ...unscreenedRewardFields(1),
        reward_source: 'worker-self-verify',
        verdict: null,
        metrics: {},
        is_completed: true,
        is_truncated: false,
        error: null,
      },
    })
    expect(() => assertMinted(unscreened)).toThrow(/realness_screened: false/)
    // Still a perfectly valid line for reporting and analysis — only the
    // promotion into the training path is refused.
    expect(validateRolloutLine(unscreened)).toEqual([])
  })

  it('admits an unscreened row whose reward is null or zero', () => {
    const withReward = (reward: number | null) =>
      malformedRolloutLine({
        outcome: {
          ...unscreenedRewardFields(reward),
          reward_source: null,
          verdict: null,
          metrics: {},
          is_completed: true,
          is_truncated: false,
          error: null,
        },
      })
    expect(assertMinted(withReward(null)).outcome.reward).toBeNull()
    expect(assertMinted(withReward(0)).outcome.reward).toBe(0)
  })

  /**
   * The same distinction, one module over. `extractVerifiableReward` takes a
   * `VerificationReport` — layer scores and nothing that says the run faked
   * them — so no gate can run there, and it emits the highest-credibility
   * reward this package produces (`deterministic`, `confidence: 1`). A stubbed
   * integration reporting green is exactly that shape. The warning used to live
   * only in a doc comment; now it travels on the value.
   */
  it('a report-derived verifiable reward declares that nothing screened it', () => {
    const report = {
      layers: [{ layer: 'test', status: 'pass' as const, score: 1 }],
      passCount: 1,
      failCount: 0,
      skippedCount: 0,
      errorCount: 0,
      allPass: true,
      blendedScore: 1,
      durationMs: 1,
      startedAt: '2026-07-24T00:00:00Z',
      finishedAt: '2026-07-24T00:00:01Z',
      pass: true,
      score: 1,
    } as unknown as Parameters<typeof extractVerifiableReward>[0]
    const reward = extractVerifiableReward(report)
    expect(reward?.value).toBe(1)
    expect(reward?.determinism).toBe('deterministic')
    expect(reward?.realnessScreened).toBe(false)
  })

  it('the RunRecord path claims a screen only when the record carries the verdict', () => {
    const [fromGamed] = extractVerifiableRewardsFromRecords([gamed])
    expect(fromGamed!.reward?.realnessScreened).toBe(true)
    expect(fromGamed!.reward?.value).toBe(0)
    const [fromHonest] = extractVerifiableRewardsFromRecords([honest])
    expect(fromHonest!.reward?.realnessScreened).toBeUndefined()
  })
})

/**
 * The gate lookup used the WRONG IDENTITY KEY, and the wrong key made it
 * ORDER-DEPENDENT.
 *
 * `admitUngatedByRun` built `new Map(lines.map((l) => [l.run_id, l]))`, which is
 * last-wins. `tangle.rollout.v1` models MANY invocations per `run_id` — that is
 * what `rollout_id` and `parent_rollout_id` are for, and
 * `supervisorRunRolloutLines` emits a supervisor node plus one per worker under
 * a single `run_id` — so a GATED invocation sharing a run with an ungated
 * sibling resolved to whichever appeared LATER in the array. Same input, same
 * triple, different array order: `[gatedRoot, worker, rival]` emitted the gamed
 * episode as `chosen`, and moving one element suppressed it.
 *
 * An order-dependent security property passes every test whose fixture happens
 * to be ordered favourably, which is why the tests below run every permutation
 * and assert the outputs are IDENTICAL — and identical to the fail-closed
 * answer, since "both orders admit it" would satisfy equality too.
 */
describe('the gate lookup names an INVOCATION, and cannot depend on array order', () => {
  const withSteps = (over: Partial<MintedRolloutLine>): MintedRolloutLine =>
    fixtureRolloutLine({
      steps: [{ kind: 'llm', name: 'step-0' }],
      ...over,
    } as Parameters<typeof fixtureRolloutLine>[0])

  const base = fixtureRolloutLine().outcome

  /** The supervisor invocation of episode `run-episode` — flagged as gamed. */
  const gatedRoot = withSteps({
    rollout_id: 'sup-root',
    run_id: 'run-episode',
    role: 'supervisor',
    outcome: { ...base, reward: 0, realness_gated: true, metrics: {}, verdict: null },
  })
  /** A worker of the SAME episode, sharing its `run_id` — not flagged. */
  const worker = withSteps({
    rollout_id: 'sup-worker',
    run_id: 'run-episode',
    role: 'worker',
    outcome: { ...base, reward: 1 },
  })
  /** An unrelated episode, one invocation, used as the other side of each pair. */
  const rival = withSteps({
    rollout_id: 'rival-root',
    run_id: 'run-rival',
    role: 'agent',
    outcome: { ...base, reward: 0.2 },
  })

  const permutations = <T>(items: T[]): T[][] =>
    items.length <= 1
      ? [items]
      : items.flatMap((item, i) =>
          permutations([...items.slice(0, i), ...items.slice(i + 1)]).map((rest) => [
            item,
            ...rest,
          ]),
        )

  const orders = permutations([gatedRoot, worker, rival])

  const triple: PreferenceTriple = {
    scenarioId: 'checkout-session',
    chosenRunId: 'run-episode',
    rejectedRunId: 'run-rival',
    chosenVariantId: 'cand-sup',
    rejectedVariantId: 'cand-rival',
    marginScore: 0.8,
    scores: { chosen: 1, rejected: 0.2 },
    meta: {
      chosenPromptHash: 'p-sup',
      rejectedPromptHash: 'p-rival',
      chosenConfigHash: 'c',
      rejectedConfigHash: 'c',
      chosenModel: 'm',
      rejectedModel: 'm',
    },
  }

  const prmTriple: PrmTrainingTriple = {
    prefixRunId: 'run-episode',
    prefixStepIndex: 0,
    chosenSpanId: 'span-chosen',
    chosenReward: 1,
    rejectedSpanId: 'span-rejected',
    rejectedReward: 0.2,
    rejectedRunId: 'run-rival',
    marginScore: 0.8,
  }

  const stepReward: StepReward = {
    spanId: 'span-chosen',
    runId: 'run-episode',
    stepIndex: 0,
    kind: 'llm',
    name: 'step-0',
    reward: 1,
    determinism: 'deterministic',
  }

  const prmLookups = {
    promptOf: (runId: string) => `prompt-for-${runId}`,
    stepTextOf: (runId: string, spanId: string) => `${runId}:${spanId}`,
  }

  it('drops the pair in EVERY order — the ambiguous run cannot answer the question', async () => {
    const results = await Promise.all(
      orders.map((lines) => toDpoRows([triple], lookups, { lines })),
    )
    for (const rows of results) expect(rows).toEqual([])
    // Identical AND closed: equality alone would also hold if every order let it
    // through, which is the bug.
    expect(new Set(results.map((r) => JSON.stringify(r))).size).toBe(1)
  })

  it('is order-independent across all five line-less exporters', async () => {
    const shapes = orders.map(async (lines) => ({
      dpo: await toDpoRows([triple], lookups, { lines }),
      prm: await toPrmRows([prmTriple], prmLookups, { lines }),
      steps: stepRewardsToJsonl([stepReward], { lines }),
      trl: toTRLFormat([triple], (hash) => `prompt:${hash}`, { lines }),
      anthropic: toAnthropicFormat([triple], { lines }),
    }))
    const rendered = (await Promise.all(shapes)).map((s) => JSON.stringify(s))
    expect(new Set(rendered).size, 'output changed when only the line order changed').toBe(1)
    expect(JSON.parse(rendered[0]!)).toEqual({
      dpo: [],
      prm: [],
      steps: '',
      trl: [],
      anthropic: [],
    })
  })

  it('counts and announces the ambiguous drops instead of shrinking the file in silence', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      expect(toAnthropicFormat([triple], { lines: [gatedRoot, worker, rival] })).toEqual([])
      expect(warn).toHaveBeenCalledTimes(1)
      expect(warn.mock.calls[0]![0]).toContain('run-episode')
      expect(warn.mock.calls[0]![0]).toContain('name more than one invocation')
    } finally {
      warn.mockRestore()
    }
  })

  it('resolves precisely when the artifact names the INVOCATION instead of the run', () => {
    const lines = [gatedRoot, worker, rival]
    const byWorker = { ...triple, chosenRunId: 'sup-worker' }
    const bySupervisor = { ...triple, chosenRunId: 'sup-root' }
    // The ungated worker of a partly-gated episode is admissible; the gated
    // supervisor of the same episode is not. Only the invocation key can say so.
    expect(toAnthropicFormat([byWorker], { lines })).toHaveLength(1)
    expect(toAnthropicFormat([bySupervisor], { lines })).toEqual([])
  })

  it('still accepts a run id when that run holds exactly one invocation', () => {
    // The ordinary `mintRolloutRows` case, where rollout_id === run_id. Nothing
    // about the fix narrows what already worked.
    const solo = { ...triple, chosenRunId: 'run-rival', rejectedRunId: 'rival-root' }
    expect(toAnthropicFormat([solo], { lines: [rival] })).toHaveLength(1)
  })

  it('still THROWS on a reference with no line at all — that is a caller defect', () => {
    expect(() => toAnthropicFormat([triple], { lines: [rival] })).toThrow(
      /no rollout line supplied for run run-episode/,
    )
  })
})

/**
 * The runtime backstop composed TWO of the three checks.
 *
 * `assertRewardGate` is the layer that exists for callers the type system never
 * saw — a plain-JavaScript consumer of the published package handing an object
 * literal to `toRewardRows`. It ran `reward-relationship` and `gated-evidence`
 * and not `unscreened-reward`, so a NEVER-SCREENED positive reward that
 * `assertMinted` correctly refuses walked through all four waist exporters at
 * full value, with `realness_gated: false` on the row.
 */
describe('the runtime backstop composes EVERY check, not the ones it remembered', () => {
  /** What a plain-JS caller can hand an exporter: right shape, unqualified reward. */
  const forged = {
    ...malformedRolloutLine(),
    outcome: {
      ...unscreenedRewardFields(1),
      reward_source: 'worker-self-verify',
      verdict: null,
      metrics: {},
      is_completed: true,
      is_truncated: false,
      error: null,
    },
  } as unknown as MintedRolloutLine

  it('refuses it at every waist exporter', () => {
    expect(() => toWaistSftRows([forged])).toThrow(/realness_screened: false/)
    expect(() => toRewardRows([forged])).toThrow(/realness_screened: false/)
    expect(() => toVerifiersRolloutOutput(forged)).toThrow(/realness_screened: false/)
    expect(() => toRftItem(forged)).toThrow(/realness_screened: false/)
  })

  it('refuses it on the rl/ reward reader and the SFT path built on it', async () => {
    await expect(toSftRows([forged], lineLookups)).rejects.toThrow(/realness_screened: false/)
  })

  it('refuses it when it arrives as CONTEXT to a line-less exporter', () => {
    // The admission rule reads `realness_gated` to decide what to drop, which is
    // one of three checks. It now runs the whole list on every resolved line.
    const pair: PreferenceTriple = {
      scenarioId: 's',
      chosenRunId: forged.run_id,
      rejectedRunId: forged.run_id,
      chosenVariantId: 'a',
      rejectedVariantId: 'b',
      marginScore: 0,
      scores: { chosen: 1, rejected: 1 },
      meta: {
        chosenPromptHash: 'p',
        rejectedPromptHash: 'p',
        chosenConfigHash: 'c',
        rejectedConfigHash: 'c',
        chosenModel: 'm',
        rejectedModel: 'm',
      },
    }
    expect(() => toAnthropicFormat([pair], { lines: [forged] })).toThrow(/realness_screened: false/)
  })

  it('leaves an unscreened reward of 0 or null alone — the refusal is about POSITIVE claims', () => {
    const zeroed = {
      ...forged,
      outcome: { ...forged.outcome, reward: 0 },
    } as unknown as MintedRolloutLine
    expect(() => toRewardRows([zeroed])).not.toThrow()
  })
})

/**
 * `realness_screened` existed on the line and reached NO exported row shape, so
 * on the wire a never-screened row stayed indistinguishable from a
 * screened-clean one — precisely the ambiguity the field was added to remove.
 */
describe('both realness claims reach the wire, on every emitted row shape', () => {
  const screened = fixtureRolloutLine({
    outcome: { ...fixtureRolloutLine().outcome, realness_screened: true },
  })
  const notStated = fixtureRolloutLine()
  const declaredUnscreened = fixtureRolloutLine({
    outcome: { ...fixtureRolloutLine().outcome, reward: 0, realness_screened: false },
  })

  it('distinguishes screened-clean from never-stated from declared-unscreened', () => {
    expect(toRewardRows([screened])[0]!.metadata.realness_screened).toBe(true)
    expect(toRewardRows([notStated])[0]!.metadata.realness_screened).toBeNull()
    // reward 0 (`assertMinted` refuses an unscreened POSITIVE reward), so the
    // default quality floor is lowered to let the row out at all.
    expect(
      toRewardRows([declaredUnscreened], {
        minimumQualityExclusive: Number.MIN_SAFE_INTEGER,
      })[0]!.metadata.realness_screened,
    ).toBe(false)
    expect(toVerifiersRolloutOutput(screened).info.realness_screened).toBe(true)
    expect(toVerifiersRolloutOutput(notStated).info.realness_screened).toBeNull()
    expect(toRftItem(screened).reference.realness_screened).toBe(true)
    expect(toRftItem(notStated).reference.realness_screened).toBeNull()
    expect(toWaistSftRows([screened])[0]!.metadata.realness_screened).toBe(true)
  })

  /**
   * The generic rule, so a FIFTH row shape cannot repeat this: any object in an
   * emitted row that states one realness claim states both. A new exporter that
   * copies the `realness_gated` line and forgets the other fails here.
   */
  it('never ships one flag without the other, anywhere in any emitted row', () => {
    const lines = [screened, notStated, declaredUnscreened]
    const emitted: unknown[] = [
      toWaistSftRows(lines),
      toRewardRows(lines),
      toVerifiersRolloutOutputs(lines),
      toRftItems(lines),
    ]
    const lonely: string[] = []
    const walk = (value: unknown, path: string): void => {
      if (Array.isArray(value)) {
        for (const [i, item] of value.entries()) walk(item, `${path}[${i}]`)
        return
      }
      if (typeof value !== 'object' || value === null) return
      const keys = Object.keys(value)
      const gated = keys.includes('realness_gated')
      const screenedKey = keys.includes('realness_screened')
      if (gated !== screenedKey) lonely.push(`${path}: gated=${gated} screened=${screenedKey}`)
      for (const [key, child] of Object.entries(value)) walk(child, `${path}.${key}`)
    }
    walk(emitted, 'emitted')
    expect(lonely).toEqual([])
  })
})
