import { describe, expect, it } from 'vitest'
import {
  assertRecordIntegrity,
  checkRecordIntegrity,
  expandMatrix,
  gatePerf,
  type JourneySpec,
  type PerfBaseline,
  scenarioKey,
  summarizeRecords,
} from '../src/perf'

function journey(overrides: Partial<JourneySpec>): JourneySpec {
  return {
    id: 'provision.cold',
    description: 'cold-start provision',
    requiresLLM: false,
    requiredFields: ['total_ms'],
    ...overrides,
  }
}

describe('expandMatrix', () => {
  const journeys = [
    journey({ id: 'provision.cold' }),
    journey({ id: 'chat.ttft', requiresLLM: true }),
  ]
  const axes = {
    region: ['us', 'eu'],
    driver: ['docker', 'firecracker'],
  }

  it('expands the full cartesian product (catches dropped journeys or axis values)', () => {
    const scenarios = expandMatrix(journeys, axes)
    expect(scenarios).toHaveLength(2 * 2 * 2)
    const keys = scenarios.map((s) => s.key)
    expect(new Set(keys).size).toBe(8)
    expect(keys).toContain('chat.ttft|driver=firecracker|region=eu')
  })

  it('sorts dimensions in the key regardless of axes object key order (catches insertion-order keys that break baseline lookup)', () => {
    const [a] = expandMatrix([journeys[0]], { region: ['us'], driver: ['docker'] })
    const [b] = expandMatrix([journeys[0]], { driver: ['docker'], region: ['us'] })
    expect(a.key).toBe('provision.cold|driver=docker|region=us')
    expect(b.key).toBe(a.key)
    expect(scenarioKey('provision.cold', { region: 'us', driver: 'docker' })).toBe(a.key)
  })

  it('filter drops invalid combos (catches a filter that is ignored or inverted)', () => {
    const scenarios = expandMatrix(
      journeys,
      axes,
      (journeyId, combo) => !(journeyId === 'chat.ttft' && combo.driver === 'firecracker'),
    )
    expect(scenarios).toHaveLength(6)
    expect(
      scenarios.some((s) => s.journey.id === 'chat.ttft' && s.axes.driver === 'firecracker'),
    ).toBe(false)
  })

  it('produces one keyed scenario per journey when axes are empty (catches zero-combo expansion)', () => {
    const scenarios = expandMatrix(journeys, {})
    expect(scenarios.map((s) => s.key)).toEqual(['provision.cold', 'chat.ttft'])
  })
})

describe('checkRecordIntegrity', () => {
  const spec = journey({
    id: 'chat.stream',
    requiredFields: ['total_ms', 'ttft_ms'],
    minimums: [{ field: 'event_count', min: 1 }],
    phaseFields: ['connect_ms'],
  })
  const resolve = () => spec

  it('flags a passing record with a null required field (catches integrity checks that trust pass=true)', () => {
    const result = checkRecordIntegrity(
      [{ pass: true, total_ms: 1200, ttft_ms: null, event_count: 4, connect_ms: 10 }],
      resolve,
    )
    expect(result.succeeded).toBe(false)
    expect(result.violations).toHaveLength(1)
    expect(result.violations[0]).toMatchObject({
      recordIndex: 0,
      journeyId: 'chat.stream',
      field: 'ttft_ms',
      reason: 'null-required-field',
    })
  })

  it('does NOT flag a failing record with nulls (catches over-eager checks that punish honest failures)', () => {
    const result = checkRecordIntegrity(
      [{ pass: false, total_ms: null, ttft_ms: null, event_count: null, connect_ms: null }],
      resolve,
    )
    expect(result.succeeded).toBe(true)
    expect(result.violations).toEqual([])
  })

  it('flags a passing streaming record with event_count 0 under min 1 (catches minimums treated as null checks)', () => {
    const result = checkRecordIntegrity(
      [{ pass: true, total_ms: 1200, ttft_ms: 80, event_count: 0, connect_ms: 10 }],
      resolve,
    )
    expect(result.succeeded).toBe(false)
    expect(result.violations[0]).toMatchObject({ field: 'event_count', reason: 'below-minimum' })
  })

  it('flags a null phase field on a passing record (catches phaseFields being ignored)', () => {
    const result = checkRecordIntegrity(
      [{ pass: true, total_ms: 1200, ttft_ms: 80, event_count: 4, connect_ms: null }],
      resolve,
    )
    expect(result.succeeded).toBe(false)
    expect(result.violations[0]).toMatchObject({
      field: 'connect_ms',
      reason: 'null-required-field',
    })
    expect(result.violations[0].detail).toContain('phase field')
  })

  it('skips records whose journey resolves to null (catches resolveJourney null being treated as a violation)', () => {
    const result = checkRecordIntegrity([{ pass: true, total_ms: null }], () => null)
    expect(result.succeeded).toBe(true)
  })

  it('reports the violating record index across a batch (catches index drift when failing records are skipped)', () => {
    const result = checkRecordIntegrity(
      [
        { pass: false, total_ms: null, ttft_ms: null, event_count: null, connect_ms: null },
        { pass: true, total_ms: 900, ttft_ms: null, event_count: 2, connect_ms: 5 },
      ],
      resolve,
    )
    expect(result.violations[0].recordIndex).toBe(1)
  })

  it('assertRecordIntegrity throws listing every violation (catches an assert that swallows the detail)', () => {
    expect(() =>
      assertRecordIntegrity(
        [{ pass: true, total_ms: null, ttft_ms: 80, event_count: 0, connect_ms: 1 }],
        resolve,
      ),
    ).toThrowError(/2 violation\(s\)[\s\S]*total_ms[\s\S]*event_count/)
  })

  it('assertRecordIntegrity returns silently on clean records (catches an assert that always throws)', () => {
    expect(() =>
      assertRecordIntegrity(
        [{ pass: true, total_ms: 900, ttft_ms: 80, event_count: 3, connect_ms: 5 }],
        resolve,
      ),
    ).not.toThrow()
  })
})

describe('summarizeRecords', () => {
  const keyOf = (r: Record<string, unknown>) => (typeof r.key === 'string' ? r.key : null)

  it('computes nearest-rank p50/p90 on a known array (catches interpolated or off-by-one percentiles)', () => {
    const records = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100].map((total_ms) => ({
      key: 's',
      total_ms,
    }))
    const summary = summarizeRecords(records, keyOf, ['total_ms'])
    // Nearest-rank: rank = ceil(p/100 * 10) → p50 = 5th value, p90 = 9th value.
    expect(summary.scenarios.s.total_ms).toEqual({ p50: 50, p90: 90, n: 10 })
  })

  it('rounds the rank up on fractional ranks (catches floor-based nearest-rank on odd n)', () => {
    // n = 7: p50 rank = ceil(3.5) = 4th value, p90 rank = ceil(6.3) = 7th value.
    const records = [70, 10, 30, 50, 20, 60, 40].map((total_ms) => ({ key: 's', total_ms }))
    const summary = summarizeRecords(records, keyOf, ['total_ms'])
    expect(summary.scenarios.s.total_ms).toEqual({ p50: 40, p90: 70, n: 7 })
  })

  it('excludes null and non-numeric metric values from n (catches nulls coerced to fake zeros)', () => {
    const records = [
      { key: 's', total_ms: 100 },
      { key: 's', total_ms: null },
      { key: 's', total_ms: 'broken' },
      { key: 's', total_ms: 300 },
    ]
    const summary = summarizeRecords(records, keyOf, ['total_ms'])
    expect(summary.scenarios.s.total_ms.n).toBe(2)
    expect(summary.scenarios.s.total_ms.p50).toBe(100)
  })

  it('omits a field with zero real samples instead of emitting a fake stat (catches all-null fields summarized as 0)', () => {
    const summary = summarizeRecords([{ key: 's', total_ms: null }], keyOf, ['total_ms'])
    expect(summary.scenarios.s).toEqual({})
  })

  it('skips records keyOf maps to null (catches unkeyed records leaking into a scenario)', () => {
    const summary = summarizeRecords([{ total_ms: 100 }, { key: 's', total_ms: 200 }], keyOf, [
      'total_ms',
    ])
    expect(summary.scenarios.s.total_ms.n).toBe(1)
  })
})

describe('gatePerf', () => {
  function baselineOf(p50: number, p90: number, n = 10): PerfBaseline {
    return { version: 1, scenarios: { s: { total_ms: { p50, p90, n } } } }
  }

  it('trips a regression beyond tolerance (catches a gate that always passes)', () => {
    const result = gatePerf(baselineOf(120, 200), baselineOf(100, 180), { tolerancePct: 10 })
    expect(result.succeeded).toBe(false)
    expect(result.regressions).toHaveLength(1)
    expect(result.regressions[0].overBy.p50Pct).toBeCloseTo(20)
  })

  it('does not trip within tolerance (catches a zero-tolerance gate that blocks noise)', () => {
    const result = gatePerf(baselineOf(105, 185), baselineOf(100, 180), { tolerancePct: 10 })
    expect(result.succeeded).toBe(true)
    expect(result.regressions).toEqual([])
  })

  it('trips on p90 alone even when p50 holds (catches gates that only watch the median)', () => {
    const result = gatePerf(baselineOf(100, 250), baselineOf(100, 180), { tolerancePct: 10 })
    expect(result.succeeded).toBe(false)
    expect(result.regressions[0].overBy.p90Pct).toBeCloseTo((250 - 180) / 1.8)
  })

  it('records strict improvements with negative overBy (catches improvements misfiled as regressions)', () => {
    const result = gatePerf(baselineOf(80, 150), baselineOf(100, 180))
    expect(result.succeeded).toBe(true)
    expect(result.improvements).toHaveLength(1)
    expect(result.improvements[0].overBy.p50Pct).toBeLessThan(0)
    expect(result.improvements[0].overBy.p90Pct).toBeLessThan(0)
  })

  it('detects scenarios missing from current and new in current (catches silently dropped coverage)', () => {
    const current: PerfBaseline = {
      version: 1,
      scenarios: { added: { total_ms: { p50: 1, p90: 2, n: 5 } } },
    }
    const baseline: PerfBaseline = {
      version: 1,
      scenarios: { s: { total_ms: { p50: 100, p90: 180, n: 10 } } },
    }
    const result = gatePerf(current, baseline)
    expect(result.missingScenarios).toEqual(['s'])
    expect(result.newScenarios).toEqual(['added'])
  })

  it('never gates a scenario with n < minSamples — reports it missing instead (catches one noisy sample tripping the gate)', () => {
    const result = gatePerf(baselineOf(500, 900, 2), baselineOf(100, 180, 10), {
      tolerancePct: 10,
      minSamples: 3,
    })
    expect(result.regressions).toEqual([])
    expect(result.missingScenarios).toEqual(['s'])
    expect(result.succeeded).toBe(true)
  })

  it('gates a scenario with exactly n = minSamples (catches an off-by-one that drops the boundary)', () => {
    const result = gatePerf(baselineOf(500, 900, 3), baselineOf(100, 180, 10), {
      tolerancePct: 10,
      minSamples: 3,
    })
    expect(result.regressions).toHaveLength(1)
    expect(result.missingScenarios).toEqual([])
  })

  it('a zero baseline with a grown current trips instead of dividing to NaN (catches 0-baseline division holes)', () => {
    const result = gatePerf(baselineOf(5, 5), baselineOf(0, 0))
    expect(result.succeeded).toBe(false)
    expect(result.regressions[0].overBy.p50Pct).toBe(Number.POSITIVE_INFINITY)
  })
})
