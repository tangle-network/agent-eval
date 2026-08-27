import { describe, expect, it } from 'vitest'
import {
  analyzeBeliefDecisionCorpus,
  extractCodeAgentBeliefDecisionPoints,
  inventoryBeliefDecisionPoints,
  selectBeliefDecisionTarget,
} from './code-agent-corpus'
import type { BeliefDecisionPoint } from './types'

describe('code-agent belief-state corpus', () => {
  it('extracts a RunRecord-joined failure-recovery corpus and evaluates selective/OPE support', () => {
    const run = runRecord('run-opencode-1', 0.5)
    const report = extractCodeAgentBeliefDecisionPoints({
      source: 'opencode',
      run,
      entries: openCodeFailureRecoveryEntries(12),
      sourcePath: '/local/opencode/session',
    })

    expect(report.diagnostics).toEqual([])
    expect(report.decisions.every((point) => point.runId === run.runId)).toBe(true)
    expect(report.decisions.every((point) => point.scenarioId === run.scenarioId)).toBe(true)

    const inventory = inventoryBeliefDecisionPoints(report.decisions)
    expect(inventory.byTarget.find((bucket) => bucket.id === 'failure-recovery')).toMatchObject({
      n: 12,
      withOutcome: 12,
      withConfidence: 12,
      withCandidateActions: 12,
      withBehaviorProb: 0,
      withTargetProb: 0,
      successRate: 0.5,
    })
    expect(inventory.byKind.find((bucket) => bucket.id === 'retry')).toMatchObject({ n: 12 })

    const target = selectBeliefDecisionTarget(report.decisions, { minN: 12 })
    expect(target?.id).toBe('failure-recovery')
    expect(target?.support.n).toBe(12)

    const analysis = analyzeBeliefDecisionCorpus({
      points: report.decisions,
      targetId: 'failure-recovery',
      minN: 12,
      minAccepted: 6,
      confidenceThreshold: 0.6,
      requireOpe: true,
    })

    expect(analysis.target?.id).toBe('failure-recovery')
    expect(analysis.evaluation?.selectiveStatus).toBe('ship')
    expect(analysis.evaluation?.calibrationStatus).toBe('supported')
    expect(analysis.evaluation?.opeStatus).toBe('unsupported')
    expect(analysis.evaluation?.status).toBe('hold')
    expect(analysis.evaluation?.diagnostics.join('\n')).toMatch(/invalid behaviorProb missing/)
  })

  it('supports Codex, Claude Code, Kimi Code, and Pi/PiGraph-shaped traces', () => {
    const cases = [
      {
        source: 'codex' as const,
        run: runRecord('run-codex-1', 0.6),
        entries: [
          {
            timestamp: '2026-06-05T00:00:00.000Z',
            type: 'response_item',
            payload: { type: 'function_call', call_id: 'call-1', name: 'edit_file' },
          },
          {
            timestamp: '2026-06-05T00:00:01.000Z',
            type: 'response_item',
            payload: { type: 'function_call_output', call_id: 'call-1', output: 'failed' },
          },
          {
            timestamp: '2026-06-05T00:00:02.000Z',
            type: 'event_msg',
            payload: { type: 'task_complete' },
          },
        ],
        expectedTarget: 'failure-recovery',
      },
      {
        source: 'claude-code' as const,
        run: runRecord('run-claude-1', 0.7),
        entries: [
          {
            type: 'assistant',
            timestamp: '2026-06-05T00:00:00.000Z',
            message: {
              content: [{ type: 'tool_use', id: 'tool-1', name: 'Bash' }],
            },
          },
          {
            type: 'assistant',
            timestamp: '2026-06-05T00:00:01.000Z',
            message: {
              content: [{ type: 'tool_result', tool_use_id: 'tool-1', is_error: true }],
            },
          },
          {
            type: 'pr-link',
            timestamp: '2026-06-05T00:00:02.000Z',
          },
        ],
        expectedTarget: 'failure-recovery',
      },
      {
        source: 'kimi-code' as const,
        run: runRecord('run-kimi-1', 0.7),
        entries: [
          {
            timestamp: 1780000000,
            message: {
              type: 'ToolCall',
              payload: { id: 'tool-1', function: { name: 'bash' } },
            },
          },
          {
            timestamp: 1780000001,
            message: {
              type: 'ToolResult',
              payload: { tool_call_id: 'tool-1', return_value: { is_error: true } },
            },
          },
          {
            timestamp: 1780000002,
            message: { type: 'TurnEnd', payload: {} },
          },
        ],
        expectedTarget: 'failure-recovery',
      },
      {
        source: 'pi' as const,
        run: runRecord('run-pi-1', 0.9),
        entries: [
          {
            nodes: [
              { id: 'tool', ir: { id: 'tool', kind: 'ToolInvocation' } },
              { id: 'result', ir: { id: 'result', kind: 'ToolResult' } },
              { id: 'done', ir: { id: 'done', kind: 'CompletionDecision' } },
            ],
            edges: [],
          },
        ],
        expectedTarget: 'tool-selection',
      },
    ]

    for (const item of cases) {
      const report = extractCodeAgentBeliefDecisionPoints({
        source: item.source,
        run: item.run,
        entries: item.entries,
      })
      const inventory = inventoryBeliefDecisionPoints(report.decisions)
      expect(inventory.n, item.source).toBeGreaterThan(0)
      expect(
        inventory.byTarget.some((bucket) => bucket.id === item.expectedTarget),
        item.source,
      ).toBe(true)
    }
  })

  it('does not select a target when support is below the minimum', () => {
    const points: BeliefDecisionPoint[] = [
      {
        id: 'd-1',
        runId: 'r-1',
        stepIndex: 0,
        kind: 'retry',
        chosenAction: 'continue',
        candidateActions: ['retry', 'verify', 'continue', 'stop'],
        confidence: 0.4,
        evidence: [{ source: 'event', id: 'e-1' }],
        outcome: { success: false, score: 0 },
        metadata: { target: 'failure-recovery' },
      },
    ]

    expect(selectBeliefDecisionTarget(points, { minN: 2 })).toBeNull()
    const analysis = analyzeBeliefDecisionCorpus({ points, minN: 2 })
    expect(analysis.evaluation).toBeUndefined()
    expect(analysis.diagnostics).toContain(
      'no decision target has enough support for policy evaluation',
    )
  })

  it('does not treat a missing patch success field as a failed recovery event', () => {
    const report = extractCodeAgentBeliefDecisionPoints({
      source: 'codex',
      run: runRecord('run-codex-patch-unknown'),
      entries: [
        {
          timestamp: '2026-06-05T00:00:00.000Z',
          type: 'event_msg',
          payload: { type: 'patch_apply_end' },
        },
      ],
    })

    expect(report.diagnostics).toEqual([])
    expect(report.decisions).toHaveLength(1)
    expect(report.decisions[0]).toMatchObject({
      kind: 'tool-select',
      chosenAction: 'patch',
      outcome: undefined,
      metadata: { target: 'tool-selection' },
    })
  })
})

function openCodeFailureRecoveryEntries(n: number): Record<string, unknown>[] {
  return Array.from({ length: n }).flatMap((_, index) => {
    const successfulVerify = index % 2 === 0
    const next = successfulVerify
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

function runRecord(runId: string, score?: number) {
  return {
    runId,
    scenarioId: 'scenario-1',
    costUsd: 0,
    outcome: {
      ...(score !== undefined ? { holdoutScore: score } : {}),
      raw: {},
    },
  }
}
