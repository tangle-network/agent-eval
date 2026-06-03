# Auto-research loop end-to-end

This is the runnable composition pattern that closes the loop the package
was originally designed for: capture-integrity → eval → preferences →
mutation → improved candidate → repeat.

There's no new orchestrator primitive that runs this for you (and we
deliberately resisted shipping one — every consumer's loop has different
invariants). What this doc gives you is **the integration recipe**: the
imports, the wiring, and the explicit invariants every iteration must
preserve.

A working version of this recipe lives at
[`examples/auto-research-with-agent-builder/`](../examples/auto-research-with-agent-builder/) —
runnable, ~250 lines, demonstrates the score climbing across iterations.

## The pattern

```ts
import {
  runEvalCampaign,
  analyzeOptimizationResult,
  trialsToRunRecords,
  PredictiveValidityResearcher,
} from '@tangle-network/agent-eval'
import { traceAnalystOnRunComplete } from '@tangle-network/agent-eval/traces'

async function runAutoResearchLoop(opts: {
  task: string
  initialVariants: Variant[]
  scenarios: Scenario[]
  iterations: number
  // The thing that turns a Variant into a scoreable artifact.
  // For agent-builder this is `runForgeBuilderSim`; for tax-agent it's
  // their domain runner; for the multi-shot prompt evolution case it's
  // already wired inside `runPromptEvolution`.
  candidateRunner: CandidateRunner<Variant>
  // The thing that proposes the next variants given the analysis output.
  // For prompt-only optimization, this is `reflective-mutation` against
  // the top/bottom trials. For code+prompt, this is `createCompositeMutator`.
  // For agent-builder, this can be a hand-rolled "edit the system prompt"
  // function — the example shows one.
  mutator: (champion: Variant, analysis: AnalysisReport) => Promise<Variant[]>
  // Optional: outcome store for predictive validity. When present, the
  // loop learns which scoring rubrics actually predict deployment outcomes
  // and reweights the composite score accordingly.
  outcomes?: { store: OutcomeStore; metrics: string[] }
}): Promise<IterationReport[]> {
  const reports: IterationReport[] = []
  let variants = opts.initialVariants

  // (Optional) standing researcher that drives rubric reweighting.
  const researcher = opts.outcomes
    ? new PredictiveValidityResearcher({
        outcomes: opts.outcomes.store,
        outcomeMetrics: opts.outcomes.metrics,
      })
    : null

  for (let iter = 0; iter < opts.iterations; iter++) {
    // 1. Capture-integrity-by-construction matrix run.
    const campaign = await runEvalCampaign({
      campaignId: `auto-research-iter-${iter}`,
      commitSha: opts.task,
      variants: variants.map((v) => ({ id: v.id, payload: v })),
      scenarios: opts.scenarios,
      seeds: [0, 1, 2],
      llmOpts: { ... },
      storeFactory: () => new InMemoryTraceStore(),
      rawSinkFactory: () => new InMemoryRawProviderSink(),
      runner: makeCampaignRunner(opts.candidateRunner),
      onRunComplete: opts.outcomes
        ? [traceAnalystOnRunComplete({ analyze: ..., save: ... })]
        : [],
      report: { comparator: variants[0]!.id },
    })

    // 2. RL-bridge analysis: preferences, verifiable rewards, sequential
    //    interim verdict, reward-hacking diagnosis.
    const analysis = await analyzeOptimizationResult({
      result: pretendItsAPromptEvolution(campaign),
      ctx: { experimentId: 'task', model: '...', commitSha: '...', promptHash: '...', configHash: '...' },
      comparator: variants[0]!.id,
      outcomes: opts.outcomes,
    })

    // 3. Periodic rubric recalibration via predictive validity.
    if (researcher && iter > 0 && iter % 5 === 0) {
      await researcher.runValidityCheck(campaign.runs)
      // The researcher's `proposeChange` output can be folded into the
      // mutator as a steering signal in the next iteration.
    }

    // 4. Pick champion + record this iteration.
    const champion = pickChampion(campaign.runs)
    reports.push({ iter, champion, score: champion.score, analysis })

    // 5. Sequential stop: the anytime-valid e-value can decisively call
    //    'promote_now' or 'reject_now' before iterations exhausted.
    if (analysis.interimConfidence?.recommendation.decision === 'promote_now') {
      break
    }

    // 6. Propose next variants via the mutator.
    if (iter < opts.iterations - 1) {
      variants = await opts.mutator(champion.variant, analysis)
    }
  }

  return reports
}
```

## Invariants every iteration must preserve

1. **The campaign produces RunRecord[] with `scenarioId` populated.** Every
   downstream primitive (preferences, sequential, predictive validity,
   tournament) keys on this. `runEvalCampaign` populates it canonically;
   if you adapt from `runPromptEvolution` use `trialsToRunRecords`.

2. **Capture is wired by construction.** Don't pass `NoopRawProviderSink`
   to `rawSinkFactory` unless the iteration is exploratory. Every
   captured run is replayable, every replayable run is free judge-iteration
   data for the next loop.

3. **`commitSha` is real.** It's how downstream tooling (predictive
   validity, contamination probe, tournament) ties iterations together.

4. **The comparator is stable across iterations.** Either the original
   `baseline` or whichever champion you froze. Shifting the comparator
   between iterations corrupts the paired-delta semantics.

5. **The mutator is deterministic given the analysis output.** Otherwise
   the iteration isn't reproducible and the auto-research artifacts
   become unfalsifiable. If you need stochastic mutation, seed the
   mutator and emit the seed onto the run record.

## When to run each primitive

| Frequency | Primitive | Why |
|---|---|---|
| Every iteration | `runEvalCampaign` | core measurement |
| Every iteration | `analyzeOptimizationResult` | preferences + verifiable rewards + reward-hacking |
| Every iteration | `evaluateInterimReleaseConfidence` (via `analyzeOptimizationResult`) | anytime-valid stop signal |
| Every 5–10 iterations | `rubricPredictiveValidity` | rubric weights drift; recalibrate |
| Every release | `runContaminationProbe` | scenario set freshness |
| Once per task | `runComputeCurve` | cost-quality frontier |
| As-needed | `adversarialScenarioSearch` | discover failure modes the curated set missed |

## When to drop into the smaller primitives

Two cases:

1. **Trajectory-shaped optimization with steering.** Use
   `runImprovementLoop` directly — it already runs the inner
   search-vs-holdout loop. Wrap with `analyzeOptimizationResult` after
   for the RL bridge.

2. **Prompt + code evolution with sandboxed code mutation.** Use
   `runPromptEvolution` + `createCompositeMutator` directly. Same wrap
   pattern.

The auto-research loop above wraps these primitives in a higher-level
loop that runs them across multiple campaigns. They're each one tick of
the bigger loop.

## What this does NOT do

- It doesn't fine-tune model weights. That's the
  [`fine-tune-with-prime-rl`](../examples/fine-tune-with-prime-rl/) example
  — separate concern, separate trainer.
- It doesn't drive a production deployment decision on its own. The
  artifacts feed a launch-review process (humans, the `researchReport`
  output, the `assertReleaseConfidence` gate). Loop ≠ promotion gate.
- It doesn't substitute for a real preregistration trail. The
  `preregistrationHash` field on the report exists so iterations can be
  audited, but the auto-research loop *is* iterative and post-hoc by
  definition. Use the standing `assertReleaseConfidence` gate at the
  release boundary; use the auto-research loop everywhere upstream of it.

## Reading order for the example

1. [`examples/auto-research-with-agent-builder/README.md`](../examples/auto-research-with-agent-builder/README.md) — architectural picture.
2. [`examples/auto-research-with-agent-builder/auto-research-with-agent-builder.ts`](../examples/auto-research-with-agent-builder/auto-research-with-agent-builder.ts) — runnable demo.
3. Run it: `npx tsx examples/auto-research-with-agent-builder/auto-research-with-agent-builder.ts`.
   It prints the iteration progression and the score climbing.
