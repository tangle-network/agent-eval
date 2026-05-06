import { describe, expect, it } from 'vitest'

import {
  buildTraceInsightPrompt,
  defaultTraceInsightPanel,
  describeTraceInsightScope,
  domainEvidencePattern,
  inferDomainKeywords,
  planTraceInsightQuestions,
  tokenizeDomainWords,
  type TraceInsightSuite,
} from './insights'

describe('trace insight planning', () => {
  const suite: TraceInsightSuite = {
    name: 'Acme Checkout',
    collectionId: 'acme-checkout',
    tasks: [{
      id: 'checkout',
      name: 'Hosted Checkout',
      prompt: 'Use the Acme payment API to create a hosted checkout session.',
      difficulty: 'hard',
      tags: ['checkout', 'payment'],
      outcome: 'error',
      score: 0.4,
      gaps: ['shot 2 still missing SDK call'],
    }],
  }

  it('infers reusable domain terms without benchmark-specific assumptions', () => {
    expect(tokenizeDomainWords('Build the Acme Checkout workflow with API docs for a hard task')).toEqual(['acme', 'checkout', 'api', 'docs'])
    expect(inferDomainKeywords(suite)).toEqual(expect.arrayContaining(['acme', 'checkout', 'payment']))
    expect(inferDomainKeywords(suite).length).toBeLessThanOrEqual(18)
    expect(describeTraceInsightScope(suite)).toBe('1 implementation task across checkout, payment.')
  })

  it('matches domain evidence with identifier-safe boundaries', () => {
    const pattern = domainEvidencePattern(['api', 'c++', 'node-'])
    expect('Used the API and C++ implementation notes.').toMatch(pattern)
    expect('Read the node- integration guide.').toMatch(pattern)
    expect('Inspected web_api_v2 wiring.').toMatch(domainEvidencePattern(['api']))
    expect('This was rapid prototyping text.').not.toMatch(pattern)
    expect('The XML parser failed.').toMatch(domainEvidencePattern([]))
  })

  it('plans trace questions and builds a bounded analyst prompt', () => {
    const questions = planTraceInsightQuestions({
      suite,
      findings: [{ kind: 'missing-domain-integration', taskIds: ['checkout'] }],
    })
    expect(questions.map((question) => question.id)).toEqual(expect.arrayContaining([
      'execution-path',
      'research-grounding',
      'domain-proof',
      'reviewer-lift',
      'optimization-targets',
    ]))
    expect(defaultTraceInsightPanel().map((role) => role.id)).toEqual([
      'trace-forensics',
      'root-cause',
      'optimization',
      'external-evidence',
    ])

    const prompt = buildTraceInsightPrompt({
      suite,
      findings: [{ kind: 'missing-domain-integration', severity: 'high', taskIds: ['checkout'] }],
      agent: { model: 'model-a' },
      totals: { passRate: 0 },
      maxRepresentativeTraces: 3,
    })
    expect(prompt).toContain('Analyze this benchmark run')
    expect(prompt).toContain('Analyst panel:')
    expect(prompt).toContain('Trace Forensics')
    expect(prompt).toContain('at most 3 representative traces')
    expect(prompt).toContain('"inferredKeywords"')
    expect(prompt).not.toContain('VerticalBench')
    expect(prompt).not.toContain('Coinbase')
  })
})
