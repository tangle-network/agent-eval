import { describe, expect, it } from 'vitest'
import { type AgentProfile, agentProfileHash } from '../../src/agent-profile'
import {
  inMemoryCampaignStorage,
  type JudgeConfig,
  type ProfileDispatchFn,
  ProfileMatrixError,
  runProfileMatrix,
  type Scenario,
} from '../../src/campaign/index'
import { BackendIntegrityError } from '../../src/integrity/backend-integrity'
import { isRunRecord } from '../../src/run-record'

interface FakeScenario extends Scenario {
  id: string
  kind: string
  persona: string
}

interface FakeArtifact {
  text: string
}

const PROFILES: AgentProfile[] = [
  { id: 'baseline', model: 'test-model@2025-01-01', promptVersion: 'v1' },
  { id: 'tuned', model: 'test-model@2025-01-01', promptVersion: 'v2' },
]

const SCENARIOS: FakeScenario[] = [
  { id: 's1', kind: 'task', persona: 'alice' },
  { id: 's2', kind: 'task', persona: 'alice' },
  { id: 's3', kind: 'task', persona: 'bob' },
]

// Deterministic judge: 'tuned' scores higher than 'baseline' so byProfile is
// distinguishable. Reads the artifact text the dispatch stamped the profile into.
const JUDGE: JudgeConfig<FakeArtifact, FakeScenario> = {
  name: 'quality',
  dimensions: [{ key: 'quality', description: 'is it good' }],
  score: ({ artifact }) => {
    const quality = artifact.text.startsWith('tuned:') ? 0.9 : 0.6
    return { dimensions: { quality }, composite: quality, notes: '' }
  },
}

/** Real dispatch — reports both cost AND token usage (the integrity guard needs tokens). */
const realDispatch: ProfileDispatchFn<FakeScenario, FakeArtifact> = async (
  profile,
  scenario,
  ctx,
) => {
  ctx.cost.observe(0.001, 'llm')
  ctx.cost.observeTokens({ input: 120, output: 40 })
  return { text: `${profile.id}:${scenario.id}` }
}

/** Stub dispatch — never reports tokens (the classic "eval ran blind" failure). */
const stubDispatch: ProfileDispatchFn<FakeScenario, FakeArtifact> = async (profile, scenario) => {
  return { text: `${profile.id}:${scenario.id}` }
}

function baseOpts() {
  return {
    profiles: PROFILES,
    scenarios: SCENARIOS,
    judges: [JUDGE],
    runDir: '/virtual/profile-matrix',
    commitSha: 'deadbeef',
    reps: 2,
    storage: inMemoryCampaignStorage(),
  }
}

describe('runProfileMatrix', () => {
  it('produces one valid RunRecord per (profile × scenario × rep) with real token usage', async () => {
    const result = await runProfileMatrix({ ...baseOpts(), dispatch: realDispatch })

    // 2 profiles × 3 scenarios × 2 reps = 12 records.
    expect(result.records).toHaveLength(12)
    for (const rec of result.records) {
      expect(isRunRecord(rec)).toBe(true)
      expect(rec.tokenUsage).toEqual({ input: 120, output: 40 })
      expect(rec.commitSha).toBe('deadbeef')
      expect(rec.splitTag).toBe('search')
      expect(rec.scenarioId).toBeDefined()
    }
    // candidateId is the profile id; both profiles present.
    expect(new Set(result.records.map((r) => r.candidateId))).toEqual(
      new Set(['baseline', 'tuned']),
    )
  })

  it('projects cost/efficiency guardrail dimensions into outcome.raw (multi-dim capture)', async () => {
    const result = await runProfileMatrix({ ...baseOpts(), dispatch: realDispatch })
    const rec = result.records[0]!
    const raw = rec.outcome.raw
    // Base guardrails come straight from the cell's reported cost/tokens/latency.
    expect(raw.cost_usd).toBe(0.001)
    expect(raw.tokens_input).toBe(120)
    expect(raw.tokens_output).toBe(40)
    expect(raw.latency_ms).toBeGreaterThanOrEqual(0)
    // Computed ratio, guarded against divide-by-zero.
    expect(raw.tokens_per_dollar).toBeCloseTo((120 + 40) / 0.001, 5)
    const composite = rec.outcome.searchScore!
    expect(raw.cost_per_quality).toBeCloseTo(0.001 / composite, 5)
    // The composite stays the JUDGE objective — guardrails are RAW-ONLY, never folded in.
    expect(raw.composite).toBe(composite)
  })

  it('omits computed ratios when cost is zero — no non-finite raw values', async () => {
    const freeDispatch: ProfileDispatchFn<FakeScenario, FakeArtifact> = async (
      profile,
      scenario,
      ctx,
    ) => {
      ctx.cost.observe(0, 'llm')
      ctx.cost.observeTokens({ input: 50, output: 10 })
      return { text: `${profile.id}:${scenario.id}` }
    }
    const result = await runProfileMatrix({
      ...baseOpts(),
      dispatch: freeDispatch,
      integrity: 'off',
    })
    const raw = result.records[0]!.outcome.raw
    expect(raw.cost_usd).toBe(0)
    expect('tokens_per_dollar' in raw).toBe(false) // guarded: cost === 0
    for (const v of Object.values(raw)) expect(Number.isFinite(v)).toBe(true)
  })

  it('runs assertRealBackend BY CONSTRUCTION — verdict real, every record costed', async () => {
    const result = await runProfileMatrix({ ...baseOpts(), dispatch: realDispatch })
    expect(result.integrity.verdict).toBe('real')
    expect(result.integrity.stubRecords).toBe(0)
    expect(result.integrity.totalInputTokens).toBe(12 * 120)
    expect(result.integrity.totalOutputTokens).toBe(12 * 40)
  })

  it('THROWS BackendIntegrityError when the dispatch reports zero tokens (stub backend)', async () => {
    // The keystone regression: a stub run must fail loudly, not report a clean
    // 0/N leaderboard. This is the exact bug the primitive exists to prevent.
    await expect(
      runProfileMatrix({ ...baseOpts(), dispatch: stubDispatch }),
    ).rejects.toBeInstanceOf(BackendIntegrityError)
  })

  it('integrity:"off" surfaces the stub verdict without throwing', async () => {
    const result = await runProfileMatrix({
      ...baseOpts(),
      dispatch: stubDispatch,
      integrity: 'off',
    })
    expect(result.integrity.verdict).toBe('stub')
    expect(result.records).toHaveLength(12)
    // Records still produced — caller opted to inspect, not gate.
    expect(result.records.every((r) => r.tokenUsage.input === 0)).toBe(true)
  })

  it('byProfile separates the tuned profile from baseline; byScenario + byPersona pivot', async () => {
    const result = await runProfileMatrix({
      ...baseOpts(),
      dispatch: realDispatch,
      personaOf: (s: FakeScenario) => s.persona,
    })
    expect(result.byProfile.tuned!.meanComposite).toBeCloseTo(0.9, 5)
    expect(result.byProfile.baseline!.meanComposite).toBeCloseTo(0.6, 5)
    expect(result.byProfile.tuned!.profileHash).toBe(agentProfileHash(PROFILES[1]!))

    // 3 scenarios pivot, each with 2 profiles × 2 reps = 4 records.
    expect(Object.keys(result.byScenario).sort()).toEqual(['s1', 's2', 's3'])
    expect(result.byScenario.s1!.n).toBe(4)

    // 2 personas: alice (s1,s2 = 8 records), bob (s3 = 4 records).
    expect(result.byPersona).toBeDefined()
    expect(result.byPersona!.alice!.n).toBe(8)
    expect(result.byPersona!.bob!.n).toBe(4)
  })

  it('fails loud at preflight when a profile model lacks a snapshot version', async () => {
    await expect(
      runProfileMatrix({
        ...baseOpts(),
        profiles: [{ id: 'bare', model: 'gpt-4o' }],
        dispatch: realDispatch,
      }),
    ).rejects.toBeInstanceOf(ProfileMatrixError)
  })

  it('rejects an empty profiles list', async () => {
    await expect(
      runProfileMatrix({ ...baseOpts(), profiles: [], dispatch: realDispatch }),
    ).rejects.toBeInstanceOf(ProfileMatrixError)
  })
})
