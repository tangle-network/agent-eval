import { describe, expect, it } from 'vitest'
import {
  extractFapoAttributionSignals,
  fapoDriver,
  parameterSweepDriver,
} from '../../src/campaign/drivers/fapo'
import type {
  GenerationRecord,
  ImprovementDriver,
  ProposeContext,
  ProposedCandidate,
} from '../../src/campaign/types'

function ctx(history: GenerationRecord[] = [], findings: unknown[] = []): ProposeContext {
  return {
    currentSurface: 'BASE',
    history,
    findings,
    populationSize: 3,
    generation: history.length,
    signal: new AbortController().signal,
  }
}

function fixedDriver(kind: string, suffix: string): ImprovementDriver {
  return {
    kind,
    async propose(c): Promise<ProposedCandidate[]> {
      return [
        {
          surface: `${String(c.currentSurface)}\n${suffix}`,
          label: `${kind}-strategy-${c.generation}`,
          rationale: `${kind} rationale`,
        },
      ]
    },
  }
}

function gen(labels: string[], scores: number[]): GenerationRecord {
  return {
    generationIndex: 0,
    promoted: [],
    candidates: labels.map((label, i) => ({
      surfaceHash: `h${i}`,
      label,
      rationale: label,
      composite: scores[i] ?? 0,
      ci95: [scores[i] ?? 0, scores[i] ?? 0],
      dimensions: {},
      scenarios: [],
    })),
  }
}

describe('fapoDriver', () => {
  it('starts at prompt level and proposes one reviewed candidate by default', async () => {
    const driver = fapoDriver({
      promptDriver: fixedDriver('prompt', 'PROMPT'),
      structuralDriver: fixedDriver('structural', 'STRUCTURE'),
    })

    const out = await driver.propose(
      ctx([], [{ level: 'structural', count: 12, label: 'retrieval misses evidence' }]),
    )

    expect(out).toHaveLength(1)
    expect(out[0]!.label).toContain('fapo:prompt')
    expect(out[0]!.rationale).toContain('prompt-first policy')
    expect(String(out[0]!.surface)).toContain('PROMPT')
  })

  it('accepts proposer aliases for the clearer public vocabulary', async () => {
    const driver = fapoDriver({
      promptProposer: fixedDriver('prompt', 'PROMPT'),
    })

    const out = await driver.propose(ctx())

    expect(out).toHaveLength(1)
    expect(out[0]!.label).toContain('fapo:prompt')
    expect(String(out[0]!.surface)).toContain('PROMPT')
  })

  it('escalates to parameter before structure after a prompt plateau with non-prompt evidence', async () => {
    const history: GenerationRecord[] = [
      gen(
        [
          'fapo:prompt:brevity-rules',
          'fapo:prompt:negative-examples',
          'fapo:prompt:ablation',
          'fapo:prompt:format-tightening',
        ],
        [0.7, 0.69, 0.68, 0.67],
      ),
    ]
    const parameter = parameterSweepDriver({
      candidates: [
        {
          label: 'raise-retrieval-k',
          rationale: 'retrieval misses should try a wider retrieval budget',
          changes: [{ path: 'retrieval.k', value: 10 }],
        },
      ],
    })
    const driver = fapoDriver({
      promptDriver: fixedDriver('prompt', 'PROMPT'),
      parameterDriver: parameter,
      structuralDriver: fixedDriver('structural', 'STRUCTURE'),
    })

    const out = await driver.propose({
      ...ctx(history, [{ label: 'retrieval misses on multi-entity queries', count: 9 }]),
      currentSurface: JSON.stringify({ retrieval: { k: 7 } }),
    })

    expect(out).toHaveLength(1)
    expect(out[0]!.label).toContain('fapo:parameter')
    expect(out[0]!.rationale).toContain('before structural edits')
    expect(JSON.parse(String(out[0]!.surface)).retrieval.k).toBe(10)
  })

  it('does not escalate after prompt plateau without attribution support', async () => {
    const history: GenerationRecord[] = [
      gen(
        [
          'fapo:prompt:brevity-rules',
          'fapo:prompt:negative-examples',
          'fapo:prompt:ablation',
          'fapo:prompt:format-tightening',
        ],
        [0.7, 0.69, 0.68, 0.67],
      ),
    ]
    const driver = fapoDriver({
      promptDriver: fixedDriver('prompt', 'PROMPT'),
      structuralDriver: fixedDriver('structural', 'STRUCTURE'),
    })

    await expect(driver.propose(ctx(history, []))).resolves.toEqual([])
  })

  it('stops after an empty FAPO generation instead of burning the remaining budget', () => {
    const driver = fapoDriver({
      promptDriver: fixedDriver('prompt', 'PROMPT'),
      structuralDriver: fixedDriver('structural', 'STRUCTURE'),
    })
    const result = driver.decide?.({
      history: [
        {
          generationIndex: 0,
          promoted: [],
          candidates: [],
        },
      ],
    })

    expect(result).toEqual({
      stop: true,
      reason: 'FAPO produced no scoped candidate in the prior generation',
    })
  })

  it('blocks reviewed failures before eval', async () => {
    const driver = fapoDriver({
      promptDriver: fixedDriver('prompt', 'PROMPT'),
      reviewCandidate: async () => ({
        verdict: 'fail',
        issues: [
          {
            checkName: 'scope_compliance',
            severity: 'block',
            description: 'variant edits a forbidden level',
          },
        ],
      }),
    })

    await expect(driver.propose(ctx())).rejects.toThrow(/reviewer blocked every prompt candidate/)
  })

  it('parses FAPO attribution output shapes and analyst-style findings', () => {
    const signals = extractFapoAttributionSignals([
      {
        level_partition: {
          prompt: { count: 2 },
          structural: {
            count: 3,
            clusters: [{ label: 'empty retrieval step', level: 'structural', count: 3 }],
          },
        },
      },
      {
        area: 'format',
        recommended_action: 'force exact answer-only output',
      },
      {
        label: 'increase retrieval_k after BM25 misses',
        count: 4,
      },
    ])

    expect(signals.counts.prompt).toBe(3)
    expect(signals.counts.structural).toBe(3)
    expect(signals.counts.parameter).toBe(4)
    expect(signals.clusters.some((cluster) => cluster.level === 'parameter')).toBe(true)
  })
})

describe('parameterSweepDriver', () => {
  it('applies deep patches and dot-path changes to JSON config surfaces', async () => {
    const driver = parameterSweepDriver({
      candidates: [
        {
          label: 'config-tune',
          rationale: 'try lower temperature and wider retrieval',
          patch: { model: { temperature: 0.2 } },
          changes: [
            { path: 'retrieval.k', value: 12 },
            { path: ['limits', 'max_tokens'], value: 8192 },
          ],
        },
      ],
    })

    const out = await driver.propose({
      ...ctx(),
      currentSurface: JSON.stringify({
        model: { temperature: 0.7, top_p: 0.95 },
        retrieval: { k: 7 },
      }),
      populationSize: 1,
    })

    expect(out).toHaveLength(1)
    const parsed = JSON.parse(String(out[0]!.surface))
    expect(parsed.model).toEqual({ temperature: 0.2, top_p: 0.95 })
    expect(parsed.retrieval.k).toBe(12)
    expect(parsed.limits.max_tokens).toBe(8192)
  })

  it('fails loud on non-JSON config surfaces', async () => {
    const driver = parameterSweepDriver({
      candidates: [{ label: 'x', rationale: 'r', patch: { temperature: 0.2 } }],
    })

    await expect(driver.propose(ctx())).rejects.toThrow(/JSON/)
  })
})
