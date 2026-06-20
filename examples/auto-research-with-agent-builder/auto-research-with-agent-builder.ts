/**
 * Auto-research loop driving agent-builder.
 *
 * Runnable demo: see README.md alongside this file for the architectural
 * picture. This file is the runnable prototype.
 *
 * What it shows:
 *   - Multiple iterations of "build a candidate agent → score it →
 *     extract preferences → propose the next variant → repeat"
 *   - Each iteration is a `runEvalCampaign` over a fresh prompt variant
 *   - Across iterations we run `analyzeOptimizationResult` to extract
 *     RL bridge artifacts (preferences, verifiable rewards, hacking
 *     diagnosis, sequential interim verdict)
 *   - The mutation step uses `reflective-mutation` against top/bottom trials
 *
 * To run against real agent-builder, replace `syntheticForgeRunner` with
 * `runForgeBuilderSim` from `@tangle-network/agent-builder`. See README.
 */

import {
  type AdapterContext,
  analyzeOptimizationResult,
  type CampaignRunner,
  runEvalCampaign,
} from '../../src'
import type {
  GenerationReport,
  PromptEvolutionResult,
  TrialResult,
} from '../../src/prompt-evolution'
import { InMemoryRawProviderSink } from '../../src/trace/raw-provider-sink'
import { InMemoryTraceStore } from '../../src/trace/store'

// ── 1. Domain types ──────────────────────────────────────────────────────

interface ForgeVariant {
  variantId: string
  systemPrompt: string
  personaId: string
}

interface BuildScore {
  /** verifier blended score 0..1 */
  score: number
  /** tool invocations recovered from transcript — proxy for tool-recovery quality */
  toolRecovery: number
  /** knowledge gaps detected — proxy for readiness */
  readinessGaps: number
}

// ── 2. Synthetic agent-builder runner (real one drops in here) ───────────

/**
 * Synthetic stand-in for agent-builder's `runForgeBuilderSim`. Returns a
 * deterministic score that improves with prompt edits — useful for the
 * demo without requiring credentials or a live model.
 *
 * The real signature returns `ForgeBuilderSimReport`; we collapse it to
 * the three numeric signals the example needs.
 */
async function syntheticForgeRunner(
  variant: ForgeVariant,
  scenarioId: string,
  seed: number,
): Promise<BuildScore> {
  // Score is a function of (variant prompt length proxy + scenario seed +
  // a "specificity" signal that improves when the prompt mentions tools).
  const lengthSignal = Math.min(1, variant.systemPrompt.length / 200)
  const toolMention = variant.systemPrompt.toLowerCase().includes('tool') ? 0.15 : 0
  const personaHit = variant.personaId === scenarioId.split('-')[0] ? 0.1 : 0
  const noise = ((seed * 17 + scenarioId.length * 31) % 23) / 100
  const score = Math.min(1, 0.45 + lengthSignal * 0.25 + toolMention + personaHit + noise)
  return {
    score,
    toolRecovery: toolMention > 0 ? 0.85 : 0.45,
    readinessGaps: Math.max(0, 3 - Math.floor(lengthSignal * 5)),
  }
}

// ── 3. Build the campaign runner that wraps the forge runner ─────────────

function makeCampaignRunner(
  forgeRunner: typeof syntheticForgeRunner,
): CampaignRunner<ForgeVariant> {
  return async (ctx) => {
    await ctx.emitter.startRun({ scenarioId: ctx.scenarioId, layer: 'app-runtime' })
    const handle = await ctx.emitter.llm({
      name: 'forge-build',
      model: 'claude-sonnet-4-6@2025-04-15',
      messages: [{ role: 'user', content: ctx.variant.systemPrompt }],
      output: '<scaffolded agent>',
    })
    // Drop a synthetic raw event so capture integrity is satisfied.
    await ctx.rawSink.record({
      eventId: `evt-${ctx.runId}`,
      runId: ctx.runId,
      spanId: handle.span.spanId,
      provider: 'tangle-router',
      model: 'claude-sonnet-4-6@2025-04-15',
      endpoint: '/chat/completions',
      baseUrl: ctx.llmOpts.baseUrl ?? '',
      attemptIndex: 0,
      direction: 'request',
      timestamp: 1_000,
      redactedFields: [],
    })
    await handle.end()

    const buildScore = await forgeRunner(ctx.variant, ctx.scenarioId, ctx.seed)
    await ctx.emitter.endRun({ pass: buildScore.score >= 0.6, score: buildScore.score })

    return {
      pass: buildScore.score >= 0.6,
      score: buildScore.score,
      costUsd: 0.05,
      tokenUsage: { input: 200, output: 400 },
      model: 'claude-sonnet-4-6@2025-04-15',
      promptHash: hashish(ctx.variant.systemPrompt),
      configHash: hashish(JSON.stringify({ persona: ctx.variant.personaId })),
      raw: {
        tool_recovery: buildScore.toolRecovery,
        readiness_gaps: buildScore.readinessGaps,
      },
    }
  }
}

// ── 4. The auto-research loop ────────────────────────────────────────────

interface IterationReport {
  iteration: number
  variants: ForgeVariant[]
  bestVariantId: string
  bestScore: number
  preferencePairs: number
  rewardHackingVerdict: 'clean' | 'suspect' | 'gaming'
  sequentialDecision: string
  rationale: string
}

async function runAutoResearchLoop(opts: {
  initialVariants: ForgeVariant[]
  scenarios: string[]
  iterations: number
  seedsPerIteration: number[]
  forgeRunner?: typeof syntheticForgeRunner
}): Promise<IterationReport[]> {
  const reports: IterationReport[] = []
  let variants = opts.initialVariants
  const adapterCtx: AdapterContext = {
    experimentId: 'auto-research-demo',
    model: 'claude-sonnet-4-6@2025-04-15',
    commitSha: `demo-${Date.now().toString(16)}`,
    promptHash: 'p'.repeat(64),
    configHash: 'c'.repeat(64),
  }

  for (let iter = 0; iter < opts.iterations; iter++) {
    // (a) Run the campaign over the current variant set.
    const campaign = await runEvalCampaign({
      campaignId: `auto-research-iter-${iter}`,
      commitSha: adapterCtx.commitSha,
      variants: variants.map((v) => ({ id: v.variantId, payload: v })),
      scenarios: opts.scenarios.map((s) => ({ scenarioId: s })),
      seeds: opts.seedsPerIteration,
      llmOpts: { baseUrl: 'https://api.test/v1', apiKey: 'sk-test' },
      storeFactory: () => new InMemoryTraceStore(),
      rawSinkFactory: () => new InMemoryRawProviderSink(),
      runner: makeCampaignRunner(opts.forgeRunner ?? syntheticForgeRunner),
      report: { comparator: variants[0]!.variantId },
    })

    // (b) Synthesize a PromptEvolutionResult shape so we can run the RL bridge.
    //     The campaign result IS the per-iteration optimization output for our purposes.
    const trials: TrialResult[] = campaign.runs.map((r) => ({
      variantId: r.candidateId,
      scenarioId: r.scenarioId ?? r.experimentId,
      rep: r.seed,
      ok: !r.failureMode,
      score: r.outcome.holdoutScore ?? r.outcome.searchScore ?? 0,
      cost: r.costUsd,
      durationMs: r.wallMs,
      metrics: { ...r.outcome.raw } as Record<string, number>,
    }))
    const generation: GenerationReport = {
      runId: `gen-${iter}`,
      generation: iter,
      populationSize: variants.length,
      trials,
      aggregates: [],
      pareto: { rank0: [], all: [] },
      bestVariantId: variants[0]!.variantId,
      bestScore: 0,
    } as unknown as GenerationReport
    const synthetic: PromptEvolutionResult = {
      runId: `auto-research-${iter}`,
      target: 'forge-prompt',
      generations: [generation],
      bestVariantId: variants[0]!.variantId,
      bestScore: Math.max(...trials.map((t) => t.score)),
      converged: false,
      durationMs: 0,
    } as unknown as PromptEvolutionResult

    const analysis = await analyzeOptimizationResult({
      result: synthetic,
      ctx: adapterCtx,
      comparator: variants[0]!.variantId,
    })

    // (c) Pick the best variant from this iteration's runs.
    const meanByVariant = new Map<string, number[]>()
    for (const r of campaign.runs) {
      const arr = meanByVariant.get(r.candidateId) ?? []
      arr.push(r.outcome.holdoutScore ?? 0)
      meanByVariant.set(r.candidateId, arr)
    }
    const candMeans = [...meanByVariant.entries()].map(([variantId, scores]) => ({
      variantId,
      mean: scores.reduce((s, v) => s + v, 0) / scores.length,
    }))
    candMeans.sort((a, b) => b.mean - a.mean)
    const best = candMeans[0]!
    const bestVariant = variants.find((v) => v.variantId === best.variantId)!

    reports.push({
      iteration: iter,
      variants,
      bestVariantId: best.variantId,
      bestScore: best.mean,
      preferencePairs: analysis.preferences.pairs.length,
      rewardHackingVerdict: analysis.rewardHacking.verdict,
      sequentialDecision: analysis.interimConfidence?.recommendation.decision ?? 'no-comparator',
      rationale: analysis.summary,
    })

    // (d) Mutate: propose new variants from the best one. In production
    // this would call into reflective-mutation with the top/bottom trials;
    // here we apply a deterministic "edit" for the demo.
    if (iter < opts.iterations - 1) {
      variants = proposeNextVariants(bestVariant, variants, iter + 1)
    }
  }

  return reports
}

function proposeNextVariants(
  champion: ForgeVariant,
  _prior: ForgeVariant[],
  generation: number,
): ForgeVariant[] {
  // Deterministic "mutator" for the demo. In production:
  //   - top/bottom trial picks → reflective-mutation prompt → child variants
  //   - or createSandboxCodeMutator over a code surface
  const nextEdit = (() => {
    if (!champion.systemPrompt.toLowerCase().includes('tool')) {
      return `${champion.systemPrompt} You have access to file_read, file_write, and shell tools — use them whenever inspecting or modifying the workspace.`
    }
    return `${champion.systemPrompt} Always pre-flight-check the workspace state before issuing destructive operations.`
  })()

  return [
    champion, // keep the best as a baseline
    {
      variantId: `cand-gen${generation}`,
      personaId: champion.personaId,
      systemPrompt: nextEdit,
    },
    {
      variantId: `cand-gen${generation}-aggressive`,
      personaId: champion.personaId,
      systemPrompt: `${champion.systemPrompt} When in doubt, ask the user a clarifying question rather than guessing.`,
    },
  ]
}

function hashish(s: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0
  return h.toString(16).padStart(8, '0').repeat(8)
}

// ── 5. Demo entry point ──────────────────────────────────────────────────

if (import.meta.url === `file://${process.argv[1]}`) {
  void main()
}

async function main(): Promise<void> {
  console.log('Running auto-research loop driving (synthetic) agent-builder...\n')
  const reports = await runAutoResearchLoop({
    initialVariants: [
      {
        variantId: 'baseline',
        personaId: 'brand',
        systemPrompt: 'You are a helpful assistant. Build the agent the user asked for.',
      },
      {
        variantId: 'cand-init',
        personaId: 'brand',
        systemPrompt:
          'You are an agent builder. Carefully analyze the user request, plan the agent, and produce a working configuration.',
      },
    ],
    scenarios: ['brand-marketer-1', 'brand-marketer-2', 'brand-marketer-3', 'dev-1', 'dev-2'],
    iterations: 4,
    seedsPerIteration: [0, 1, 2],
  })

  console.log('Iteration report:\n')
  for (const r of reports) {
    console.log(
      `  iter ${r.iteration} | best=${r.bestVariantId} | score=${r.bestScore.toFixed(3)} | ` +
        `prefs=${r.preferencePairs} | hacking=${r.rewardHackingVerdict} | seq=${r.sequentialDecision}`,
    )
    console.log(`    ${r.rationale}\n`)
  }
  const first = reports[0]!
  const last = reports[reports.length - 1]!
  console.log(
    `Score progression: ${first.bestScore.toFixed(3)} → ${last.bestScore.toFixed(3)} ` +
      `(Δ ${(last.bestScore - first.bestScore).toFixed(3)} over ${reports.length} iterations)`,
  )
}

export type { BuildScore, ForgeVariant, IterationReport }
export { runAutoResearchLoop, syntheticForgeRunner }
