import { describe, expect, it } from 'vitest'
import { extractCodeAgentBeliefDecisionPoints } from './code-agent-corpus'
import { buildBeliefDecisionResearchEvidencePacket } from './research-evidence'
import type { BeliefDecisionPoint } from './types'

describe('belief-state research evidence packets', () => {
  it('blocks counterfactual claims when propensities are missing', () => {
    const report = extractCodeAgentBeliefDecisionPoints({
      source: 'opencode',
      run: runRecord('run-opencode-replay', 0.5),
      entries: openCodeFailureRecoveryEntries(12),
    })

    const packet = buildBeliefDecisionResearchEvidencePacket({
      points: report.decisions,
      targetId: 'failure-recovery',
      minN: 12,
      minAccepted: 6,
      confidenceThreshold: 0.6,
      claimScope: 'counterfactual',
    })

    expect(packet.status).toBe('blocked')
    expect(gateStatus(packet, 'corpus')).toBe('supported')
    expect(gateStatus(packet, 'selective')).toBe('supported')
    expect(gateStatus(packet, 'calibration')).toBe('supported')
    expect(gateStatus(packet, 'ope')).toBe('blocked')
    expect(packet.blockers.join('\n')).toMatch(/behaviorProb/)
  })

  it('supports selective-only claims while excluding counterfactual claims', () => {
    const report = extractCodeAgentBeliefDecisionPoints({
      source: 'opencode',
      run: runRecord('run-opencode-replay', 0.5),
      entries: openCodeFailureRecoveryEntries(12),
    })

    const packet = buildBeliefDecisionResearchEvidencePacket({
      points: report.decisions,
      targetId: 'failure-recovery',
      minN: 12,
      minAccepted: 6,
      confidenceThreshold: 0.6,
      claimScope: 'selective',
    })

    expect(packet.status).toBe('supported')
    expect(packet.gates.map((gate) => gate.id)).toEqual(['corpus', 'selective', 'calibration'])
    expect(packet.caveats).toContain('counterfactual claims excluded: OPE support was not required')
  })

  it('blocks undersupported corpora', () => {
    const points: BeliefDecisionPoint[] = [
      {
        id: 'd-1',
        runId: 'r-1',
        stepIndex: 0,
        kind: 'retry',
        chosenAction: 'verify',
        candidateActions: ['retry', 'verify', 'continue', 'stop'],
        confidence: 0.8,
        evidence: [{ source: 'event', id: 'e-1' }],
        outcome: { success: true, score: 1 },
        metadata: { target: 'failure-recovery' },
      },
    ]

    const packet = buildBeliefDecisionResearchEvidencePacket({ points, minN: 2 })

    expect(packet.status).toBe('blocked')
    expect(gateStatus(packet, 'corpus')).toBe('blocked')
    expect(packet.blockers).toContain('no decision target has enough outcome support')
  })
})

function gateStatus(
  packet: ReturnType<typeof buildBeliefDecisionResearchEvidencePacket>,
  id: string,
) {
  return packet.gates.find((gate) => gate.id === id)?.status
}

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
