import { describe, expect, it } from 'vitest'
import {
  acquisitionPlansForKnowledgeGaps,
  blockingKnowledgeEval,
  scoreKnowledgeReadiness,
  userQuestionsForKnowledgeGaps,
  type KnowledgeRequirement,
} from '../src/knowledge'
import { classifyFailure } from '../src/failure-taxonomy'
import type { Run, Span, TraceEvent } from '../src/trace/schema'

function req(overrides: Partial<KnowledgeRequirement> = {}): KnowledgeRequirement {
  return {
    id: 'repo-build-command',
    description: 'Repo build and typecheck command',
    requiredFor: ['coding-agent-run'],
    category: 'codebase_specific',
    acquisitionMode: 'inspect_repo',
    importance: 'blocking',
    freshness: 'weekly',
    sensitivity: 'public',
    confidenceNeeded: 0.9,
    currentConfidence: 0.2,
    evidenceIds: [],
    fallbackPolicy: 'block',
    ...overrides,
  }
}

describe('knowledge readiness', () => {
  it('scores blocking gaps and emits a control-runtime eval', () => {
    const report = scoreKnowledgeReadiness({
      taskId: 'task-1',
      requirements: [
        req(),
        req({
          id: 'style-pref',
          category: 'preference',
          acquisitionMode: 'ask_user',
          importance: 'low',
          confidenceNeeded: 0.5,
          currentConfidence: 0.5,
          fallbackPolicy: 'continue_with_caveat',
          evidenceIds: ['answer-1'],
        }),
      ],
    })

    expect(report.readinessScore).toBeLessThan(1)
    expect(report.blockingMissingRequirements.map((r) => r.id)).toEqual(['repo-build-command'])
    expect(report.recommendedAction).toBe('inspect_repo')

    const evalResult = blockingKnowledgeEval(report)
    expect(evalResult.passed).toBe(false)
    expect(evalResult.severity).toBe('critical')
    expect(evalResult.metadata?.knowledgeReadiness).toBe(report)
  })

  it('builds reusable user questions and acquisition plans from gaps', () => {
    const gap = req({
      id: 'customer-api-key',
      description: 'Customer API key',
      category: 'credential_or_secret',
      acquisitionMode: 'ask_user',
      sensitivity: 'secret',
      fallbackPolicy: 'ask',
    })

    const questions = userQuestionsForKnowledgeGaps([gap])
    expect(questions[0]).toMatchObject({
      requirementId: 'customer-api-key',
      answerType: 'credential',
    })

    const plans = acquisitionPlansForKnowledgeGaps([gap])
    expect(plans[0]?.mode).toBe('ask_user')
    expect(plans[0]?.questions?.[0]?.id).toBe('question_customer-api-key')
  })

  it('treats expired knowledge as missing even when confidence is high', () => {
    const report = scoreKnowledgeReadiness({
      taskId: 'task-stale',
      now: new Date('2026-05-04T12:00:00.000Z'),
      requirements: [
        req({
          id: 'irs-publication-current',
          description: 'Current IRS publication for the requested tax year',
          currentConfidence: 1,
          confidenceNeeded: 0.8,
          evidenceIds: ['source:irs-pub'],
          validUntil: '2026-05-04T11:59:59.000Z',
          lastVerifiedAt: '2026-04-01T00:00:00.000Z',
        }),
      ],
    })

    expect(report.readinessScore).toBe(0)
    expect(report.blockingMissingRequirements.map((requirement) => requirement.id)).toEqual(['irs-publication-current'])
    expect(blockingKnowledgeEval(report).passed).toBe(false)
  })

  it.each([
    ['ask_user', 'ask_user'],
    ['search_web', 'collect_web_data'],
    ['query_connector', 'query_connectors'],
    ['inspect_repo', 'inspect_repo'],
  ] as const)('routes non-blocking %s gaps to %s', (acquisitionMode, expectedAction) => {
    const report = scoreKnowledgeReadiness({
      taskId: `task-${acquisitionMode}`,
      requirements: [
        req({
          id: `gap-${acquisitionMode}`,
          acquisitionMode,
          importance: 'medium',
          sensitivity: 'public',
          confidenceNeeded: 0.9,
          currentConfidence: 0.1,
          fallbackPolicy: 'continue_with_caveat',
        }),
      ],
    })

    expect(report.blockingMissingRequirements).toEqual([])
    expect(report.nonBlockingGaps.map((gap) => gap.id)).toEqual([`gap-${acquisitionMode}`])
    expect(report.recommendedAction).toBe(expectedAction)
  })

  it('preserves blocking-gap priority over non-blocking gap acquisition modes', () => {
    const report = scoreKnowledgeReadiness({
      taskId: 'task-blocking-priority',
      requirements: [
        req({
          id: 'blocking-repo-context',
          acquisitionMode: 'inspect_repo',
          importance: 'blocking',
          fallbackPolicy: 'block',
        }),
        req({
          id: 'nonblocking-user-preference',
          acquisitionMode: 'ask_user',
          importance: 'medium',
          fallbackPolicy: 'continue_with_caveat',
        }),
      ],
    })

    expect(report.blockingMissingRequirements.map((gap) => gap.id)).toEqual(['blocking-repo-context'])
    expect(report.recommendedAction).toBe('inspect_repo')
  })
})

describe('knowledge failure taxonomy', () => {
  const failedRun: Run = {
    runId: 'run-1',
    scenarioId: 'scenario-1',
    startedAt: 0,
    status: 'failed',
    outcome: { pass: false },
  }

  it('classifies readiness-blocked runs before generic failures', () => {
    const events: TraceEvent[] = [{
      eventId: 'evt-1',
      runId: 'run-1',
      kind: 'custom',
      timestamp: 1,
      payload: { kind: 'readiness_scored', passed: false },
    }]

    expect(classifyFailure({ run: failedRun, spans: [], events }).failureClass).toBe('knowledge_readiness_blocked')
  })

  it('classifies empty retrieval on failed runs as bad_retrieval', () => {
    const spans: Span[] = [{
      spanId: 'span-1',
      runId: 'run-1',
      kind: 'retrieval',
      name: 'kb.search',
      startedAt: 1,
      query: 'build command',
      hits: [],
    }]

    expect(classifyFailure({ run: failedRun, spans, events: [] }).failureClass).toBe('bad_retrieval')
  })
})
