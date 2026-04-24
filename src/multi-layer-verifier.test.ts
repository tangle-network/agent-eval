import { describe, it, expect, vi } from 'vitest'
import {
  MultiLayerVerifier,
  gradeSemanticStatus,
  type Layer,
  type LayerResult,
} from './multi-layer-verifier'

function passLayer(name: string, score = 1, extras: Partial<Layer> = {}): Layer {
  return {
    name,
    ...extras,
    run: () => ({
      layer: name,
      status: 'pass',
      score,
      durationMs: 10,
      findings: [],
    }),
  }
}

function failLayer(name: string, score = 0, extras: Partial<Layer> = {}): Layer {
  return {
    name,
    ...extras,
    run: () => ({
      layer: name,
      status: 'fail',
      score,
      durationMs: 10,
      findings: [{ severity: 'major', message: `${name} failed` }],
    }),
  }
}

describe('MultiLayerVerifier — construction', () => {
  it('rejects duplicate layer names', () => {
    expect(
      () => new MultiLayerVerifier([passLayer('install'), passLayer('install')]),
    ).toThrow(/duplicate/)
  })

  it('rejects unknown dependsOn', () => {
    expect(
      () => new MultiLayerVerifier([{ ...passLayer('build'), dependsOn: ['install'] }]),
    ).toThrow(/depends on "install"/)
  })
})

describe('MultiLayerVerifier — execution', () => {
  it('runs layers in order, produces aggregated report', async () => {
    const v = new MultiLayerVerifier([passLayer('install', 1), passLayer('build', 0.8)])
    const r = await v.run({ env: null })
    expect(r.passCount).toBe(2)
    expect(r.failCount).toBe(0)
    expect(r.allPass).toBe(true)
    expect(r.blendedScore).toBeCloseTo(0.9, 2)
  })

  it('skips downstream layers when upstream fails', async () => {
    const v = new MultiLayerVerifier([
      failLayer('install', 0),
      { ...passLayer('build', 1), dependsOn: ['install'] },
      { ...passLayer('test', 1), dependsOn: ['build'] },
    ])
    const r = await v.run({ env: null })
    expect(r.passCount).toBe(0)
    expect(r.failCount).toBe(1)
    expect(r.skippedCount).toBe(2)
    expect(r.allPass).toBe(false)
    expect(r.layers[1]!.status).toBe('skipped')
    expect(r.layers[1]!.reason).toMatch(/upstream not passing/)
  })

  it('runs independent layers even when one fails (no dependency = no skip)', async () => {
    const v = new MultiLayerVerifier([failLayer('a'), passLayer('b', 0.7)])
    const r = await v.run({ env: null })
    expect(r.failCount).toBe(1)
    expect(r.passCount).toBe(1)
    expect(r.allPass).toBe(false)
    // Only the passing layer contributes to blendedScore by default.
    expect(r.blendedScore).toBeCloseTo(0.7, 2)
  })

  it('failContributesToScore=true keeps failed layers in the blend', async () => {
    const v = new MultiLayerVerifier([
      { ...failLayer('semantic', 0.3), failContributesToScore: true },
      passLayer('install', 1),
    ])
    const r = await v.run({ env: null })
    // Weights 1 each: (0.3 + 1) / 2 = 0.65
    expect(r.blendedScore).toBeCloseTo(0.65, 2)
  })

  it('respects per-layer weights in the blend', async () => {
    const v = new MultiLayerVerifier([
      { ...passLayer('install', 1), weight: 1 },
      { ...passLayer('semantic', 0.5), weight: 3 },
    ])
    const r = await v.run({ env: null })
    // (1*1 + 3*0.5) / (1+3) = 2.5/4 = 0.625
    expect(r.blendedScore).toBeCloseTo(0.625, 3)
  })

  it('calls onLayer after each layer completes', async () => {
    const onLayer = vi.fn<(r: LayerResult) => void>()
    const v = new MultiLayerVerifier([passLayer('a'), passLayer('b')])
    await v.run({ env: null, onLayer })
    expect(onLayer).toHaveBeenCalledTimes(2)
    expect(onLayer.mock.calls[0]![0]!.layer).toBe('a')
    expect(onLayer.mock.calls[1]![0]!.layer).toBe('b')
  })

  it('wraps thrown errors as status=error with the message', async () => {
    const v = new MultiLayerVerifier([
      {
        name: 'boom',
        run: () => {
          throw new Error('kaboom')
        },
      },
    ])
    const r = await v.run({ env: null })
    expect(r.errorCount).toBe(1)
    expect(r.layers[0]!.status).toBe('error')
    expect(r.layers[0]!.findings[0]!.message).toBe('kaboom')
  })

  it('per-layer capMs aborts a runaway layer as timeout', async () => {
    const v = new MultiLayerVerifier([
      {
        name: 'hang',
        capMs: 50,
        run: ({ signal }) =>
          new Promise<LayerResult>((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(new Error('aborted')))
            // Never resolves.
          }),
      },
    ])
    const r = await v.run({ env: null })
    expect(r.errorCount + r.failCount).toBeGreaterThan(0)
    expect(['timeout', 'error']).toContain(r.layers[0]!.status)
  })

  it('attaches layer name to findings that omit it', async () => {
    const v = new MultiLayerVerifier([
      {
        name: 'x',
        run: () => ({
          layer: 'x',
          status: 'fail',
          durationMs: 5,
          findings: [{ severity: 'minor', message: 'thing' }],
        }),
      },
    ])
    const r = await v.run({ env: null })
    expect(r.layers[0]!.findings[0]!.layer).toBe('x')
  })

  it('prior results are visible to subsequent layers', async () => {
    const seen: Record<string, unknown> = {}
    const v = new MultiLayerVerifier([
      passLayer('a', 1),
      {
        name: 'b',
        run: ({ prior }) => {
          seen.priorAScore = prior.a?.score
          return { layer: 'b', status: 'pass', score: 1, durationMs: 1, findings: [] }
        },
      },
    ])
    await v.run({ env: null })
    expect(seen.priorAScore).toBe(1)
  })
})

describe('gradeSemanticStatus', () => {
  it('pass: high score + no critical gaps', () => {
    expect(
      gradeSemanticStatus({
        score: 0.85,
        available: true,
        findings: [{ severity: 'minor', present: true, score: 6 }],
      }),
    ).toBe('pass')
  })

  it('fail: score below threshold', () => {
    expect(
      gradeSemanticStatus({
        score: 0.5,
        available: true,
        findings: [],
      }),
    ).toBe('fail')
  })

  it('fail: critical gap despite high score', () => {
    expect(
      gradeSemanticStatus({
        score: 0.9,
        available: true,
        findings: [{ severity: 'critical', present: false, score: 0 }],
      }),
    ).toBe('fail')
  })

  it('error: judge unavailable', () => {
    expect(
      gradeSemanticStatus({
        score: 0,
        available: false,
        findings: [],
      }),
    ).toBe('error')
  })

  it('custom threshold', () => {
    expect(
      gradeSemanticStatus({
        score: 0.6,
        available: true,
        findings: [],
        threshold: 0.5,
      }),
    ).toBe('pass')
  })
})
