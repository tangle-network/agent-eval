import { describe, expect, it } from 'vitest'
import { toRftItems, toSftRows, toVerifiersRolloutOutputs } from '../exporters'
import { fixtureRolloutLine } from '../fixtures'
import {
  assertGateReport,
  FORMAT_GATE_DISPOSITION,
  type GateReport,
  gatedRolloutIds,
  measureFormatGate,
  releaseRowRefs,
} from './gate-report'

function lines() {
  const base = fixtureRolloutLine()
  return [
    base,
    fixtureRolloutLine({
      rollout_id: 'gamed-1',
      outcome: { ...base.outcome, reward: 0, realness_gated: true },
    }),
  ]
}

describe('gatedRolloutIds', () => {
  it('collects only the flagged lines', () => {
    expect([...gatedRolloutIds(lines())]).toEqual(['gamed-1'])
  })
})

describe('measureFormatGate', () => {
  it('measures the rows an exporter actually produced, per format', () => {
    const kept = lines()
    const gated = gatedRolloutIds(kept)
    expect(measureFormatGate(gated, releaseRowRefs.sft(toSftRows(kept)))).toEqual({
      input: 1,
      emitted: 0,
      excluded: 1,
      maxEmittedReward: null,
    })
    expect(
      measureFormatGate(gated, releaseRowRefs.verifiers(toVerifiersRolloutOutputs(kept))),
    ).toEqual({ input: 1, emitted: 1, excluded: 0, maxEmittedReward: 0 })
    expect(measureFormatGate(gated, releaseRowRefs.rft(toRftItems(kept)))).toEqual({
      input: 1,
      emitted: 1,
      excluded: 0,
      maxEmittedReward: 0,
    })
    expect(measureFormatGate(gated, releaseRowRefs.raw(kept))).toEqual({
      input: 1,
      emitted: 1,
      excluded: 0,
      maxEmittedReward: 0,
    })
  })

  it('reports no max reward when a format emitted no gated row', () => {
    expect(measureFormatGate(new Set(['absent']), releaseRowRefs.raw(lines()))).toEqual({
      input: 1,
      emitted: 0,
      excluded: 1,
      maxEmittedReward: null,
    })
  })
})

describe('assertGateReport', () => {
  const clean: GateReport = {
    gatedLines: 1,
    byFormat: {
      sft: { input: 1, emitted: 0, excluded: 1, maxEmittedReward: null },
      raw: { input: 1, emitted: 1, excluded: 0, maxEmittedReward: 0 },
    },
  }

  it('accepts a report where every gated row shipped at reward 0', () => {
    expect(() => assertGateReport(clean)).not.toThrow()
  })

  it('throws when any config emitted a gated row above reward 0', () => {
    expect(() =>
      assertGateReport({
        gatedLines: 1,
        byFormat: { rft: { input: 1, emitted: 1, excluded: 0, maxEmittedReward: 0.95 } },
      }),
    ).toThrow('may not ship a positive reward in any config')
  })

  it('throws when an exclude-disposition config emitted a gated row at all', () => {
    expect(() =>
      assertGateReport({
        gatedLines: 1,
        byFormat: { sft: { input: 1, emitted: 1, excluded: 0, maxEmittedReward: 0 } },
      }),
    ).toThrow('declares gated lines EXCLUDED but wrote 1')
  })
})

describe('release policy', () => {
  it('excludes gated lines from SFT only — every other config discloses them', () => {
    expect(FORMAT_GATE_DISPOSITION).toEqual({
      sft: 'exclude',
      verifiers: 'zero-and-flag',
      rft: 'zero-and-flag',
      raw: 'zero-and-flag',
    })
  })
})
