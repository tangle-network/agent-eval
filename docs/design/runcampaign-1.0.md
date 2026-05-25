# Substrate v1.0 — one primitive, rich options, no preset proliferation

Status: **draft v4** — Drew + Claude, 2026-05-25
Owner: agent-eval substrate
Approach: collapse the wrappers, ship one primitive with flexible options. No new named presets. Tracing on by default.

## TL;DR

We've built every primitive a self-improving agent product needs. Across 4 product repos there are ~10,500 LOC of duplicated wrappers calling those primitives. Each wrapper is a slight curry of the same underlying flow.

v1.0 ships **one function** in agent-eval:

```ts
runCampaign({
  scenarios,                    // ANY scenario shape — personas, kinds, tasks, journeys
  dispatch,                     // ONE function: scenario+ctx → artifact
  sessions?,                    // multi-session sequencer (state-carrying between sessions)
  judges?,                      // pluggable JudgeConfig[]
  optimizer?,                   // mutator + population + generations → turns it into prompt evolution
  gate?,                        // promotion gate (held-out / cost / composed)
  autoOnPromote?,               // 'pr' (CI cron) | 'config' (live production) | 'none'
  trace?,                       // defaults to FileSystemTraceStore; opts out only
  costCeiling?,
  runDir,
})
```

Every existing wrapper — prompt evolution, production loop, matrix, multi-kind dispatch, multi-session journey — is a CONFIGURATION of `runCampaign`. No separate `runPromptEvolutionCampaign`, `runMultiKindCampaign`, `runUserJourneyCampaign` names. The semantics of those flows is in the options, not the name.

**Net change after v1.0:**
- Consumer code: **~10,500 → ~830 LOC** across 5 products (-9,670)
- Substrate add: **~400 LOC** (the `runCampaign` core + `LabeledScenarioStore` + tracing default + `openAutoPr` + `writeProductionConfig`)
- 0 new packages
- 0 new contracts beyond what 0.38 ships (`Scenario` / `DispatchFn` / `JudgeConfig`)
- 0 new adoption skills
- 0 new acronyms or ML primitives

---

## Package boundary (the line we draw)

Per Drew's framing — agent-runtime owns the **loops that autonomously run processes**, agent-eval owns the **primitives those loops invoke**, agent-knowledge owns **knowledge state**:

| Package | Owns |
|---|---|
| `@tangle-network/agent-eval` | **Eval primitives.** `runCampaign`, `runJudge`, `Mutator`, `Gate`, `TraceStore`, `LabeledScenarioStore`, `AnalystRegistry`, scorecards. |
| `@tangle-network/agent-runtime` | **Autonomous execution loops + the kernel.** `runLoop` (iteration), `runAnalystLoop` (trace→findings), `runProductionLoop` (scheduler around `runCampaign`), `auto-research-runner` (the autoresearch hook), `handleChatTurn`, MCP server + executors, OTEL exporter, cost ledger. |
| `@tangle-network/agent-knowledge` | **Knowledge state.** `searchKnowledge`, `proposeFromFindings`, `applyKnowledgeWriteBlocks`, `researcherProfile`. |
| `@tangle-network/sandbox` | Substrate types: `AgentProfile`, `Sandbox`, `streamPrompt`, `SandboxFleet`, `exportTraceBundle`. |

`runCampaign` is the primitive. The autonomous loops (`runProductionLoop`, `runAnalystLoop`, `auto-research-runner`) call it. A loop is just a scheduler — fire `runCampaign` on a cadence, observe results, decide next action.

`runLoop` (in agent-runtime) is the per-task iteration kernel — reused by ANY layer that wants N parallel attempts (product code giving a user 3 drafts, eval dispatchers running FanoutVote, mutator-driven re-runs).

---

## The one function

```ts
runCampaign<TScenario extends Scenario, TArtifact>(opts: {
  // ── Input ──────────────────────────────────────────────────────────
  scenarios: TScenario[]
  dispatch: (scenario: TScenario, ctx: DispatchContext) => Promise<TArtifact>
  /** When present, scenarios are run as sequences. Each `SessionScript` invokes dispatch
   *  with state carried from the prior session's artifact. Persona can `evolveAfterSession`
   *  to mutate between sessions (frustrated user after session 1 acts more frustrated in
   *  session 2). Models multi-month user simulation. */
  sessions?: SessionScript<TScenario, TArtifact>[]

  // ── Scoring ────────────────────────────────────────────────────────
  judges?: JudgeConfig<TArtifact, TScenario>[]    // empty allowed — eval without judging

  // ── Improvement (turns this into a production loop) ────────────────
  /** When present, runs N generations: mutator produces N candidate surfaces, each gets
   *  scored, top-K promoted. Replaces all `run-prompt-evolution.ts` wrappers. */
  optimizer?: {
    mutator: Mutator                               // reflective, gepa via runMultiShotOptimization, AxGEPA, custom
    populationSize: number
    maxGenerations: number
    surfaceExtractor: (profile: AgentProfile) => MutableSurface  // what's being optimized
  }
  /** When present, decides ship/hold/need-more-work/model-ceiling/arch-ceiling.
   *  Composed via `composeGate(heldOut, costBudget, manualReview)`. */
  gate?: Gate<TArtifact>
  /** What happens when gate decides 'ship':
   *  - 'pr': openAutoPr opens a PR with the new profile (CI cron mode)
   *  - 'config': writeProductionConfig updates a live config row (embedded runtime mode)
   *  - 'none': just report — caller decides */
  autoOnPromote?: 'pr' | 'config' | 'none'

  // ── Data accumulation (default on) ─────────────────────────────────
  /** Where labeled scenarios accumulate. Every artifact + score lands here, available
   *  as default `scenarios` source for the next runCampaign invocation. FS adapter
   *  for local, Turso for multi-tenant. Off only via `labeledStore: 'off'`. */
  labeledStore?: LabeledScenarioStore | 'off'

  // ── Tracing (default ON) ───────────────────────────────────────────
  /** FileSystemTraceStore at `.production-data/traces/` by default. OTEL exporter
   *  auto-attached when `OTEL_EXPORTER_OTLP_ENDPOINT` env is set. Off only via
   *  `tracing: 'off'`. */
  tracing?: TraceStore | 'off'

  // ── Knobs ──────────────────────────────────────────────────────────
  costCeiling?: number
  maxConcurrency?: number
  reps?: number
  runDir: string
}): Promise<CampaignResult<TArtifact, TScenario>>
```

That's the entire substrate surface. Every existing wrapper across products is a partial application of these options.

### Examples mapping to the duplicated wrappers

```ts
// gtm's eval:multishot (today's run-prompt-evolution.ts: 1436 LOC)
// After v1.0: ~40 LOC
runCampaign({
  scenarios: cartesian(profiles, personas),
  dispatch: multishotDispatch(/* uses runMultishot under the hood */),
  judges: [gtmConvo, gtmCodeReview, gtmContentQuality],
  runDir,
})

// legal's eval:production-loop (today: 352 LOC)
// After v1.0: ~50 LOC
runCampaign({
  scenarios: labeledStore.sample({ count: 30, split: 'train' }),
  dispatch: chatDispatch(productionProfile),
  judges: [legalConvo, legalCitation],
  optimizer: { mutator: reflectiveMutator, populationSize: 8, maxGenerations: 5, surfaceExtractor: p => p.prompt!.systemPrompt },
  gate: composeGate(heldOutGate({ holdoutScenarios }), costBudgetGate(50)),
  autoOnPromote: 'pr',
  runDir,
})

// agent-builder's canonical-campaign.ts (today: 1098 LOC across 6 scenario kinds)
// After v1.0: ~120 LOC
runCampaign({
  scenarios: agentBuilderScenarios,          // tagged union of 6 kinds
  dispatch: (s, ctx) => kindDispatchers[s.kind](s, ctx),  // route by kind
  judges: judgesByKind,
  runDir,
})

// tax's multi-month user simulation (new capability)
// 30 sessions of one persona over a month, state-carrying
runCampaign({
  scenarios: [johnDoeTaxClient],
  dispatch: multishotDispatch(taxProfile),
  sessions: [
    { id: 'intake', intent: 'Initial 1040 questions', affectsKnowledge: true },
    { id: 'follow-up-1', intent: 'Returned after gathering W-2s' },
    // ... 28 more sessions
  ],
  judges: [taxConvo, taxRiskDisclosure],
  runDir,
})

// Production runtime embedded self-optimization (Shape B)
// Runs in a Cloudflare Worker, mutates the live agent config on promote
runCampaign({
  scenarios: labeledStore.sample({ count: 20, split: 'train' }),
  dispatch: chatDispatch(productionProfile),
  optimizer: { mutator: gepaMutator, populationSize: 4, maxGenerations: 3 },
  gate: composeGate(heldOutGate, conservativeCostGate(5)),
  autoOnPromote: 'config',   // writes to config row instead of opening PR
  costCeiling: 5,
  runDir: '/tmp/live-runs/' + Date.now(),
})
```

Same function. Five wildly different use cases. The use case lives in the OPTIONS, not in a naming taxonomy.

---

## What lights up when consumers adopt

Drop-in `runCampaign` + `handleChatTurn` (already in every product). Substrate auto-wires:

1. **Tracing ON by default** — every chat turn captured to `FileSystemTraceStore`, OTEL-exported if env is set
2. **`LabeledScenarioStore` populated by every artifact** — production + eval both feed it
3. **Next `runCampaign` invocation** (CI cron OR live worker) pulls from the labeled store automatically
4. **Mutator** (reflective via `runMultiShotOptimization`, or `AxGEPA`, or custom) generates candidates
5. **Gate** decides ship/hold/needs-more-work
6. **`autoOnPromote`** opens PR (Shape A) or updates live config (Shape B)
7. The flywheel: more interactions → more labeled scenarios → better candidates → better profile → MORE interactions

**Substrate IS the product surface.** Same primitive runs in CI as a cron OR in the production worker as a background scheduler. Same store sources both.

---

## Migration

| Product | Before | After | Δ |
|---|---|---|---|
| gtm-agent | 1606 LOC wrappers | ~150 LOC | **-1456** |
| legal-agent | 2464 LOC | ~180 LOC | **-2284** |
| tax-agent | 3371 LOC | ~200 LOC | **-3171** |
| creative-agent | 2015 LOC | ~150 LOC | **-1865** |
| agent-builder | 1098 LOC | ~150 LOC | **-948** |
| **Total** | **10,554** | **~830** | **-9,724** |

Substrate addition: ~400 LOC (the `runCampaign` core + helpers).

**Risk: per-product wrapper drift.** Across the 4 `run-prompt-evolution.ts` (~1900 LOC each), differences are mostly format/persona-shape, but bug fixes drifted. Migration plan must DIFF the 4 versions, identify unique fixes, fold them into the substrate before deleting. ~1 day.

### Ship plan (2 weeks honest)

| Day | Substrate | Consumer |
|---|---|---|
| 1-2 | `runCampaign` core in agent-eval. Tracing-on-by-default. `LabeledScenarioStore` (FS adapter). | — |
| 3 | `LabeledScenarioStore` Turso adapter. `openAutoPr` + `writeProductionConfig` helpers. | — |
| 4 | `runProductionLoop` scheduler in agent-runtime (Shape A + B). Pluggable mutator (reflective, AxGEPA wrapper). | — |
| 5 | Tests + docs. Publish `agent-eval@0.39.0` + `agent-runtime@0.25.0`. | — |
| 6 | DIFF the 4 product `run-prompt-evolution.ts` files. Fold unique fixes into substrate. | — |
| 7-8 | — | gtm + legal migrations |
| 9-10 | — | tax + creative migrations |
| 11 | — | agent-builder migration (multi-kind dispatch validation) |
| 12 | — | Live smokes across 5; close PRs. v1.0 frozen. |

---

## What is NOT in v1.0

- No new packages
- No new contracts beyond `Scenario` / `DispatchFn` / `JudgeConfig` (0.38)
- No new adoption skills — existing skills update naturally
- No ML primitive invention (GEPA via `runMultiShotOptimization` + `AxGEPA` via `@ax-llm/ax` Mutator covers prompt optimization; analyst loop covers trace→findings)
- No YAML-first surface (TypeScript-first; YAML loader is a follow-up)
- No `Scheduler` / `CycleStore` / `PromotionPipeline` contracts (deferred — current `costCeiling` + `LabeledScenarioStore` + CI workflows cover today)
- No real-time / streaming evals (batch-oriented; streaming when a consumer needs it)
- No PR-opening-as-substrate-policy (the `openAutoPr` helper is a thin shell-out; products can override)

---

## Open sign-off

- (a) Is **one function with rich options** the right cut? Or are 2-3 named presets clearer to consumers?
- (b) Package boundary: agent-runtime owns the LOOPS (`runProductionLoop` scheduler, `runAnalystLoop`, `auto-research-runner`), agent-eval owns the PRIMITIVE (`runCampaign`). Is this split clean?
- (c) Is tracing-on-by-default the right default, or is opt-in safer?
- (d) Is 2-week ship + migration plan realistic given the wrapper-diff work in day 6?

When you sign off, this becomes the v1.0 implementation track. After v1.0 lands, the substrate stops being a maintenance burden — adding a 6th product is 50 LOC of config, not 2000 LOC of wrapper.
