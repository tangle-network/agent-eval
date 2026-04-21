import { describe, expect, it } from 'vitest'
import { canaryLeakView, checkCanaries, HoldoutAuditor } from '../src/contamination-guard'
import { InMemoryTraceStore, TraceEmitter } from '../src/trace'

describe('checkCanaries', () => {
  it('returns leaks when canary appears in output — regression: memorized holdouts must fire', () => {
    const leaks = checkCanaries('sure here goes XYZ-CANARY-9f3e', [{ id: 's1', payload: {}, canary: 'XYZ-CANARY-9f3e' }])
    expect(leaks).toHaveLength(1)
    expect(leaks[0].scenarioId).toBe('s1')
  })

  it('ignores scenarios without canary', () => {
    const leaks = checkCanaries('hello', [{ id: 's1', payload: {} }])
    expect(leaks).toHaveLength(0)
  })
})

describe('canaryLeakView', () => {
  it('finds canary in recorded LLM outputs', async () => {
    const store = new InMemoryTraceStore()
    const e = new TraceEmitter(store)
    await e.startRun({ scenarioId: 's1' })
    const h = await e.span({ kind: 'llm', name: 'gen', model: 'm', messages: [], output: 'begin CANARY-ABCDE end' })
    await h.end()
    await e.endRun({ pass: true })
    const leaks = await canaryLeakView(store, [{ id: 's1', payload: {}, canary: 'CANARY-ABCDE' }])
    expect(leaks).toHaveLength(1)
    expect(leaks[0].runId).toBe(e.runId)
  })
})

describe('HoldoutAuditor', () => {
  it('rejects bogus purpose — regression: accidental reads into training pipelines must fail loudly', () => {
    const audit = new HoldoutAuditor([{ id: 'a', payload: {} }])
    expect(() => (audit as unknown as { get: (a: string, b: string) => unknown }).get('a', 'training')).toThrow(/purpose/)
  })

  it('logs accesses with purpose', () => {
    const audit = new HoldoutAuditor([{ id: 'a', payload: {} }])
    audit.get('a', 'evaluation')
    expect(audit.getAccessLog()).toHaveLength(1)
    expect(audit.getAccessLog()[0].purpose).toBe('evaluation')
  })
})
