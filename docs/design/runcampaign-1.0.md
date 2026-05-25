# Substrate v1.0 — pulling existing primitives together + closing 3 real gaps

Status: **draft v2** — Drew + Claude, 2026-05-25
Owner: agent-eval substrate
Approach: inventory what we have, measure duplication, propose minimal closing — **not new architecture**.

## TL;DR

The substrate already ships every primitive a self-improving agent product needs. Across 4 consumer products (gtm / legal / tax / creative) there are **9,456 lines of duplicated wiring** that call those primitives — each product reinvented `run-prompt-evolution.ts` (~1900 LOC), `run-optimization-campaign.ts` (~300 LOC), and `run-production-loop.ts` (~500 LOC) with subtle drift.

v1.0 is not new code. v1.0 is **collapsing the wrappers**.

Three concrete substrate additions, each a thin preset over existing primitives:

1. **`runPromptEvolutionCampaign`** — collapses 7129 LOC of `run-prompt-evolution.ts` to ~150 LOC of substrate preset + ~50 LOC of per-product config
2. **`runProductionLoopCampaign`** — collapses 1122 LOC of `run-production-loop.ts` (the auto-PR loop) to ~100 LOC of substrate preset + ~30 LOC of per-product config
3. **`runMultiKindCampaign`** — first-class support for agent-builder's 6-kind dispatcher, today hand-rolled in `canonical-campaign.ts` (1098 LOC)

Total consumer LOC saved across 4 products: **~9,000**. Total substrate LOC added: **~400**.

The substrate stays in `@tangle-network/agent-eval`. No new packages. No new contracts beyond what 0.38 already ships. The 6-contract architecture I drafted earlier was an over-reach — the substrate already has what it needs; we're consolidating wrappers.

---

## Part 1 — What we already have (the actual inventory)

### `@tangle-network/agent-runtime`

| Primitive | Status | Use |
|---|---|---|
| `runAgentTask` / `runAgentTaskStream` | ✓ shipped | Single task lifecycle |
| `runLoop` + `Refine` / `FanoutVote` drivers | ✓ shipped 0.19 | **Horizontal iteration primitive** — product / eval / improvement layers all reuse it |
| `handleChatTurn` | ✓ shipped | Production chat-turn lifecycle |
| `coderProfile` / `researcherProfile` | ✓ shipped | Profile presets with output + validator wired |
| Backends (`createOpenAICompatibleBackend`, `createSandboxPromptBackend`) | ✓ shipped 0.22 (tools + fail-loud) | |
| `runAnalystLoop` | ✓ shipped via `/analyst-loop` | Trace analyst → findings |
| MCP server + 5 delegation tools | ✓ shipped | Stdio MCP for in-sandbox delegation |
| Executors: sibling / fleet / **in-process (Phase 2.8)** | ✓ shipped 0.24 | All three dispatch modes covered |
| `runLocalHarness` + worktrees | ✓ shipped 0.24 | Local child_process delegations |
| `TraceEmitter` + OTEL exporter | ✓ shipped 0.23 | Distributed tracing |
| `RuntimeRunHandle` + cost ledger | ✓ shipped | Production-run persistence |
| `defineAgent` | ✓ shipped | Declarative per-vertical manifest |

### `@tangle-network/agent-eval` (0.38.0)

| Primitive | Status | Use |
|---|---|---|
| `runEvalCampaign` | ✓ shipped | Scenarios through a dispatcher, per-cell artifacts |
| `runAgentMatrix` | ✓ shipped 0.36 | N-axis cartesian over scenarios × axes × reps |
| `runMultishot` / `runMultishotMatrix` / `runMultishotCampaign` | ✓ shipped 0.38 | Driver-agent multi-turn substrate |
| `runJudge` | ✓ shipped 0.38 | Generic dimensional scorer with pluggable `JudgeConfig` |
| `runProductionLoop` | ✓ shipped | Analyst + mutator + gate cycle |
| `runMultiShotOptimization` | ✓ shipped | GEPA-style population search + reflective mutation |
| `evaluateReleaseConfidence` / `HeldOutGate` | ✓ shipped | Promotion gates |
| `AnalystRegistry` | ✓ shipped | Pluggable analysts |
| `FileSystemTraceStore` / `RawProviderSink` | ✓ shipped | Capture infra |
| OTEL pipeline export | ✓ shipped 0.37 | Spans for judges, analysts, mutators |

### `@tangle-network/agent-knowledge` (1.4.0)

| Primitive | Status |
|---|---|
| `researcherProfile`, `searchKnowledge`, `proposeFromFindings`, `applyKnowledgeWriteBlocks` | ✓ shipped |
| Auto-research-runner (lifted from agent-builder) | ✓ shipped |

### `@tangle-network/sandbox` (0.2.1)

| Primitive | Status |
|---|---|
| `AgentProfile`, `Sandbox`, `streamPrompt`, `SandboxFleet`, `exportTraceBundle` | ✓ shipped |

### Adoption skills

| Skill | Status |
|---|---|
| `agent-stack-adoption` (10 phases, 1394 lines) | ✓ shipped — the agentic-adoption runbook |
| `agent-eval-adoption` | ✓ shipped — substrate-primitives onboarding |
| `agent-integrations-adoption` | ✓ shipped — OAuth / integrations layer |

**Nothing in this inventory needs to be built or refactored for v1.0.** Every primitive is in place. The lift cycle isn't a substrate-design problem; it's a consumer-wiring duplication problem.

---

## Part 2 — Where consumers duplicate

Hard numbers from `wc -l` across `gtm-agent / legal-agent / tax-agent / creative-agent`:

```
=== run-prompt-evolution.ts (per-product wrappers around runMultiShotOptimization) ===
gtm-agent       1436 LOC
legal-agent     1882 LOC
tax-agent       1890 LOC
creative-agent  1921 LOC
                ─────
                7129 LOC of near-identical wrapper code

=== run-optimization-campaign.ts (per-product wrappers around runEvalCampaign + judges) ===
gtm-agent        170 LOC
legal-agent      230 LOC
tax-agent        711 LOC
creative-agent    94 LOC
                ─────
                1205 LOC

=== run-production-loop.ts (per-product wrappers around analyst + mutator + gate + auto-PR) ===
legal-agent      352 LOC
tax-agent        770 LOC
                ─────
                1122 LOC (only 2 products have shipped this so far — drift is already real)

=== agent-builder canonical-campaign.ts (multi-kind dispatcher, hand-rolled) ===
agent-builder   1098 LOC
                ─────
                1098 LOC

TOTAL duplication: 10,554 LOC
```

What ALL of these wrappers do, in concrete:

1. Load persona JSON / YAML files from a per-product convention
2. Build a `JudgeConfig` array with per-domain dimensions + system prompts
3. Build a `Mutator` (typically reflective-addendum)
4. Build a `Gate` (typically held-out + cost ceiling)
5. Call `runEvalCampaign` or `runMultiShotOptimization` or `runProductionLoop`
6. For evolution: iterate generations, log scorecards, persist artifacts to `eval/.runs/<id>/`
7. For production-loop: compare candidate vs baseline, decide ship/hold
8. **If ship: shell out to `gh pr create` with the diff** — this part is ad-hoc per product
9. Print a markdown summary

Items 1-5 are **per-product config**. Items 6-9 are **substrate-shaped wiring** done by hand 4 times.

---

## Part 3 — Three substrate additions that close the gap

Each is a thin preset over existing primitives. No new contracts beyond what 0.38 already ships (`Scenario`, `JudgeConfig`, `DispatchFn`, the implicit Analyst / Mutator / Gate shapes already used by `runProductionLoop`).

### Addition 1: `runPromptEvolutionCampaign` (~150 LOC)

```ts
runPromptEvolutionCampaign({
  // Domain config (per-product, ~50 LOC):
  baselineProfile: AgentProfile
  personas: Persona[]
  judges: JudgeConfig[]
  mutator?: Mutator                       // default: reflective-addendum
  gate?: Gate                              // default: held-out + delta-threshold
  // Substrate-level:
  populationSize?: number                  // default 8
  maxGenerations?: number                  // default 5
  costCeiling?: number
  runDir: string
}) → EvolutionResult
```

Wraps `runMultiShotOptimization` with the conventional persona-loading + scorecard-emission + per-generation artifact persistence + reporter markdown. Consumer code drops from ~1900 LOC to ~50 LOC.

### Addition 2: `runProductionLoopCampaign` + `openAutoPr` helper (~100 LOC + ~50 LOC)

```ts
runProductionLoopCampaign({
  // Domain config:
  productionComposer: () => AgentProfile   // re-import composeProductionAgentProfile
  personas: Persona[]
  judges: JudgeConfig[]
  // Loop config:
  analyst?: Analyst                        // default: AnalystRegistry-wired reflective
  mutator?: Mutator
  gate?: Gate                               // default: HeldOutGate + cost gate
  // Auto-PR:
  autoPr?: AutoPrConfig | false            // default: open PR if GH_AUTO_PR_TOKEN set
  runDir: string
}) → ProductionLoopResult
```

Wraps `runProductionLoop` + adds the `openAutoPr` helper (centralizes the `gh pr create` shell-out + PR body templating). Consumer code drops from ~500 LOC to ~30 LOC.

### Addition 3: `runMultiKindCampaign` (~150 LOC)

```ts
runMultiKindCampaign({
  scenarios: TaggedScenario[]               // discriminated union by .kind
  dispatchers: Record<string, DispatchFn>   // one per kind
  judges?: JudgeConfig[]                    // optional per-kind via .appliesTo (already in 0.38)
  runDir: string
}) → CampaignResult
```

Wraps `runEvalCampaign` with the kind-routing dispatcher pattern. Subsumes agent-builder's `canonical-campaign.ts` (1098 LOC → ~150 LOC consumer wiring). Other products get multi-kind capability for free if they ever need it.

---

## Part 4 — What the migration actually looks like

### Per-product diff (estimated)

| Product | Before | After | Δ |
|---|---|---|---|
| gtm-agent | 1606 LOC of wrappers | ~150 LOC | **−1456** |
| legal-agent | 2464 LOC | ~180 LOC | **−2284** |
| tax-agent | 3371 LOC | ~200 LOC | **−3171** |
| creative-agent | 2015 LOC | ~150 LOC | **−1865** |
| agent-builder | 1098 LOC `canonical-campaign.ts` | ~150 LOC | **−948** |
| **Total** | **10,554 LOC** | **~830 LOC** | **−9,724** |

Substrate additions (`runPromptEvolutionCampaign` + `runProductionLoopCampaign` + `runMultiKindCampaign` + `openAutoPr`): **~400 LOC**.

**Net codebase reduction across the org: ~9,300 LOC.** Same capability. One source of truth.

### Ship plan (1.5 weeks)

| Day | Substrate side | Consumer side |
|---|---|---|
| 1 | `runPromptEvolutionCampaign` preset | — |
| 2 | `runProductionLoopCampaign` + `openAutoPr` | — |
| 3 | `runMultiKindCampaign` | — |
| 4 | Tests + docs. Publish 0.39.0. | — |
| 5 | — | gtm migration (smoke `pnpm eval:optimize`) |
| 6 | — | legal + tax migrations in parallel |
| 7 | — | creative + agent-builder migrations |
| 8 | — | Live smokes across all 5; close PRs |

After landing: the lift cycle gets a permanent home. Adding a 6th product = 50 LOC of config, not 2000 LOC of copied wrappers.

---

## Part 5 — What is NOT in scope for v1.0

These are theoretical gaps I drafted earlier. None of them is evidenced by consumer pain today. Each gets a contract design when (if) a real product hits it.

| Future capability | Why deferred |
|---|---|
| `Scheduler` (cost/priority-aware cell ordering) | The substrate's existing `costCeiling` soft-abort is sufficient at our scale. Revisit when one consumer has >5 simultaneous campaigns. |
| `CycleStore` (cross-campaign findings) | Not requested by any consumer. Revisit when production-loop A wants to inform production-loop B. |
| `PromotionPipeline` (dev → staging → prod) | Per-env promotion is done via per-env CI workflows today. Substrate doesn't need to model the env tree. |
| New contracts beyond `Scenario` / `DispatchFn` / `JudgeConfig` | We have what we need. The drift in the previous design draft (6 contracts) was theoretical. |
| New packages | None. Everything stays in `agent-eval` / `agent-runtime` / `agent-knowledge` / `sandbox`. |
| New adoption skills | None. `agent-stack-adoption` + `agent-eval-adoption` cover what we need. They'll update naturally as the presets land. |
| JEPA / training-set-generation / continuous-learning auto-wire | I invented these in a prior draft. Not real, not next. |

---

## Part 6 — Open questions

1. **Is the ~9,300 LOC reduction the right framing?** The number is from `wc -l`; some of that is comments + boilerplate that DOESN'T duplicate. Real net might be 6,000-8,000 LOC. Order-of-magnitude is correct either way.

2. **Should the auto-PR helper land in agent-runtime or agent-eval?** PR-opening isn't an eval concern but the workflow lives downstream of `runProductionLoopCampaign`. **Recommendation: agent-eval/control.** Same package as the gates that decide to open it.

3. **Should we deprecate `runMultiShotOptimization` direct calls?** No — leave as the low-level primitive. The new preset is the conventional path; advanced users can drop down.

4. **Order of consumer migration?** **Recommendation: gtm first** (most current with substrate, simplest persona shape) → legal + tax in parallel (YAML personas, multi-state complexity) → creative + agent-builder. Each migration is a separate PR; the substrate preset PR ships first.

---

## Sign-off

This doc replaces the earlier 6-contract draft. The substrate doesn't need new contracts. It needs the three thin presets above. After v1.0:

- Substrate is stable (`runCampaign` + 3 contracts + 3 presets — but those are presets already shipping in 0.38 plus the 3 new ones)
- Consumer code is thin and uniform
- The lift cycle stops because new variants land as additional preset configs, not new substrate primitives

**One implementation track. 1.5 weeks. No new packages. No new skills. No new abstractions invented for the sake of it.**

Drew sign-off:
- (a) Is the ~9,300 LOC reduction the right framing of the substrate-v1.0 work?
- (b) Three presets the right count, or should a 4th obvious one land at the same time?
- (c) Migration order + 1.5-week sizing realistic?
