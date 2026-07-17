import { describe, expect, it } from 'vitest'
import { callbackGovernor, type GovernorContext, type GovernorOp } from '../lineage'
import { inMemoryCampaignStorage } from '../storage'
import type {
  JudgeConfig,
  MutableSurface,
  ProposeContext,
  Scenario,
  SurfaceProposer,
} from '../types'
import { runLineageLoop } from './run-lineage-loop'

// ── Deterministic, LLM-free fixtures ──────────────────────────────────────────
// A surface is a plain string that ENCODES its own fitness value: `tag:v=NNNN`.
// The stub proposer decides the NEXT surface (a higher value); the scorer merely
// DECODES the embedded value — so the two seams are cleanly separated and every
// number in the run is a pure function of the inputs. No LLM, no sandbox.
const CEILING = 0.9
const CLIMB = 0.2
const mk = (v: number, tag = 's'): string => `${tag}:v=${v.toFixed(4)}`
const decode = (surface: string): number => {
  const m = /v=([\d.]+)/.exec(surface)
  return m ? Number.parseFloat(m[1]!) : 0
}
const round = (v: number): number => Number.parseFloat(v.toFixed(4))

/** A pure `SurfaceProposer`: single-parent reflection CLIMBS toward the ceiling;
 *  multi-parent (`paretoParents.length > 1`) fires the crossover path and merges
 *  to `max(parent value) + 0.01` — the same contract `gepaProposer` implements,
 *  minus the LLM. */
const stubProposer: SurfaceProposer = {
  kind: 'stub',
  async propose(ctx: ProposeContext) {
    const parents = ctx.paretoParents ?? []
    if (parents.length > 1) {
      const best = Math.max(...parents.map((p) => decode(p.surface as string)))
      return [
        {
          surface: mk(round(best + 0.01), 'merge'),
          label: 'crossover',
          rationale: 'combined parents',
        },
      ]
    }
    const cur = decode(ctx.currentSurface as string)
    const next = round(Math.min(CEILING, cur + CLIMB))
    return [{ surface: mk(next, 'reflect'), label: 'climb', rationale: 'reflective step' }]
  },
}

const sc = (id: string): Scenario => ({ id, kind: 'unit' })

/** A deterministic judge: reads the artifact (the surface string dispatch echoed
 *  back) and scores it as the value the surface encodes. Two scenarios ⇒ a
 *  2-component objective vector per surface. */
const stubJudge: JudgeConfig<string, Scenario> = {
  name: 'decode-judge',
  dimensions: [{ key: 'quality', description: 'decoded fitness' }],
  score({ artifact }) {
    const v = decode(artifact)
    return { dimensions: { quality: v }, composite: v, notes: '' }
  },
}

// The "agent" seam: echo the current surface back as the artifact so the judge
// can decode it. Deterministic; reports no cost (expectUsage:'off' below).
const echoAgent = async (surface: MutableSurface): Promise<string> =>
  typeof surface === 'string' ? surface : JSON.stringify(surface)

function realScorerOpts() {
  return {
    scenarios: [sc('a'), sc('b')],
    judges: [stubJudge],
    dispatchWithSurface: (surface: MutableSurface) => echoAgent(surface),
    runDir: 'lineage-loop-test',
    storage: inMemoryCampaignStorage(),
    tracing: 'off' as const,
    expectUsage: 'off' as const,
    proposer: stubProposer,
  }
}

describe('runLineageLoop — real runCampaign scorer + stub proposer', () => {
  const seeds = [
    { surface: mk(0.1, 'solve'), track: 'solve', vision: 'solve', proposer: 'gepa' },
    {
      surface: mk(0.1, 'outside'),
      track: 'outside-the-box',
      vision: 'outside-the-box',
      proposer: 'gepa',
    },
    { surface: mk(0.1, 'contrarian'), track: 'contrarian', vision: 'contrarian', proposer: 'gepa' },
  ]

  it('seeds N visioned tracks, produces a multi-node merge DAG, and best() is the max score', async () => {
    const result = await runLineageLoop({
      ...realScorerOpts(),
      seeds,
      governor: undefined, // default heuristicGovernor()
      budget: { maxSteps: 30 },
    })

    // Three visioned roots.
    expect(result.lineage.roots()).toHaveLength(3)
    expect(new Set(result.lineage.roots().map((n) => n.vision))).toEqual(
      new Set(['solve', 'outside-the-box', 'contrarian']),
    )

    // A multi-node DAG (more than just the seeds).
    expect(result.lineage.all().length).toBeGreaterThan(3)

    // The governor merged: at least one node has >= 2 parents.
    expect(result.lineage.all().some((n) => n.parentIds.length >= 2)).toBe(true)

    // best() is the max score in the graph, and the loop climbed to the ceiling.
    const maxScore = Math.max(...result.lineage.all().map((n) => n.score))
    expect(result.best!.score).toBe(maxScore)
    expect(result.best!.score).toBeCloseTo(CEILING, 6)

    expect(result.steps).toBeLessThanOrEqual(30)
  })

  it('is deterministic: re-running yields an identical DAG', async () => {
    const run = () => runLineageLoop({ ...realScorerOpts(), seeds, budget: { maxSteps: 30 } })
    const r1 = await run()
    const r2 = await run()
    expect(r2.lineage.toGraph()).toEqual(r1.lineage.toGraph())
  })
})

describe('runLineageLoop — merge seam drives the crossover proposer', () => {
  // Pure injected scorer (no campaign) + a governor that forces a merge, to
  // prove the `merge` seam collapses 2 parents through the crossover proposer.
  const pureScore = async (surface: string | { toString(): string }) => {
    const v = decode(String(surface))
    return { score: v, scoreVector: [v, v] }
  }

  it('a forced merge produces a >=2-parent node whose surface is the crossover output', async () => {
    let n = 0
    const gov = callbackGovernor(async (ctx: GovernorContext): Promise<GovernorOp> => {
      n += 1
      if (n === 1) return { op: 'extend', track: 'a' }
      if (n === 2) return { op: 'extend', track: 'b' }
      if (n === 3) {
        const tipA = ctx.lineage.trackTip('a')!
        const tipB = ctx.lineage.trackTip('b')!
        return { op: 'merge', parentIds: [tipA.id, tipB.id], track: 'a' }
      }
      return { op: 'stop' }
    })

    const result = await runLineageLoop({
      scenarios: [sc('a')],
      seeds: [
        { surface: mk(0.1, 'a'), track: 'a', vision: 'solve', proposer: 'gepa' },
        { surface: mk(0.1, 'b'), track: 'b', vision: 'contrarian', proposer: 'gepa' },
      ],
      proposer: stubProposer,
      scoreSurface: pureScore,
      governor: gov,
      budget: { maxSteps: 10 },
    })

    const mergeNode = result.lineage.all().find((node) => node.parentIds.length >= 2)
    expect(mergeNode).toBeDefined()
    expect(mergeNode!.parentIds).toHaveLength(2)
    // The crossover proposer emitted a `merge:`-tagged surface.
    expect(mergeNode!.surface.startsWith('merge:')).toBe(true)
    // Both tracks climbed 0.1 -> 0.3 before merging; the crossover bumps to 0.31.
    expect(mergeNode!.score).toBeCloseTo(0.31, 6)
    expect(result.best!.score).toBe(Math.max(...result.lineage.all().map((node) => node.score)))
  })
})

describe('runLineageLoop — required-seam validation', () => {
  it('throws when neither a proposer nor llm+model is provided', async () => {
    await expect(
      runLineageLoop({
        scenarios: [sc('a')],
        seeds: [{ surface: mk(0.1), track: 'a', proposer: 'gepa' }],
        scoreSurface: async () => ({ score: 0.1 }),
        budget: { maxSteps: 1 },
      }),
    ).rejects.toThrow(/a proposer is required/)
  })

  it('throws when neither a scoreSurface nor dispatchWithSurface+runDir is provided', async () => {
    await expect(
      runLineageLoop({
        scenarios: [sc('a')],
        seeds: [{ surface: mk(0.1), track: 'a', proposer: 'gepa' }],
        proposer: stubProposer,
        budget: { maxSteps: 1 },
      }),
    ).rejects.toThrow(/scoring is required/)
  })
})

describe('runLineageLoop candidate concurrency', () => {
  it('scores independent seeds and candidates with the configured bound', async () => {
    let decisions = 0
    let active = 0
    let maxActive = 0
    const governor = callbackGovernor(async (): Promise<GovernorOp> => {
      decisions += 1
      return decisions === 1 ? { op: 'extend', track: 'wide' } : { op: 'stop' }
    })
    const proposer: SurfaceProposer = {
      kind: 'wide',
      async propose() {
        return [mk(0.2, 'a'), mk(0.3, 'b'), mk(0.4, 'c')]
      },
    }

    const result = await runLineageLoop({
      scenarios: [sc('a')],
      seeds: [{ surface: mk(0.1, 'seed'), track: 'wide', proposer: 'wide' }],
      proposer,
      scoreSurface: async (surface) => {
        const text = String(surface)
        if (text.startsWith('seed:')) return { score: decode(text) }
        active += 1
        maxActive = Math.max(maxActive, active)
        await new Promise((resolve) => setTimeout(resolve, 10))
        active -= 1
        return { score: decode(text) }
      },
      governor,
      populationSize: 3,
      candidateConcurrency: 2,
      budget: { maxSteps: 2 },
    })

    expect(maxActive).toBe(2)
    expect(result.best?.surface).toBe(mk(0.4, 'c'))
  })
})
