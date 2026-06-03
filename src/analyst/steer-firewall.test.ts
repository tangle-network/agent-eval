import { describe, expect, it } from 'vitest'
import { assertTraceObservable, isTraceObservable } from './steer-firewall'
import type { AnalystFinding, EvidenceRef } from './types'

// The gap-4 firewall: a realness/authenticity signal may steer the next attempt
// ONLY when it reports observable behavior (the agent DID x — cite a span/event/
// artifact), never a bare verdict (this output is fake / will fail). The latter
// is the held-out judge leaking into steering, which makes the loop game realness.
function finding(id: string, refs: EvidenceRef[]): AnalystFinding {
  return {
    schema_version: '1.0.0',
    finding_id: id,
    analyst_id: 'realness-detector',
    produced_at: '2026-06-02T00:00:00.000Z',
    severity: 'high',
    area: 'authenticity',
    claim: 'placeholder',
    evidence_refs: refs,
    confidence: 0.9,
  }
}

describe('steer firewall — isTraceObservable', () => {
  it('admits a realness finding grounded in a trace span (observed behavior)', () => {
    const f = finding('used-stub', [
      { kind: 'span', uri: 'span://exec/42', excerpt: 'import stub_crypto' },
    ])
    expect(isTraceObservable(f)).toBe(true)
  })

  it('admits findings grounded in an event or a produced artifact', () => {
    expect(isTraceObservable(finding('evt', [{ kind: 'event', uri: 'event://tool-call/9' }]))).toBe(
      true,
    )
    expect(
      isTraceObservable(finding('art', [{ kind: 'artifact', uri: 'file://out/cipher.ts' }])),
    ).toBe(true)
  })

  it('rejects a bare verdict-shaped finding with no observable evidence', () => {
    // "this output is fake" with nothing cited = the judge's verdict wearing a
    // finding costume — the exact leak the firewall stops.
    expect(isTraceObservable(finding('verdict-only', []))).toBe(false)
  })

  it('rejects findings grounded ONLY in a metric (could be a judge score) or a chained finding', () => {
    expect(
      isTraceObservable(finding('metric', [{ kind: 'metric', uri: 'metric://realness_score' }])),
    ).toBe(false)
    expect(isTraceObservable(finding('chain', [{ kind: 'finding', uri: 'finding://other' }]))).toBe(
      false,
    )
  })

  it('admits a finding with mixed evidence as long as one ref is observable', () => {
    const f = finding('mixed', [
      { kind: 'metric', uri: 'metric://realness_score' },
      { kind: 'span', uri: 'span://exec/7' },
    ])
    expect(isTraceObservable(f)).toBe(true)
  })
})

describe('steer firewall — assertTraceObservable', () => {
  it('passes through when every admitted finding is trace-observable', () => {
    const ok = [
      finding('a', [{ kind: 'span', uri: 'span://1' }]),
      finding('b', [{ kind: 'artifact', uri: 'file://x' }]),
    ]
    expect(assertTraceObservable(ok)).toBe(ok)
  })

  it('throws and names EXACTLY the verdict-leaking findings, not the grounded ones', () => {
    const mixed = [
      finding('grounded', [{ kind: 'span', uri: 'span://1' }]),
      finding('leak-1', []),
      finding('leak-2', [{ kind: 'metric', uri: 'metric://realness' }]),
    ]
    expect(() => assertTraceObservable(mixed, 'realnessSteer')).toThrow(/leak-1, leak-2/)
    expect(() => assertTraceObservable(mixed, 'realnessSteer')).toThrow(/realnessSteer/)
    expect(() => assertTraceObservable(mixed)).not.toThrow(/grounded/)
  })
})
