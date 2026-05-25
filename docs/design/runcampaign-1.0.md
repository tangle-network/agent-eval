# Substrate v1.0 — pulling existing primitives together + closing 3 real gaps

Status: **draft v2** — Drew + Claude, 2026-05-25
Owner: agent-eval substrate
Approach: inventory what we have, measure duplication, propose minimal closing — **not new architecture**.

## TL;DR

The substrate already ships every primitive a self-improving agent product needs. Across 4 consumer products (gtm / legal / tax / creative) there are **9,456 lines of duplicated wiring** that call those primitives — each product reinvented `run-prompt-evolution.ts` (~1900 LOC), `run-optimization-campaign.ts` (~300 LOC), and `run-production-loop.ts` (~500 LOC) with subtle drift.

v1.0 is not new code. v1.0 is **collapsing the wrappers** + **closing four narrow gaps** that products will hit immediately when they consume the consolidated surface.

Four thin presets + one store, each over existing primitives:

1. **`runPromptEvolutionCampaign`** — collapses 7129 LOC of `run-prompt-evolution.ts` to ~150 LOC of substrate preset + ~50 LOC of per-product config. Wraps `runMultiShotOptimization` (the GEPA implementation we already ship). Pluggable `Mutator` lets `AxGEPA` from `@ax-llm/ax` slot in as an alternate.
2. **`runProductionLoopCampaign`** + `openAutoPr` helper — collapses 1122 LOC of `run-production-loop.ts` to ~150 LOC. Runs in TWO modes: **CI cron** (opens PR for promoted candidate) OR **embedded in production runtime** (live worker continuously self-optimizes from real traces). Same primitive, two deployment shapes.
3. **`runMultiKindCampaign`** — first-class support for agent-builder's 6-kind dispatcher. agent-builder's `canonical-campaign.ts` (1098 LOC) → ~150 LOC consumer.
4. **`runUserJourneyCampaign`** — NEW preset for multi-SESSION simulation. A persona returns over many sessions with shared knowledge state; substrate sequences N `runMultishot` calls with state carried between them. Models "user uses the product for a month across many chats / button clicks."
5. **`LabeledScenarioStore`** — the auto-dataset that ALL of the above consume by default. Every trace from production OR from eval feeds into a continuously-updated labeled-scenario corpus. The next campaign run pulls from it. Closes the "datasets build themselves over time" requirement.

Total consumer LOC saved across 4 products: **~9,000**. Total substrate LOC added: **~600** (the multi-session + labeled-store additions to the previous ~400-LOC estimate).

The substrate stays in `@tangle-network/agent-eval`. No new packages. No new contracts beyond what 0.38 already ships (`Scenario` / `DispatchFn` / `JudgeConfig`). The 6-contract architecture I drafted earlier was over-reach.

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

### Addition 4: `runUserJourneyCampaign` (~100 LOC) — multi-session simulation

The product-shape every consumer actually wants: **simulate a real user across a month of sessions.** Not one chat, not even one multi-turn chat — many sessions over time, each starting from the state the previous one left behind (workspace knowledge accumulated, prior outputs visible, integrations connected).

```ts
runUserJourneyCampaign({
  // Persona + product:
  persona: JourneyPersona              // includes optional state-evolution callback
  profile: AgentProfile                // product agent being tested
  sessions: SessionScript[]            // ordered list of session intents
  // Optional carrying-state between sessions:
  initialKnowledge?: KnowledgeSeed
  sessionGap?: 'realtime' | { simulatedHoursBetween: number }   // affects "context staleness"
  // Standard eval surface:
  judges: JudgeConfig[]
  costCeiling?: number
  runDir: string
}) → JourneyResult                     // per-session artifacts + cumulative scorecard

interface JourneyPersona extends Persona {
  /** Called after each session — persona can update its own goals / mood / data based on what the product did last session. */
  evolveAfterSession?: (lastSessionArtifact: unknown, sessionIndex: number) => JourneyPersona
}

interface SessionScript {
  id: string
  intent: string                       // "come back to check on the campaign I set up last week"
  maxTurns?: number
  affectsKnowledge?: boolean           // when true, knowledge accumulated this session persists to next
}
```

Mechanically: a thin sequencer over `runMultishot`. Carries shared state (workspace knowledge, prior artifacts, integration grants) between sessions. The persona itself can mutate between sessions (a user who couldn't find a feature in session 1 should be MORE frustrated in session 2 — `evolveAfterSession` handles it).

Subsumes the "multi-month simulation" requirement: 30 sessions × the same persona = month-of-usage. The substrate doesn't model real time; it models session-ordering + state-carrying.

### Addition 5: `LabeledScenarioStore` (~80 LOC) — the autobuild dataset

Every trace from `runProductionLoopCampaign` (production runtime OR CI cron) AND every artifact from any other campaign feeds here, labeled by the judges that scored them. The next campaign run pulls scenarios from this store as the default source.

```ts
interface LabeledScenarioStore {
  // Capture phase — substrate-internal:
  observeTrace(args: { trace; artifact; judgeScores; persona; productSurface }): Promise<void>
  // Read phase — used as the default scenarios source for the next campaign:
  sample(args: { count: number; filter?: ScenarioFilter; split: 'train' | 'test' }): Promise<LabeledScenario[]>
  // Maintenance:
  size(): Promise<{ train: number; test: number }>
  /** Deduplicate by canonical hash of (persona, intent, productSurface). */
  dedupe(): Promise<{ removed: number }>
}
```

Backed by SQLite (local CI) or Turso (multi-tenant production). Substrate ships a `FileSystemLabeledScenarioStore` for local + a thin Turso adapter for remote.

**The compounding effect:** consumer adopts the substrate → every production interaction labels a scenario → next CI campaign pulls those scenarios → mutator proposes a candidate → gate decides → promoted profile ships → MORE production interactions, MORE scenarios, BETTER mutator candidates. The flywheel needs nothing from the consumer beyond the initial `handleChatTurn` hookup (already there).

---

## Part 3.5 — The substrate-IS-the-product-surface positioning

Drew's framing: "Same substrate that the products will ideally use themselves to gather this data. Eval AND production surface."

This isn't a code change — it's a deployment statement. `runProductionLoopCampaign` is designed to run in **two shapes**:

```
SHAPE A — CI cron (default consumer wiring):
  .github/workflows/production-loop.yml fires weekly
    → runProductionLoopCampaign reads from LabeledScenarioStore
    → analyst + mutator + gate
    → openAutoPr opens a PR with promoted profile
    → human reviews + merges

SHAPE B — embedded in production runtime:
  Cloudflare Worker or Node server boots with the substrate imported
    → background scheduler kicks runProductionLoopCampaign on user-traffic cadence
    → uses the SAME LabeledScenarioStore (now a Turso table the worker also writes to)
    → on promote: writes new addendum to a config row the chat handler reads next request
    → no PR, no human, the agent updates itself live (gated + costCeiling-bounded)
```

Both shapes share: the same `runProductionLoopCampaign` call, the same store, the same gates, the same judges. The only difference is WHAT THE GATE DOES WITH A PROMOTED CANDIDATE — open a PR (Shape A) or write to a config row (Shape B).

Substrate work to make Shape B robust:

- Ensure `runProductionLoopCampaign` doesn't assume Node CLI process env (Workers-compatible)
- `LabeledScenarioStore` has a Turso adapter (substrate ships it; consumer wires the Turso instance)
- The `openAutoPr` helper has a sibling `writeProductionConfig` helper that mutates a config row instead of opening a PR

Estimated extra LOC for Shape B compatibility: ~50 in substrate. Most of `runProductionLoopCampaign` is already runtime-pure.

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

### Ship plan (2 weeks honest with the multi-session + dataset additions)

| Day | Substrate side | Consumer side |
|---|---|---|
| 1-2 | `runPromptEvolutionCampaign` + `runProductionLoopCampaign` + `openAutoPr` + `writeProductionConfig` (Shape B) | — |
| 3 | `runMultiKindCampaign` | — |
| 4-5 | `runUserJourneyCampaign` (multi-session sequencer) + `LabeledScenarioStore` (FS adapter) | — |
| 6 | Turso adapter for `LabeledScenarioStore` + Worker-compat smoke for `runProductionLoopCampaign` Shape B | — |
| 7 | Tests + docs. Publish 0.39.0. | — |
| 8 | — | gtm migration (smoke `pnpm eval:optimize`) |
| 9 | — | legal + tax migrations in parallel |
| 10 | — | creative + agent-builder migrations |
| 11-12 | — | Live smokes across all 5; close PRs |

After landing: the lift cycle gets a permanent home. Adding a 6th product = 50 LOC of config, not 2000 LOC of copied wrappers. AND every product gets multi-session simulation + auto-dataset-accumulation + Shape-B-runtime-self-optimization by default. The substrate IS the product surface.

---

## Part 5 — What is NOT in scope for v1.0

| Future capability | Why deferred |
|---|---|
| `Scheduler` (cost/priority-aware cell ordering) | The substrate's existing `costCeiling` soft-abort is sufficient at our scale. Revisit when one consumer has >5 simultaneous campaigns. |
| `CycleStore` (cross-campaign findings) | The `LabeledScenarioStore` is the minimum needed; richer cross-campaign analysis can come later. |
| `PromotionPipeline` (dev → staging → prod) | Per-env promotion is done via per-env CI workflows today. Substrate doesn't need to model the env tree. |
| New contracts beyond `Scenario` / `DispatchFn` / `JudgeConfig` | We have what we need. |
| New packages | None. Everything stays in `agent-eval` / `agent-runtime` / `agent-knowledge` / `sandbox`. |
| New adoption skills | None. `agent-stack-adoption` + `agent-eval-adoption` cover what we need. They'll update naturally as the presets land. |
| JEPA / new ML primitives | Not in scope. GEPA via `runMultiShotOptimization` + `AxGEPA` via `@ax-llm/ax` Mutator is sufficient. |
| Text-only YAML config surface | Nice-to-have; v1.0 ships TypeScript-first config with optional YAML loader as a follow-up. |

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
- (a) Is the ~9,300 LOC consumer-reduction + 5 substrate additions (4 presets + 1 store) the right framing?
- (b) Multi-session simulation (`runUserJourneyCampaign`) the right primitive shape, or should we model time even more explicitly (real-time gaps, simulated calendar)?
- (c) Substrate-as-product Shape A + Shape B duality the right framing, or should production-runtime-self-optimization be a separate primitive?
- (d) 2-week ship sizing realistic, or do we discover unknowns in Shape B Worker compat or Turso `LabeledScenarioStore` adapter?
