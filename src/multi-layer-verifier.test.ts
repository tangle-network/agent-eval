import { describe, expect, it } from 'vitest'
import { type Layer, type LayerResult, MultiLayerVerifier } from './multi-layer-verifier'

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

describe('MultiLayerVerifier — execution', () => {
  it('runs layers in order, produces aggregated report', async () => {
    const v = new MultiLayerVerifier([passLayer('install', 1), passLayer('build', 0.8)])
    const r = await v.run({ env: null })
    expect(r.passCount).toBe(2)
    expect(r.failCount).toBe(0)
    expect(r.allPass).toBe(true)
    expect(r.blendedScore).toBeCloseTo(0.9, 2)
    expect(r.taskScore).toBeCloseTo(0.9, 2)
    // Generic verdict fields use only the complete task measurement.
    expect(r.valid).toBe(true)
    expect(r.score).toBeCloseTo(0.9, 2)
  })

  it('keeps a partial blend diagnostic without publishing it as a task score', async () => {
    const v = new MultiLayerVerifier([failLayer('install', 0), passLayer('build', 0.7)])
    const r = await v.run({ env: null })
    expect(r.allPass).toBe(false)
    expect(r.valid).toBe(r.allPass)
    expect(r.blendedScore).toBe(0.7)
    expect(r.taskScore).toBeUndefined()
    expect(r.score).toBe(0)
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

  it('leaves an all-error report without a task score', async () => {
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
    expect(r.layers[0]!.errorSource).toBe('execution')
    expect(r.taskScore).toBeUndefined()
    expect(r.score).toBe(0)
  })

  it('leaves an all-timeout report without a task score', async () => {
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
    expect(r.errorCount).toBe(1)
    expect(r.layers[0]!.status).toBe('timeout')
    expect(r.taskScore).toBeUndefined()
    expect(r.score).toBe(0)
  })

  it('enforces a layer cap when the layer ignores its abort signal', async () => {
    const v = new MultiLayerVerifier([
      {
        name: 'ignores-signal',
        capMs: 5,
        run: () => new Promise<LayerResult>(() => {}),
      },
    ])
    const r = await v.run({ env: null })
    expect(r.layers[0]!.status).toBe('timeout')
    expect(r.layers[0]!.reason).toBe('layer ignores-signal cap')
    expect(r.taskScore).toBeUndefined()
  })

  it('leaves an unscored pass without a task score', async () => {
    const v = new MultiLayerVerifier([
      {
        name: 'diagnostic',
        run: () => ({
          layer: 'diagnostic',
          status: 'pass',
          durationMs: 5,
          findings: [],
        }),
      },
    ])
    const r = await v.run({ env: null })
    expect(r.passCount).toBe(1)
    expect(r.allPass).toBe(false)
    expect(r.taskScore).toBeUndefined()
    expect(r.score).toBe(0)
  })

  it('preserves a partial panel without claiming complete task quality', async () => {
    const v = new MultiLayerVerifier([
      passLayer('tests', 0.8),
      {
        name: 'semantic',
        errorSource: 'judge',
        run: () => {
          throw new Error('judge unavailable')
        },
      },
    ])
    const r = await v.run({ env: null })
    expect(r.blendedScore).toBe(0.8)
    expect(r.layers[0]!.score).toBe(0.8)
    expect(r.layers[1]!.errorSource).toBe('judge')
    expect(r.taskScore).toBeUndefined()
    expect(r.allPass).toBe(false)
    expect(r.score).toBe(0)
  })

  it('allows a successful non-scoring check beside a complete scored layer', async () => {
    const v = new MultiLayerVerifier([
      passLayer('tests', 0.8),
      {
        name: 'diagnostic',
        run: () => ({
          layer: 'diagnostic',
          status: 'pass',
          durationMs: 5,
          findings: [],
        }),
      },
    ])

    const r = await v.run({ env: null })

    expect(r.taskScore).toBe(0.8)
    expect(r.allPass).toBe(true)
    expect(r.score).toBe(0.8)
  })

  it('rejects a non-finite or out-of-range layer score as incomplete', async () => {
    const v = new MultiLayerVerifier([
      {
        name: 'invalid',
        run: () => ({
          layer: 'invalid',
          status: 'pass',
          score: Number.POSITIVE_INFINITY,
          durationMs: 5,
          findings: [],
        }),
      },
    ])

    const r = await v.run({ env: null })

    expect(r.taskScore).toBeUndefined()
    expect(r.allPass).toBe(false)
  })

  it('publishes a complete score for an actual scored failure', async () => {
    const v = new MultiLayerVerifier([
      { ...failLayer('semantic', 0.3), failContributesToScore: true },
    ])
    const r = await v.run({ env: null })
    expect(r.failCount).toBe(1)
    expect(r.taskScore).toBe(0.3)
    expect(r.blendedScore).toBe(0.3)
    expect(r.allPass).toBe(false)
    expect(r.score).toBe(0.3)
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

describe('MultiLayerVerifier — certification', () => {
  it('every report carries a composite certification with the pipeline checker identity', async () => {
    const verifier = new MultiLayerVerifier([passLayer('install'), passLayer('typecheck')])
    const report = await verifier.run({ env: {} })
    expect(report.certification?.strategy).toBe('composite')
    expect(report.certification?.checker.name).toBe('agent-eval:multi-layer-verifier')
    expect(report.certification?.checker.version).toMatch(/^\d+\.\d+\.\d+/)
    expect(report.certification?.assumptions).toEqual([])
    expect(report.certification?.evidenceDigest).toMatch(/^[0-9a-f]{64}$/)
  })

  it('names every unmeasured layer as an assumption instead of folding it into the blend silently', async () => {
    const verifier = new MultiLayerVerifier([
      failLayer('install'),
      passLayer('typecheck', 1, { dependsOn: ['install'] }),
    ])
    const report = await verifier.run({ env: {} })
    expect(report.certification?.assumptions).toEqual([
      "layer 'typecheck' skipped — its obligations are unverified",
    ])
  })
})
