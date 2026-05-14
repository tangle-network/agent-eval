import { describe, expect, it, vi } from 'vitest'

import { type FlowRunner, type FlowSpec, flowLayer } from './flow-layer'
import { MultiLayerVerifier } from './multi-layer-verifier'

function makeRunner(opens: boolean, stepOks: boolean[]): FlowRunner {
  let stepIdx = 0
  return {
    open: vi.fn(async () => ({ ok: opens, evidence: opens ? 'opened' : 'connection refused' })),
    step: vi.fn(async () => {
      const ok = stepOks[stepIdx] ?? false
      stepIdx += 1
      return { ok, evidence: ok ? 'ok' : `step ${stepIdx} failed` }
    }),
    close: vi.fn(async () => undefined),
  }
}

const HAPPY_SPEC: FlowSpec = {
  url: 'http://localhost:3000',
  steps: [
    { action: 'expect-text', target: 'EHR Timeline' },
    { action: 'click', target: 'button[Encounters]' },
    { action: 'expect-element', target: '.encounter-event' },
  ],
}

describe('flowLayer', () => {
  it('skips when no flowSpec', async () => {
    const layer = flowLayer({ runner: () => makeRunner(true, []), dependsOn: [] })
    const v = new MultiLayerVerifier([layer])
    const r = await v.run({ env: {} })
    expect(r.layers[0]!.status).toBe('skipped')
    expect(r.layers[0]!.reason).toBe('no flowSpec supplied')
  })

  it('passes when every step passes', async () => {
    const runner = makeRunner(true, [true, true, true])
    const layer = flowLayer({ flowSpec: HAPPY_SPEC, runner: () => runner, dependsOn: [] })
    const v = new MultiLayerVerifier([layer])
    const r = await v.run({ env: {} })
    expect(r.layers[0]!.status).toBe('pass')
    expect(r.layers[0]!.score).toBe(1)
    expect(r.layers[0]!.diagnostics?.flowStepsPassed).toBe(3)
    expect(r.layers[0]!.diagnostics?.flowOpenOk).toBe(1)
    expect(runner.close).toHaveBeenCalledTimes(1)
  })

  it('fails when any step fails (default stop-on-fail)', async () => {
    const runner = makeRunner(true, [true, false, true])
    const layer = flowLayer({ flowSpec: HAPPY_SPEC, runner: () => runner, dependsOn: [] })
    const v = new MultiLayerVerifier([layer])
    const r = await v.run({ env: {} })
    expect(r.layers[0]!.status).toBe('fail')
    expect(r.layers[0]!.diagnostics?.flowStepsRan).toBe(2)
    expect(r.layers[0]!.findings[0]!.message).toContain('step[1]')
    // Stop-on-fail means runner.step called twice (step 0 + step 1, then stop).
    expect(runner.step).toHaveBeenCalledTimes(2)
  })

  it('continues on fail when continueOnFail=true', async () => {
    const runner = makeRunner(true, [true, false, true])
    const layer = flowLayer({
      flowSpec: { ...HAPPY_SPEC, continueOnFail: true },
      runner: () => runner,
      dependsOn: [],
    })
    const v = new MultiLayerVerifier([layer])
    const r = await v.run({ env: {} })
    expect(r.layers[0]!.status).toBe('fail')
    expect(r.layers[0]!.diagnostics?.flowStepsRan).toBe(3)
    expect(r.layers[0]!.diagnostics?.flowStepsPassed).toBe(2)
    expect(runner.step).toHaveBeenCalledTimes(3)
  })

  it('marks fail when open() fails and runner closes', async () => {
    const runner = makeRunner(false, [])
    const layer = flowLayer({ flowSpec: HAPPY_SPEC, runner: () => runner, dependsOn: [] })
    const v = new MultiLayerVerifier([layer])
    const r = await v.run({ env: {} })
    expect(r.layers[0]!.status).toBe('fail')
    expect(r.layers[0]!.findings[0]!.message).toContain('flow.open')
    expect(runner.close).toHaveBeenCalledTimes(1)
  })

  it('returns error on runner-init throw', async () => {
    const layer = flowLayer({
      flowSpec: HAPPY_SPEC,
      runner: () => {
        throw new Error('browser not installed')
      },
      dependsOn: [],
    })
    const v = new MultiLayerVerifier([layer])
    const r = await v.run({ env: {} })
    expect(r.layers[0]!.status).toBe('error')
    expect(r.layers[0]!.findings[0]!.message).toContain('browser not installed')
  })
})
