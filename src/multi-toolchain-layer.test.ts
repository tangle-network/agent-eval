import { describe, expect, it } from 'vitest'
import type { LayerResult } from './multi-layer-verifier'
import { mergeLayerResults, multiToolchainLayer } from './multi-toolchain-layer'

function mkResult(
  status: LayerResult['status'],
  score?: number,
  findings: LayerResult['findings'] = [],
): LayerResult {
  return {
    layer: 'install',
    status,
    score,
    durationMs: 100,
    findings,
  }
}

describe('mergeLayerResults', () => {
  it('skipped when no adapters', () => {
    const r = mergeLayerResults('install', [])
    expect(r.status).toBe('skipped')
    expect(r.findings).toHaveLength(0)
    expect(r.reason).toBe('no adapters')
  })

  it('passes through when single adapter (preserves findings + reason)', () => {
    const r = mergeLayerResults('install', [
      {
        adapter: 'pnpm',
        result: {
          ...mkResult('pass', 1),
          findings: [{ severity: 'info', layer: 'install', message: 'pnpm install ok' }],
        },
      },
    ])
    expect(r.status).toBe('pass')
    expect(r.score).toBe(1)
    expect(r.findings[0]!.detail).toEqual({ adapter: 'pnpm' })
  })

  it('worst-of-parts status reduction', () => {
    const r = mergeLayerResults('install', [
      { adapter: 'pnpm', result: mkResult('pass', 1) },
      { adapter: 'npm', result: mkResult('fail', 0) },
    ])
    expect(r.status).toBe('fail')
  })

  it('error > timeout > fail > skipped > pass', () => {
    const cases: Array<[Array<LayerResult['status']>, LayerResult['status']]> = [
      [['pass', 'skipped'], 'skipped'],
      [['pass', 'fail'], 'fail'],
      [['fail', 'timeout'], 'timeout'],
      [['timeout', 'error'], 'error'],
      [['pass', 'pass'], 'pass'],
    ]
    for (const [statuses, expected] of cases) {
      const r = mergeLayerResults(
        'x',
        statuses.map((s, i) => ({ adapter: `a${i}`, result: mkResult(s) })),
      )
      expect(r.status).toBe(expected)
    }
  })

  it('weighted-mean score across numeric adapters; skips contribute null', () => {
    const r = mergeLayerResults('build', [
      { adapter: 'pnpm', result: mkResult('pass', 0.8) },
      { adapter: 'npm', result: mkResult('pass', 1.0) },
      { adapter: 'forge', result: mkResult('skipped') },
    ])
    expect(r.score).toBeCloseTo(0.9, 2)
  })

  it('attributes findings with detail.adapter', () => {
    const r = mergeLayerResults('typecheck', [
      {
        adapter: 'pnpm',
        result: mkResult('fail', 0, [
          { severity: 'major', layer: 'typecheck', message: 'tsc 4 errors' },
        ]),
      },
      {
        adapter: 'forge',
        result: mkResult('pass', 1, [
          { severity: 'info', layer: 'typecheck', message: 'forge ok' },
        ]),
      },
    ])
    expect(r.findings).toHaveLength(2)
    expect(r.findings.find((f) => f.message === 'tsc 4 errors')?.detail).toMatchObject({
      adapter: 'pnpm',
    })
    expect(r.findings.find((f) => f.message === 'forge ok')?.detail).toMatchObject({
      adapter: 'forge',
    })
  })

  it('reason concatenates adapter:status; durationMs is max-of-parts', () => {
    const r = mergeLayerResults('install', [
      { adapter: 'pnpm', result: { ...mkResult('pass', 1), durationMs: 5000 } },
      { adapter: 'npm', result: { ...mkResult('skipped'), durationMs: 100 } },
    ])
    expect(r.reason).toBe('pnpm: pass · npm: skipped')
    expect(r.durationMs).toBe(5000)
  })
})

describe('multiToolchainLayer', () => {
  it('runs adapters in parallel + merges results', async () => {
    const calls: string[] = []
    const layer = multiToolchainLayer<unknown, { id: string }>({
      name: 'install',
      adapters: [{ id: 'pnpm' }, { id: 'npm' }, { id: 'forge' }],
      adapterName: (a) => a.id,
      run: async (a) => {
        calls.push(a.id)
        return mkResult(a.id === 'forge' ? 'fail' : 'pass', a.id === 'forge' ? 0 : 1)
      },
    })
    const r = await layer.run({ env: null, prior: {}, signal: new AbortController().signal })
    expect(r.status).toBe('fail')
    expect(calls.sort()).toEqual(['forge', 'npm', 'pnpm'])
    expect(r.detail).toMatchObject({
      adapters: expect.arrayContaining([
        expect.objectContaining({ adapter: 'pnpm', status: 'pass' }),
      ]),
    })
  })

  it('catches per-adapter throws as status=error (rest of layer still completes)', async () => {
    const layer = multiToolchainLayer<unknown, string>({
      name: 'install',
      adapters: ['pnpm', 'cursed'],
      adapterName: (a) => a,
      run: async (a) => {
        if (a === 'cursed') throw new Error('boom')
        return mkResult('pass', 1)
      },
    })
    const r = await layer.run({ env: null, prior: {}, signal: new AbortController().signal })
    expect(r.status).toBe('error') // worst-of (pass + error)
    const cursed = r.findings.find(
      (f) => f.detail && (f.detail as Record<string, unknown>).adapter === 'cursed',
    )
    expect(cursed?.message).toBe('boom')
  })

  it('skipped result on zero adapters (no toolchain detected)', async () => {
    const layer = multiToolchainLayer<unknown, string>({
      name: 'install',
      adapters: [],
      adapterName: (a) => a,
      run: async () => mkResult('pass', 1),
    })
    const r = await layer.run({ env: null, prior: {}, signal: new AbortController().signal })
    expect(r.status).toBe('skipped')
    expect(r.reason).toMatch(/no adapters detected/)
  })

  it('respects maxParallel — chunks calls', async () => {
    let inFlight = 0
    let peak = 0
    const layer = multiToolchainLayer<unknown, number>({
      name: 'x',
      adapters: [1, 2, 3, 4, 5, 6, 7, 8],
      adapterName: (a) => `a${a}`,
      maxParallel: 2,
      run: async () => {
        inFlight++
        peak = Math.max(peak, inFlight)
        await new Promise((r) => setTimeout(r, 10))
        inFlight--
        return mkResult('pass', 1)
      },
    })
    await layer.run({ env: null, prior: {}, signal: new AbortController().signal })
    expect(peak).toBeLessThanOrEqual(2)
  })

  it('passes verify ctx through to adapter run fn', async () => {
    const seen: unknown[] = []
    const layer = multiToolchainLayer<{ marker: number }, string>({
      name: 'x',
      adapters: ['pnpm'],
      adapterName: (a) => a,
      run: async (_a, ctx) => {
        seen.push(ctx.env.marker)
        return mkResult('pass', 1)
      },
    })
    await layer.run({ env: { marker: 42 }, prior: {}, signal: new AbortController().signal })
    expect(seen).toEqual([42])
  })
})
