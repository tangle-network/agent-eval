# The product self-improvement loop — the finish-line target

This is the **end state** every Tangle product agent (gtm, legal, tax, creative,
agent-builder, blueprint, physim) converges to. It is the target the consumer
migrations build toward — not a 1:1 port of whatever eval/improvement code a
product has today.

**Thesis.** A product agent is *one closed, automated self-improvement loop*
that makes the agent measurably better over time while humans only approve
PRs. A product should NOT have a "production loop" *and* a pile of `eval/*`
CLIs *and* bespoke optimization orchestration. It has **one** loop, composed
from the substrate. Everything else is deleted.

Primitives reference: [`../eval-surface-map.md`](../eval-surface-map.md).
Engine internals: [`self-improvement-engine.md`](./self-improvement-engine.md).

---

## The loop (7 steps, exact substrate composition)

```
1. SAMPLE the eval matrix
   scenarios = cartesian(
     profileVariants,        // the surface(s) under test: baseline + candidates
     productScenarios,       // the hard product tasks (gtm: attribution honesty, …)
     personas,               // simulated users / drivers
   )  ∪  productionFailures  // real failures pulled from the LabeledScenarioStore
                             // (the flywheel: prod traces become eval scenarios)

2. MEASURE — runCampaign
   dispatch(scenario) = runMultishot({           // the multi-turn challenging flow
     persona: scenario.persona,                  //   driver = simulated user
     profile: productAgentProfile(surface),      //   worker = the agent under test
     shape:   scenario.flow,                     //   the real task, many turns
     tools:   productTools,                      //   real tools, real side-effects
   }) → transcript artifact
   judges = product ensemble (domain dimensions) → scorecard + bootstrap CIs
   labeledStore: capture EVERY cell (scenario, artifact, score, source) → the dataset

3. ANALYZE — trace analysts (runAnalystLoop / AnalystRegistry)
   read the campaign traces → a research report (failure modes, why, where).
   This REPLACES bespoke "failure clustering": the analyst is the richer,
   LLM-driven version of "what should we improve and why".

4. IMPROVE — runImprovementLoop( proposer = improvementDriver + agenticGenerator )
   proposer.propose({ report, dataset, … }) → candidate surfaces.
   The agentic generator runs a coding harness in a worktree, reading the
   report + the codebase, making REAL product changes — prompt, tools, AND
   code — not just an addendum string. Each candidate is measured on a
   HELD-OUT slice of the matrix.

5. GATE — defaultProductionGate (+ domain gates, composed)
   heldout-delta + budget + red-team + reward-hacking + canary, plus any
   product-specific gate (e.g. anti-fabrication) and an overfit-gap check.
   Verdict ∈ ship | hold | need_more_work | model_ceiling | arch_ceiling.

6. PROMOTE — openAutoPr
   the winning worktree → a PR against the product repo. Human approves → ships.
   (autoOnPromote: 'pr'. Live self-mutation is deferred behind the full safety
   stack.)

7. LOOP
   the shipped, improved agent runs in production → emits traces → the dataset
   grows → back to (1). The loop is scheduled (cron) and/or triggered when the
   analyst report crosses a severity threshold. Autonomous between PR approvals.
```

**One entry point, no new abstractions.** A product exposes a single
`run<Product>ImprovementCycle()` that *composes* the substrate primitives
above. It does NOT define `runFooPromptEvolution`, `FooOptimizer`,
`FooProductionLoop`, etc. The substrate carries every name; the product only
wires its domain pieces into the seams.

---

## What each product OWNS vs DELETES vs COMPOSES

**OWNS (domain — stays, this is the product's value):**
- `productScenarios` — the hard tasks the agent must handle.
- `personas` — the simulated users that drive the multi-shot flows.
- `judges` / rubrics / dimension weights — how "good" is defined.
- `productTools` — the real tools the agent uses.
- deterministic checks (anti-slop, format, forbidden-claim) — fast pre-judges.
- domain gates (e.g. anti-fabrication) — composed into the gate.

**DELETES (orchestration the substrate now owns):**
- every `for (gen of generations)` mutate→score→select loop.
- bespoke prompt-evolution / production-loop / analyst-loop wrappers.
- trial-matrix construction, frontier tracking, seed plumbing, manifest
  hashing, cell caching, scorecard aggregation, CI math.
- PR-opening scaffolding, worktree git plumbing.
- parallel `eval/*` CLIs that each re-implement a slice of the above.

**COMPOSES (the substrate, in the one cycle):**
- `runCampaign` (matrix measurement) · `runMultishot` (the dispatch flow) ·
  `FsLabeledScenarioStore` (dataset) · analysts (report) ·
  `runImprovementLoop` + `improvementDriver` + `agenticGenerator` (improve) ·
  `defaultProductionGate` + `composeGate` (gate) · `openAutoPr` (promote).

---

## Definition of done (a product is "at the finish line" when)

1. **One cycle, one entry.** A single `run<Product>ImprovementCycle()` composes
   the substrate; the old eval/improvement systems are deleted, not coexisting.
2. **Matrix eval is real.** `dispatch` runs genuine multi-shot persona↔agent
   flows with real tools — not single-turn projections, not stubbed workers
   (non-zero token usage is asserted).
3. **The dataset is fed.** Every cell captures to `LabeledScenarioStore` with
   correct provenance; production failures flow back in as scenarios.
4. **Improvement is code-real.** The agentic generator produces worktree
   changes (prompt/tools/code), measured on holdout — not just addendum-string
   mutation.
5. **The gate is honest.** Composed `defaultProductionGate` + domain gates +
   overfit-gap; fails closed; holdout never overlaps train.
6. **Promotion is a PR.** `openAutoPr` opens it; a human approves; nothing
   auto-deploys.
7. **It's scheduled + triggered.** Runs on cadence and/or when the analyst
   report crosses severity; autonomous between approvals.
8. **Tests + a real proof run.** Contract tests assert the wiring; one real
   end-to-end cycle produces a scorecard and (on a shipping gate) a PR.

Anything short of this is mid-migration, not done.

---

## gtm-agent — the worked instantiation (first reference build)

| Loop step | gtm wiring |
|---|---|
| SAMPLE | profile variants of `OPERATOR_CEO_SYSTEM_PROMPT` + addendum; `GTM_LOOP_HOLDOUT_SCENARIOS` + `eval/business-owner/personas.json`; production failures from the trace store |
| MEASURE | `dispatch` = `runMultishot(persona ↔ gtm-agent via runChatThroughRuntime, real tools)`; judges = the 3-model ensemble (`attribution_honesty`, `proposal_grounding`) + canonical 12-dim |
| ANALYZE | trace analysts over the campaign traces → report (supersedes `FailureClusterConfig` clustering) |
| IMPROVE | `improvementDriver` + `agenticGenerator` (claude harness) edits prompt/tools/code in a worktree, fed the report |
| GATE | `composeGate(defaultProductionGate, antiFabricationGate, overfitGapGate)` |
| PROMOTE | `openAutoPr` → PR against `tangle-network/gtm-agent` |

**Deleted:** `eval/run-prompt-evolution.ts`, `eval/analyst-loop.ts`,
`eval/optimization-campaign.ts`, `scripts/evals/*`, the orchestration body of
`production-loop/index.ts` and `eval/canonical.ts`.
**Kept:** scenarios, personas, judges, tools, deterministic checks, the
`composeProductionLoopSystemPrompt` wiring.
**Result:** one `runGtmImprovementCycle()`; ~3–4k LOC of scattered orchestration
gone, replaced by a substrate composition.

This gtm build is the reference the other six products copy.
