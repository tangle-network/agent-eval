import { describe, expect, it } from 'vitest'

import { evaluateActionPolicy } from './action-policy'

describe('evaluateActionPolicy', () => {
  it('requires approval for external side effects before execution', () => {
    const decision = evaluateActionPolicy(
      { type: 'browser.submit-form', externalSideEffect: true },
      { requireApprovalForExternalSideEffects: true },
      { createdAt: '2026-01-01T00:00:00.000Z' },
    )

    expect(decision.allowed).toBe(true)
    expect(decision.requiresApproval).toBe(true)
    expect(decision.label?.source).toBe('policy')
    expect(decision.label?.kind).toBe('comment')
    expect(decision.reasons).toContain('external side effect requires approval')
  })

  it('blocks actions that exceed cost or evidence policy', () => {
    const decision = evaluateActionPolicy(
      { type: 'coding.run-large-mutation', costUsd: 12, metadata: { expectedOutcome: 'improve tests' } },
      { maxActionCostUsd: 5, expectedOutcomeRequired: true, killCriteriaRequired: true },
      { createdAt: '2026-01-01T00:00:00.000Z' },
    )

    expect(decision.allowed).toBe(false)
    expect(decision.blocked).toBe(true)
    expect(decision.requiresApproval).toBe(false)
    expect(decision.label?.kind).toBe('policy_block')
    expect(decision.reasons).toEqual([
      'cost 12 exceeds max action cost 5',
      'kill criteria are required',
    ])
  })

  it('does not let auto-approve override explicit approval policies', () => {
    const decision = evaluateActionPolicy(
      { type: 'browser.submit-form', externalSideEffect: true },
      {
        autoApproveTypes: ['browser.submit-form'],
        requireApprovalForExternalSideEffects: true,
      },
      { createdAt: '2026-01-01T00:00:00.000Z' },
    )

    expect(decision.allowed).toBe(true)
    expect(decision.requiresApproval).toBe(true)
    expect(decision.reasons).toEqual([
      'external side effect requires approval',
      'action type "browser.submit-form" is auto-approved only when no approval policy applies',
    ])
  })
})
