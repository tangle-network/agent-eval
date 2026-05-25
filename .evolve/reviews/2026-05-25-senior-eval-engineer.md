# Senior Eval Engineer Review — `runCampaign` v1.0

Reviewer lens: shipped Inspect AI / OpenAI Evals / Anthropic Evals-class harnesses. Pattern-matched against SWE-bench, HELM, BIG-Bench, lm-eval-harness, SimpleQA, GAIA.
Doc reviewed: `docs/design/runcampaign-1.0.md` (244 lines, draft v4, 2026-05-25).

## Overall sufficiency for production AI eval work: **5.5/10**

## TL;DR

`runCampaign` is a clean *collapse* of duplicated product wrappers into one substrate primitive, and as an internal API surface refactor it scores 8/10. As a **general-purpose eval harness**, it scores closer to 4/10 — it bundles dispatch, scoring, optimization, gating, tracing, and labeled-store accumulation into one function with no seam to swap parts in/out cleanly, no first-class result schema, no statistical rigor (no CI bounds, no power analysis, no seeded reps), no resumability, no caching, no contamination story, no determinism contract, and a "soft cost-ceiling" that is unsafe to run unattended at scale. The doc reads like an internal consolidation memo, not a v1.0 of an eval framework. **Do not call this v1.0** until items 1–5 in "Top 5 gaps" are addressed; ship it as `runCampaign` 0.1 (consolidation), and design the actual eval-harness contract on top.

---

## Per-question scores + critique

### 1. Does the primitive cover what a serious eval harness needs? — **4/10**

Lines 60–108 define the input. **Nowhere** does the doc define `CampaignResult` (the return type at line 108 is `Promise<CampaignResult<TArtifact, TScenario>>` — never specified). For an eval framework, **the output schema IS the framework**. Inspect AI's `EvalLog`, OpenAI Evals' `final_report` + per-sample records, HELM's `RunSpec`/`ScenarioState`/`Stat` — these schemas are the contract consumers build dashboards, regression checks, and statistical tests against. The doc punts on this entirely.

What's missing from a working eval harness mental model:

- **Per-sample record** (one row per `(scenario, rep, judge)` tuple) with: input, output, judge verdict, latency, tokens-in/out, cost, model id, profile hash, dispatch error, judge error, retries, attempt index, timestamp, run id, parent run id.
- **Aggregate report** with per-judge mean ± CI, per-scenario-tag breakdowns, pass@k where applicable, regression deltas against prior run.
- **Failure taxonomy** (dispatch timeout vs dispatch crash vs judge crash vs cost-cap vs scenario malformed) — they aggregate differently and contaminate metrics differently.
- **Run metadata** (git SHA, env hash, model versions, prompt hash, dataset hash, dataset version, seed). Without this, runs are not reproducible and not comparable. SWE-bench/HELM bake this into the result.

The single-function shape *can* return all of this, but the doc not specifying it means consumers will paper over the gap with bespoke scorecards — exactly the wrapper-drift problem v1.0 claims to solve.

### 2. Is `dispatch: (scenario, ctx) => Promise<artifact>` the right level? — **6/10**

For *agent-eval specifically* (where dispatch IS "run the agent end-to-end and capture the artifact"), `dispatch` at this level is roughly fine — it matches Inspect's `Solver` abstraction (`Solver = (state, generate) => state`) and OpenAI Evals' `eval_sample`. The decision to keep dispatch opaque is defensible.

What's broken (line 65):
- `DispatchContext` is referenced but never defined in the doc. What's in it? Cancellation signal? Cost ledger? Seed? Trace span? Rep index? Run-scoped KV? Without this contract, dispatchers can't safely participate in tracing/cost/retries.
- **No retry contract.** A flaky LLM call deep inside `dispatch` is the dispatcher's problem to handle — but the substrate has no way to distinguish a transient failure (retry) from a permanent failure (record + move on) from a hard fault (abort). Inspect AI has `retry_on` / `fail_on_error`. OpenAI Evals has `record_event` + retry strategies. lm-eval-harness has `--retry`. Here: nothing.
- **No idempotency / caching.** Re-running a campaign with the same scenarios and the same profile **must** be able to skip already-completed cells (resume-from-checkpoint). Inspect AI's `log.json` + `--resume`, BIG-Bench's task caching, HELM's per-instance memoization. With LLM calls at $0.01–$1/call, re-running 1000 scenarios because cell 873 OOM'd is malpractice.
- Conflating dispatch and sandbox-lifecycle: if a dispatcher spawns a Sandbox per scenario (the `legal-agent` / `tax-agent` shape), that sandbox setup/teardown is *not* what should be measured as the cell's latency/cost. The substrate provides no hook to separate "dispatcher wall-clock" from "model wall-clock" from "infra wall-clock".

A real fix: keep `dispatch` opaque but require it to emit structured events through `ctx` (`ctx.recordModelCall`, `ctx.recordToolCall`, `ctx.checkpoint()`, `ctx.shouldAbort()`). Inspect's `TaskState` does this cleanly.

### 3. Is `judges: JudgeConfig[]` with `appliesTo()` scoping right? — **5/10**

The doc *mentions* `JudgeConfig` (lines 71, 227) but never shows its shape and never shows `appliesTo`. From the prompt context I know it exists in 0.38. Assuming the shape is `{ id, judge, weight?, appliesTo? }`:

Strengths:
- Pluggable judge list + per-scenario applicability is the right MVP and matches Inspect's `scorer=[...]` and HELM's `metrics: List[MetricSpec]`.

Gaps (every one is real and known to bite in production):

- **No judge composition / hierarchy.** Real eval suites have *meta-judges* (a "compile-then-judge" short-circuit, an aggregator that combines a panel of judges, a pairwise tournament). HELM's `Metric` is composable; OpenAI Evals supports `ModelGradedComparison` voting; AlpacaEval has judge ensembles. Here: a flat list with no contract for "judge B depends on judge A's verdict" or "if judge X passes, skip judges Y/Z".
- **No judge calibration / IRR story.** Every serious LLM-judge harness needs inter-rater reliability against human labels (Cohen's κ, agreement rate). Where in `runCampaign` does that live? Nowhere — and you already have a `corpus-IRR` workflow in the project memory, which suggests the team knows this and just didn't wire it into the substrate.
- **No judge versioning.** A judge's prompt changes → all historical scores become incomparable. Inspect has `scorer.metadata`; HELM tags `Metric` with version. Here: not addressed.
- **Cost asymmetry not modeled.** A `judges: [cheap-regex, expensive-pairwise, gpt-4o-graded]` list silently 10x's run cost. The substrate should expose `runJudges: 'serial' | 'parallel'` and per-judge budget caps. Not in the design.
- **No "judge-of-judge" / disagreement surfacing.** When two judges of the same artifact disagree, that's a high-signal training datapoint. Substrate doesn't capture this.
- **No rubric versioning at the judge level.** If `gtmConvo` rubric changes between runs, the regression delta is meaningless. The doc relies on the user to know this.

### 4. `optimizer + gate + autoOnPromote` for GEPA — **3/10**

This is the section where the doc is most aspirational and least technical (lines 73–89). Concrete problems:

- **`populationSize: number` + `maxGenerations: number` is not a population search.** It's a grid loop. A real GEPA / EvoPrompt / PromptBreeder / DSPy-MIPRO has: selection pressure (Pareto front vs elitism vs tournament), crossover policy, mutation rate decay, novelty bonus, archive of dominated solutions, early-stopping on plateau, restart-from-random. The doc handwaves this to "mutator". So the "mutator" is the optimizer, and `populationSize/maxGenerations` are just bounds — which means **the substrate is offering nothing for the optimization beyond a for-loop**. That's not v1.0 of an optimizer surface; it's a placeholder.
- **`surfaceExtractor: profile => MutableSurface`** with no `surfaceApplier`. How does the mutated surface get *back into the profile* for the next dispatch? If the answer is "Mutator handles it", then `surfaceExtractor` is unused decoration. If the answer is "the framework re-applies", it's underspecified.
- **No exploration/exploitation knob.** Temperature schedule? Restart probability? Budget allocation across generations (front-load exploration, back-load exploitation)? The substrate doesn't model these, so a serious population search must monkey-patch its own.
- **No fitness aggregation across reps.** If `reps=5` and `populationSize=8`, you have 40 dispatches per generation. How are 5-rep variances rolled up into a fitness score? Median? Mean - std? Pessimistic CVaR? Not specified. This is the *core* of any noisy-fitness optimizer (see Bayesian optimization literature). HELM/DSPy hit this and address it explicitly.
- **`autoOnPromote: 'pr' | 'config' | 'none'`** is mixing eval-harness concerns with deploy-pipeline concerns. A serious eval framework returns *what* should be promoted; it doesn't open PRs. Conflating these means every consumer that doesn't use Tangle's PR/config conventions has to override. (Tangle-internal use case: fine. v1.0 "primitive": wrong.)
- **No multi-objective optimization.** Real prompt evolution optimizes for accuracy *and* cost *and* latency *and* safety. `composeGate` (line 83) hints at this but a gate is a Boolean, not a Pareto front. The optimizer surface needs `objectives: Objective[]` with directions, not just one fitness.

This section needs a real ML-optimization eng to review. Currently reads as "we have a mutator and a gate, ship it".

### 5. `labeledStore` auto-accumulating from traces — **2/10**

This is the **most dangerous** part of the design. Lines 91–95, 163, 188.

> "Every artifact + score lands here, available as default `scenarios` source for the next runCampaign invocation."

That is **train/test contamination by default**, dressed as a feature. Specifically:

- Production traces flow into `labeledStore`. Next eval samples from it. The optimizer's gate then evaluates on… data the optimizer's predecessor already produced. This is the textbook definition of a feedback loop that inflates apparent gains. Goodhart's law, instrumented.
- There's no `holdout: true` flag at the scenario level, no `split: 'train' | 'test' | 'holdout'` discipline visible at the store contract. The example at line 128 (`labeledStore.sample({ count: 30, split: 'train' })`) hints at splits — but where does a scenario get assigned a split? At insertion time? Hashed deterministically? Manually? Drift over time?
- The `HeldOutGate` (referenced in line 132) presumably evaluates against a held-out set, but **the held-out set comes from where**? If from the same labeled store, contamination is one config bug away. The contract should make contamination *impossible by construction*, not "off by best practices".
- PII / privacy: production user data → `.production-data/traces/` → next eval run. Where's the redaction step? Consent? Data residency? GDPR right-to-be-forgotten propagation into already-sampled scenarios?
- No data versioning. If `labeledStore` mutates over time and a campaign sampled `count: 30` from it on Tuesday, you cannot reproduce Tuesday's run on Friday. Inspect AI snapshots the dataset by hash. HELM versions datasets. Here: nothing.
- "Default on" + "off only via 'off'" (line 95) means a naive consumer ships with contamination on. That's the wrong default.

**Recommendation: make `labeledStore` opt-in, not default. Require explicit `split` assignment. Snapshot a scenarios manifest hash into the result. Add PII redaction hook.**

### 6. Cost ceiling as soft-abort — **3/10**

`costCeiling: number` (line 104) with no detail on enforcement semantics. Questions the doc doesn't answer:

- Is it pre-flight (estimate, refuse to start if exceeded) or in-flight (kill mid-run)?
- Is it per-run, per-day, per-tenant?
- Does it abort the optimizer mid-generation (leaving an inconsistent population)?
- Does it count only dispatch cost or also judge cost?
- Is it accurate? Token accounting in agentic loops with sub-agents is notoriously off by 2–10x. The project memory mentions a "NaN→$0 cost-meter pattern" — exactly this hazard.
- What happens to in-flight cells when the ceiling is hit? Cancelled? Counted as failures? Marked `aborted`?

For unattended production cron use, you need **hard guarantees**: pre-flight budget check, per-call cost meter that aborts on first overage, per-tenant rate limiting, and a kill-switch that doesn't leave the system in an inconsistent state. The current design isn't safe to run on a customer's Cloudflare Worker against a customer's API key.

### 7. Tracing on by default at `.production-data/traces/` — **4/10**

Default-on tracing is the right call (line 97). The path and storage shape are wrong:

- **`.production-data/`** is a *runtime artifact directory* in a source repo. That implies these traces are written from inside customer workers/CI/dev machines and then… what? Committed? Gitignored and never seen? Synced where? OTEL export (line 99) is opt-in via env. If env isn't set, the trace is *only* on the box that produced it. For a multi-product, multi-tenant org, that's effectively unobservable.
- **No retention policy.** Inspect AI's `.eval/` directory grows unbounded. HELM rotates. Here: not mentioned.
- **No partitioning by tenant / product / run-id structure shown.** What's the directory layout? `.production-data/traces/{date}/{run-id}/{cell-id}.json`? Not specified.
- **Privacy**: production traces contain user PII. Writing to `.production-data/` on a developer's laptop is a leak vector. Need an opt-in `tracingScope: 'eval-only' | 'prod-redacted' | 'prod-raw'`.
- **Format**: not specified. OTEL spans? JSONL? Inspect's `.eval` zip format? The schema IS the integration surface for every downstream tool (dashboards, replay, debug).
- **No span budget.** A long-horizon multi-session journey can produce 10K+ spans per scenario. At 5K scenarios, that's 50M spans. Filesystem store falls over.

The right shape: pluggable `TraceStore` (already designed), default to an *in-memory* store for local + an OTEL exporter when env is set, never write to the source tree.

### 8. Reps + concurrency — **4/10**

`reps?: number` and `maxConcurrency?: number` (lines 105–106). No mention of:

- **Seeding / determinism.** Each rep needs a deterministic seed for reproducibility. Inspect: `epochs: List[int]` or `seed`. HELM: explicit `RandomSeed`. Without a seed contract, reps are unreproducible noise.
- **Statistical rigor.** What is `reps` for? Bootstrap CI? Pass@k? Variance estimation? With `reps=1` (the default?) you have *zero* signal on variance. The framework should compute CIs, force `reps>=3` for promotion gates, refuse to ship when variance > threshold.
- **Concurrency hazards.** Concurrent dispatch against the same Sandbox / same user account / same rate-limited API. Per-tenant rate limits. Backpressure. None addressed.
- **Stratification.** Sampling K from labeledStore with `reps` — does it stratify by scenario tag, or random? In a 1000-scenario set with 5 tags, simple random sampling gives huge variance in tag coverage.

Compare HELM's `MetricService` + `Stat` aggregation (mean, stddev, min, max, 25/50/75/95 percentiles, sum, count) and Inspect's bootstrap CI per scorer. This design has neither.

### 9. Multi-session sequencer — **5/10**

`sessions: SessionScript[]` (line 67) is a nice idea, especially for tax / legal multi-month flows. But:

- **`SessionScript` shape not defined in the doc.** From the example (lines 151–156) it's `{ id, intent, affectsKnowledge? }`. That's a single LLM turn description, not a session. A real session has: turns, expected branches, environment state mutations (calendar advance, file system state, tool availability), persona internal-state evolution rules, exit conditions.
- **No simulated time.** A multi-month sim needs `clock.advance(days: 7)`; the substrate has no abstraction for this. Real-world long-horizon agent eval (AgentBench, GAIA) bakes in environment state.
- **No persona internal-state evolution contract.** Line 67 mentions `evolveAfterSession` but the shape isn't specified. How does the persona's "frustration level" get persisted between sessions? Where does it live? How does it gate dispatch?
- **No branching.** A real journey has decision points (user accepts / rejects / asks clarifying question). `SessionScript[]` is a linear chain. GAIA / WebArena / SWE-bench-multi handle branching via state-machine task definitions.
- **Single dispatch function across all sessions.** Sometimes session 1 should use the chat profile, session 7 should use the document-revision profile. The single `dispatch` forces all routing inside the dispatcher.

This is the section where the design under-models reality the most. For tax/legal "multi-month user simulation" to actually work, you need a `SessionEnvironment` contract, not just a list of intents.

### 10. What's MISSING — **see "Top 5 gaps" below.**

---

## Top 5 concrete gaps (table stakes missing)

### Gap 1 — No `CampaignResult` schema defined.

The output type is the contract. Without it, every consumer reinvents reporting. Need:

```ts
interface CampaignResult<A, S> {
  runId: string
  startedAt: number; finishedAt: number
  manifest: { gitSha, profileHashes, scenariosHash, judgesHashes, seed }
  cells: CellRecord<A, S>[]              // every (scenario, rep) record, with all errors
  aggregates: {
    perJudge: Record<JudgeId, Stat>      // mean, stddev, CI, count
    perScenarioTag: Record<Tag, Stat>
    perGeneration?: GenerationReport[]   // if optimizer used
    failures: FailureTaxonomy            // dispatch-timeout / dispatch-crash / judge-crash / cost-cap
  }
  cost: { totalUsd, perDispatch, perJudge, perGeneration? }
  artifacts: { tracePath, scorecardPath, htmlReportPath }
  comparison?: { baseline: RunId, deltas: Record<JudgeId, DeltaWithCI> }
}
```

Without this, you can't build dashboards, can't gate CI, can't compare runs. Lift directly from Inspect's `EvalLog`.

### Gap 2 — No resumability / no idempotency / no caching.

Re-running a 5,000-cell campaign because cell 4,873 OOM'd burns $50–$500. Every serious harness has resume:
- Inspect AI: `--resume`, log-based replay.
- BIG-Bench: per-instance JSON cache.
- HELM: `--cache-instances`.
- SWE-bench: per-instance docker layer cache.

Need: deterministic cell id = `hash(scenario, profile, rep, seed)`. Skip on cache hit. Resumable from log. **Must-have for v1.0.**

### Gap 3 — No determinism / seeding contract.

The doc never mentions "seed". Every reasonable harness propagates a seed into dispatch, into the judge, into sampling, into mutation. Without it, **the same campaign run twice gives different scores by 5–20%**, and your optimizer cannot distinguish "real improvement" from "lucky reroll".

This is the single most embarrassing miss for a v1.0 substrate.

### Gap 4 — No statistical layer.

Mean is not a metric. Single-point estimates with no CI are not evidence. Promotion-gate decisions on "mean improved by 3pp" without `n` and variance are unfounded.

Need: per-judge mean ± bootstrap CI; pass@k; per-tag stratification; variance threshold guard ("if stddev > X, refuse to gate"); McNemar's test on paired runs; power analysis ("you need ≥N reps to detect a 3pp delta with 95% confidence given σ").

HELM does this. Inspect does this. lm-eval-harness does this. The team's project memory mentions corpus-IRR; the work exists but isn't surfaced into the substrate.

### Gap 5 — No dataset / scenarios versioning + manifest.

Scenarios sampled from `labeledStore` change over time. Without a manifest hash in the result, you cannot reproduce or compare. Inspect snapshots dataset to log. HELM has explicit `Scenario` SHAs. Here: nothing.

Also missing within this: schema validation of scenarios at intake (Zod), required-fields enforcement, scenario lint (duplicate detection, distributional checks, label leakage detection).

---

## Top 5 things they got right

1. **Collapse 10,500 LOC of wrappers into one primitive.** This is the right instinct. Wrapper proliferation is how every eval framework rots into a maintenance graveyard.
2. **`scenarios + dispatch + judges` is the right MVP triple.** This is exactly Inspect's `Task = dataset + solver + scorer`, OpenAI Evals' `eval = samples + run + grade`. Sound architectural alignment.
3. **Substrate IS the product surface** (lines 178–189). Running the same primitive in CI cron AND in the production worker is correct — and matches the design instinct behind HELM-as-a-service / Inspect-as-a-service. This is genuinely better than what most internal eval frameworks do.
4. **Tracing on by default** (the *intent*, not the current path choice). The shift from "you must explicitly enable tracing" to "tracing is the substrate" is the right call. Eval without traces is theater.
5. **The package boundary** (lines 40–53): agent-eval = primitives, agent-runtime = loops, agent-knowledge = state. That cut is clean and survives the design pressure. It maps directly to: Inspect = primitives, Inspect-as-a-service = loops, eval-set repos = state. Don't change it.

---

## Package boundary review

agent-eval = primitives, agent-runtime = loops, agent-knowledge = state.

**Verdict: correct cut.** But the line is fuzzed by `autoOnPromote: 'pr' | 'config'` (line 89) — that's a *loop* concern (what to do *after* the primitive returns), not a primitive concern. Move `autoOnPromote` out of `runCampaign` and into `runProductionLoop` (in agent-runtime). The primitive should return a `PromoteDecision`; the loop should act on it. This keeps `runCampaign` honest as the "compute eval result" boundary.

Similarly, `optimizer` blurs the line — running N generations is a *loop*. Cleaner split:
- `runCampaign` = one generation (scenarios × dispatch × judges → result).
- `runOptimization` (in agent-runtime) = wraps `runCampaign` in a generational outer loop with mutation + gate.

This makes both functions simpler and more reusable.

---

## Comparison to existing frameworks

| Dimension | Inspect AI | OpenAI Evals | HELM | SWE-bench | lm-eval-harness | **`runCampaign` v1.0** |
|---|---|---|---|---|---|---|
| Result schema defined | EvalLog (Pydantic) | final_report JSON | ScenarioState/Stat | per-instance JSON | task results JSON | **undefined** |
| Per-sample records | yes | yes | yes | yes | yes | implied, not specified |
| Resume / cache | `--resume` | recorder | instance cache | docker cache | partial | **none** |
| Seed contract | yes | yes | yes | n/a | yes | **none** |
| CI / variance | bootstrap | mean+std | full Stat | per-instance | yes | **none** |
| Multi-objective | scorers + weights | metrics | metrics | resolved/applied | metric list | gate only |
| Dataset versioning | hash in log | datasets sdk | RunSpec SHA | git tags | task version | **none** |
| Cost guardrails | n/a (academic) | n/a | n/a | n/a | n/a | soft ceiling |
| Tracing | per-task log | event recorder | per-instance | n/a | per-task | OTEL + FS |
| Optimizer integration | no | no | no | no | no | yes (incomplete) |
| Agent / multi-turn | basic | basic | basic | full | minimal | **sessions[] (under-modeled)** |
| Train/test split | dataset.split | partition_id | scenario split | by design | n/a | **implicit + leaky** |
| Resumability proof | log replay | event log | instance cache | per-instance | partial | **none** |

`runCampaign` is *more ambitious* than any of these on optimizer integration and embedded production-loop. It is *less rigorous* than any of these on result schema, determinism, statistics, and resumability.

The closest analog architecturally is **Inspect AI**. The team should read Inspect's `EvalLog`, `Task`, `Solver`, `Scorer`, and `epochs`/`bootstrap` contracts cover-to-cover before freezing v1.0.

---

## Recommendation: **ship with these changes — do not freeze as v1.0 yet**

This is good consolidation work but it is not a v1.0 of an eval framework. Reframe and ship in two passes:

**Pass A (this 2-week sprint) — ship as `runCampaign` 0.x consolidation. Add:**

1. **Define `CampaignResult` schema explicitly** in the doc, exhaustively, with per-cell records + aggregates + manifest. Adopt Inspect's `EvalLog` shape as the starting point.
2. **Add a seed contract.** `seed: number` in `runCampaign` opts, threaded into dispatch ctx, into judge ctx, into mutation, into sampling. Refuse to run optimizer without a seed.
3. **Add resumability.** Deterministic cell id = `hash(scenarioId, profileHash, rep, seed)`. On startup, scan the trace store for already-completed cell ids and skip. This is ~50 LOC and saves $100K/yr at the team's burn rate.
4. **Make `labeledStore` opt-in, not default.** Require `split` at insertion. Add explicit `holdout` table separate from `train`. Hash a manifest into the result.
5. **Move `autoOnPromote` out of `runCampaign`** into `runProductionLoop`. Cleaner boundary.
6. **Pin down `DispatchContext` and `SessionScript`** in the doc — they're referenced and never defined.
7. **Define `costCeiling` semantics precisely** (pre-flight + in-flight + per-call + behavior-on-exceed). Or remove it from v1.0 and ship as 0.x.

**Pass B (next sprint) — design `runCampaign` 1.0 properly. Add:**

8. Statistical layer: bootstrap CIs, McNemar's, power analysis helper, variance gates.
9. Multi-objective optimizer surface (Pareto, objectives with directions, fitness aggregation across reps).
10. Real `SessionEnvironment` contract for long-horizon agents (clock, environment state, branching).
11. Judge composition (hierarchies, dependencies, voting, IRR-against-human gate).
12. Privacy / redaction hook on trace + labeledStore ingestion.
13. Dataset versioning + lint + schema validation at scenario intake.

The 2-week ship plan (lines 208–220) is realistic for Pass A *if* you cut the optimizer + multi-session features from the v1.0 surface and ship them in Pass B. Trying to ship the full doc in 2 weeks reproduces the wrapper-drift problem at the substrate level — same shape, one layer deeper.

**Two more things to do before freezing:**

- Run the design doc past someone who has shipped an academic eval suite. They will spot the missing seed and missing CI within 60 seconds.
- DIFF this doc against Inspect AI's top-level `task.py` and `log.py`. Adopt their schemas wholesale where they fit. There is zero ROI in inventing a result schema from scratch.

---

## Sign-off on the open questions (lines 237–243)

- **(a) One function with rich options vs 2–3 named presets?** One function is fine *if* `CampaignResult` and seed are defined. The number of names is a non-issue; the schema is the issue.
- **(b) Package boundary?** Right cut. Move `autoOnPromote` and `optimizer` out of the primitive into the loop layer; primitive returns decisions, loop acts.
- **(c) Tracing on by default?** Yes — but not to `.production-data/` in the repo. Default to OS temp dir or platform-appropriate cache dir, ship OTEL adapter. Add redaction hook.
- **(d) 2-week ship realistic?** Yes for Pass A above. No for the doc as written.
