import { describe, expect, it } from 'vitest'
import { extractCodeAgentBeliefDecisionPoints } from './code-agent-corpus'
import { buildBeliefDecisionResearchEvidencePacket } from './research-evidence'
import type { BeliefDecisionPoint } from './types'

describe('belief-state research evidence packets', () => {
  it('separates selective/calibration support from missing counterfactual support', () => {
    const report = extractCodeAgentBeliefDecisionPoints({
      source: 'opencode',
      run: runRecord('run-opencode-replay', 0.5),
      entries: openCodeFailureRecoveryEntries(12),
      sourcePath: '/local/opencode/session',
    })

    const strict = buildBeliefDecisionResearchEvidencePacket({
      corpusId: 'local-code-agent-corpus',
      sourceId: 'opencode',
      generatedAt: '2026-06-05T00:00:00.000Z',
      points: report.decisions,
      targetId: 'failure-recovery',
      minN: 12,
      minAccepted: 6,
      confidenceThreshold: 0.6,
      requireOpeForCounterfactualClaim: true,
    })

    expect(strict.status).toBe('insufficient')
    expect(claimStatus(strict, 'decision-corpus-support')).toBe('supported')
    expect(claimStatus(strict, 'selective-policy-evidence')).toBe('supported')
    expect(claimStatus(strict, 'calibration-evidence')).toBe('supported')
    expect(claimStatus(strict, 'off-policy-support')).toBe('insufficient')
    expect(claimStatus(strict, 'paper-ready-replay')).toBe('insufficient')
    expect(strict.blockers.join('\n')).toMatch(/behaviorProb/)
    expect(strict.paperTableRows.some((row) => row.metric === 'utilityDelta')).toBe(true)

    const selectiveOnly = buildBeliefDecisionResearchEvidencePacket({
      corpusId: 'local-code-agent-corpus',
      sourceId: 'opencode',
      generatedAt: '2026-06-05T00:00:00.000Z',
      points: report.decisions,
      targetId: 'failure-recovery',
      minN: 12,
      minAccepted: 6,
      confidenceThreshold: 0.6,
      requireOpeForCounterfactualClaim: false,
    })

    expect(selectiveOnly.status).toBe('supported')
    expect(claimStatus(selectiveOnly, 'off-policy-support')).toBe('insufficient')
    expect(claimStatus(selectiveOnly, 'paper-ready-replay')).toBe('supported')
    expect(selectiveOnly.caveats).toContain(
      'counterfactual policy claims are excluded because OPE is not required for this packet',
    )
  })

  it('marks undersupported corpora as insufficient with concrete blockers', () => {
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

    const packet = buildBeliefDecisionResearchEvidencePacket({
      generatedAt: '2026-06-05T00:00:00.000Z',
      points,
      minN: 2,
    })

    expect(packet.status).toBe('insufficient')
    expect(claimStatus(packet, 'decision-corpus-support')).toBe('insufficient')
    expect(packet.blockers).toContain(
      'collect more decision points with outcomes for at least one target',
    )
    expect(packet.analysis.evaluation).toBeUndefined()
  })
})

function claimStatus(
  packet: ReturnType<typeof buildBeliefDecisionResearchEvidencePacket>,
  id: string,
) {
  return packet.claims.find((claim) => claim.id === id)?.status
}

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
