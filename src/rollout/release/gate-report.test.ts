import { describe, expect, it } from 'vitest'
import { toRftItems, toSftRows, toVerifiersRolloutOutputs } from '../exporters'
import { fixtureRolloutLine } from '../fixtures'
import { GATE_CHECK_IDS, GATE_POLICIES, type GateCheckId } from '../gate-checks'
import {
  assertGateReport,
  FORMAT_GATE_DISPOSITION,
  type FormatGateCounts,
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

/** A clean measurement for one format, so a case states only what it varies. */
const counts = (over: Partial<FormatGateCounts> = {}): FormatGateCounts => ({
  input: 1,
  emitted: 0,
  excluded: 1,
  maxEmittedReward: null,
  maxEmittedEvidence: null,
  unscreenedPositiveRows: 0,
  maxUnscreenedReward: null,
  maxEmittedStepEvidence: null,
  ...over,
})

describe('gatedRolloutIds', () => {
  it('collects only the flagged lines', () => {
    expect([...gatedRolloutIds(lines())]).toEqual(['gamed-1'])
  })
})

describe('measureFormatGate', () => {
  it('measures the rows an exporter actually produced, per format', () => {
    const kept = lines()
    const gated = gatedRolloutIds(kept)
    // Exporters are driven exactly as the release build drives them: SFT under
    // its always-exclude policy, verifiers/rft under their declared
    // 'zero-and-flag' disposition (bare calls default to 'exclude').
    expect(measureFormatGate(gated, releaseRowRefs.sft(toSftRows(kept)))).toEqual(counts())
    expect(
      measureFormatGate(
        gated,
        releaseRowRefs.verifiers(
          toVerifiersRolloutOutputs(kept, { gatedLines: FORMAT_GATE_DISPOSITION.verifiers }),
        ),
      ),
    ).toEqual(counts({ emitted: 1, excluded: 0, maxEmittedReward: 0 }))
    expect(
      measureFormatGate(
        gated,
        releaseRowRefs.rft(toRftItems(kept, { gatedLines: FORMAT_GATE_DISPOSITION.rft })),
      ),
    ).toEqual(counts({ emitted: 1, excluded: 0, maxEmittedReward: 0 }))
    expect(measureFormatGate(gated, releaseRowRefs.raw(kept))).toEqual(
      counts({ emitted: 1, excluded: 0, maxEmittedReward: 0 }),
    )
  })

  it('reports no max reward when a format emitted no gated row', () => {
    expect(measureFormatGate(new Set(['absent']), releaseRowRefs.raw(lines()))).toEqual(counts())
  })

  it('counts a never-screened positive reward even though it is not in the gated set', () => {
    // The unscreened population is disjoint from the gated one by construction:
    // an unscreened reward is one the gate never returned a verdict on, so it is
    // never in `gated` and a measurement scoped to that set reports 0 forever.
    //
    // Built as refs rather than lines because `assertMinted` refuses to mint this
    // row at all — which is the earlier door working, and exactly why the last
    // door still has to measure for it instead of assuming.
    const refs = [
      { rollout_id: 'never-screened', reward: 1, realness_screened: false },
      { rollout_id: 'screened-clean', reward: 1, realness_screened: true },
      { rollout_id: 'not-stated', reward: 1, realness_screened: null },
    ]
    expect(measureFormatGate(new Set(), refs)).toEqual(
      counts({
        input: 0,
        excluded: 0,
        unscreenedPositiveRows: 1,
        maxUnscreenedReward: 1,
      }),
    )
  })
})

describe('assertGateReport', () => {
  const clean: GateReport = {
    gatedLines: 1,
    byFormat: {
      sft: counts(),
      raw: counts({ emitted: 1, excluded: 0, maxEmittedReward: 0 }),
    },
  }

  it('accepts a report where every gated row shipped at reward 0', () => {
    expect(() => assertGateReport(clean)).not.toThrow()
  })

  it('throws when any config emitted a gated row above reward 0', () => {
    expect(() =>
      assertGateReport({
        gatedLines: 1,
        byFormat: { rft: counts({ emitted: 1, excluded: 0, maxEmittedReward: 0.95 }) },
      }),
    ).toThrow('may not ship a positive reward in any config')
  })

  it('throws when an exclude-disposition config emitted a gated row at all', () => {
    expect(() =>
      assertGateReport({
        gatedLines: 1,
        byFormat: { sft: counts({ emitted: 1, excluded: 0, maxEmittedReward: 0 }) },
      }),
    ).toThrow('declares gated lines EXCLUDED but wrote 1')
  })

  /**
   * The release certifier is the fourth entry point on the canonical check list,
   * and it consumes that list through two TOTAL maps: its policy in
   * `GATE_POLICIES` and `REPORT_MEASURES` in `gate-report.ts`. `REPORT_TRIPWIRES`
   * below is the third — adding a check to `GATE_CHECK_IDS` makes this object a
   * type error until the new check is given a measurement that fires, so a check
   * cannot be added to the package and quietly skipped at the last door before a
   * public dataset.
   */
  const REPORT_TRIPWIRES: Record<GateCheckId, { counts: FormatGateCounts; message: RegExp }> = {
    'reward-relationship': {
      counts: counts({ emitted: 1, excluded: 0, maxEmittedReward: 0.95 }),
      message: /may not ship a positive reward in any config/,
    },
    'gated-evidence': {
      counts: counts({
        emitted: 1,
        excluded: 0,
        maxEmittedReward: 0,
        maxEmittedEvidence: { path: 'layer.tests', value: 1 },
      }),
      message: /positive reward-derived number \(layer\.tests = 1\)/,
    },
    'undeclared-step-payload': {
      counts: counts({
        emitted: 1,
        excluded: 0,
        maxEmittedReward: 0,
        maxEmittedStepEvidence: { path: 'steps[0].reward', value: 0.86 },
      }),
      message: /positive per-step number under a field .* does not declare/,
    },
    'unscreened-reward': {
      counts: counts({ unscreenedPositiveRows: 1, maxUnscreenedReward: 1 }),
      message: /NO authenticity screen ran on it/,
    },
  }

  it.each(GATE_CHECK_IDS)('refuses a release tripping the %s check', (id) => {
    const tripwire = REPORT_TRIPWIRES[id]
    const report: GateReport = { gatedLines: 1, byFormat: { rft: tripwire.counts } }
    if (GATE_POLICIES.assertGateReport[id].kind === 'enforce') {
      expect(() => assertGateReport(report)).toThrow(tripwire.message)
    } else {
      expect(() => assertGateReport(report)).not.toThrow()
    }
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
