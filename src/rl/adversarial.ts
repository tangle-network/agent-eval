/**
 * Adversarial scenario search.
 *
 * Capability evaluation on a fixed scenario set measures performance on
 * the distribution someone curated. Production failure modes live in the
 * tail — inputs the curator didn't think of, or actively avoided. The
 * adversarial-search primitive actively looks for them: starting from a
 * pool of scenarios where the policy already passes, it mutates them
 * (paraphrase, edge-case substitution, compositional combination) and
 * keeps the mutations that *break* the policy.
 *
 * This is not magic. It's the simplest version of the loop that AdA
 * (Open-Ended Adaptation, DeepMind 2023), POET, and Anthropic's
 * auto-jailbreak rigs all run: hill-climb against a failure indicator,
 * keep the survivors, repeat. We ship the harness; consumers supply the
 * mutation strategies and the failure detector.
 *
 * Why ship this in agent-eval and not as a separate red-team tool: every
 * piece of the standard adversarial loop is already in this package
 * (`runEvalCampaign` for the matrix run, `RawProviderSink` for capture,
 * `assertRunCaptured` for integrity, `pairedEvalueSequence` for stop
 * criteria). The adversarial primitive is just the *scenario-mutation
 * meta-loop* on top of that machinery.
 */

export interface AdversarialScenario<S> {
  /** Stable id — used for deduplication and lineage tracking. */
  id: string
  /** Generation index — 0 for seeds, 1 for first round of mutations, etc. */
  generation: number
  /** Lineage — id of the parent scenario this was mutated from, if any. */
  parentId: string | null
  scenario: S
  /** Score on the policy under test. Lower = adversarial signal. */
  score: number | null
  /** Strategy that produced this mutation, for diagnostics. */
  mutationStrategy: string | null
}

export interface AdversarialMutation<S> {
  id: string
  /**
   * Mutate one scenario. Return null to skip; return one or more new
   * scenarios. The harness deduplicates by `mutateScenarioId(scenario)`.
   */
  mutate(parent: S, rng: () => number): Promise<S[]> | S[]
}

export interface AdversarialSearchOptions<S> {
  /** Initial scenarios — typically those the policy currently passes. */
  seeds: S[]
  /** Stable identifier extraction. */
  mutateScenarioId: (s: S) => string
  /** Mutation strategies. */
  mutations: AdversarialMutation<S>[]
  /**
   * Run the policy under test against one scenario, return a scalar score
   * in [0, 1]. Lower = adversarial signal.
   */
  scoreFn: (s: S) => Promise<number>
  /**
   * Threshold below which a scenario counts as a "failure" worth keeping.
   * Default 0.5.
   */
  failureThreshold?: number
  /** Number of mutation rounds. Default 3. */
  rounds?: number
  /** Children per parent per round. Default 4. */
  childrenPerParent?: number
  /** Maximum total scenarios examined. Default Infinity. */
  budget?: number
  /** Seed for the deterministic RNG. Default 1. */
  seed?: number
}

export interface AdversarialSearchReport<S> {
  scenarios: AdversarialScenario<S>[]
  /** Discovered failures sorted by score ascending. */
  failures: AdversarialScenario<S>[]
  /** Round-by-round counts. */
  byGeneration: Array<{ generation: number; total: number; failures: number; meanScore: number }>
  /** Total scoreFn invocations consumed. */
  scoreCalls: number
}

export async function adversarialScenarioSearch<S>(
  opts: AdversarialSearchOptions<S>,
): Promise<AdversarialSearchReport<S>> {
  const failureThreshold = opts.failureThreshold ?? 0.5
  const rounds = opts.rounds ?? 3
  const children = opts.childrenPerParent ?? 4
  const budget = opts.budget ?? Number.POSITIVE_INFINITY
  const seed = opts.seed ?? 1
  const rng = mulberry32(seed)

  const scenarios: AdversarialScenario<S>[] = []
  const seen = new Set<string>()
  let scoreCalls = 0

  // Seed generation.
  for (const s of opts.seeds) {
    const id = opts.mutateScenarioId(s)
    if (seen.has(id)) continue
    seen.add(id)
    if (scoreCalls >= budget) break
    const score = await opts.scoreFn(s)
    scoreCalls++
    scenarios.push({
      id, generation: 0, parentId: null, scenario: s,
      score, mutationStrategy: null,
    })
  }

  // Mutation rounds.
  for (let g = 1; g <= rounds; g++) {
    if (scoreCalls >= budget) break
    const parents = scenarios.filter((s) => s.generation === g - 1)
    for (const parent of parents) {
      for (const mutation of opts.mutations) {
        if (scoreCalls >= budget) break
        const produced = await mutation.mutate(parent.scenario, rng)
        const childArr = Array.isArray(produced) ? produced : [produced]
        for (let k = 0; k < Math.min(children, childArr.length); k++) {
          if (scoreCalls >= budget) break
          const child = childArr[k]!
          const cid = opts.mutateScenarioId(child)
          if (seen.has(cid)) continue
          seen.add(cid)
          const cscore = await opts.scoreFn(child)
          scoreCalls++
          scenarios.push({
            id: cid, generation: g, parentId: parent.id,
            scenario: child, score: cscore, mutationStrategy: mutation.id,
          })
        }
      }
    }
  }

  const failures = scenarios
    .filter((s) => s.score !== null && s.score < failureThreshold)
    .sort((a, b) => (a.score ?? 0) - (b.score ?? 0))

  const byGeneration: AdversarialSearchReport<S>['byGeneration'] = []
  const maxGen = scenarios.reduce((m, s) => Math.max(m, s.generation), 0)
  for (let g = 0; g <= maxGen; g++) {
    const gens = scenarios.filter((s) => s.generation === g)
    if (gens.length === 0) continue
    const fails = gens.filter((s) => s.score !== null && s.score < failureThreshold).length
    const meanScore = gens.reduce((sum, s) => sum + (s.score ?? 0), 0) / gens.length
    byGeneration.push({ generation: g, total: gens.length, failures: fails, meanScore })
  }

  return { scenarios, failures, byGeneration, scoreCalls }
}

// ── Helpers ──────────────────────────────────────────────────────────────

function mulberry32(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6D2B79F5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
