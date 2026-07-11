/**
 * selfImprove() power-analysis wiring proof — offline, deterministic.
 *
 * Drives the REAL loop (baseline-only, no LLM) with a variance-bearing judge and
 * asserts the result carries the minimum-detectable-lift analysis and that the
 * `power.estimated` progress event fires. The MDE math itself is unit-tested in
 * campaign/gates/power-preflight.test.ts; this guards the composition.
 */

import { describe, expect, it } from 'vitest'
import { surfaceHash } from '../campaign/surface-identity'
import type { CodeSurface, Gate, JudgeConfig, SurfaceProposer } from '../campaign/types'
import type { DispatchContext, Scenario } from './index'
import { type SelfImproveProgressEvent, selfImprove } from './self-improve'

const scenarios: Scenario[] = Array.from({ length: 8 }, (_, i) => ({
  id: `s${i}`,
  kind: 'fixture',
}))

// Alternating 0/1 composites: real variance for the power estimate.
const judge: JudgeConfig<{ text: string }, Scenario> = {
  name: 'variance-judge',
  dimensions: [{ key: 'q', description: 'fixture quality' }],
  score: ({ scenario }) => {
    const flip = Number.parseInt(scenario.id.slice(1), 10) % 2
    return { dimensions: { q: flip }, composite: flip, notes: '' }
  },
}

async function stubAgent(
  surface: unknown,
  _scenario: Scenario,
  ctx: DispatchContext,
): Promise<{ text: string }> {
  ctx.cost.observe(0.0001, 'stub-agent')
  ctx.cost.observeTokens({ input: 1, output: 1 })
  return { text: String(surface) }
}

function codeSurface(worktreeRef: string): CodeSurface {
  return {
    kind: 'code',
    worktreeRef,
    baseRef: 'main',
    baseCommit: '1'.repeat(40),
    baseTree: '2'.repeat(40),
    candidateCommit: '3'.repeat(40),
    candidateTree: '4'.repeat(40),
    patch: {
      format: 'git-diff-binary',
      sha256: `sha256:${'5'.repeat(64)}`,
      byteLength: 1,
    },
  }
}

describe('selfImprove — power analysis wiring', () => {
  it('attaches the MDE analysis to the result and emits power.estimated', async () => {
    const events: SelfImproveProgressEvent[] = []
    const result = await selfImprove({
      agent: stubAgent,
      scenarios,
      judge,
      baselineSurface: 'be careful',
      budget: { generations: 0, holdoutFraction: 0.5 },
      onProgress: (e) => events.push(e),
    })

    expect(result.power).toBeDefined()
    const power = result.power
    if (!power) throw new Error('unreachable')
    expect(power.n).toBeGreaterThanOrEqual(3)
    expect(power.sd).toBeGreaterThan(0.3) // alternating 0/1 cells
    expect(power.mde).toBeGreaterThan(power.deltaThreshold)
    expect(power.recommendation.length).toBeGreaterThan(20)

    const powerEvents = events.filter((e) => e.kind === 'power.estimated')
    expect(powerEvents).toHaveLength(1)
  })
})

describe('selfImprove — hosted code-surface identity', () => {
  it('uses the content identity in snapshots instead of the mutable worktree path', async () => {
    const baseline = codeSurface('/tmp/candidate-a')
    const sameBytesElsewhere = codeSurface('/tmp/candidate-b')
    const payloads: Array<{
      events?: Array<{
        baseline?: { surfaceHash: string }
        generations: Array<{ surfaceHash: string }>
      }>
    }> = []
    const fetchImpl: typeof fetch = async (_input, init) => {
      if (typeof init?.body === 'string') payloads.push(JSON.parse(init.body))
      return new Response(JSON.stringify({ accepted: 1, rejected: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    const proposer: SurfaceProposer = {
      kind: 'code-candidate',
      propose: async () => [sameBytesElsewhere],
    }

    await selfImprove({
      agent: stubAgent,
      scenarios,
      judge,
      baselineSurface: baseline,
      proposer,
      budget: { generations: 1, populationSize: 1, holdoutFraction: 0.5 },
      hostedTenant: {
        endpoint: 'https://ingest.example',
        apiKey: 'test-key',
        tenantId: 'test-tenant',
        fetchImpl,
      },
    })

    const expected = surfaceHash(baseline)
    const event = payloads
      .flatMap((payload) => payload.events ?? [])
      .find((candidate) => candidate.baseline?.surfaceHash === expected)
    expect(event).toBeDefined()
    expect(event?.generations[0]?.surfaceHash).toBe(expected)
    expect(surfaceHash(sameBytesElsewhere)).toBe(expected)
  })
})

describe('selfImprove — neutralize (placebo arm) passthrough', () => {
  it('forwards `neutralize`: runs the placebo arm and hands its scores to the gate', async () => {
    let neutralizeCalled = false
    let gateSawNeutralized = false

    // Rewards only the surface containing "better", so the proposed candidate
    // beats the baseline → the loop promotes a winner ≠ baseline → the placebo
    // arm runs (it is skipped when winner == baseline).
    const winJudge: JudgeConfig<{ text: string }, Scenario> = {
      name: 'win-judge',
      dimensions: [{ key: 'q', description: 'fixture quality' }],
      score: ({ artifact }) => {
        const good = artifact.text.includes('better') ? 1 : 0
        return { dimensions: { q: good }, composite: good, notes: '' }
      },
    }
    const proposer: SurfaceProposer = { kind: 'stub', propose: async () => ['better'] }
    const captureGate: Gate<{ text: string }, Scenario> = {
      name: 'capture',
      async decide(ctx) {
        gateSawNeutralized = (ctx.neutralizedJudgeScores?.size ?? 0) > 0
        return { decision: 'hold', reasons: [], contributingGates: [] }
      },
    }

    await selfImprove({
      agent: stubAgent,
      scenarios,
      judge: winJudge,
      baselineSurface: 'base',
      proposer,
      gate: captureGate,
      budget: { generations: 1, populationSize: 1, holdoutFraction: 0.5 },
      neutralize: (winner) => {
        neutralizeCalled = true
        // footprint-matched-ish blank: same length, zero content
        return '#'.repeat(String(winner).length)
      },
    })

    expect(neutralizeCalled).toBe(true)
    expect(gateSawNeutralized).toBe(true)
  })
})
