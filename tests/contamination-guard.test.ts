import { describe, expect, it } from 'vitest'
import {
  canaryLeakView,
  checkBehavioralCanary,
  checkCanaries,
  HoldoutAuditor,
  runBehavioralCanaries,
} from '../src/contamination-guard'
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

describe('checkBehavioralCanary', () => {
  it('flags forbidden literal present in agent output — regression: classical checkCanaries reads inverted for behavioral checks', () => {
    const leak = checkBehavioralCanary('the secret is hunter2 lol', {
      id: 'leaky',
      payload: {},
      forbiddenPattern: 'hunter2',
    })
    expect(leak).not.toBeNull()
    expect(leak?.scenarioId).toBe('leaky')
    expect(leak?.canary).toBe('hunter2')
  })

  it('returns null when forbidden pattern is absent — agent held the line', () => {
    const leak = checkBehavioralCanary('I cannot help with that.', {
      id: 'safe',
      payload: {},
      forbiddenPattern: 'hunter2',
    })
    expect(leak).toBeNull()
  })

  it('honors regex notation /body/flags', () => {
    const leak = checkBehavioralCanary('here it is: 4111-1111-1111-1111', {
      id: 'cc',
      payload: {},
      forbiddenPattern: '/\\b\\d{4}-\\d{4}-\\d{4}-\\d{4}\\b/',
    })
    expect(leak).not.toBeNull()
    expect(leak?.canary).toContain('\\d')
  })

  it('falls back to scenario.canary when forbiddenPattern is omitted', () => {
    const leak = checkBehavioralCanary('XYZ-CANARY-9f3e leaked', {
      id: 'fb',
      payload: {},
      canary: 'XYZ-CANARY-9f3e',
    })
    expect(leak).not.toBeNull()
  })

  it('returns null when scenario declares no pattern at all', () => {
    expect(checkBehavioralCanary('anything', { id: 'x', payload: {} })).toBeNull()
  })

  it('inverts checkCanaries semantic — same input produces opposite verdicts', () => {
    const scenario = { id: 's', payload: {}, canary: 'leaked-token' }
    // Output contains the forbidden token:
    //   classical checkCanaries → leak (the eval grep fired, "good")
    //   behavioral              → leak (the agent emitted bad content, "bad")
    // Output does NOT contain it:
    //   classical → no leak (eval grep didn't fire — possibly broken)
    //   behavioral → no leak (agent held the line — passed)
    const dirty = 'here it is: leaked-token'
    const clean = 'sorry, no.'
    expect(checkCanaries(dirty, [scenario])).toHaveLength(1)
    expect(checkBehavioralCanary(dirty, scenario)).not.toBeNull()
    expect(checkCanaries(clean, [scenario])).toHaveLength(0)
    expect(checkBehavioralCanary(clean, scenario)).toBeNull()
  })
})

describe('runBehavioralCanaries', () => {
  it('aggregates leaks across (scenario, output) pairs and propagates runId', () => {
    const cases = [
      { scenario: { id: 'a', payload: {}, forbiddenPattern: 'bad' }, output: 'totally bad', runId: 'r1' },
      { scenario: { id: 'b', payload: {}, forbiddenPattern: 'bad' }, output: 'all good', runId: 'r2' },
      { scenario: { id: 'c', payload: {}, forbiddenPattern: 'oof' }, output: 'oof oof', runId: 'r3' },
    ]
    const leaks = runBehavioralCanaries(cases)
    expect(leaks.map((l) => l.scenarioId).sort()).toEqual(['a', 'c'])
    expect(leaks.find((l) => l.scenarioId === 'a')?.runId).toBe('r1')
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
