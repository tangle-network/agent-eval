import { describe, expect, it } from 'vitest'
import { fixtureRolloutLine } from '../fixtures'
import { buildDatasetCard, type DatasetCardInputs } from './card'
import { emptyScrubCounts } from './scrub'

function cardInputs(overrides: Partial<DatasetCardInputs> = {}): DatasetCardInputs {
  const supervisorWin = fixtureRolloutLine({ role: 'supervisor', run_id: 'run-a', generation: 0 })
  const supervisorLoss = fixtureRolloutLine({
    role: 'supervisor',
    run_id: 'run-a',
    generation: -1,
    outcome: {
      ...fixtureRolloutLine().outcome,
      reward: 0,
      reward_source: 'swe-arena-official-judge',
    },
  })
  const worker = fixtureRolloutLine({ role: 'worker', run_id: 'run-b', generation: 0 })
  const proposer = fixtureRolloutLine({
    role: 'proposer',
    run_id: 'run-b',
    generation: 0,
    outcome: {
      ...fixtureRolloutLine().outcome,
      reward: 1 / 3,
      reward_source: 'swe-arena-official-judge/candidate-resolved-fraction',
    },
  })
  const scrubTotals = emptyScrubCounts()
  scrubTotals['home-path'] = 7
  return {
    lines: [supervisorWin, supervisorLoss, worker, proposer],
    formats: ['sft', 'raw'],
    includeProposers: true,
    sourceFiles: ['gen3-rollouts.jsonl'],
    scrubTotals,
    excluded: { proposers: 0, nonTrain: 2 },
    formatCounts: { sft: 2, raw: 4 },
    gate: {
      gatedLines: 0,
      byFormat: {
        sft: { input: 0, emitted: 0, excluded: 0, maxEmittedReward: null },
        raw: { input: 0, emitted: 0, excluded: 0, maxEmittedReward: null },
      },
    },
    ...overrides,
  }
}

/** A card whose lines include one gated run, with a consistent gate report. */
function gatedCardInputs(): DatasetCardInputs {
  const base = cardInputs()
  const gamed = fixtureRolloutLine({
    rollout_id: 'gamed-1',
    role: 'worker',
    run_id: 'run-b',
    generation: 0,
    outcome: { ...fixtureRolloutLine().outcome, reward: 0, realness_gated: true },
  })
  return {
    ...base,
    lines: [...base.lines, gamed],
    formats: ['sft', 'verifiers', 'rft', 'raw'],
    formatCounts: { sft: 2, verifiers: 5, rft: 5, raw: 5 },
    gate: {
      gatedLines: 1,
      byFormat: {
        sft: { input: 1, emitted: 0, excluded: 1, maxEmittedReward: null },
        verifiers: { input: 1, emitted: 1, excluded: 0, maxEmittedReward: 0 },
        rft: { input: 1, emitted: 1, excluded: 0, maxEmittedReward: 0 },
        raw: { input: 1, emitted: 1, excluded: 0, maxEmittedReward: 0 },
      },
    },
  }
}

describe('dataset card', () => {
  it('emits frontmatter configs only for the selected formats', () => {
    const card = buildDatasetCard(cardInputs())
    expect(card.startsWith('---\nlicense: unknown\n')).toBe(true)
    expect(card).toContain('config_name: sft')
    expect(card).toContain('path: sft/train.jsonl')
    expect(card).toContain('config_name: raw')
    expect(card).not.toContain('config_name: verifiers')
    expect(card).not.toContain('config_name: rft')
  })

  it('counts table matches the input lines per role and reward', () => {
    const card = buildDatasetCard(cardInputs())
    expect(card).toContain('| supervisor | 1 | 1 |')
    expect(card).toContain('| supervisor | 0 | 1 |')
    expect(card).toContain('| worker | 1 | 1 |')
    expect(card).toContain('| proposer | 0.3333 | 1 |')
    expect(card).toContain('Total lines: 4')
  })

  it('documents provenance: run ids, generations, reward sources', () => {
    const card = buildDatasetCard(cardInputs())
    expect(card).toContain('`run-a`, `run-b`')
    expect(card).toContain('Generations: -1, 0')
    expect(card).toContain('`swe-arena-official-judge/candidate-resolved-fraction`')
    expect(card).toContain('`gen3-rollouts.jsonl`')
  })

  it('handles null generations (non-improvement-loop lines)', () => {
    const card = buildDatasetCard(
      cardInputs({ lines: [fixtureRolloutLine({ generation: null, candidate_index: null })] }),
    )
    expect(card).toContain('Generations: ')
  })

  it('states the inherited-reward caveat and the trainable-only guarantee', () => {
    const card = buildDatasetCard(cardInputs())
    expect(card).toContain('INHERITED from the parent supervisor episode')
    expect(card).toContain("does not establish this worker's individual contribution")
    expect(card).toContain('trainable split only')
    expect(card).toContain('(2 dropped here)')
  })

  it('carries scrub totals, license placeholder, and citation stub', () => {
    const card = buildDatasetCard(cardInputs())
    expect(card).toContain('| home-path | 7 |')
    expect(card).toContain('must set the real SPDX license id')
    expect(card).toContain('@misc{tangle_rollout_ledger')
  })

  it('reflects the proposer-exclusion flag both ways', () => {
    const withProposers = buildDatasetCard(cardInputs())
    expect(withProposers).toContain('Proposer sessions are INCLUDED')
    const withoutProposers = buildDatasetCard(
      cardInputs({ includeProposers: false, excluded: { proposers: 3, nonTrain: 0 } }),
    )
    expect(withoutProposers).toContain('excluded by default (3 lines dropped)')
  })

  it('is deterministic for the same inputs', () => {
    expect(buildDatasetCard(cardInputs())).toBe(buildDatasetCard(cardInputs()))
  })
})

describe('dataset card — anti-Goodhart gate section', () => {
  it('renders the measured per-format counts, not a static claim', () => {
    const card = buildDatasetCard(gatedCardInputs())
    expect(card).toContain('**1 of 5 lines in this release are gated.**')
    expect(card).toContain('| sft | EXCLUDED — an SFT row is an imitation target | 0 | 1 | — |')
    expect(card).toContain('| verifiers | INCLUDED, reward forced to 0, flagged | 1 | 0 | 0 |')
    expect(card).toContain('| rft | INCLUDED, reward forced to 0, flagged | 1 | 0 | 0 |')
    expect(card).toContain('| raw | INCLUDED verbatim, flagged | 1 | 0 | 0 |')
    expect(card).toContain('`info.realness_gated`')
    expect(card).toContain('`reference.realness_gated`')
  })

  it('states zero gated lines when the release has none', () => {
    const card = buildDatasetCard(cardInputs())
    expect(card).toContain('**0 of 4 lines in this release are gated.**')
  })

  it('refuses to render a gate report that disagrees with the lines it describes', () => {
    const drifted = { ...gatedCardInputs(), lines: cardInputs().lines }
    expect(() => buildDatasetCard(drifted)).toThrow('measured different data')
  })

  it('refuses to render a gate report that violates the release policy', () => {
    const base = gatedCardInputs()
    const poisoned: DatasetCardInputs = {
      ...base,
      gate: {
        gatedLines: 1,
        byFormat: {
          ...base.gate.byFormat,
          verifiers: { input: 1, emitted: 1, excluded: 0, maxEmittedReward: 0.95 },
        },
      },
    }
    expect(() => buildDatasetCard(poisoned)).toThrow('may not ship a positive reward')
  })
})
