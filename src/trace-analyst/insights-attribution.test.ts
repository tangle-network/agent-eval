import assert from 'node:assert/strict'
import { describe, it } from 'vitest'

import {
  buildTraceInsightContext, buildTraceInsightPrompt, isTraceInsightAttribution,
  scoreTraceInsightReadiness, type TraceInsightAttribution, type TraceInsightEvidence, type TraceInsightFinding,
} from './insights'

function evidence(): TraceInsightEvidence {
  const artifact = (role: string) => ({ role, uri: `artifacts/${'a'.repeat(64)}`, sha256: `sha256:${'a'.repeat(64)}` as const, byteLength: 1 })
  return {
    subject: { verticalId: 'v', taskId: 't', cellId: 'c', attemptId: 'a', company: 'Acme', tool: 'SDK', toolRevision: '1.0.0' },
    artifacts: { seed: artifact('seed'), task: artifact('task'), cell: artifact('cell'), request: artifact('request'),
      response: artifact('response'), document: artifact('document'), controls: artifact('controls'), binding: artifact('binding') },
    spans: [{ traceId: 'a'.repeat(32), spanId: 'b'.repeat(16), artifact: artifact('span') }],
  }
}

function toolFailure(): Extract<TraceInsightAttribution, { outcome: 'tool-failure' }> {
  const captured = evidence()
  return { ...captured, outcome: 'tool-failure', evidenceClass: 'validated-request-response',
    proof: { ...captured.artifacts.binding!, role: 'execution' }, authority: { ...captured.artifacts.seed!, role: 'authority' } }
}

// A missing evidence class is also a compile-time error for producers, not just a report check.
function typeContract(): void {
  const { evidenceClass: _class, ...withoutClass } = toolFailure()
  // @ts-expect-error Every attribution, including an unknown, requires its evidence class.
  const invalid: TraceInsightAttribution = withoutClass
  void invalid
}
void typeContract

describe('evidence-classed trace findings', () => {
  it('an attribution requires its evidence class and complete artifact/span links', () => {
    assert.equal(isTraceInsightAttribution(toolFailure()), true)
    const value = toolFailure()
    for (const invalid of [
      { ...value, evidenceClass: undefined }, { ...value, evidenceClass: 'unknown' },
      { ...value, proof: undefined }, { ...value, authority: undefined },
      { ...value, proof: { ...value.proof, role: 'prose' } },
      { ...value, artifacts: { ...value.artifacts, response: null } },
      { ...value, artifacts: { ...value.artifacts, request: undefined } },
      { ...value, spans: [] }, { ...value, subject: { ...value.subject, company: null } },
      { ...value, proof: { ...value.proof, uri: 'javascript:alert(1)' } },
      { ...value, proof: { ...value.proof, sha256: [value.proof.sha256] } },
    ]) assert.equal(isTraceInsightAttribution(invalid), false)
  })

  it('documentation evidence classes cannot be substituted with narrative judgement', () => {
    const base = evidence()
    const execution = { ...base, outcome: 'documentation-failure', evidenceClass: 'authoritative-execution',
      documentation: 'stale', proof: { ...base.artifacts.binding!, role: 'execution' }, authority: { ...base.artifacts.seed!, role: 'authority' } }
    assert.equal(isTraceInsightAttribution(execution), true)
    assert.equal(isTraceInsightAttribution({ ...execution, evidenceClass: 'regex-label' }), false)
    assert.equal(isTraceInsightAttribution({ ...execution, documentation: 'probably wrong' }), false)
    assert.equal(isTraceInsightAttribution({ ...execution, documentation: ['stale'] }), false)
    const paired = { ...base, outcome: 'documentation-failure', evidenceClass: 'paired-corrected-document',
      proof: { ...base.artifacts.binding!, role: 'publication' }, plan: { ...base.artifacts.seed!, role: 'plan' }, comparisonId: 'correct-docs', correctedEvidence: base.artifacts.binding }
    assert.equal(isTraceInsightAttribution(paired), true)
    assert.equal(isTraceInsightAttribution({ ...paired, plan: undefined }), false)
    assert.equal(isTraceInsightAttribution({ ...paired, comparisonId: '' }), false)
  })

  it('unknown remains explicit and legacy prose cannot produce external readiness', () => {
    const unknown: TraceInsightAttribution = { ...evidence(), outcome: 'unknown', evidenceClass: 'unknown', reasons: ['missing-response'] }
    unknown.artifacts.response = null
    assert.equal(isTraceInsightAttribution(unknown), true)
    assert.equal(isTraceInsightAttribution({ ...unknown, reasons: [] }), false)
    const suite = { name: 'Acme API', tasks: [{ id: 't', name: 'API integration', outcome: 'error', gaps: ['failed'] }] }
    const legacy: TraceInsightFinding = { kind: 'tool-failure', taskIds: ['t'], evidence: 'The API is broken.' }
    assert.notEqual(scoreTraceInsightReadiness(buildTraceInsightContext({ suite, findings: [legacy] })).grade, 'external-ready')
    const supported = { kind: 'tool-failure', taskIds: ['t'], attribution: toolFailure() }
    assert.equal(scoreTraceInsightReadiness(buildTraceInsightContext({ suite, findings: [supported] })).grade, 'external-ready')
    assert.match(buildTraceInsightPrompt({ suite, findings: [supported] }), /validated-request-response/)
    assert.match(buildTraceInsightPrompt({ suite, findings: [supported] }), /report unknown/)
    assert.notEqual(scoreTraceInsightReadiness(buildTraceInsightContext({ suite, findings: [{ ...supported, taskIds: ['other'] }] })).grade, 'external-ready')
  })
})
