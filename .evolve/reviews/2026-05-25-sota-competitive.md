# runCampaign v1.0 — SOTA Competitive Audit

Reviewer: AI infra eng (LangSmith / Inspect / DSPy / Phoenix / Langfuse / Mastra / Vercel AI SDK familiar)
Date: 2026-05-25
Doc: `docs/design/runcampaign-1.0.md` (244 lines, v4 draft)

---

## Competitive positioning score: **6.5 / 10**

Strong as **internal substrate** for a 5-product agent portfolio (the actual job it's hired for).
Weak as **standalone OSS product**: there's a real seam ("CI loop + live runtime loop run the same primitive against an auto-growing labeled store") that is genuinely uncommon in 2026, but it's buried under a generic-looking `runCampaign(opts)` and reads as "yet another eval harness" on first contact. The novel part is doctrine, not API shape, and doctrine doesn't sell itself.

---

## TL;DR

- **Commodity, well-executed:** scenarios + dispatch + judges + traces + cost ceiling. Every modern framework has these. Doing it in 400 LOC of substrate is impressive but invisible to a chooser.
- **Genuinely differentiated:** (1) the **CI + live-runtime symmetry** (`autoOnPromote: 'pr' | 'config'`) with the same primitive; (2) **multi-session state-carrying user simulation** as a first-class option, not a "build it yourself" pattern; (3) **labeled store auto-populates from production traces** by default — closes the loop nobody else closes by default.
- **Table-stakes gaps:** dataset versioning, online A/B routing, human annotation queue, regression diffing UI, schema-validated judges, structured output / function-call evals, eval-result-as-data (queryable), public benchmark integrations.
- **Adoption risk:** `runCampaign({...11 optional fields...})` is a 30-minute read before a 5-minute demo. Vercel AI SDK and Langfuse get a developer to "first useful signal" in <2 minutes. This design's wedge is invisible until the second week of using it.
- **Recommendation:** keep one primitive internally; ship **three named presets** (`runEval`, `runOptimization`, `runProductionLoop`) as the documented surface. Lead the README with the **closed-loop diagram** (production traces → labeled store → CI mutates profile → PR → ship), not with the API. That diagram is the moat.

---

## Capability comparison matrix

Legend: **F** = first-class / shipped default, **P** = partial / via plugin, **B** = build-it-yourself, **—** = not in scope.

| Capability | runCampaign v1.0 | LangSmith | Inspect AI | OpenAI Evals | DSPy | Mastra | Vercel AI SDK | Pydantic AI | Phoenix | Langfuse |
|---|---|---|---|---|---|---|---|---|---|---|
| **Scenario / dataset abstraction** | F | F | F | F | F (Examples) | F | P | F | F | F |
| **Pluggable LLM-judge** | F | F | F | F | F (Suggest) | F | F | F | F | F |
| **Heuristic / code judges** | F | F | F | F | F | F | F | F | F | F |
| **Tracing on by default** | F | F (SaaS) | F | P | P | F | F (otel) | F | F | F |
| **OTEL export** | F (env-detect) | P | P | — | — | F | F | F | F | F |
| **Cost meter / ceiling** | F | F | P | — | P | F | P | F | F | F |
| **Prompt optimization** | F (GEPA via AxGEPA, reflective) | P (Playground) | — | — | **F (compile)** | P | — | — | — | P |
| **Multi-generation evolutionary loop** | F | — | — | — | P | — | — | — | — | — |
| **Held-out / promotion gate** | F | P | P | P | P | — | — | — | P | P |
| **Open PR on promote (CI)** | F | — | — | — | — | — | — | — | — | — |
| **Mutate live config on promote** | F | — | — | — | — | — | — | — | — | — |
| **Multi-session state-carrying simulation** | **F** | B | B | B | B | B | B | B | B | B |
| **Persona evolution between sessions** | **F** | — | — | — | — | — | — | — | — | — |
| **Auto-growing labeled store from prod traces** | **F** | P (annotation queue) | — | — | — | — | — | — | P | P (dataset from trace) |
| **Single primitive for CI + runtime** | **F** | — | — | — | — | — | — | — | — | — |
| **Hosted UI / dashboard** | — | **F** | P (local) | — | — | P | — | — | **F** | **F** |
| **Human annotation queue** | — | F | P | — | — | — | — | — | F | F |
| **Dataset versioning** | — | F | P | P | P | — | — | — | F | F |
| **Regression diff between runs** | P (scorecard) | F | F | P | — | — | — | — | F | F |
| **Online A/B / shadow routing** | — | P | — | — | — | P | — | — | — | P |
| **Schema-validated structured-output judges** | P | F | F | F | F | F | F (Zod) | **F (Pydantic)** | F | F |
| **Function/tool-call correctness eval** | P | F | F | P | F | F | F | F | F | F |
| **Public benchmark adapters (SWE-bench, MMLU, GAIA)** | — | P | **F** | F | P | — | — | — | P | — |
| **Multi-turn agent loop primitive** | F (runLoop in runtime) | F | F | — | F (ReAct) | F | F | F | F | F |
| **Local-first (no SaaS required)** | F | — (SaaS) | F | F | F | F | F | F | F (self-host) | F (self-host) |
| **Wire protocol / language-agnostic clients** | F (Python client exists) | F | — | F | — | — | — | — | F (otel) | F |

**Reading the matrix:** v1.0 has unique bold cells in **4 rows**: multi-session simulation, persona evolution, auto-growing labeled store from prod by default, and a single primitive for both CI and runtime. Those are the moat. Everything else is parity or below-parity vs. hosted competitors.

---

## What's commodity / what's novel

### Commodity (every competitor has this)

- Scenario + dispatch + judge separation — standard since LangSmith 2023.
- LLM-as-judge with rubric — standard since OpenAI Evals 2023.
- Trace store + OTEL export — Langfuse, Phoenix, Mastra all ship this.
- Cost ceiling — Helicone, Langfuse, Mastra.
- Prompt optimization — DSPy is the canonical reference; AxGEPA is the 2025 follow-on. Wrapping AxGEPA is not novel; **using GEPA as a substrate Mutator inside a generation loop** is at least uncommon.
- `composeGate(heldOut, costBudget)` — pattern exists in every promotion pipeline that hits prod (Anthropic's, OpenAI's internal evals). Naming it "Gate" is fine; the gate itself is commodity.

### Genuinely novel (worth leading with)

1. **The closed loop in one binary.** Production traces feed a labeled store. CI cron OR live worker invokes the same `runCampaign` against that store. Gate decides ship. Either a PR opens (Shape A) or the live config row updates (Shape B). **Nobody else ships both shapes from one primitive.** LangSmith has datasets and evals; the loop closure is a customer integration project, not a default. Langfuse has dataset-from-trace but the optimization loop is BYO. This is the differentiator.
2. **Multi-session, state-carrying user simulation with persona evolution.** `sessions: [{ id: 'intake', affectsKnowledge: true }, { id: 'follow-up', ... }]` + `evolveAfterSession` on the persona. This is the "frustrated user gets more frustrated" pattern. **No other framework ships this as a first-class option.** Inspect AI has multi-turn but stateless across sessions; LangSmith conversation eval is single-thread; Pydantic AI has nothing here. This is **uniquely defensible for products that care about retention / longitudinal UX** (tax across a filing season, legal across a case, creative across a project).
3. **`autoOnPromote: 'config'`.** The live-worker-mutates-its-own-config pattern is genuinely rare outside research demos (Adept's internal stuff, Letta-style memory mutation). Most teams do this manually via a deploy. As a 3-character config option it's a real wedge.
4. **`runLoop` as the per-task kernel reused by product code AND eval dispatchers.** "Give the user 3 drafts, pick the best" and "FanoutVote N candidates in eval" sharing a primitive is structurally clean. Competitors fork those two paths.

### Not novel, but well-executed

- "One primitive, rich options" — the Stripe API model. Works when the options are well-designed; collapses under its own weight if they aren't. (See adoption-friction section.)
- 400 LOC substrate replacing 10,500 LOC of duplicated wrappers — internal engineering win, not a market message.

---

## Table-stakes gaps

These are things a senior dev expects to find in the box in 2026. Their absence will cause "looks half-done" reactions:

| Gap | Why it matters | Lift to fix |
|---|---|---|
| **Dataset versioning** | Eval-result drift can't be attributed if the dataset silently changed. LangSmith, Phoenix, Langfuse, OpenAI Evals all version datasets. `LabeledScenarioStore` snapshots aren't called out as versioned. | Medium — content-hash the scenario set, label runs with the hash. |
| **Regression diff between runs** | "This run vs. the last green run: 3 scenarios regressed, here they are" is the #1 ask of every eval user. Scorecards alone don't surface this; need a `diffRuns(runA, runB)` helper. | Small — implement on top of CampaignResult. |
| **Schema-validated structured-output judges** | Pydantic AI's whole pitch. If the artifact is JSON with a schema, the judge should validate shape before scoring content. | Small — accept a Zod schema in JudgeConfig. |
| **Function/tool-call correctness eval** | Agent evals are >50% about "did it call the right tool with the right args". v1.0 has `dispatch` returning `TArtifact` generically; no first-class tool-trace judge. | Medium — typed tool-call assertions. |
| **Human annotation queue** | Every hosted competitor has one. For OSS this is the "review traces in a UI, mark good/bad, push to dataset" loop. Without it, the labeled store grows from prod auto-labels only, which is noisy. | Large — but a thin "export to JSON, re-import with labels" CLI is 80% of the value. |
| **Public benchmark adapters** | Inspect AI wins this category outright (SWE-bench, GAIA, MMLU, HumanEval all in-box). Without these, every "is this framework serious?" check fails. | Large — but a single SWE-bench adapter as proof-of-substrate is 1 week and gets you the credibility. |
| **Hosted UI (even minimal)** | LangSmith / Langfuse / Phoenix all have one. "Scorecard markdown + JSONL traces" is fine for a 5-person internal team and a deal-breaker for everyone else. | Large — but you don't need to build it if you bet "OTEL → Langfuse/Phoenix render the UI". That bet needs to be explicit in the README. |
| **Online A/B / shadow routing** | Production loop runs offline. Shipping a new profile is all-or-nothing per the `autoOnPromote: 'config'` flow. A 10% canary is what every serious team wants. | Medium — `writeProductionConfig` could take a `{ traffic: 0.1 }` knob. |
| **Eval-result-as-data** | `CampaignResult` is a TS object. SQL/DuckDB query over runs ("show me every scenario that regressed in the last 30 runs") is what teams build dashboards on. | Small — emit a flat results.jsonl per run alongside the scorecard. |
| **Streaming eval** | Doc says deferred. Fine. But "we don't do streaming" needs to be a positioning choice, not a TODO. | — |

**The big four to close before public launch:** dataset versioning, regression diff, schema-validated judges, one public benchmark adapter.

---

## Adoption friction analysis

### "Zero context → self-improving agent" — minute-by-minute

**Vercel AI SDK (current SOTA for zero-friction):**
- Min 0-2: `npm i ai`, `streamText({ model, prompt })`, working chat.
- Min 5-10: Add an eval — `evaluate({ runs: 10, judge: 'gpt-4o' })`. Done.
- Path to "self-improving": doesn't exist as a built-in. Customer integration.

**LangSmith:**
- Min 0-5: API key, `traceable` decorator. Traces flowing.
- Min 5-15: Create dataset from traces in UI. Run eval. See diff.
- Path to "self-improving": prompt playground + manual review + deploy. Mostly manual.

**DSPy:**
- Min 0-10: Write Signature + Module. Define metric.
- Min 10-30: `compile()` with trainset. Optimized prompts.
- Path to "self-improving": re-compile on a cadence. No promotion gate; it's research-grade.

**runCampaign v1.0 (estimated, based on doc):**
- Min 0-15: Read concepts.md + skim runCampaign signature.
- Min 15-30: Wire `dispatch` to your existing chat handler. Define one judge.
- Min 30-45: First `runCampaign` invocation. Scorecard out.
- Min 45-90: Add `optimizer`, `gate`, `autoOnPromote: 'pr'`. CI runs it. Self-improving.
- Path to "self-improving": **shipped as a 4-option config change.** That IS the differentiator if the developer gets that far.

**The friction problem:** developer dropoff is heaviest in min 0-15. v1.0 asks for more upfront reading than Vercel AI SDK or LangSmith. The closed loop is invisible until the developer has already invested an hour.

**Fix:** lead documentation with a **20-line "your agent improves itself overnight"** snippet. Hide the 11-option surface behind preset functions until the developer wants more control.

```ts
// What the README's first code block should look like
import { runProductionLoop } from '@tangle-network/agent-runtime'

runProductionLoop({
  profile: myProfile,
  judges: [myJudge],
  schedule: '0 2 * * *',   // nightly
  autoOnPromote: 'pr',
})
// That's it. Traces → labeled scenarios → nightly optimization → PR when better.
```

The fact that this is `runCampaign` with 6 fields defaulted is an implementation detail. The developer should see `runProductionLoop`.

---

## Single primitive vs N named presets

The doc's open question (a) is the right one. My read:

**Internally, keep the one primitive.** 400 LOC of substrate is the right engineering. Five wrappers per product was the duplication tax.

**Externally, ship named presets as the documented surface.** Three presets cover 95% of adoption:

| Preset | Wraps `runCampaign` with | Mental model |
|---|---|---|
| `runEval` | judges + scenarios + no optimizer | "Score this profile against these scenarios." |
| `runOptimization` | judges + scenarios + optimizer + gate | "Find a better prompt for this profile." |
| `runProductionLoop` | + schedule + autoOnPromote + labeled-store default | "Keep this profile improving in production." |

The fat `runCampaign({ ... })` stays exported for power users and is what the presets call internally. Documentation shows presets first; advanced section shows the underlying primitive.

**Cognitive load math:** developer reading "11 optional fields, semantics depend on which combinations you set" has to hold the matrix in their head. Developer reading "runProductionLoop takes a profile and a judge" has zero matrix to hold. The presets cost ~30 LOC of substrate code and buy a 5-minute onboarding curve instead of a 30-minute one.

The doc claims "no preset proliferation". That's the right value if presets diverge into independent codepaths. It's the wrong value if presets are docs-only thin wrappers — those are FREE.

---

## Pricing / business model implications

Nothing in the doc speaks to monetization. Two readings:

**Reading 1: OSS substrate, no direct monetization.** Then the strategic value is gravitational — make agent-eval the default substrate for Tangle's product portfolio + outside adopters, sell something else (managed runtime, hosted MCP, sandbox compute). This is the LangChain → LangSmith model (give away core, charge for hosted ops). The current design supports this **if** the OSS surface is dead-simple to adopt (see friction analysis above) and the hosted layer (UI / annotation / managed runs) is the upsell.

**Reading 2: Internal-only substrate for the 5-product portfolio.** Then it doesn't matter and the doc is correct as-is. 400 LOC is cheap insurance.

**Tactical recommendation:** **build for OSS adoption even if you don't intend to launch publicly yet.** Every doc tightening that makes external adoption easier also makes the next internal product adoption cheaper. Treating "internal substrate" as a different bar than "public substrate" is how you end up with 10,500 LOC of wrappers — exactly the problem v1.0 solves.

**Wedge if going OSS:** lead with "self-improving" not "evaluation". The eval market is saturated. The "production loop that ships PRs against your agent overnight" framing is unsaturated. The name `runCampaign` says "evaluation campaign" — fine for internal, weak for the wedge.

---

## What would prevent a senior dev from adopting

Concrete dealbreakers, ranked:

1. **"No hosted UI" → bounces to Langfuse / Phoenix.** Mitigation: explicit OTEL → Langfuse story. "Use Langfuse for the UI, agent-eval for the loop" is a real and credible message. Doc this prominently.
2. **"Where's the SWE-bench number?"** Without one public benchmark adapter + a published result, senior devs default to Inspect AI. Mitigation: ship one adapter + a blog post with a real number.
3. **"My LLM stack is Python."** Doc mentions Python client + wire protocol. That story needs to be load-bearing in the README, not a side door. Otherwise the Pydantic AI / DSPy / Inspect crowd (which is the technical-buyer crowd) skips on language.
4. **"What's the diff between this and DSPy + LangSmith glued together?"** Real answer: closed loop + multi-session + Shape B. Doc doesn't make that contrast explicit. Add a 1-page "Why not just DSPy + LangSmith" doc.
5. **"How do I review what the agent is about to ship to itself?"** The `autoOnPromote: 'config'` flow is powerful and terrifying. Need a clear story for: human-in-the-loop gating, rollback, audit log of what mutated when. Mitigation: ship a default "promotion log" that's append-only and replayable.
6. **`runCampaign` is one fat function.** Adoption-friction issue covered above. Mitigation: presets.
7. **"What happens when the judge is wrong?"** Judge-quality is the load-bearing assumption. Inspect AI has judge calibration tooling; LangSmith has judge-vs-human IRR. v1.0 should ship at least a `judgeAgreement` helper that computes IRR against a held-out human set.

---

## Recommendation: positioning + naming + GTM

### Positioning

**Not** "another eval framework". The market doesn't need one.

**Yes** "the only substrate where your agent improves itself in production, with the same primitive running in CI and in the live worker."

Lead the README with the closed-loop diagram. Show production traces flowing into a store, the store feeding a nightly run, the run opening a PR, the PR shipping a new profile. **The diagram IS the wedge.** The API is an implementation detail.

### Naming

- Keep `runCampaign` as the internal primitive. Don't rename.
- Add `runEval`, `runOptimization`, `runProductionLoop` as the **documented** surface. Thin wrappers, ~30 LOC each.
- Rename the package conceptually (in docs/marketing, not npm): "agent-eval" undersells. It's an **agent improvement substrate**, not an eval lib. Tagline: *"Self-improving agents, in production."*

### GTM angle (if going public)

1. **Land:** "Drop in `runEval` against your existing chat handler. 5 minutes to a scorecard. OTEL exports to your Langfuse." (Commodity foot in the door.)
2. **Expand:** "Add `optimizer + gate`. Now overnight CI proposes prompt improvements as PRs." (DSPy users move here.)
3. **Lock:** "Flip `autoOnPromote: 'config'`. Your live worker self-mutates against a held-out gate." (Nobody else can do this. Switching cost is now real.)

The wedge is step 3. Steps 1 and 2 are how you get someone to step 3.

### Doc-level fixes (low cost, high impact)

- `README.md`: replace API-first opening with diagram-first + `runProductionLoop` snippet.
- `docs/concepts.md`: add "Why not DSPy + LangSmith?" section.
- Add `docs/comparison.md`: the matrix above, kept honest. (This is what every "should I use this?" reader searches for.)
- Ship one SWE-bench adapter + one published number before public launch.

---

## Answers to the doc's open sign-off questions

- **(a) One function vs presets?** One internal primitive, three exported presets. Doc + onboard via presets; power users discover the primitive.
- **(b) Package boundary?** Clean. agent-runtime owning loops + agent-eval owning primitives + agent-knowledge owning state is the right cut. The only concern: `runProductionLoop` in agent-runtime needs to be the *documented entry point* for adopters — not buried as "the loop that calls the primitive".
- **(c) Tracing on by default?** Yes — every modern framework defaults this on. Opt-out via `tracing: 'off'` is fine. Make sure the default `FileSystemTraceStore` has a clearly documented size cap and rotation policy, or it'll bite production users on disk.
- **(d) 2-week ship realistic?** Optimistic. Day 6 wrapper-diff is dangerous — bug fixes drifted across 4 copies of 1900 LOC. Budget 2 days minimum. The 2-week plan also doesn't include the table-stakes gaps (dataset versioning, regression diff, judge IRR helper). v1.0 ship is realistic; v1.0-with-credibility-for-external-launch is 4 weeks.

---

## Top 3 differentiators

1. **Same primitive, two destinations** (`autoOnPromote: 'pr' | 'config'`) — CI-cron and live-worker self-mutation from one function. Nobody else ships both shapes in-box.
2. **Multi-session, state-carrying user simulation with persona evolution** — first-class option for longitudinal UX testing. No competitor has this as anything but a custom build.
3. **Production traces auto-feed the labeled store, which auto-feeds the next optimization run** — the closed loop is ON by default. Langfuse/LangSmith expose the pieces; v1.0 wires them.

Everything else is parity-or-below vs hosted competitors. The above three only matter if positioning leads with them and onboarding doesn't fight the developer for 30 minutes before they see the wedge.
