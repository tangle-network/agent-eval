import { describe, expect, it } from 'vitest'
import {
  extractFapoAttributionSignals,
  fapoProposer,
  parameterSweepProposer,
} from '../../src/campaign/proposers/fapo'
import type {
  GenerationRecord,
  ProposeContext,
  ProposedCandidate,
  SurfaceProposer,
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

function fixedProposer(kind: string, suffix: string): SurfaceProposer {
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

describe('fapoProposer', () => {
  it('starts at prompt level and proposes one reviewed candidate by default', async () => {
    const proposer = fapoProposer({
      promptProposer: fixedProposer('prompt', 'PROMPT'),
      structuralProposer: fixedProposer('structural', 'STRUCTURE'),
    })

    const out = await proposer.propose(
      ctx([], [{ level: 'structural', count: 12, label: 'retrieval misses evidence' }]),
    )

    expect(out).toHaveLength(1)
    expect(out[0]!.label).toContain('fapo:prompt')
    expect(out[0]!.rationale).toContain('prompt-first policy')
    expect(String(out[0]!.surface)).toContain('PROMPT')
  })

  it('accepts the level-proposer map for the clearer public vocabulary', async () => {
    const proposer = fapoProposer({
      proposers: { prompt: fixedProposer('prompt', 'PROMPT') },
    })

    const out = await proposer.propose(ctx())

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
    const parameter = parameterSweepProposer({
      candidates: [
        {
          label: 'raise-retrieval-k',
          rationale: 'retrieval misses should try a wider retrieval budget',
          changes: [{ path: 'retrieval.k', value: 10 }],
        },
      ],
    })
    const proposer = fapoProposer({
      promptProposer: fixedProposer('prompt', 'PROMPT'),
      parameterProposer: parameter,
      structuralProposer: fixedProposer('structural', 'STRUCTURE'),
    })

    const out = await proposer.propose({
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
    const proposer = fapoProposer({
      promptProposer: fixedProposer('prompt', 'PROMPT'),
      structuralProposer: fixedProposer('structural', 'STRUCTURE'),
    })

    await expect(proposer.propose(ctx(history, []))).resolves.toEqual([])
  })

  it('stops after an empty FAPO generation instead of burning the remaining budget', () => {
    const proposer = fapoProposer({
      promptProposer: fixedProposer('prompt', 'PROMPT'),
      structuralProposer: fixedProposer('structural', 'STRUCTURE'),
    })
    const result = proposer.decide?.({
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
    const proposer = fapoProposer({
      promptProposer: fixedProposer('prompt', 'PROMPT'),
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

    await expect(proposer.propose(ctx())).rejects.toThrow(/reviewer blocked every prompt candidate/)
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

  it('can escalate directly to structural when parameter-before-structural is disabled', async () => {
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
    const proposer = fapoProposer({
      promptProposer: fixedProposer('prompt', 'PROMPT'),
      parameterProposer: fixedProposer('parameter', 'PARAM'),
      structuralProposer: fixedProposer('structural', 'STRUCTURE'),
      parameterBeforeStructural: false,
    })

    const out = await proposer.propose(
      ctx(history, [{ label: 'tool chain drops the second lookup', count: 5 }]),
    )

    expect(out).toHaveLength(1)
    expect(out[0]!.label).toContain('fapo:structural')
    expect(String(out[0]!.surface)).toContain('STRUCTURE')
  })

  it('respects forbidden structural scope even when structural attribution is present', async () => {
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
    const proposer = fapoProposer({
      promptProposer: fixedProposer('prompt', 'PROMPT'),
      structuralProposer: fixedProposer('structural', 'STRUCTURE'),
      scope: { forbiddenLevels: ['structural'] },
    })

    await expect(
      proposer.propose(ctx(history, [{ label: 'tool chain drops the second lookup', count: 5 }])),
    ).resolves.toEqual([])
  })

  it('allows batch proposals only when proposalsPerCycle raises the paper-faithful default', async () => {
    const promptProposer: SurfaceProposer = {
      kind: 'prompt',
      async propose({ populationSize }) {
        return Array.from({ length: populationSize }, (_, i) => ({
          surface: `PROMPT_${i}`,
          label: `variant-${i}`,
          rationale: `variant ${i}`,
        }))
      },
    }
    const proposer = fapoProposer({ promptProposer, proposalsPerCycle: 2 })

    const out = await proposer.propose(ctx())

    expect(out.map((candidate) => candidate.label)).toEqual([
      'fapo:prompt:variant-0',
      'fapo:prompt:variant-1',
    ])
  })

  it('guards recursive attribution inputs instead of looping forever', () => {
    const finding: Record<string, unknown> = {
      label: 'retrieval misses evidence',
      level: 'structural',
      count: 1,
    }
    finding.clusters = [finding]

    const signals = extractFapoAttributionSignals([finding])

    expect(signals.counts.structural).toBe(1)
    expect(signals.clusters).toHaveLength(1)
  })
})

describe('parameterSweepProposer', () => {
  it('applies deep patches and dot-path changes to JSON config surfaces', async () => {
    const proposer = parameterSweepProposer({
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

    const out = await proposer.propose({
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
    const proposer = parameterSweepProposer({
      candidates: [{ label: 'x', rationale: 'r', patch: { temperature: 0.2 } }],
    })

    await expect(proposer.propose(ctx())).rejects.toThrow(/JSON/)
  })

  it('skips semantic no-op patches even when formatting changes', async () => {
    const proposer = parameterSweepProposer({
      candidates: [
        { label: 'same', rationale: 'r', patch: { retrieval: { k: 7 } } },
        { label: 'next', rationale: 'r', changes: [{ path: 'retrieval.k', value: 8 }] },
      ],
    })

    const out = await proposer.propose({
      ...ctx(),
      currentSurface: JSON.stringify({ retrieval: { k: 7 } }),
      populationSize: 2,
    })

    expect(out).toHaveLength(1)
    expect(out[0]!.label).toBe('next')
  })

  it('rejects unsafe JSON patch keys before applying a parameter candidate', async () => {
    const pathProposer = parameterSweepProposer({
      candidates: [
        {
          label: 'pollute-path',
          rationale: 'r',
          changes: [{ path: ['safe', '__proto__'], value: { polluted: true } }],
        },
      ],
    })
    const patchProposer = parameterSweepProposer({
      candidates: [
        {
          label: 'pollute-patch',
          rationale: 'r',
          patch: { safe: { constructor: { polluted: true } } },
        },
      ],
    })

    await expect(
      pathProposer.propose({
        ...ctx(),
        currentSurface: JSON.stringify({ safe: {} }),
      }),
    ).rejects.toThrow(/unsafe JSON key/)
    await expect(
      patchProposer.propose({
        ...ctx(),
        currentSurface: JSON.stringify({ safe: {} }),
      }),
    ).rejects.toThrow(/unsafe JSON key/)
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined()
  })
})
