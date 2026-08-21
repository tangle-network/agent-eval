import { describe, expect, it } from 'vitest'
import { ValidationError } from '../errors'
import { mulberry32 } from './random'
import { type EProcessState, eProcess } from './sequential-eprocess'

// ── Fixtures ──────────────────────────────────────────────────────────

/** Observations with a real edge over the default null (E[x] ≈ 0.7), so an
 *  uninterrupted run crosses the 1/alpha boundary well inside the stream. */
function edgeStream(seed: number, length: number): number[] {
  const rng = mulberry32(seed)
  return Array.from({ length }, () => Math.min(1, Math.max(0, 0.7 + (rng() - 0.5) * 0.6)))
}

interface Trace {
  wealths: number[]
  decidedFlags: boolean[]
  final: EProcessState
}

function runUninterrupted(xs: number[], opts: Parameters<typeof eProcess>[0]): Trace {
  const p = eProcess(opts)
  const wealths: number[] = []
  const decidedFlags: boolean[] = []
  for (const x of xs) {
    const step = p.update(x)
    wealths.push(step.wealth)
    decidedFlags.push(step.decided)
  }
  return { wealths, decidedFlags, final: p.state() }
}

/** Run the first k observations, snapshot `state()`, serialize it through
 *  JSON (what a restart-safe store does), rebuild, and run the rest. */
function runWithRestart(xs: number[], opts: Parameters<typeof eProcess>[0], k: number): Trace {
  const first = eProcess(opts)
  const wealths: number[] = []
  const decidedFlags: boolean[] = []
  for (const x of xs.slice(0, k)) {
    const step = first.update(x)
    wealths.push(step.wealth)
    decidedFlags.push(step.decided)
  }
  const persisted = JSON.parse(JSON.stringify(first.state())) as EProcessState
  const second = eProcess({ ...opts, resume: persisted })
  for (const x of xs.slice(k)) {
    const step = second.update(x)
    wealths.push(step.wealth)
    decidedFlags.push(step.decided)
  }
  return { wealths, decidedFlags, final: second.state() }
}

// ── state(): complete and plain ───────────────────────────────────────

describe('eProcess.state — the running sums the next bet is computed from', () => {
  it('reports the sums the bet formula reads', () => {
    const p = eProcess({ alpha: 0.1, maxBet: 0.4, nullMean: 0.5 })
    for (const x of [0.2, 0.9, 0.6]) p.update(x)
    const s = p.state()
    expect(s.sumX).toBeCloseTo(0.2 + 0.9 + 0.6, 12)
    // varSum = Σ (x_i − μ̂_i)² with the shrunk running mean μ̂_i = (1/2 + Σ_{j≤i} x_j)/(i+1).
    const mu1 = (0.5 + 0.2) / 2
    const mu2 = (0.5 + 0.2 + 0.9) / 3
    const mu3 = (0.5 + 0.2 + 0.9 + 0.6) / 4
    expect(s.varSum).toBeCloseTo((0.2 - mu1) ** 2 + (0.9 - mu2) ** 2 + (0.6 - mu3) ** 2, 12)
  })

  it('a JSON round-trip of the snapshot rebuilds the same process', () => {
    const p = eProcess()
    for (const x of [0.8, 0.4, 0.95]) p.update(x)
    const snapshot = p.state()
    const persisted = JSON.parse(JSON.stringify(snapshot)) as EProcessState
    expect(eProcess({ resume: persisted }).state()).toEqual(snapshot)
  })
})

// ── Restart reconstruction ────────────────────────────────────────────

describe('eProcess.resume — reconstruction after a restart', () => {
  const opts = { alpha: 0.05, maxBet: 0.5, nullMean: 0.5 }
  const xs = edgeStream(2024, 120)
  const reference = runUninterrupted(xs, opts)

  it('the uninterrupted reference decides inside the stream (the fixture has an edge)', () => {
    expect(reference.final.decided).toBe(true)
    expect(reference.final.decidedAtN).toBeGreaterThan(1)
    expect(reference.final.decidedAtN).toBeLessThan(xs.length)
  })

  it.each([0, 1, 7, 30, 119])(
    'interrupting at n=%i and resuming from state() reproduces the wealth sequence and decision exactly',
    (k) => {
      const resumed = runWithRestart(xs, opts, k)
      expect(resumed.wealths).toEqual(reference.wealths)
      expect(resumed.decidedFlags).toEqual(reference.decidedFlags)
      expect(resumed.final).toEqual(reference.final)
    },
  )

  it('interrupting exactly at the decision crossing keeps decidedAtN and the latch', () => {
    const k = reference.final.decidedAtN as number
    for (const at of [k - 1, k, k + 1]) {
      const resumed = runWithRestart(xs, opts, at)
      expect(resumed.wealths).toEqual(reference.wealths)
      expect(resumed.final.decidedAtN).toBe(k)
      expect(resumed.final.decided).toBe(true)
    }
  })

  it('resuming twice in a row (two restarts) is still exact', () => {
    const first = eProcess(opts)
    for (const x of xs.slice(0, 20)) first.update(x)
    const second = eProcess({ ...opts, resume: first.state() })
    for (const x of xs.slice(20, 55)) second.update(x)
    const third = eProcess({ ...opts, resume: JSON.parse(JSON.stringify(second.state())) })
    const wealths = [
      ...reference.wealths.slice(0, 55),
      ...xs.slice(55).map((x) => third.update(x).wealth),
    ]
    expect(wealths).toEqual(reference.wealths)
    expect(third.state()).toEqual(reference.final)
  })

  it('a resumed process keeps the predictability invariant: the next bet depends only on the snapshot', () => {
    // Two different continuations of the same snapshot agree on the first
    // post-restart wealth factor whenever their first observation agrees,
    // and diverge only from the second observation on.
    const p = eProcess(opts)
    for (const x of xs.slice(0, 10)) p.update(x)
    const snap = p.state()
    const a = eProcess({ ...opts, resume: snap })
    const b = eProcess({ ...opts, resume: snap })
    expect(a.update(0.9).wealth).toBe(b.update(0.9).wealth)
    expect(a.update(1).wealth).not.toBe(b.update(0).wealth)
  })

  it('with non-default parameters, resume still matches the uninterrupted run', () => {
    const custom = { alpha: 0.2, maxBet: 0.9, nullMean: 0.6 }
    const ref = runUninterrupted(xs, custom)
    const resumed = runWithRestart(xs, custom, 41)
    expect(resumed.wealths).toEqual(ref.wealths)
    expect(resumed.final).toEqual(ref.final)
  })
})

// ── Refusals ──────────────────────────────────────────────────────────

describe('eProcess.resume — refuses an incompatible or inconsistent snapshot', () => {
  function snapshot(n = 12): EProcessState {
    const p = eProcess({ alpha: 0.05 })
    for (const x of edgeStream(7, n)) p.update(x)
    return p.state()
  }

  it('a snapshot taken under different parameters is refused, naming the field', () => {
    const s = snapshot()
    expect(() => eProcess({ alpha: 0.01, resume: s })).toThrow(ValidationError)
    expect(() => eProcess({ alpha: 0.01, resume: s })).toThrow(
      /alpha=0\.05 differs from the process alpha=0\.01/,
    )
    expect(() => eProcess({ nullMean: 0.6, resume: s })).toThrow(/nullMean=0\.5 differs/)
    expect(() => eProcess({ maxBet: 0.25, resume: s })).toThrow(/maxBet=0\.5 differs/)
    // The defaults are the parameters when none are passed: a snapshot with
    // a non-default alpha needs that alpha passed explicitly.
    const tight = eProcess({ alpha: 0.01 }).state()
    expect(() => eProcess({ resume: tight })).toThrow(
      /alpha=0\.01 differs from the process alpha=0\.05/,
    )
    expect(() => eProcess({ alpha: 0.01, resume: tight })).not.toThrow()
  })

  it('a tampered threshold is refused even when alpha matches', () => {
    const s = { ...snapshot(), threshold: 50 }
    expect(() => eProcess({ resume: s })).toThrow(
      /threshold=50 differs from the process threshold=20/,
    )
  })

  it.each<[string, Partial<EProcessState>]>([
    ['negative n', { n: -1 }],
    ['fractional n', { n: 2.5 }],
    ['zero wealth', { wealth: 0 }],
    ['negative wealth', { wealth: -1 }],
    ['sumX above n', { sumX: 13 }],
    ['negative sumX', { sumX: -0.1 }],
    ['negative varSum', { varSum: -1e-9 }],
    ['decided without decidedAtN', { decided: true }],
    ['decidedAtN set while undecided', { decidedAtN: 3 }],
    ['decidedAtN above n', { decided: true, decidedAtN: 99 }],
    ['decidedAtN zero', { decided: true, decidedAtN: 0 }],
    ['undecided with wealth at the threshold', { wealth: 20 }],
  ])('refuses %s', (_label, patch) => {
    const s = { ...snapshot(), ...patch }
    expect(() => eProcess({ resume: s })).toThrow(ValidationError)
    expect(() => eProcess({ resume: s })).toThrow(/cannot resume/)
  })

  it('an n=0 snapshot must be the initial state', () => {
    const fresh = eProcess().state()
    expect(eProcess({ resume: fresh }).state()).toEqual(fresh)
    expect(() => eProcess({ resume: { ...fresh, wealth: 1.5 } })).toThrow(/n=0 requires/)
    expect(() => eProcess({ resume: { ...fresh, sumX: 0.3 } })).toThrow(
      /sumX must lie in \[0, n=0\]/,
    )
  })

  it('a truncated snapshot (missing running sums) is refused, not silently re-zeroed', () => {
    const { sumX: _sumX, varSum: _varSum, ...legacy } = snapshot()
    void _sumX
    void _varSum
    expect(() => eProcess({ resume: legacy as EProcessState })).toThrow(/sumX must lie in/)
  })
})
