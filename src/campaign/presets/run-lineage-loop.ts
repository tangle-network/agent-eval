/**
 * `runLineageLoop` — the live adapter that wires the {@link runLineage} DAG's
 * two abstract seams (`step`, `merge`) to the REAL improvement machinery, so the
 * multi-track, multi-parent improvement DAG can run against a real proposer +
 * real measurement.
 *
 * INTEGRATION CHOICE (smallest correct integration):
 *   - `step`  = ONE `SurfaceProposer.propose` from the track tip (a single GEPA
 *               reflective generation, small population) + one scoring campaign
 *               per candidate. The best-scoring candidate (elitist: the tip is
 *               kept in the pool so a step never regresses below its parent)
 *               becomes the new DAG node.
 *   - `merge` = the SAME proposer driven with `ctx.paretoParents` set to the
 *               2+ parent surfaces, which fires `gepaProposer`'s GEPA
 *               combine-complementary-lessons CROSSOVER, then one scoring
 *               campaign on the merged surface.
 *
 * We deliberately do NOT run a full {@link runImprovementLoop} (baseline
 * campaign + optimization + two holdout campaigns + gate + optional PR) per DAG
 * step — that is the OUTER gated-promotion shell for a single lineage, far too
 * heavy to fire once per node. The DAG {@link Governor} controls BREADTH across
 * steps (extend / branch / merge / prune); the inner step is intentionally one
 * small generation. This mirrors the task's guidance: "Keep the improvement
 * budget per step SMALL (1 generation, small population)."
 *
 * Both machinery halves are injectable seams so the loop is unit-testable
 * without a live model or a sandbox:
 *   - `proposer`     — defaults to {@link gepaProposer} (needs `llm` + `model`).
 *                      A test injects a pure stub `SurfaceProposer`.
 *   - `scoreSurface` — defaults to a {@link runCampaign} pass over
 *                      `holdoutScenarios ?? scenarios` (the "agent" =
 *                      `dispatchWithSurface`, the judges = `judges`). A test
 *                      injects a deterministic function of the surface string,
 *                      or supplies a stub `dispatchWithSurface` + `judges` and
 *                      exercises the real `runCampaign` path.
 *
 * Additive: no changes to `lineage.ts`, `run-optimization.ts`, or `gepa.ts`.
 */

import type { LlmClientOptions } from '../../llm-client'
import {
  type Governor,
  heuristicGovernor,
  type Lineage,
  type LineageNode,
  type LineageStore,
  type RunLineageSeed,
  runLineage,
} from '../lineage'
import { gepaProposer } from '../proposers/gepa'
import { type RunCampaignOptions, runCampaign } from '../run-campaign'
import { campaignBreakdown, campaignMeanComposite } from '../score-utils'
import type { CampaignStorage } from '../storage'
import { surfaceHash } from '../surface-identity'
import {
  isProposedCandidate,
  type JudgeConfig,
  type MutableSurface,
  type ParetoParent,
  type ProposedCandidate,
  type Scenario,
  type SurfaceProposer,
} from '../types'

/** A seed track: the initial surface + track identity. Unlike
 *  {@link RunLineageSeed} there is NO `score` — `runLineageLoop` scores each
 *  seed surface in an initial pass so seed fitness is measured, not asserted. */
export interface RunLineageLoopSeed {
  surface: MutableSurface
  track: string
  /** Human label for the strategy driving this track (e.g. `solve`,
   *  `outside-the-box`, `contrarian`). */
  vision?: string
  /** Proposer label recorded on the seed node (e.g. `gepa`, `seed`). */
  proposer: string
}

/** The measured fitness of one surface — the value recorded on a DAG node. */
export interface SurfaceScore {
  score: number
  /** Per-objective vector (per-scenario composite) for Pareto dominance across
   *  track tips. Omitted ⇒ the DAG uses the scalar `score`. */
  scoreVector?: number[]
}

export interface RunLineageLoopOptions<TScenario extends Scenario, TArtifact> {
  /** The visioned tracks to seed the DAG with. Each is scored once up front. */
  seeds: RunLineageLoopSeed[]

  // ── Scoring machinery (default `scoreSurface` = a runCampaign pass) ────────
  /** Scenarios the candidate surfaces are proposed against + scored on. */
  scenarios: TScenario[]
  /** Held-out scenarios used to SCORE each DAG node's fitness. Defaults to
   *  `scenarios` when omitted. Scored the same way for seeds, steps, and merges
   *  so every node's `score` is comparable. */
  holdoutScenarios?: TScenario[]
  /** Judges for the scoring campaign. */
  judges?: JudgeConfig<TArtifact, TScenario>[]
  /** The "agent" seam: run the CURRENT surface on a scenario → artifact. Same
   *  shape as `runOptimization`'s `dispatchWithSurface`. Required UNLESS a
   *  custom `scoreSurface` is injected. */
  dispatchWithSurface?: (
    surface: MutableSurface,
    scenario: TScenario,
    ctx: Parameters<RunCampaignOptions<TScenario, TArtifact>['dispatch']>[1],
  ) => Promise<TArtifact>
  /** Where scoring campaigns write. Required UNLESS `scoreSurface` is injected. */
  runDir?: string

  // ── Proposer machinery (default = gepaProposer) ───────────────────────────
  /** Router transport for the default `gepaProposer`. Required UNLESS a custom
   *  `proposer` is injected. */
  llm?: LlmClientOptions
  /** Model for the default `gepaProposer`. Required UNLESS a custom `proposer`
   *  is injected. */
  model?: string
  /** What is being optimized — appears in the GEPA reflection/combine prompts.
   *  Default `'agent surface'`. */
  target?: string
  /** Candidates proposed per extend/branch step (BREADTH within one step).
   *  Default 4. The merge always proposes a single crossover. */
  populationSize?: number

  // ── DAG control ───────────────────────────────────────────────────────────
  /** Agent-managed decision layer. Default {@link heuristicGovernor}. */
  governor?: Governor
  budget: { maxSteps: number }
  store?: LineageStore

  // ── Injectable seams (unit-testable without a live model) ─────────────────
  /** Override the per-step proposer. Default {@link gepaProposer}. Inject a
   *  pure stub to unit-test without an LLM. */
  proposer?: SurfaceProposer
  /** Override how a surface is scored into a DAG-node fitness. Default is a
   *  {@link runCampaign} pass over `holdoutScenarios ?? scenarios`. Inject a
   *  deterministic function to unit-test without a campaign. */
  scoreSurface?: (surface: MutableSurface) => Promise<SurfaceScore>

  // ── runCampaign passthroughs (consumed by the default `scoreSurface`) ─────
  seed?: number
  reps?: number
  storage?: CampaignStorage
  tracing?: 'on' | 'off'
  expectUsage?: 'assert' | 'warn' | 'off'
  maxConcurrency?: number
  dispatchTimeoutMs?: number
  /** Test seam — deterministic wall clock forwarded to `runCampaign`. */
  now?: () => Date

  log?: (msg: string, fields?: Record<string, unknown>) => void
}

export interface RunLineageLoopResult {
  lineage: Lineage
  best: LineageNode | undefined
  steps: number
}

/** Normalize a proposer output (bare surface OR `ProposedCandidate`) to its
 *  surface + optional rationale. */
function toCandidate(p: MutableSurface | ProposedCandidate): {
  surface: MutableSurface
  rationale?: string
} {
  return isProposedCandidate(p)
    ? { surface: p.surface, ...(p.rationale ? { rationale: p.rationale } : {}) }
    : { surface: p }
}

/**
 * Wire the {@link runLineage} DAG's `step`/`merge` seams to a real
 * `SurfaceProposer` + a real scoring campaign and run the multi-track improvement
 * DAG live under a {@link Governor}.
 */
export async function runLineageLoop<TScenario extends Scenario, TArtifact>(
  opts: RunLineageLoopOptions<TScenario, TArtifact>,
): Promise<RunLineageLoopResult> {
  const governor = opts.governor ?? heuristicGovernor()
  const populationSize = opts.populationSize ?? 4
  if (populationSize < 1) {
    throw new Error('runLineageLoop: populationSize must be >= 1')
  }

  // ── Resolve the proposer seam ─────────────────────────────────────────────
  let proposer = opts.proposer
  if (!proposer) {
    if (!opts.llm || !opts.model) {
      throw new Error(
        'runLineageLoop: a proposer is required — either inject `proposer`, or provide `llm` + `model` for the default gepaProposer.',
      )
    }
    proposer = gepaProposer({
      llm: opts.llm,
      model: opts.model,
      target: opts.target ?? 'agent surface',
      // GEPA combine-complementary-lessons is what the `merge` seam relies on.
      combineParents: true,
    })
  }

  // ── Resolve the scoreSurface seam ─────────────────────────────────────────
  const scoringScenarios = opts.holdoutScenarios ?? opts.scenarios
  let scoreSurface = opts.scoreSurface
  if (!scoreSurface) {
    const dispatchWithSurface = opts.dispatchWithSurface
    const runDir = opts.runDir
    if (!dispatchWithSurface || !runDir) {
      throw new Error(
        'runLineageLoop: scoring is required — either inject `scoreSurface`, or provide `dispatchWithSurface` (the agent) + `runDir` for the default runCampaign scorer.',
      )
    }
    if (scoringScenarios.length === 0) {
      throw new Error(
        'runLineageLoop: the default scorer needs at least one scenario (holdoutScenarios ?? scenarios is empty).',
      )
    }
    scoreSurface = async (surface: MutableSurface): Promise<SurfaceScore> => {
      const campaign = await runCampaign<TScenario, TArtifact>({
        scenarios: scoringScenarios,
        dispatch: (scenario, ctx) => dispatchWithSurface(surface, scenario, ctx),
        dispatchRef: `lineage-loop:${surfaceHash(surface)}`,
        runDir: `${runDir}/score/${surfaceHash(surface)}`,
        ...(opts.judges ? { judges: opts.judges } : {}),
        ...(opts.seed !== undefined ? { seed: opts.seed } : {}),
        ...(opts.reps !== undefined ? { reps: opts.reps } : {}),
        ...(opts.storage ? { storage: opts.storage } : {}),
        ...(opts.tracing ? { tracing: opts.tracing } : {}),
        ...(opts.expectUsage ? { expectUsage: opts.expectUsage } : {}),
        ...(opts.maxConcurrency !== undefined ? { maxConcurrency: opts.maxConcurrency } : {}),
        ...(opts.dispatchTimeoutMs !== undefined
          ? { dispatchTimeoutMs: opts.dispatchTimeoutMs }
          : {}),
        ...(opts.now ? { now: opts.now } : {}),
      })
      const score = campaignMeanComposite(campaign)
      // Build the objective vector in a STABLE order (scoringScenarios order) so
      // component i is the same scenario across every scored surface — a
      // prerequisite for the DAG's Pareto dominance across track tips.
      const byId = new Map(
        campaignBreakdown(campaign).scenarios.map((s) => [s.scenarioId, s.composite]),
      )
      const scoreVector = scoringScenarios.map((s) => byId.get(s.id) ?? 0)
      return { score, scoreVector }
    }
  }

  // Build the per-parent objective map GEPA's combine prompt reads: per-scenario
  // composite when a scoreVector is present, else the scalar score. Aligned to
  // `scoringScenarios` order (the same order `scoreSurface` builds the vector in).
  const objectivesOf = (node: LineageNode): Record<string, number> => {
    const objectives: Record<string, number> = {}
    if (node.scoreVector && node.scoreVector.length > 0) {
      scoringScenarios.forEach((s, i) => {
        objectives[s.id] = node.scoreVector![i] ?? 0
      })
      if (Object.keys(objectives).length > 0) return objectives
    }
    objectives.composite = node.score
    return objectives
  }

  // ── (1) Score every seed surface → RunLineageSeed[] ───────────────────────
  const scoredSeeds: RunLineageSeed[] = []
  for (const seed of opts.seeds) {
    const measured = await scoreSurface(seed.surface)
    scoredSeeds.push({
      surface: seed.surface as string,
      track: seed.track,
      proposer: seed.proposer,
      score: measured.score,
      ...(seed.vision !== undefined ? { vision: seed.vision } : {}),
      ...(measured.scoreVector !== undefined ? { scoreVector: measured.scoreVector } : {}),
    })
  }

  // ── (2) The live `step` seam: propose from the tip, score, pick the best ──
  const step = async (args: {
    tip: LineageNode
  }): Promise<SurfaceScore & { surface: string; rationale?: string }> => {
    const proposed = await proposer!.propose({
      currentSurface: args.tip.surface,
      history: [],
      findings: [],
      populationSize,
      generation: 0,
      signal: new AbortController().signal,
      paretoParents: [],
    })

    // Elitism: keep the tip in the pool so a step never regresses below its
    // parent — mirrors runOptimization keeping the winner as the baseline when
    // no candidate beats it. A tie resolves to the earliest pool entry (the tip
    // first, then proposer order) → deterministic.
    type PoolEntry = {
      surface: MutableSurface
      score: number
      scoreVector?: number[]
      rationale?: string
    }
    const pool: PoolEntry[] = [
      {
        surface: args.tip.surface,
        score: args.tip.score,
        ...(args.tip.scoreVector !== undefined ? { scoreVector: args.tip.scoreVector } : {}),
        ...(args.tip.rationale !== undefined ? { rationale: args.tip.rationale } : {}),
      },
    ]
    for (const p of proposed) {
      const { surface, rationale } = toCandidate(p)
      const measured = await scoreSurface!(surface)
      pool.push({
        surface,
        score: measured.score,
        ...(measured.scoreVector !== undefined ? { scoreVector: measured.scoreVector } : {}),
        ...(rationale !== undefined ? { rationale } : {}),
      })
    }

    let best = pool[0]!
    for (const entry of pool) {
      if (entry.score > best.score) best = entry
    }
    return {
      surface: best.surface as string,
      score: best.score,
      ...(best.scoreVector !== undefined ? { scoreVector: best.scoreVector } : {}),
      ...(best.rationale !== undefined ? { rationale: best.rationale } : {}),
    }
  }

  // ── (3) The live `merge` seam: GEPA crossover of the parents, then score ──
  const merge = async (args: {
    parents: LineageNode[]
  }): Promise<SurfaceScore & { surface: string; rationale?: string }> => {
    // Order parents best-first; the strongest surface is the reflection base and
    // GEPA reads each parent's per-scenario objectives to combine strengths.
    const ordered = [...args.parents].sort((a, b) => b.score - a.score)
    const paretoParents: ParetoParent[] = ordered.map((node) => ({
      surface: node.surface,
      surfaceHash: surfaceHash(node.surface),
      objectives: objectivesOf(node),
      composite: node.score,
      generation: node.generation,
    }))

    const proposed = await proposer!.propose({
      currentSurface: ordered[0]!.surface,
      history: [],
      findings: [],
      // A merge is a single crossover; combineParents fires because
      // paretoParents has > 1 string member.
      populationSize: 1,
      // generation >= 1 keeps the combine slot semantically a "merge" step.
      generation: 1,
      signal: new AbortController().signal,
      paretoParents,
    })

    const first = proposed[0]
    // Fall back to the best parent surface if the proposer returned nothing
    // mergeable (a degenerate proposer) — never fabricate a surface.
    const merged = first ? toCandidate(first) : { surface: ordered[0]!.surface as string }
    const measured = await scoreSurface!(merged.surface)
    return {
      surface: merged.surface as string,
      score: measured.score,
      ...(measured.scoreVector !== undefined ? { scoreVector: measured.scoreVector } : {}),
      ...(merged.rationale !== undefined ? { rationale: merged.rationale } : {}),
    }
  }

  // ── (4) Run the DAG under the governor ────────────────────────────────────
  const result = await runLineage({
    seeds: scoredSeeds,
    step,
    merge,
    governor,
    budget: opts.budget,
    ...(opts.store ? { store: opts.store } : {}),
    ...(opts.log ? { log: opts.log } : {}),
  })

  return { lineage: result.lineage, best: result.best, steps: result.steps }
}
