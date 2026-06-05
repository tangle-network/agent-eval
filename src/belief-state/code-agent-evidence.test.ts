import { describe, expect, it } from 'vitest'
import { buildCodeAgentBeliefEvidenceCorpus } from './code-agent-evidence'

describe('code-agent belief-state evidence corpus', () => {
  it('joins session intake, decision extraction, and research gates', () => {
    const corpus = buildCodeAgentBeliefEvidenceCorpus({
      sessions: [
        {
          source: 'opencode',
          entries: openCodeFailureRecoveryEntries(12),
          sourcePath: '/local/opencode/session.jsonl',
          scenarioId: 'scenario-1',
          score: 0.5,
        },
      ],
      targetId: 'failure-recovery',
      minN: 12,
      minAccepted: 6,
      confidenceThreshold: 0.6,
      claimScope: 'selective',
    })

    expect(corpus.runs).toHaveLength(1)
    expect(corpus.intakeDiagnostics[0]).toMatchObject({
      source: 'opencode',
      entries: 24,
      hasQualityLabel: true,
    })
    expect(corpus.extractionDiagnostics).toEqual([])
    expect(
      corpus.inventory.byTarget.find((bucket) => bucket.id === 'failure-recovery'),
    ).toMatchObject({
      n: 12,
      withOutcome: 12,
      withConfidence: 12,
    })
    expect(corpus.evidence.status).toBe('supported')
    expect(corpus.evidence.analysis.target?.id).toBe('failure-recovery')
    expect(corpus.evidence.caveats).toContain(
      'counterfactual claims excluded: OPE support was not required',
    )
  })

  it('keeps counterfactual claims blocked when sessions have no logged propensities', () => {
    const corpus = buildCodeAgentBeliefEvidenceCorpus({
      sessions: [
        {
          source: 'opencode',
          entries: openCodeFailureRecoveryEntries(12),
          score: 0.5,
        },
      ],
      targetId: 'failure-recovery',
      minN: 12,
      minAccepted: 6,
      confidenceThreshold: 0.6,
      claimScope: 'counterfactual',
    })

    expect(corpus.evidence.status).toBe('blocked')
    expect(corpus.evidence.blockers.join('\n')).toMatch(/behaviorProb/)
  })
})

function openCodeFailureRecoveryEntries(n: number): Record<string, unknown>[] {
  return Array.from({ length: n }).flatMap((_, index) => {
    const next =
      index % 2 === 0
        ? {
            id: `follow-up-${index}`,
            type: 'tool',
            tool: 'test',
            time: { created: 1780000001 + index * 10 },
            state: { status: 'completed' },
          }
        : {
            id: `terminal-${index}`,
            role: 'assistant',
            finish: 'error',
            time: { created: 1780000001 + index * 10, completed: 1780000002 + index * 10 },
          }
    return [
      {
        id: `failed-${index}`,
        type: 'tool',
        tool: 'edit_file',
        time: { created: 1780000000 + index * 10 },
        state: { status: 'error' },
      },
      next,
    ]
  })
}
