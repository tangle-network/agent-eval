import { describe, expect, it } from 'vitest'
import { evaluatePowerFloorGate, type ValidityGate } from '../../src/experiment/ast'
import { defineExperiment } from '../../src/experiment/define'
import { killtestSpec } from './preregistrations'

const gate: Extract<ValidityGate, { kind: 'power-floor' }> = {
  kind: 'power-floor',
  target: 0.8,
  minimumEffect: 0.01,
  effectGrid: [0.01, 1],
  sim: { trials: 2000, resamples: 4000, seed: 1 },
}

describe('registered power at the minimum worthwhile effect', () => {
  it('refuses an underpowered worthwhile effect even when a larger effect has perfect power', () => {
    const result = evaluatePowerFloorGate('power', gate, [
      { effect: 0.01, power: 0.1 },
      { effect: 1, power: 1 },
    ])
    expect(result.passed).toBe(false)
    expect(result.evidence).toMatchObject({
      target: 0.8,
      minimumEffect: 0.01,
      powerAtMinimumEffect: 0.1,
      maxPower: 1,
    })
  })

  it('accepts target power at the registered effect independently of other grid points', () => {
    const result = evaluatePowerFloorGate('power', gate, [
      { effect: 0.01, power: 0.8 },
      { effect: 1, power: 0.7 },
    ])
    expect(result.passed).toBe(true)
  })

  it.each([
    { minimumEffect: 0.02 },
    { minimumEffect: NaN },
    { target: 0 },
    { target: NaN },
    { effectGrid: [] },
    { effectGrid: [0.01, 0.01, 1] },
    { effectGrid: [0.01, Infinity] },
    { sim: { trials: 0, resamples: 1, seed: 1 } },
  ])('rejects malformed power registration before sealing: %j', (change) => {
    const spec = {
      ...killtestSpec,
      gates: { ...killtestSpec.gates, 'power-floor': { ...gate, ...change } },
    }
    expect(() => defineExperiment(spec)).toThrow()
  })

  it.each([
    [{ effect: 1, power: 1 }],
    [
      { effect: 0.01, power: 0.9 },
      { effect: 1, power: 1 },
      { effect: 2, power: 1 },
    ],
    [
      { effect: 0.01, power: 0.1 },
      { effect: 0.01, power: 1 },
      { effect: 1, power: 1 },
    ],
    [
      { effect: 0.01, power: NaN },
      { effect: 1, power: 1 },
    ],
    [
      { effect: 0.01, power: 1.1 },
      { effect: 1, power: 1 },
    ],
  ])('refuses missing, duplicate, extra, or uncalibrated curve values: %j', (...curve) => {
    expect(() => evaluatePowerFloorGate('power', gate, curve)).toThrow()
  })
})
