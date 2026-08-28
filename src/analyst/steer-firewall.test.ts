import { describe, expect, it } from 'vitest'
import { assertNoJudgeVerdict, isJudgeVerdict, isTraceObservable } from './steer-firewall'
import type { AnalystFinding, EvidenceRef } from './types'

// The gap-4 firewall keys on PROVENANCE, not evidence. A realness signal may
// steer the next attempt ONLY as an observation of behavior; a finding lifted
// from a judge VERDICT (an acceptance score) must never steer — that is the
// held-out judge leaking into the loop, which makes the loop game realness.
function finding(id: string, opts: { refs?: EvidenceRef[]; judge?: boolean } = {}): AnalystFinding {
  return {
    schema_version: '1.0.0',
    finding_id: id,
    analyst_id: opts.judge ? 'judge' : 'trace-analyst',
    produced_at: '2026-06-02T00:00:00.000Z',
    severity: 'high',
    area: opts.judge ? 'judge' : 'agent-reasoning',
    claim: 'placeholder',
    evidence_refs: opts.refs ?? [],
    confidence: 0.9,
    ...(opts.judge ? { derived_from_judge: true } : {}),
  }
}

describe('steer firewall — provenance is the discriminator (the cases evidence gets backwards)', () => {
  it('ADMITS an evidence-less trace-analyst observation (would be wrongly rejected by an evidence gate)', () => {
    // Trace analysts may legitimately emit findings with evidence_refs: [].
    const obs = finding('trace-bullet', { refs: [] })
    expect(isJudgeVerdict(obs)).toBe(false)
    expect(() => assertNoJudgeVerdict([obs])).not.toThrow()
  })

  it('REJECTS a judge verdict that cites an artifact (would be wrongly admitted by an evidence gate)', () => {
    // liftJudgeScore attaches {kind:'artifact', uri:'inline:evidence'} when the
    // judge supplies evidence — an evidence gate would pass it; provenance does not.
    const verdict = finding('authenticity-0.2', {
      judge: true,
      refs: [{ kind: 'artifact', uri: 'inline:evidence', excerpt: 'looks templated' }],
    })
    expect(isTraceObservable(verdict)).toBe(true) // evidence gate would ADMIT — wrong
    expect(isJudgeVerdict(verdict)).toBe(true)
    expect(() => assertNoJudgeVerdict([verdict])).toThrow(/judge verdict cannot be admitted/)
  })

  it('REJECTS a bare judge verdict (no evidence)', () => {
    expect(() => assertNoJudgeVerdict([finding('bare-verdict', { judge: true })])).toThrow(
      /held-out judge leaking/,
    )
  })

  it('names EXACTLY the judge-derived findings, not the observations', () => {
    const mixed = [
      finding('obs-1', { refs: [{ kind: 'span', uri: 'span://1' }] }),
      finding('verdict-1', { judge: true }),
      finding('obs-2', { refs: [] }),
      finding('verdict-2', { judge: true, refs: [{ kind: 'artifact', uri: 'inline:evidence' }] }),
    ]
    expect(() => assertNoJudgeVerdict(mixed, 'realnessSteer')).toThrow(/verdict-1, verdict-2/)
    expect(() => assertNoJudgeVerdict(mixed, 'realnessSteer')).toThrow(/realnessSteer/)
    expect(() => assertNoJudgeVerdict(mixed)).not.toThrow(/obs-1|obs-2/)
  })

  it('passes through a pure observation set unchanged', () => {
    const ok = [
      finding('a', { refs: [{ kind: 'span', uri: 'span://1' }] }),
      finding('b', { refs: [] }),
    ]
    expect(assertNoJudgeVerdict(ok)).toBe(ok)
  })
})
