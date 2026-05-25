# v1.0 substrate design — 4-reviewer synthesis
Date: 2026-05-25
Source: design doc v4 at `/home/drew/code/agent-eval/docs/design/runcampaign-1.0.md`
Reviewers: senior eval engineer / SOTA competitive / Anthropic self-improvement / alignment-steering

## Score panel

| Reviewer | Score | One-line |
|---|---|---|
| Senior AI eval engineer | **5.5 / 10** | "Internal refactor 8/10, v1.0 eval framework 4/10. CampaignResult undefined, no stats layer, contamination by default." |
| SOTA competitive | **6.5 / 10** | "Strong as internal substrate, weak as OSS. Real differentiators exist but the surface reads as another eval harness." |
| Anthropic self-improvement | **4.5 / 10** | "Train/test contamination structural, Shape B unsafe as specified, no reward-hacking surveillance on the critical path." |
| Alignment / steering | **3.5 / 10** | "`autoOnPromote: 'config'` is a closed-loop autonomous prompt-rewrite against a LIVE agent with no required safety gate. Block from v1.0." |
| **Mean** | **5.0 / 10** | **Internal refactor — yes. Real v1.0 — not yet.** |

## Where 3 of 4 (or 4 of 4) agree

### BLOCKERS (cannot ship as drafted)

1. **`autoOnPromote: 'config'` is dangerous as v1.0 default.** Anthropic SI + alignment-steering explicit "block from v1.0." Eval engineer + SOTA flag missing canary / shadow / rollback. 4/4 reviewers agree this needs to come out or get a full safety stack wired in.

2. **`LabeledScenarioStore` train/test contamination + data poisoning.** Eval engineer + Anthropic SI flag the structural contamination (no temporal split, no canary enforcement on writes, no manifest-hash in result). Alignment flags the data-poisoning surface (adversarial production traffic shapes optimization signal). 4/4 agree fixable but the **default-on** posture must change to **default-off-for-training-source / default-on-for-capture**.

3. **Existing safety primitives are off the critical path.** Alignment-steering surfaced this most sharply: the repo HAS `red-team.ts`, `rl/reward-hacking.ts`, `canary.ts`, `HoldoutAuditor`, `checkCanaries`, `judge-calibration.ts`. NONE are wired into `runCampaign`'s default gate composition. Anthropic SI made the same point — "the most likely 6-month steady state is judge-overfit prompts that score higher and serve users worse." Fixing this is a 1-2 day wire-up; not architectural, but blocking for safety.

4. **`CampaignResult` return type undefined.** Senior eval engineer flagged: the return schema IS the downstream tool contract (Inspect's `EvalLog`, HELM's `RunSpec`/`Stat`). Without it, every dashboard / CI gate / regression tool will rebuild bespoke — exactly the wrapper-drift problem v1.0 claims to solve, one layer deeper.

### TABLE-STAKES GAPS (must address before public ship)

5. **No statistical layer.** No seed, no determinism, no bootstrap CIs, no `pass@k`, no run-to-run regression diff, no variance guards, no cell-level resumability. Eval engineer + SOTA both. Inspect / OpenAI Evals / HELM all bake these in.

6. **No reward-hacking surveillance.** Judges are sole reward signal. No judge ensemble requirement, no inter-judge agreement check, no spec-gaming probe (e.g., negative-control candidates), no red-team battery as gate condition. Anthropic SI + alignment.

7. **No dataset versioning / regression diff.** SOTA flagged: when you re-run the same campaign against a new mutator, you need to see what got better vs worse PER scenario, with statistical significance. Today's `CampaignResult` (undefined) doesn't carry the manifest hash needed for stable diffing.

8. **Provenance + schema on `LabeledScenarioStore` writes.** Alignment flagged the data-poisoning vector. Anthropic SI flagged the contamination. Both fixable with: provenance gate (where did this trace come from — user / adversary / synthetic), per-source rate limit, PII redaction on capture, data versioning hash in the manifest.

### NAMING + ADOPTION

9. **Three named presets vs one primitive.** SOTA reviewer recommends shipping `runEval` / `runOptimization` / `runProductionLoop` as the documented public surface even if `runCampaign` is the internal primitive. The 11-option signature is a 30-minute read before the wedge becomes visible. Senior eval engineer didn't flag — but acknowledged it as an API-surface refactor. **Verdict: ship both. `runCampaign` as primitive + 3 thin named exports for adoption ergonomics.**

10. **GTM framing.** SOTA: lead with "self-improving agents in production," not "evaluation." Eval market is saturated; closed-loop self-mutation framing isn't. Diagram-first README + "why not DSPy + LangSmith" doc.

## Where the reviewers AGREE the design is RIGHT

1. **Wrapper collapse is correct architecturally.** 9.7k LOC consumer reduction is real. The lift-cycle exit is genuine. 8/10 as internal refactor (eval engineer's words).

2. **Package boundary clean.** agent-eval owns primitive, agent-runtime owns loops, agent-knowledge owns knowledge. None of the 4 challenged this.

3. **Multi-session sequencer with `evolveAfterSession`** is novel and well-shaped (SOTA + eval engineer both noted it positively). Closest to a real "long-horizon agent eval" capability the field doesn't have.

4. **Same-primitive-two-destinations (Shape A + Shape B)** as an idea is real differentiation — IF Shape B gets the safety stack 3/4 reviewers demanded.

5. **Tracing on by default** is the right call (alignment specifically said it should NOT be off-able when Shape B is active).

## Recalibrated v1.0 scope (what ship actually should be)

### Pass A — ship now (3-4 weeks honest)

- **`runCampaign` primitive** with `autoOnPromote: 'pr' | 'none'` ONLY (drop `'config'`)
- **3 named presets** as public surface: `runEval`, `runOptimization`, `runProductionLoop`
- **`CampaignResult` defined schema** with manifest hash, seed, per-cell artifacts, judge scores, statistical metadata (sample size, CI bands)
- **Seed + determinism** required field; `repsForCI` defaults to 5 with bootstrap CIs
- **Resumability** via cell-level cache keyed by (manifest hash, scenario hash, profile hash)
- **`LabeledScenarioStore` capture-default-on, training-source-default-off** — explicitly opt in to training-use
- **Provenance fields** on store writes (source tag, redaction status, version hash)
- **Default `composeGate`** in `runProductionLoop` preset wires: heldOutGate + costGate + **reward-hacking detector** (uses existing `rl/reward-hacking.ts`) + **red-team probe** (uses existing `red-team.ts`) + **canary check** (uses existing `canary.ts`)
- Migration of 5 consumer products to thin wrappers (~830 LOC total across products)

### Pass B — v1.x after Pass A lands

- **`autoOnPromote: 'config'`** gated behind required `defaultSafetyGate` composition + shadow-deploy phase + rollback API + diff history + per-source rate limits + behavioral-diff floor + ensemble judges + spec-gaming probe
- **Multi-objective optimizer** (Pareto front, fitness aggregation across reps, explore/exploit knob)
- **Public benchmark adapter** (SWE-bench, HELM-style scenarios)
- **Judge calibration helper** (judge-vs-human IRR scoring)
- **Online A/B canary infrastructure** for Shape B (when it ships)

## Concrete recommendation

Treat current PR #91 as the **Pass A track**, not v1.0. Title it "0.40 substrate consolidation" or similar. Reserve "1.0" for after Pass A + safety stack land and the canary / shadow / rollback story is in place for Shape B.

Three open questions for Drew sign-off:

- (a) Accept the 5.0/10 mean + ship as Pass A (renamed from v1.0) with 3-4 week scope, deferring `autoOnPromote: 'config'` to Pass B?
- (b) Wire existing safety primitives (`red-team.ts`, `rl/reward-hacking.ts`, `canary.ts`, `HoldoutAuditor`) into default `composeGate` for `runProductionLoop` preset — or leave opt-in and document loudly?
- (c) Ship 3 named presets (`runEval` / `runOptimization` / `runProductionLoop`) as documented public surface + `runCampaign` as internal primitive — yes/no?

## File map of individual reviews

- `.evolve/reviews/2026-05-25-senior-eval-engineer.md` (5.5/10)
- `.evolve/reviews/2026-05-25-sota-competitive.md` (6.5/10)
- `.evolve/reviews/2026-05-25-anthropic-self-improvement.md` (4.5/10)
- `.evolve/reviews/2026-05-25-alignment-steering.md` (3.5/10)
- `.evolve/reviews/2026-05-25-SYNTHESIS.md` (this file)
