import { describe, expect, it } from 'vitest'
import {
  evidenceRefsFromRawFinding,
  parseRawFinding,
  parseTraceSpanEvidenceUri,
} from '../src/analyst/finding-signature'

describe('analyst finding signature', () => {
  it('omits absent optional evidence fields instead of materializing undefined', () => {
    const finding = parseRawFinding({
      severity: 'medium',
      claim: 'The worker retried the same failed action.',
      confidence: 0.9,
      evidence: [{ uri: 'artifact://run/trace.json' }],
    })
    expect(finding).not.toBeNull()

    const refs = evidenceRefsFromRawFinding(finding!)
    expect(refs).toEqual([{ kind: 'artifact', uri: 'artifact://run/trace.json' }])
    expect(Object.hasOwn(refs[0]!, 'excerpt')).toBe(false)
  })

  it('retains a present excerpt and classifies encoded trace evidence', () => {
    const uri = 'trace://trace%2Fone/span/span%20two'
    const finding = parseRawFinding({
      severity: 'high',
      claim: 'The tool call failed.',
      confidence: 1,
      evidence: [{ uri, excerpt: 'permission denied' }],
    })

    expect(evidenceRefsFromRawFinding(finding!)).toEqual([
      { kind: 'span', uri, excerpt: 'permission denied' },
    ])
    expect(parseTraceSpanEvidenceUri(uri)).toEqual({
      traceId: 'trace/one',
      spanId: 'span two',
    })
  })
})
