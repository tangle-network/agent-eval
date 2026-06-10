import { appendFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ValidationError } from '../src/errors'
import { calibrateJudge, continuousAgreement, type GoldenItem } from '../src/judge-calibration'
import {
  evalHealthStamp,
  fileSentinelStore,
  inMemorySentinelStore,
  judgeSentinelReport,
  type SentinelMetrics,
  type SentinelSnapshot,
  snapshotFromAgreement,
  snapshotFromCalibration,
  snapshotFromSentinelSet,
} from '../src/meta-eval'
import { analyzeSeries } from '../src/series-convergence'
import { corpusInterRaterAgreement } from '../src/statistics'

const day = (n: number): string => `2026-01-${String(n).padStart(2, '0')}T00:00:00Z`

const snap = (
  at: string,
  metrics: SentinelMetrics,
  judgeModel = 'judge-model-v1',
  judgeId = 'quality-judge',
): SentinelSnapshot => ({ at, judgeId, judgeModel, metrics })

describe('judgeSentinelReport — alarms', () => {
  it('alarms on a decaying sentinelPassRate via the drifting-down state', () => {
    const history = [1.0, 0.95, 0.9, 0.85, 0.8].map((v, i) =>
      snap(day(i + 1), { sentinelPassRate: v }),
    )
    const report = judgeSentinelReport(history, { asOf: day(6) })

    const row = report.perJudge.find((r) => r.metric === 'sentinelPassRate')!
    expect(row.state).toBe('drifting-down')
    expect(row.alarmed).toBe(true)
    expect(row.drift).toBeCloseTo(-0.2, 10)
    expect(report.healthy).toBe(false)
    expect(report.alarms.some((a) => a.includes('drifting-down'))).toBe(true)
  })

  it('alarms on a calibrationKappa cliff that the trend machine alone misses', () => {
    const history = [0.8, 0.8, 0.62].map((v, i) => snap(day(i + 1), { calibrationKappa: v }))
    const report = judgeSentinelReport(history, { asOf: day(4) })

    const row = report.perJudge.find((r) => r.metric === 'calibrationKappa')!
    expect(row.state).toBe('noisy')
    expect(row.alarmed).toBe(true)
    expect(row.reason).toContain('dropped')
    expect(report.healthy).toBe(false)
  })

  it('alarms on irr below the floor even with insufficient history', () => {
    const report = judgeSentinelReport([snap(day(1), { irr: 0.3 })], { asOf: day(2) })

    const row = report.perJudge[0]!
    expect(row.state).toBe('insufficient-data')
    expect(row.alarmed).toBe(true)
    expect(row.reason).toContain('below floor')
    expect(report.insufficientHistory).toEqual(['quality-judge:irr'])
    expect(report.healthy).toBe(false)
  })

  it('names thin series in insufficientHistory without alarming when values are fine', () => {
    const report = judgeSentinelReport([snap(day(1), { irr: 0.9 })], { asOf: day(2) })

    expect(report.insufficientHistory).toEqual(['quality-judge:irr'])
    expect(report.alarms).toEqual([])
    expect(report.healthy).toBe(true)
  })

  it('healthy stays healthy: stable metrics, same model, fresh snapshots', () => {
    const history = Array.from({ length: 6 }, (_, i) =>
      snap(day(i + 1), { irr: 0.85, calibrationKappa: 0.8, sentinelPassRate: 0.95 }),
    )
    const report = judgeSentinelReport(history, { asOf: day(7) })

    expect(report.perJudge).toHaveLength(3)
    for (const row of report.perJudge) {
      expect(row.state).toBe('stabilized')
      expect(row.alarmed).toBe(false)
    }
    expect(report.alarms).toEqual([])
    expect(report.insufficientHistory).toEqual([])
    expect(report.healthy).toBe(true)
  })

  it('alarms on staleness vs asOf, and not within the window', () => {
    const history = Array.from({ length: 6 }, (_, i) => snap(day(i + 1), { calibrationKappa: 0.8 }))
    const stale = judgeSentinelReport(history, { asOf: '2026-03-15T00:00:00Z' })
    expect(stale.healthy).toBe(false)
    expect(stale.alarms.some((a) => a.includes('stale'))).toBe(true)

    const fresh = judgeSentinelReport(history, { asOf: day(20) })
    expect(fresh.healthy).toBe(true)
  })

  it('rejects an unparseable asOf', () => {
    expect(() => judgeSentinelReport([], { asOf: 'not-a-date' })).toThrow(ValidationError)
  })
})

describe('judgeSentinelReport — silent-upgrade trap', () => {
  const calibratedOnV1 = [0.8, 0.8, 0.8].map((v, i) =>
    snap(day(i + 1), { calibrationKappa: v }, 'judge-model-v1'),
  )

  it('alarms when the judge model changes with no post-change calibration snapshot', () => {
    const history = [...calibratedOnV1, snap(day(4), { irr: 0.9 }, 'judge-model-v2')]
    const report = judgeSentinelReport(history, { asOf: day(5) })

    expect(report.healthy).toBe(false)
    const alarm = report.alarms.find((a) => a.includes('silent-upgrade'))!
    expect(alarm).toContain('"judge-model-v1" → "judge-model-v2"')
  })

  it('alarms on an empty-metrics model-change marker until recalibration lands', () => {
    const marker = snap(day(4), {}, 'judge-model-v2')
    const before = judgeSentinelReport([...calibratedOnV1, marker], { asOf: day(5) })
    expect(before.alarms.some((a) => a.includes('silent-upgrade'))).toBe(true)

    const recalibrated = snap(day(5), { calibrationKappa: 0.78 }, 'judge-model-v2')
    const after = judgeSentinelReport([...calibratedOnV1, marker, recalibrated], { asOf: day(6) })
    expect(after.alarms).toEqual([])
    expect(after.healthy).toBe(true)
  })

  it('does not alarm when the post-change snapshot itself carries calibration', () => {
    const history = [...calibratedOnV1, snap(day(4), { calibrationKappa: 0.79 }, 'judge-model-v2')]
    const report = judgeSentinelReport(history, { asOf: day(5) })

    expect(report.alarms).toEqual([])
    expect(report.healthy).toBe(true)
  })

  it('irr after the change does NOT clear the trap — agreement is not ground truth', () => {
    const history = [
      ...calibratedOnV1,
      snap(day(4), { irr: 0.95 }, 'judge-model-v2'),
      snap(day(5), { irr: 0.95 }, 'judge-model-v2'),
    ]
    const report = judgeSentinelReport(history, { asOf: day(6) })
    expect(report.alarms.some((a) => a.includes('silent-upgrade'))).toBe(true)
  })
})

describe('judgeSentinelReport — series-convergence integration', () => {
  it('reports the real analyzeSeries state verbatim', () => {
    const values = [0.5, 0.55, 0.6, 0.65, 0.7]
    const history = values.map((v, i) => snap(day(i + 1), { irr: v }))
    const report = judgeSentinelReport(history, { asOf: day(6) })

    const row = report.perJudge.find((r) => r.metric === 'irr')!
    expect(row.state).toBe(analyzeSeries(values).state)
    expect(row.state).toBe('drifting-up')
    expect(row.alarmed).toBe(false)
  })

  it('forwards convergence options to the machine', () => {
    const values = [0.9, 0.8, 0.7]
    const history = values.map((v, i) => snap(day(i + 1), { calibrationKappa: v }))
    const opts = { window: 3, driftRun: 2 }

    const byDefault = judgeSentinelReport(history, { asOf: day(4) })
    expect(byDefault.perJudge[0]!.state).toBe('noisy')

    const report = judgeSentinelReport(history, { asOf: day(4), convergence: opts })
    const row = report.perJudge[0]!
    expect(row.state).toBe(analyzeSeries(values, opts).state)
    expect(row.state).toBe('drifting-down')
    expect(row.alarmed).toBe(true)
  })
})

describe('snapshot adapters — real instrument outputs', () => {
  const meta = { at: day(1), judgeId: 'quality-judge', judgeModel: 'judge-model-v1' }
  const golden: GoldenItem[] = [
    { itemId: 'a', humanScore: 0 },
    { itemId: 'b', humanScore: 1 },
    { itemId: 'c', humanScore: 2 },
    { itemId: 'd', humanScore: 3 },
  ]

  it('snapshotFromCalibration carries κ from calibrateJudge', () => {
    const report = calibrateJudge(
      golden,
      golden.map((g) => ({ itemId: g.itemId, score: g.humanScore })),
    )
    const s = snapshotFromCalibration(report, meta)
    expect(s.metrics.calibrationKappa).toBe(1)
    expect(s.judgeModel).toBe('judge-model-v1')
  })

  it('snapshotFromCalibration fails loud on a degenerate (n<2) calibration', () => {
    const report = calibrateJudge(golden.slice(0, 1), [{ itemId: 'a', score: 0 }])
    expect(() => snapshotFromCalibration(report, meta)).toThrow(ValidationError)
  })

  it('snapshotFromAgreement carries ICC from continuousAgreement', () => {
    const agreement = continuousAgreement(
      [
        [0.8, 0.82],
        [0.5, 0.48],
        [0.3, 0.33],
        [0.9, 0.88],
      ],
      { bootstrap: 0 },
    )
    const s = snapshotFromAgreement(agreement, meta)
    expect(s.metrics.irr).toBe(agreement.icc)
    expect(Number.isFinite(s.metrics.irr)).toBe(true)
  })

  it('snapshotFromAgreement carries overall ICC from corpusInterRaterAgreement', () => {
    const j1 = [0.9, 0.5, 0.1]
    const j2 = [0.85, 0.55, 0.15]
    const records = ['i1', 'i2', 'i3'].flatMap((itemId, i) => [
      { itemId, judgeName: 'j1', dimension: 'quality', score: j1[i]! },
      { itemId, judgeName: 'j2', dimension: 'quality', score: j2[i]! },
    ])
    const report = corpusInterRaterAgreement(records, { bootstrap: 0 })
    const s = snapshotFromAgreement(report, meta)
    expect(s.metrics.irr).toBe(report.overallIcc)
    expect(Number.isFinite(s.metrics.irr)).toBe(true)
  })

  it('snapshotFromSentinelSet computes a tolerance-gated pass rate over joined items', () => {
    const human: GoldenItem[] = [
      { itemId: 'a', humanScore: 0.8 },
      { itemId: 'b', humanScore: 0.6 },
      { itemId: 'c', humanScore: 0.4 },
      { itemId: 'd', humanScore: 0.2 },
    ]
    const scores = [
      { itemId: 'a', score: 0.85 },
      { itemId: 'b', score: 0.75 },
      { itemId: 'c', score: 0.42 },
      { itemId: 'd', score: 0.21 },
      { itemId: 'not-in-golden', score: 0.0 },
    ]
    const s = snapshotFromSentinelSet(scores, human, meta)
    expect(s.metrics.sentinelPassRate).toBeCloseTo(0.75, 10)
  })

  it('snapshotFromSentinelSet fails loud when nothing joins the golden set', () => {
    expect(() => snapshotFromSentinelSet([{ itemId: 'zz', score: 0.5 }], golden, meta)).toThrow(
      ValidationError,
    )
  })
})

describe('sentinel stores', () => {
  let dir: string | undefined
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
    dir = undefined
  })

  it('inMemorySentinelStore appends and filters by judgeId', async () => {
    const store = inMemorySentinelStore()
    await store.append(snap(day(1), { irr: 0.8 }, 'm', 'a'))
    await store.append(snap(day(2), { irr: 0.9 }, 'm', 'b'))
    expect(await store.history()).toHaveLength(2)
    expect(await store.history('a')).toHaveLength(1)
  })

  it('fileSentinelStore roundtrips JSONL across instances', async () => {
    dir = mkdtempSync(join(tmpdir(), 'judge-sentinel-'))
    const path = join(dir, 'nested', 'sentinel.jsonl')
    const writer = fileSentinelStore(path)
    await writer.append(snap(day(1), { calibrationKappa: 0.8 }, 'm', 'a'))
    await writer.append(snap(day(2), { calibrationKappa: 0.78 }, 'm', 'a'))
    await writer.append(snap(day(1), { irr: 0.9 }, 'm', 'b'))

    const reader = fileSentinelStore(path)
    const all = await reader.history()
    expect(all).toHaveLength(3)
    expect(all[0]!.metrics.calibrationKappa).toBe(0.8)
    expect(await reader.history('a')).toHaveLength(2)
  })

  it('fileSentinelStore returns empty history for a missing file', async () => {
    dir = mkdtempSync(join(tmpdir(), 'judge-sentinel-'))
    const store = fileSentinelStore(join(dir, 'never-written.jsonl'))
    expect(await store.history()).toEqual([])
  })

  it('fileSentinelStore fails loud on a corrupt JSONL line, naming the line', async () => {
    dir = mkdtempSync(join(tmpdir(), 'judge-sentinel-'))
    const path = join(dir, 'sentinel.jsonl')
    const store = fileSentinelStore(path)
    await store.append(snap(day(1), { irr: 0.8 }))
    appendFileSync(path, '{ definitely not json\n', 'utf8')

    await expect(store.history()).rejects.toThrow(ValidationError)
    await expect(store.history()).rejects.toThrow(/line 2/)
  })

  it('fileSentinelStore fails loud on a shape-invalid line (unknown metric key)', async () => {
    dir = mkdtempSync(join(tmpdir(), 'judge-sentinel-'))
    const path = join(dir, 'sentinel.jsonl')
    const store = fileSentinelStore(path)
    const bogus = { at: day(1), judgeId: 'a', judgeModel: 'm', metrics: { kapa: 0.8 } }
    appendFileSync(path, `${JSON.stringify(bogus)}\n`, 'utf8')

    await expect(store.history()).rejects.toThrow(/unknown key "kapa"/)
  })

  it('append rejects snapshots with unparseable timestamps or non-finite metrics', async () => {
    const store = inMemorySentinelStore()
    await expect(store.append(snap('garbage', { irr: 0.8 }))).rejects.toThrow(ValidationError)
    await expect(store.append(snap(day(1), { irr: Number.NaN }))).rejects.toThrow(ValidationError)
  })
})

describe('evalHealthStamp', () => {
  it('mirrors the report verdict and isolates the alarm list', () => {
    const report = judgeSentinelReport(
      [1.0, 0.95, 0.9, 0.85, 0.8].map((v, i) => snap(day(i + 1), { sentinelPassRate: v })),
      { asOf: day(6) },
    )
    const stamp = evalHealthStamp(report)
    expect(stamp.healthy).toBe(false)
    expect(stamp.alarms).toEqual(report.alarms)

    stamp.alarms.push('mutated')
    expect(report.alarms).not.toContain('mutated')
  })

  it('stamps healthy when nothing is alarmed', () => {
    const report = judgeSentinelReport(
      Array.from({ length: 5 }, (_, i) => snap(day(i + 1), { calibrationKappa: 0.8 })),
      { asOf: day(6) },
    )
    expect(evalHealthStamp(report)).toEqual({ healthy: true, alarms: [] })
  })
})
