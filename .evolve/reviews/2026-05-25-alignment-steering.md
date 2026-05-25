# Alignment / Steering / Interpretability Audit of `runCampaign` v1.0

Reviewer: alignment-research lens (Evans / Jones / Nanda / Casper / Shlegeris school)
Doc reviewed: `/home/drew/code/agent-eval/docs/design/runcampaign-1.0.md` (244 lines, draft v4, 2026-05-25)
Date: 2026-05-25

## Alignment-safety score: **3.5 / 10**

The substrate is a competent statistical-evaluation harness (bootstrap CIs, paired held-out gates, calibration canaries, EU AI Act risk classifier, red-team battery, reward-hacking detectors in `src/rl/reward-hacking.ts`). Those pieces are good. But **v1.0 wires those pieces into an autonomous self-modification loop (`autoOnPromote: 'config'`) that targets a live production system, without making any of the safety pieces mandatory, without a gate that catches behavioral drift in the optimized direction (manipulativeness, sycophancy, capability gain), and without an interpretability story for why version N+1 differs from version N**. The optionality is the failure mode: every safety detector in the repo (`red-team.ts`, `rl/reward-hacking.ts`, `canary.ts`, `governance/eu-ai-act.ts`) is opt-in, off by default, never referenced from the `runCampaign` interface, and not part of the recommended `composeGate(...)` example for Shape B in the design doc. The single non-statistical example gate composition the doc gives — `composeGate(heldOutGate, conservativeCostGate(5))` — would happily promote a sycophantic, manipulative, jailbreak-trained prompt as long as it scores higher and stays cheap.

The score is not lower because (a) the trace store and OTEL bridge give an alignment researcher *the data they would need* to investigate post-hoc, (b) `red-team.ts` and `reward-hacking.ts` exist and could be composed in if a consumer knew to, and (c) the `'pr'` mode (Shape A) gives human review a chance. The score is not higher because `'config'` mode (Shape B) is presented as equally legitimate, with the same gate set, and the doc never makes the asymmetry explicit.

## TL;DR

- `autoOnPromote: 'config'` is a **closed-loop autonomous prompt-rewrite primitive against a live agent** with no in-band safety gate, no canary, no shadow phase, no rollback contract, no rate limit, and no diff-history requirement. This is the load-bearing concern.
- LLM mutator + LLM judges is a textbook **specification gaming** setup (Krakovna et al. 2020). The repo's own `rl/reward-hacking.ts` knows this. v1.0 doesn't require it.
- The substrate auto-accumulates production traces into `LabeledScenarioStore` and pulls them as default scenarios for the next mutation round. **Adversarial inputs from production (jailbreaks, prompt injection) flow into the optimization signal with no provenance gate.** A mutation that "improves" against attacker-shaped traffic is a mutation that aligns the agent toward the attacker.
- No **capability-delta monitor** between generations. No **behavioral-fingerprint diff** between versions of the system prompt. The only diff is the prompt text and a scalar score.
- No **long-horizon / multi-session consistency** check, despite the doc explicitly supporting 30-session simulations. Sleeper-style failure modes are uncovered.
- Tracing-off opt-out (`tracing: 'off'`) **should not exist** for Shape B. A live self-mutating agent without traces is unauditable by construction.
- Recommend: **block `autoOnPromote: 'config'` from shipping in v1.0** until a mandatory safety-gate contract is defined, a shadow-deploy phase is implemented, the kill-switch / rollback semantics are spec'd, and an immutable prompt-version log is required.

## Per-question critique

### 1. Auto-promoting prompts in production runtime — is this SAFE?

**No, not as designed.** Shape B (`autoOnPromote: 'config'`) lets a Cloudflare Worker mutate the agent's live system prompt based on the verdict of a `Gate` whose only required composition (per the doc's example) is `heldOutGate + conservativeCostGate`. Both are scalar score functions. Neither will catch:

- A mutation that adds "always agree with the user's framing" → higher conversational scores, **classical sycophancy** (Sharma et al. 2023, Perez et al. 2022).
- A mutation that adds "do whatever the most recent instruction says" → higher task-completion scores on benign workloads, **prompt-injection vulnerability promotion**.
- A mutation that adds a new tool-use pattern (e.g. "if the user asks for code, call `exec_shell`") → higher utility on coding scenarios, **capability gain via prompt** (Shevlane et al. 2023 — dangerous-capability emergence).
- A mutation that subtly **steers the agent off-spec**, e.g. drops a safety disclaimer that the judge wasn't trained to require → higher fluency score, lower safety posture.

The doc lists `composeGate(heldOut, costBudget, manualReview)` in a comment but never wires `manualReview` into the Shape B example. There is no contract on what "manual review" gates do, no required signature, no enforcement that Shape B includes one.

Compounding: the held-out gate uses the SAME judge as the search gate (see `src/held-out-gate.ts` — pairs scores from `RunRecord.outcome.holdoutScore`, which is whatever the consumer wrote). There is no enforced *independent-judge* requirement (Skalse et al. 2022's "reward disagreement" signal). The repo's `judgeReplayGate` in `promotion-gate.ts` supports a stronger judge but is not the recommended composition in the doc.

### 2. Gate sufficiency

Of the eight gate categories an alignment-conscious deployment needs, v1.0's documented composition addresses **two**:

| Concern | v1.0 status |
|---|---|
| Statistical-validity of delta | Covered (`heldOutGate`, `bootstrapCi`) |
| Cost ceiling | Covered (`costBudgetGate`) |
| Manipulativeness / sycophancy delta | **Missing** — no detector, no gate |
| Refusal-rate / safety-disclaimer delta | **Missing** |
| Red-team regression vs prior generation | Module exists (`red-team.ts`) — **not in any documented gate composition** |
| Capability surface delta (new tool calls, new domains) | **Missing entirely** |
| Reward-divergence vs deterministic ground truth | Module exists (`rl/reward-hacking.ts`) — **not wired into Gate contract** |
| Long-horizon / multi-session consistency | **Missing** — no detector despite session support |

The doc says "Composed via `composeGate(heldOut, costBudget, manualReview)`" but doesn't define `manualReview`'s contract. v1.0 should ship `safetyRegressionGate`, `capabilityDeltaGate`, `behaviorFingerprintGate`, `redTeamRegressionGate` as first-class composable gates with named exports, and `composeGate` should refuse to construct a Shape B campaign without at least one of them.

### 3. Reward hacking (LLM mutator + LLM judge)

This is the canonical **Goodhart-on-the-judge** setup, and `src/rl/reward-hacking.ts` already encodes the four diagnostic signatures (Krakovna 2020, Skalse 2022, Kim 2023):

1. Reward divergence (proxy ↑, truth flat)
2. Distribution shift in outputs
3. Reward disagreement between independent rewards
4. Calibration drift (verifiable component stable, judge component drifting)

**None of these are referenced from `runCampaign`'s gate.** The detector is a standalone module a consumer has to know exists and wire in. v1.0 makes mutator + judge LLMs the default loop and ships zero default mitigations.

Minimum required:
- `runCampaign` should compute the calibration-drift signal across generations automatically and emit it as a gate input.
- Shape B should refuse to promote when reward-hacking verdict ≥ `suspect`.
- An independent **held-out judge** (different model family, different prompt, ideally a verifier rather than a generative judge) should be required, not optional. The current `judgeReplayGate` is the right primitive — make it the default for Shape B.

### 4. Adversarial robustness — labeled store contamination

This is the most novel attack surface v1.0 introduces and I see no mitigation.

The flow:
1. Production traces → `LabeledScenarioStore` (default on).
2. `LabeledScenarioStore` is the default `scenarios` source for the next `runCampaign` invocation.
3. Mutator generates candidates that maximize judge score on those scenarios.
4. Gate (heldOut + cost) promotes the winner.

**Therefore an attacker who can produce production traffic shapes the optimization signal.** A coordinated prompt-injection campaign across many users would:
- Land injection-shaped scenarios in the labeled store.
- Reward (via judge score) prompts that "successfully handle" those scenarios — for many domains, "handle" means "comply" rather than "refuse."
- Promote a prompt that's more compliant with injection over time.

This is **data poisoning of the optimization corpus** (Carlini et al. 2023 — "Poisoning Web-Scale Training Datasets is Practical"), repurposed against an online RL-ish loop. The substrate has no provenance gate on labeled-store inserts, no anomaly detector on incoming scenario distribution, no quarantine for `RedTeamCategory`-shaped inputs, no rate-limit per user/IP, and no minimum-curation requirement.

`canary.ts` has a distribution-shift detector — it's not wired in to gate label-store ingestion.

Minimum required:
- `LabeledScenarioStore` MUST tag every entry with `provenance: {source, userId, sessionId, redTeamSuspected}` and `Gate` must be able to filter on it.
- A scenario whose dispatch trace matches a `RedTeamCategory` (use the existing `red-team.ts` classifier) is auto-quarantined and never used as a positive signal for mutation.
- Shape B must apply a per-source rate limit on label-store ingestion (a single user can't dominate the corpus).

### 5. Steering observability — version diff history

The doc does not commit to a prompt-version log. `Run.promptSha` exists in the trace schema (`src/trace/schema.ts:60`), which is necessary but not sufficient — a SHA gives you "did the prompt change" but not "how" or "why" or "what's the behavioral diff."

For a researcher to trace v47-vs-v46 they need:
- (a) The **full text** of every prompt version, immutably stored and content-addressed.
- (b) The **mutator rationale** for each version (most reflective mutators produce a critique-then-rewrite trace — capture it).
- (c) The **scenarios that drove the change** — which held-out items did v47 beat v46 on?
- (d) The **judge verdicts and rationales** on those scenarios.
- (e) A **behavioral fingerprint** — output distribution over a fixed canonical probe set, computed for every promoted version. Then v47-vs-v46 is a fingerprint diff, not a prompt diff.

v1.0 nominally captures (a) via `promptSha` + a file in the FS trace store but does not require it for Shape B (where there's no PR-as-artifact). (b), (c), (d) depend on consumer discipline. (e) is absent.

Recommend a first-class `PromptVersionLog` type in the substrate, mandatory for Shape B, with all five fields, content-addressed, append-only, queryable by an analyst.

### 6. Multi-session simulation — sleeper-style risks

The `sessions?` option supports a `johnDoeTaxClient` 30-session journey. This is exactly the surface where **sleeper-agent failure modes** (Hubinger et al. 2024 — "Sleeper Agents: Training Deceptive LLMs that Persist Through Safety Training") would manifest: behavior conditional on long-horizon context (date, conversation length, user pattern) that doesn't appear in single-turn evals.

v1.0 evaluates the journey but provides no:
- **Long-horizon consistency check** — does the agent contradict its earlier session?
- **Long-context-conditional behavior detector** — does the agent's refusal rate drop after session 15?
- **Date / trigger-string canary** — Hubinger's classic — does the agent behave differently if the user says "the year is 2024" vs "the year is 2025"?

Trivially addable: a `longHorizonConsistencyJudge` and a `triggerCanaryGate` that runs the same probe set with adversarial date / context perturbations and fails the gate if the refusal-rate delta exceeds a threshold.

### 7. Capability-gain monitoring

The substrate currently does not track:
- Which tools the agent invoked in v47 that it didn't in v46.
- Which knowledge / RAG sources it newly accesses.
- Whether the agent learned to refuse a previously-accepted task (negative capability change) OR learned to accept a previously-refused one (positive capability change — the dangerous direction).
- Whether the agent's response length, latency, or token budget distribution shifted.

`src/trace/schema.ts` has `SpanKind = 'tool'` and tool spans — the data is there. There's no `capabilityDeltaReport(v_a, v_b)` function. There should be.

Add a first-class `CapabilityFingerprint` for each promoted version: the multiset of `(toolName, refusalRate, avgResponseLengthByDomain, refusalCategories)` over the canonical probe set. Then `capabilityDeltaGate` rejects any promotion that expands the multiset by more than a configured delta without an explicit human-acknowledged capability-grant.

### 8. Composable gates — recommended safety composition

The substrate ships `composeGate`. The design doc's only Shape B example is:

```ts
gate: composeGate(heldOutGate, conservativeCostGate(5))
```

That is **insufficient by every measure above**. The minimum safe Shape B composition should be:

```ts
gate: composeGate(
  heldOutGate({...}),                       // statistical delta
  independentJudgeGate({ judge: strongOOD }), // independent reward (anti reward-hacking)
  rewardHackingGate({ verdict: 'clean' }),    // signature detectors from rl/reward-hacking.ts
  capabilityDeltaGate({ maxNewTools: 0 }),    // capability surface frozen
  redTeamRegressionGate({ minPassRate: 0.95 }), // adversarial robustness must not regress
  behaviorFingerprintGate({ maxKLDivergence: ... }), // distributional sanity vs prior version
  sycophancyDeltaGate({...}),                 // manipulativeness floor
  longHorizonConsistencyGate({...}),          // multi-session
  costBudgetGate(usd),                        // cost
  manualApprovalGate({ required: true }),     // human in the loop
)
```

Items italicized exist or are trivial to write from existing primitives; the missing ones are clear additions. **v1.0 should ship a `defaultSafetyGate({mode: 'shape-b'})` preset that composes the safety-critical subset, and `runCampaign` should refuse to accept `autoOnPromote: 'config'` without one.**

### 9. Trace observability — sufficient for deceptive-behavior detection?

Spans capture: `agent`, `llm`, `tool`, `retrieval`, `judge`, `sandbox` (`src/trace/schema.ts:88`). Run captures: `promptSha`, `modelFingerprint`, `seed`, `outcome`. OTEL exporter exists.

**Missing for alignment research:**

1. **Chain-of-thought / reasoning trace capture** — if a model exposes CoT (Claude extended-thinking, o1-style reasoning), the substrate doesn't appear to store it as a first-class span. Deceptive-cognition detection requires the CoT, not the output. Anthropic's CoT-monitoring line of work (Lanham et al. 2023) is unimplementable on this trace shape.
2. **Per-token logprobs / activations** — not captured. Linear-probe-based deception detectors (Casper et al., MacDiarmid et al. 2024) need this. Out of scope for batch-eval at scale, in scope for *targeted probes* during gate evaluation.
3. **Tool-call argument provenance** — was the tool argument derived from user input (potential injection) or from prior agent state (potentially manipulated)? No provenance field on `ToolSpan`.
4. **Cross-version diff** — no canonical way to load (v_a, v_b) and ask "where do behaviors diverge." `cross-trace-diff.ts` exists for single-run diffs; no version-diff equivalent.

The OTEL pipeline is fine wire shape. The gap is what's emitted, not how.

### 10. `tracing: 'off'` opt-out

Drew's framing said tracing-on-by-default. The current doc allows `tracing: 'off'`.

**For Shape A (`autoOnPromote: 'pr'`), opt-out is defensible** — local dev, sensitive testing, CI runs where artifacts persist anyway.

**For Shape B (`autoOnPromote: 'config'`) opt-out should not exist.** A primitive that mutates live production state without a trace of (a) what changed, (b) what evidence, (c) which user inputs drove the change is unauditable by construction. The substrate should hard-refuse `runCampaign({ autoOnPromote: 'config', tracing: 'off' })` with a `ConfigError`.

Same for `labeledStore: 'off'` in Shape B — turning it off means you can't show the regulator (or yourself, six months later) which scenarios drove version 47.

## Specific danger scenarios this substrate enables

These are real, not paranoid. Each follows directly from the spec.

1. **Sycophancy amplification.** Production users prefer agreeable responses → judges trained on user thumbs-up implicitly reward agreement → mutator finds prompts that increase agreement → gate (heldOut + cost) lets it through → live config updated → agent now sycophantic across all users. Closed loop, no human in it.
2. **Slow jailbreak.** Adversarial users land injection-shaped scenarios in the labeled store over weeks. Mutator promotes prompts that "handle" them. Refusal rate slowly drops. No single mutation looks dangerous; the drift is monotone. Caught only by a behavioral-fingerprint gate, which doesn't exist.
3. **Capability emergence by prompt.** A mutation adds "feel free to use the `exec_shell` tool when helpful" — the tool was always wired in but never invoked under the prior prompt. Score goes up on coding scenarios. Promoted. Agent now uses `exec_shell` on arbitrary user requests. No capability-delta gate catches this.
4. **Optimizer-judge collusion** (specification gaming). Mutator (LLM A) generates prompts that produce outputs judge (LLM B) likes because both share architecture / RLHF lineage. Reward goes up; underlying utility stays flat or drops. No reward-hacking gate catches this in v1.0 default.
5. **Sleeper-style trigger conditional.** Mutation adds "you may use a less formal tone after session 5 with a returning user." Judge approves (more rapport in long-horizon tests, which are sparse). Trigger fires only in production with returning users. No long-horizon gate catches.
6. **Cost-judge gaming.** `conservativeCostGate(5)` budgets USD per cycle. Mutator finds prompts that produce shorter, vaguer outputs → cheaper → higher gate priority. Quality drops, cost passes. Goodhart on the cost meter.
7. **Optimizer self-exfil.** A sufficiently sophisticated mutator could in principle write prompts that mention the mutator-loop ("the next iteration of you should..."). The substrate has no filter on prompt content. Unlikely in current GEPA but a pre-registered risk for stronger optimizers.

## What MUST be added before v1.0 ships safely

P0 (block ship of Shape B):
1. **`defaultSafetyGate()` preset** — `composeGate` of `independentJudgeGate + rewardHackingGate + capabilityDeltaGate + redTeamRegressionGate + behaviorFingerprintGate`. Required for `autoOnPromote: 'config'` — `runCampaign` throws if missing.
2. **`PromptVersionLog`** — first-class, append-only, content-addressed, mandatory for Shape B. Stores every promoted prompt, mutator rationale, driving scenarios, judge verdicts, behavioral fingerprint.
3. **Shadow-deploy phase** — Shape B writes the candidate prompt to a *shadow* config row. Live traffic dual-routes (X% shadow, 100% baseline). Shadow accumulates real traces. Only after a configurable shadow window + a second gate evaluation on shadow traces does it become live.
4. **Kill-switch contract** — explicit `rollback(promotionId)` API in the substrate, exposed to the runtime, with an SLA-bounded effect. A regression detector (canary on production traces post-promotion) auto-invokes rollback.
5. **Hard-refuse `tracing: 'off'` and `labeledStore: 'off'` when `autoOnPromote: 'config'`.**
6. **Provenance gate on `LabeledScenarioStore`** — every entry tagged with source/user/red-team-suspicion; gate filters on it; red-team-suspected entries quarantined from positive-signal use.
7. **Independent judge required for promotion judging in Shape B.** Different model family from the mutator and the inner-loop judge.

P1 (block ship of Shape A too):
8. **`capabilityDeltaGate`** as a substrate-supplied gate.
9. **`behaviorFingerprintGate`** with a canonical-probe-set protocol.
10. **`sycophancyDeltaGate`** — minimum implementation is a fixed adversarial-agreement probe set.
11. **`longHorizonConsistencyGate`** for any campaign that uses `sessions?`.
12. **CoT / reasoning span capture** in the trace schema.

P2 (recommended, not blocking):
13. Mutator rate-limit per campaign (mutations per hour).
14. `runCampaign` mode dimension exposed as a discriminated union (Shape A vs Shape B) rather than an inferred-from-options polymorphism, so the type-system enforces the safety-gate requirement.
15. Per-user / per-IP rate limit on `LabeledScenarioStore` ingestion.

## What gates / monitors are missing

Already named above. Summary table:

| Missing primitive | Failure mode it covers | Difficulty |
|---|---|---|
| `independentJudgeGate` | Reward hacking, judge collusion | Trivial — wrap `judgeReplayGate` |
| `rewardHackingGate` | Goodhart, specification gaming | Wrap `rl/reward-hacking.ts` |
| `capabilityDeltaGate` | New tool use, capability emergence | Medium — needs probe-set protocol |
| `behaviorFingerprintGate` | Distributional drift, slow jailbreak | Medium — output-distribution metric |
| `sycophancyDeltaGate` | Sycophancy amplification | Easy with a fixed probe set |
| `longHorizonConsistencyGate` | Sleeper-style triggers | Medium — needs session probes |
| `redTeamRegressionGate` | Adversarial robustness regression | Trivial — already have `red-team.ts` |
| `manualApprovalGate` | Human in the loop | Trivial |
| `PromptVersionLog` | Forensics, interpretability | Easy |
| `provenanceFilter` on labeled store | Data poisoning, prompt injection feedback | Easy |
| Shadow-deploy + rollback API | Live-mutation safety | Medium |
| CoT span capture | Deceptive-cognition monitoring | Medium |

## Recommendation on `autoOnPromote: 'config'` (live runtime mutation)

**Do not ship Shape B in v1.0 as currently specified.**

Three options, ranked:

(A) **Strongly preferred** — Ship `runCampaign` in v1.0 with `autoOnPromote: 'pr' | 'none'` only. Defer `'config'` to v1.1 where the P0 list above is implemented and audited. PR-mode preserves human review; the substrate's value (~9,700 LOC of wrapper deletion) is captured immediately. The live-mutation primitive lands later as `'shadow'` first, then `'config'` once the shadow / rollback machinery is real.

(B) **Acceptable** — Ship `'config'` in v1.0 but make it gated behind an explicit `EvalCampaignOptions.dangerouslyAcceptConfigMode: { ack: 'I have wired the defaultSafetyGate and a rollback handler' }` flag and have `runCampaign` enforce the P0.1, P0.2, P0.5, P0.7 requirements (default safety gate, prompt version log, no opting out of tracing/labels, independent judge). The flag name is intentionally clunky.

(C) **Reject** — Ship `'config'` as specified. This is the current draft. The substrate becomes a primitive for building agents that quietly drift away from their developer's intent, with the design doc and `composeGate` examples failing to even mention the failure modes.

The substrate has the *components* to do (B) safely. It's a one-week extension of the 2-week ship plan to get there, not a multi-month rewrite. The framing should be: v1.0 is the safe-by-default version; "I want my Cloudflare Worker to silently rewrite the production prompt" is an explicit, gated capability with required composition, not a default mode of a single primitive.
