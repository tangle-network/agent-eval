# `runCampaign` — the v1.0 substrate design

Status: **draft for review** — Drew + Claude, 2026-05-25
Owner: agent-eval substrate
Replaces: the lift-extract-refactor cycle that has produced `runAgentMatrix` (0.36), OTEL export (0.37), and `runMultishot` (0.38) as separate primitives each locking some enumeration.

## TL;DR

Today we keep extracting new "run-something" primitives from consumer products: `runAgentMatrix`, `runMultishot`, `runMultishotMatrix`, `runProductionLoop`, soon `runMultiKindCampaign`. Each one is correct for its slice but locks the variant set. The next product needs variant N+1 → we lift again. **The loop ends when the substrate ships SHAPES instead of ENUMERATIONS.**

This doc specifies the v1.0 substrate:

- **ONE generic primitive**: `runCampaign<TScenario, TArtifact>(opts)`
- **SIX contracts**: `Scenario`, `DispatchFn`, `JudgeConfig`, `Analyst`, `Mutator`, `Gate`
- **THREE thin presets** (each ~50 LOC): `runChatCampaign`, `runMatrixCampaign`, `runMultiKindCampaign`
- **THREE stubbed-but-named contracts** for the future: `Scheduler`, `CycleStore`, `PromotionPipeline`

After v1.0 consumers extend by IMPLEMENTING contracts. The substrate doesn't change for new domains. Self-improvement is structural: the substrate eats its own dogfood by feeding its own examples into `runCampaign`.

---

## Part 1 — The lift cycle, and why it ends

### What we've actually built (inventory)

`agent-runtime` (kernel — these primitives are HORIZONTAL: product code, eval dispatchers, and improvement mutators all use them):

| Primitive | Job | Used by |
|---|---|---|
| `runAgentTask` / `runAgentTaskStream` | Single task lifecycle: input → backend → events → output | product / eval |
| `runLoop` + `Refine` / `FanoutVote` drivers | Multi-iteration of ONE task spec, picks winner via validator. **Reused at product layer (give user N drafts), eval layer (dispatcher reaches for it for diversity), improvement layer (per-mutator-candidate re-run).** | product / eval / improvement |
| `handleChatTurn` | Chat-turn envelope (NDJSON + session.run.* lifecycle) |
| `coderProfile` / `researcherProfile` | Preset `AgentProfile` factories with output + validator wired |
| `createOpenAICompatibleBackend` / `createSandboxPromptBackend` | Backends |
| `runAnalystLoop` | Reads traces → produces findings |
| `defineAgent` | Declarative per-vertical manifest |
| MCP server + executors (sibling / fleet / in-process Phase 2.8) | Delegation surface inside sandboxes |
| `TraceEmitter` + OTEL exporter (0.23) | Distributed tracing |
| `RuntimeRunHandle` + cost ledger | Production-run persistence |

`agent-eval` (orchestration):

| Primitive | Job |
|---|---|
| `runEvalCampaign` | Scenarios through a dispatcher, per-cell artifacts collected |
| `runAgentMatrix` (0.36) | N-axis cartesian over scenarios + axes + reps |
| `runMultishot` / `runMultishotMatrix` (0.38) | Multi-turn driver-agent loop + matrix wrapper |
| `runJudge` (0.38) | Generic dimensional scorer with JSON parsing |
| `runProductionLoop` | Analyst + mutator + gate cycle |
| `runMultiShotOptimization` | GEPA-style prompt evolution |
| `evaluateReleaseConfidence` / `HeldOutGate` | Promotion gates |
| `AnalystRegistry` | Pluggable analysts (proto for the contract this doc formalizes) |
| `FileSystemTraceStore` / `FileSystemRawProviderSink` | Capture infra |

### Where the lift loop has hit us

| Lift | Concrete primitive shipped | Extension point it LOCKED |
|---|---|---|
| 0.36 matrix | `runAgentMatrix(axes)` | None — caller writes runCell; healthy |
| 0.37 OTEL | `runJudge` + span emitters | None — pluggable dimensions; healthy |
| 0.38 multishot | `runMultishot` with exactly 3 judge slots (conv + code + content) + exactly 2 tool defaults (delegate_research + delegate_code) | **Locked**: 4th judge category requires substrate change. New tool defaults require substrate change. |
| (queued) multi-kind | If we ship `runMultiKindCampaign({ kinds: 6 enumerated })` we'll lock the kind set | About to lock again unless we ship the SHAPE |

The 0.38 multishot pattern is correct for chat products (gtm/legal/tax) but already wrong-shaped for agent-builder, which has **six scenario kinds** (builder-sim / customer-sim / forge-chat / forge-chat-multi-turn / knowledge-authoring / integration-grant) running through **three production wrappers** (`runForgeBuilderSim` / `runCustomerSim` / `runForgeChatThroughRuntime`).

This is the next lift — UNLESS v1.0 ships the contract instead.

### Why the loop persists architecturally

Each lift assumed the variant set was small + enumerable: "three judges should cover everything"; "two tools cover everything"; "chat handler is the only dispatcher." Each was true at the moment of lift. None was true two products later.

**Two architectural rules the substrate violates today:**

1. **Never enumerate when you could parameterize.** Today: `judges: { conversation, codeReview, contentQuality }` (3-slot enumeration). Should be: `judges: JudgeConfig[]` (parameterized).
2. **Never ship a primitive without a contract underneath it.** Today: `runMultishot` is a concrete entry point. Should be: `runCampaign + ChatScenario + ChatDispatch + ConversationJudge` (contracts) → `runMultishot` becomes a thin preset that wires defaults.

V1.0 enforces both rules.

---

## Part 2 — The v1.0 shape

### The primitive

```ts
runCampaign<TScenario extends Scenario, TArtifact>(opts: {
  scenarios: TScenario[]
  dispatch: DispatchFn<TScenario, TArtifact>
  judges?: JudgeConfig<TArtifact, TScenario>[]    // empty array allowed — eval without scoring
  analysts?: AnalystRegistry                       // optional: improvement loop reads
  mutators?: MutatorRegistry                       // optional: improvement loop writes
  gate?: Gate<TArtifact>                           // optional: ship/hold decision
  scheduler?: Scheduler                            // future: cost/priority-aware (stubbed v1)
  cycleStore?: CycleStore                          // future: cross-campaign cycle state (stubbed v1)
  promotion?: PromotionPipeline                    // future: env-stack promotion (stubbed v1)
  trace: TraceStore                                // required: substrate already mandates traces
  artifacts: ArtifactStore                         // required: per-cell persistence
  costCeiling?: number                             // global $ cap, soft-abort past
  maxConcurrency?: number
  runDir: string                                   // root for artifacts + traces
  reps?: number                                    // replicates per scenario
}): Promise<CampaignResult<TArtifact, TScenario>>
```

### The six contracts

#### 1. `Scenario`

```ts
interface Scenario {
  /** Unique within a campaign. Used as artifact path + matrix axis key. */
  id: string
  /** Discriminator for multi-kind dispatchers. Single-kind campaigns can hard-code 'default'. */
  kind: string
  /** Optional per-scenario tags for filtering / aggregation. */
  tags?: string[]
}
```

That's it. Consumer scenarios EXTEND this with their per-kind payload (persona, task, requirement, whatever).

#### 2. `DispatchFn<TScenario, TArtifact>`

```ts
type DispatchFn<TScenario, TArtifact> = (
  scenario: TScenario,
  ctx: DispatchContext,
) => Promise<DispatchResult<TArtifact>>

interface DispatchContext {
  cellId: string                  // <scenarioId>:<rep>
  rep: number
  signal: AbortSignal
  trace: TraceWriter              // scoped: every span auto-tagged with cellId
  artifacts: ArtifactWriter       // scoped: writes land under runDir/cellId/
  cost: CostMeter                 // accumulates LLM + sandbox spend per cell
  cycleId?: string                // populated when this run is part of a multi-cycle campaign
  prior?: PriorRunHandle          // populated for improvement loops — read prior cell's findings
}

interface DispatchResult<TArtifact> {
  artifact: TArtifact
  costUsd?: number                 // optional; ctx.cost auto-tracks if backend reports
  durationMs?: number              // auto-tracked by substrate if not provided
}
```

This is the ONE escape hatch the substrate gives consumers: dispatch can do anything. Spawn a sandbox. Spawn a child process. Call an HTTP endpoint. Invoke `runLoop` with a coder profile. Invoke `runMultishot`. Whatever produces the artifact.

#### 3. `JudgeConfig<TArtifact, TScenario>`

Already implemented in 0.38; this just becomes 2-arg generic + lands at the campaign level:

```ts
interface JudgeConfig<TArtifact, TScenario> {
  name: string
  model?: string
  dimensions: JudgeDimension[]
  systemPrompt: string
  buildPrompt: (input: { artifact: TArtifact; scenario: TScenario }) => string
  // optional: scope which scenarios this judge applies to
  appliesTo?: (scenario: TScenario) => boolean
}
```

`appliesTo` is the upgrade — a 4-judge-category product can run `legalCorrectness` only on legal scenarios, `codeCorrectness` only on code-producing scenarios. No 3-slot enumeration. No substrate change to add a 5th.

#### 4. `Analyst`

```ts
interface Analyst<TFindings = unknown> {
  kind: string                              // 'reflective' / 'failure-cluster' / 'cycle-detect' / ...
  /** Read traces produced by `runCampaign` for THIS scenario kind (or all kinds), emit findings. */
  analyze(args: {
    traces: TraceQuery
    scenarios: Scenario[]
    artifacts: ArtifactReader
    priorFindings?: TFindings[]
    signal: AbortSignal
  }): Promise<TFindings[]>
}

interface AnalystRegistry {
  register(analyst: Analyst): void
  /** Substrate iterates registered analysts in order on every cycle. */
  list(): ReadonlyArray<Analyst>
}
```

`AnalystRegistry` already exists in `agent-eval` (proto for this contract); the upgrade is the typed Findings parameter.

#### 5. `Mutator`

```ts
interface Mutator<TSurface, TFindings = unknown> {
  kind: string                              // 'reflective-addendum' / 'gepa' / 'feature-toggle' / ...
  /** Given findings + the current mutable surface (system prompt, tools, scaffold), propose candidates. */
  mutate(args: {
    findings: TFindings[]
    currentSurface: TSurface
    populationSize?: number
    signal: AbortSignal
  }): Promise<TSurface[]>                  // returns N candidate surface variants
}
```

The MOSS-paper alignment lives here. Mutators can be reflective-mutation, GEPA-style population search, manual-template-substitution, etc. Consumer picks which to register.

#### 6. `Gate<TArtifact>`

```ts
interface Gate<TArtifact> {
  decide(args: {
    candidateArtifacts: Map<string, TArtifact>  // by cellId
    baselineArtifacts?: Map<string, TArtifact>  // optional reference run
    judgeScores: Map<string, JudgeScore[]>      // by cellId
    cost: { candidate: number; baseline: number }
    signal: AbortSignal
  }): Promise<{
    decision: 'ship' | 'hold' | 'need_more_work' | 'model_ceiling' | 'arch_ceiling'
    reason: string
    delta?: number
  }>
}

// Composition: products want held-out + cost + manual-review combined.
function composeGate<T>(...gates: Gate<T>[]): Gate<T>
```

`HeldOutGate` and `evaluateReleaseConfidence` become two instances of `Gate`. The four-verdict taxonomy (`ship | hold | need_more_work | model_ceiling | arch_ceiling`) is the MOSS paper's verdict set, lifted into the contract.

### The three presets

Each preset is a thin wrapper over `runCampaign`. The presets exist for ergonomics, not because the substrate has multiple primitives:

```ts
// preset 1: chat scenarios across one or many profiles
runChatCampaign(opts: {
  profiles: AgentProfile[]
  scenarios: ChatScenario[]
  judges?: JudgeConfig<ChatArtifact, ChatScenario>[]
  ...
}): Promise<CampaignResult<ChatArtifact, ChatScenario>>

// Implementation (~30 LOC):
async function runChatCampaign(opts) {
  return runCampaign({
    scenarios: cartesianProduct(opts.profiles, opts.scenarios),  // axes flattened to scenarios
    dispatch: async (scenario, ctx) => {
      const stream = runChatThroughRuntime({
        profile: scenario.profile,
        userMessage: scenario.userMessage,
        ...
      })
      const text = await drainStream(stream, ctx.signal)
      return { artifact: { text, profile: scenario.profile.name } }
    },
    ...opts,
  })
}

// preset 2: matrix sweep
runMatrixCampaign(opts: {
  axes: MatrixAxis[]
  dispatch: DispatchFn<MatrixScenario, TArtifact>
  ...
})

// preset 3: multi-kind dispatch — subsumes agent-builder's pattern
runMultiKindCampaign(opts: {
  scenarios: AnyScenario[]            // tagged union of scenario kinds
  dispatchers: Record<string, DispatchFn<TaggedScenario, TArtifact>>
  ...
})

// Implementation:
async function runMultiKindCampaign(opts) {
  return runCampaign({
    scenarios: opts.scenarios,
    dispatch: (scenario, ctx) => {
      const handler = opts.dispatchers[scenario.kind]
      if (!handler) throw new Error(`no dispatcher registered for kind=${scenario.kind}`)
      return handler(scenario, ctx)
    },
    ...opts,
  })
}
```

`runMultishot` from 0.38 becomes a fourth preset (`runMultishotCampaign`) that pre-wires the driver-agent dispatch + the 3-judge default. Backwards-compatible.

### Where `runLoop` lives (it's a horizontal primitive, not just an eval-dispatch tool)

**`runLoop` stays in `agent-runtime`** because it's the iteration kernel — given ONE task spec + a driver (Refine or FanoutVote) + a validator, run N iterations, pick winner. That positioning is correct, but the broader truth is that `runLoop` is reused at **three different layers** with the same shape:

```
┌─ Improvement layer (runCampaign + mutator population) ───┐
│  When the mutator generates N candidate surfaces, each   │
│  one needs to be evaluated as a coherent multi-attempt   │
│  task. `runLoop` handles that per-candidate iteration.   │
└──────────────────────────────────────────────────────────┘
              │ uses
              ▼
┌─ Eval layer (runCampaign dispatchers) ───────────────────┐
│  A campaign dispatcher chooses runLoop when one scenario  │
│  warrants N parallel attempts (coder fanout, researcher   │
│  multi-source, etc.). Single-turn dispatchers skip it.    │
└──────────────────────────────────────────────────────────┘
              │ uses
              ▼
┌─ Product layer (runtime / chat handler) ─────────────────┐
│  Production chat code can run `runLoop` directly to give  │
│  a USER N parallel drafts (e.g., "3 generated emails,     │
│  pick the best") without involving any eval system.       │
└──────────────────────────────────────────────────────────┘
```

This is the substrate-correctness point: `runLoop` is not OWNED by eval. It's a **horizontal iteration primitive** that product code, eval dispatchers, and improvement mutators all consume. Same call signature, same semantics, three different invocation contexts.

**At the eval layer**, the campaign dispatcher chooses whether to use it:

```ts
runCampaign({
  scenarios: codingTasks,
  dispatch: async (task, ctx) => {
    // FanoutVote(3) inside ONE scenario cell
    const result = await runLoop({
      task,
      driver: createFanoutVoteDriver({ n: 3 }),
      validator: coderValidator(task),
      sandboxClient: ctx.sandbox,
      traceEmitter: ctx.trace.toLoopEmitter(),
      runHandle: ctx.runHandle,
    })
    return { artifact: result.winner.output }
  },
})
```

**At the product layer**, the chat handler reaches for it directly:

```ts
// In gtm-agent's email-drafting flow (product code, no eval system involved):
const result = await runLoop({
  task: { intent: 'draft 3 launch announcement emails' },
  driver: createFanoutVoteDriver({ n: 3 }),
  validator: emailQualityValidator,
  sandboxClient,
})
showUser(result.candidates)  // user picks one
```

**At the improvement layer**, the mutator-driven re-run uses it per candidate surface:

```ts
// Inside runCampaign's mutator phase:
for (const candidateSurface of mutatorOutputs) {
  const result = await runLoop({
    task: scenarioWithSurface(scenario, candidateSurface),
    driver: createRefineDriver({ maxIterations: 3 }),
    validator: scenarioValidator,
    sandboxClient: ctx.sandbox,
  })
  candidateArtifacts.set(candidateSurface.id, result.winner.output)
}
```

So `runLoop` is the iteration primitive everywhere. `runCampaign` is the scenario-orchestration primitive in eval. The two compose naturally; neither owns the other.

The architectural rule this encodes: **iteration of ONE task is runtime; orchestration of MANY scenarios is eval.** Both are first-class. Both are reusable across layers.

### Sandbox topology: per-cell vs shared vs fleet

Drew's question: "run inside the same sandbox or what?" This is a real config choice with three sensible answers:

```ts
runCampaign({
  ...
  sandboxTopology:
    | { kind: 'per-cell' }                              // current default; each cell spawns a sandbox
    | { kind: 'shared'; box: SandboxInstance }          // all cells run sequentially in one sandbox
    | { kind: 'fleet'; fleet: FleetHandle }             // cells round-robin across fleet workers
    | { kind: 'in-process'; repoRoot: string }          // no sandbox — Phase 2.8 in-process executor
})
```

The substrate's job: hand the dispatcher a `ctx.sandbox` that resolves correctly per topology choice. Dispatcher code is identical across topologies.

**Trade-offs:**

| Topology | Isolation | Cost | When to use |
|---|---|---|---|
| per-cell | strong | high | paid production eval, regulator-audit-ready |
| shared | weak (state leak between cells) | low | dev iteration, fast feedback |
| fleet | strong (workspace-mounted, machine-isolated) | medium | multi-machine workload, agent-builder-scale |
| in-process | shared FS (Phase 2.8) | lowest | recursive eval, harness-CLI delegations |

V1.0 defaults to per-cell with `costCeiling` enforcement. Other topologies are opt-in via the `sandboxTopology` field.

### Self-improvement of the substrate itself

When `runCampaign` evaluates the substrate's own examples (e.g., `examples/self-improving-loop/` produces predictable artifacts that the substrate can score), the substrate uses ITS OWN `runCampaign` to do it. Recursive eval. The substrate eats its own dogfood by construction.

```ts
// In agent-eval's own CI:
runCampaign({
  scenarios: substrateExamples,                       // every example/*/example.ts
  dispatch: async (example, ctx) => {
    const output = await runExample(example.path)
    return { artifact: { stdout: output.stdout, exitCode: output.exitCode } }
  },
  judges: [exampleJudge],                             // judges the example output shape
  analysts: [exampleRegressionAnalyst],               // finds when an example output regressed
  mutators: [exampleDocstringMutator],                // proposes README updates
  gate: composeGate(exampleStabilityGate, costGate),  // composed gates
  ...
})
```

No special "meta-eval" primitive needed. The substrate just runs itself.

### Migration: existing primitives → presets

| Today | After v1.0 | LOC change |
|---|---|---|
| `runEvalCampaign` | Preset `runEvalCampaign` over `runCampaign` | ~50 LOC down |
| `runAgentMatrix` | Preset `runMatrixCampaign` over `runCampaign` | ~50 LOC down |
| `runMultishot` | Preset `runMultishotCampaign` over `runCampaign` | ~80 LOC down |
| `runMultishotMatrix` | Preset that composes `runMatrixCampaign` + multishot dispatch | ~60 LOC down |
| `runProductionLoop` | Preset that wires analyst + mutator + gate over `runCampaign` | ~120 LOC down |
| `runMultiShotOptimization` | Becomes an `AnalystRegistry` + `MutatorRegistry` registration; campaign sees one cycle | ~150 LOC down |
| `runLoop` | UNCHANGED in agent-runtime; consumed by dispatch | 0 |

Net: agent-eval LOC down ~500 (presets are thinner than current primitives). Capability up (multi-kind, gate composition, scenario tagging).

---

## Part 3 — The three stubbed contracts (forecast)

V1.0 names these as contracts but ships them empty. Adding implementations later is additive (no breaking change).

### `Scheduler` — cost/priority-aware cell ordering

Today the matrix scheduler does dumb concurrency-capped iteration with soft-abort past `costCeiling`. Real production wants:
- Prioritize scenarios by recency × failure-rate
- Skip low-priority cells when budget tightens
- Multi-tenant fairness (one workspace's heavy campaign can't starve another's)

Contract:

```ts
interface Scheduler {
  schedule(args: {
    pendingCells: Cell[]
    runningCells: Cell[]
    completedCells: Cell[]
    budget: { remainingUsd: number; remainingCells: number }
    signal: AbortSignal
  }): Promise<{ next: Cell[]; skip?: Cell[]; reason?: string }>
}
```

### `CycleStore` — cross-campaign findings persistence

When campaign A produces findings that should inform campaign B (e.g., production-loop campaign in week 1 finds a bug pattern; week 2's campaign should test against it), substrate needs a place to persist findings KEYED by something other than runId.

Contract:

```ts
interface CycleStore<TFindings = unknown> {
  appendFindings(cycle: { id: string; kind: string; findings: TFindings[] }): Promise<void>
  queryFindings(filter: { kind?: string; since?: Date }): Promise<Array<{ cycle: string; findings: TFindings[] }>>
}
```

### `PromotionPipeline` — env-stack promotion

dev → staging → prod with different gates per env. Substrate doesn't have this as a first-class concept today. Producs hand-wire CI workflows.

Contract:

```ts
interface PromotionPipeline {
  stages: PromotionStage[]
  promote(candidate: PromotionCandidate, fromStage: string): Promise<{ promoted: boolean; toStage?: string; reason: string }>
}
```

---

## Part 4 — Layering, naming, package boundary

### What goes where

**`@tangle-network/agent-runtime` — kernel**:
- `runAgentTask`, `runAgentTaskStream`, `handleChatTurn`, `runLoop`, drivers, profiles, backends, MCP, OTEL, cost ledger
- UNCHANGED for v1.0. The kernel is correct.

**`@tangle-network/agent-eval` — orchestration**:
- `runCampaign` (new — the primitive)
- 6 contract types: `Scenario`, `DispatchFn`, `JudgeConfig`, `Analyst`, `Mutator`, `Gate`
- 3 stubbed contracts: `Scheduler`, `CycleStore`, `PromotionPipeline`
- 4 presets: `runEvalCampaign` (DEPRECATED ALIAS), `runChatCampaign`, `runMatrixCampaign`, `runMultiKindCampaign`, `runMultishotCampaign`
- Existing helpers: `runJudge`, `AnalystRegistry`, `TraceStore`, gates

**`@tangle-network/agent-knowledge` — knowledge primitives**:
- UNCHANGED. `researcherProfile`, `searchKnowledge`, `proposeFromFindings`, `applyKnowledgeWriteBlocks`. Knowledge writes are an Artifact kind that `runCampaign` happens to produce; the substrate is symmetric here.

**`@tangle-network/sandbox` — execution surface**:
- UNCHANGED. `AgentProfile`, `Sandbox`, `streamPrompt`, `SandboxFleet`, `exportTraceBundle`.

### Naming: do we deprecate the old primitives?

Yes — but deprecation, not removal:

- `runEvalCampaign` becomes an alias for `runCampaign`. Same shape, additive.
- `runAgentMatrix` becomes an alias for `runMatrixCampaign`. Same call signature.
- `runMultishot` / `runMultishotMatrix` get preserved as `runMultishotCampaign` (single preset that handles both single-cell and matrix-sweep).
- `runProductionLoop` becomes an alias for `runCampaign` with analyst+mutator+gate wired.

Consumers can migrate at their own pace. The substrate ships v1.0 with all aliases present + a 6-month deprecation window before removal in v2.0.

---

## Part 5 — v1.0 ship plan

**Timeline: 2–3 weeks of focused work.**

### Week 1: substrate refactor

- Day 1-2: write `runCampaign<T>` core + the 6 contracts as types. No implementation logic changes yet.
- Day 3: refactor `runEvalCampaign` to be a thin preset over `runCampaign`. Tests pass.
- Day 4: refactor `runAgentMatrix` to be `runMatrixCampaign`. Tests pass.
- Day 5: refactor `runMultishot` + `runMultishotMatrix` to be `runMultishotCampaign`. Tests pass.

### Week 2: multi-kind + production-loop + gates

- Day 1-2: add `runMultiKindCampaign` preset. Test with the 6 agent-builder kinds.
- Day 3: refactor `runProductionLoop` to be a preset that registers analyst + mutator + gate. Tests pass.
- Day 4: `composeGate` helper. Verdict taxonomy (`ship | hold | need_more_work | model_ceiling | arch_ceiling`). Tests pass.
- Day 5: stub `Scheduler`, `CycleStore`, `PromotionPipeline` interfaces. Add to public exports as `@experimental`.

### Week 3: consumer migration + 1.0 release

- Day 1-2: agent-builder migration — replace `canonical-campaign.ts` (1098 LOC) with `runMultiKindCampaign` consumer (~150 LOC).
- Day 3: gtm/legal/tax consumer migration — replace local `matrix.ts` (~92 LOC each) with `runMultishotCampaign` consumer (~50 LOC each).
- Day 4: substrate self-eval — `examples/self-improving-loop/` becomes a CI-runnable campaign.
- Day 5: `1.0.0` release. Semver guarantee: no breaking changes to `runCampaign` or the 6 contracts before 2.0.

---

## Part 6 — What this prevents

| Future demand | Pre-v1.0 (today) | Post-v1.0 |
|---|---|---|
| New product wants 4 judge categories | Substrate change | Add a `JudgeConfig` to the array |
| New product wants 7th scenario kind | Substrate change | Register a dispatcher |
| New product wants custom analyst | Substrate change | Register to `AnalystRegistry` |
| New product wants 3 different mutator strategies | Substrate change | Register 3 to `MutatorRegistry` |
| Multi-tenant cost-attribution | Substrate change | Provide a `Scheduler` impl |
| Cross-campaign cycle tracking | Substrate change | Provide a `CycleStore` impl |
| Promotion pipeline (dev/staging/prod) | Substrate change | Provide a `PromotionPipeline` impl |
| Recursive eval (substrate evals itself) | Build a new primitive | Run `runCampaign` on substrate examples |
| Real-time streaming evals | Build a new primitive | Add a `streamingMode` config (additive) |

The substrate stops being the blocker.

---

## Part 7 — The "is this a deeper challenge?" honest answer

Yes, AND it's tractable. Three disciplines:

1. **Never enumerate when you could parameterize.** Today's `judges: { conv, code, content }` violates this. v1.0 fixes it (`judges: JudgeConfig[]`).
2. **Never ship a primitive without a contract underneath it.** Today's `runMultishot` violates this. v1.0 fixes it (it's a preset over `runCampaign` + contracts).
3. **The substrate's own examples are scenarios in its own `runCampaign`.** Forces dogfooding. The substrate can't ship a v1.1 that breaks its own eval — its own CI is the canary.

After v1.0, the substrate's API changes only when a new CONTRACT emerges from real consumer use. Contracts are additive (new contract = new optional field on `runCampaign` opts). The substrate becomes boring infrastructure. Which is the point.

---

## Part 8 — Open questions for review

1. **Does `runCampaign` belong in `agent-eval` or do we hoist to a new `@tangle-network/agent-core` package?** Argument for hoist: `runCampaign` references nothing in eval; it's pure orchestration. Argument against: every consumer already depends on agent-eval; adding a 5th package is friction. **Recommendation: keep in agent-eval; revisit at 2.0 if eval gets too big.**

2. **Should the verdict taxonomy be 4-valued (`ship | hold | need_more_work | ceiling`) or 5-valued (`ship | hold | need_more_work | model_ceiling | arch_ceiling`)?** MOSS paper distinguishes model-ceiling vs arch-ceiling. Both are useful but the distinction is hard to make algorithmically. **Recommendation: 5-valued, with the substrate documenting that gates returning `model_ceiling` vs `arch_ceiling` should explain rationale in the `reason` string.**

3. **How do consumers compose `Analyst` + `Mutator` pairs that share a `Findings` type?** TypeScript generics suffice if both register at the same type. If a consumer wants to pair analyst A with mutator B-not-A and the findings shapes differ, they must declare an adapter. **Recommendation: substrate provides `adaptFindings<A, B>(adapter)` helper; runtime check warns when shapes don't compose.**

4. **What's the deprecation window for the v0.x primitives?** Six months is generous. Some consumers will lag. **Recommendation: 6 months from v1.0; v2.0 removes the aliases.**

5. **Self-eval-as-CI: how often should the substrate's own `runCampaign` against its own examples gate releases?** **Recommendation: every PR (cheap — examples run offline) + nightly (live LLM eval against pinned scoring rubric).**

---

## Sign-off

Draft for review. Drew's review priorities:

- (a) Is the 6-contract surface the RIGHT cut? Anything to add or merge?
- (b) Is `runLoop` correctly placed (kernel, not eval) AND correctly positioned as a horizontal primitive reused across product / eval / improvement layers?
- (c) Is the migration story realistic in 2–3 weeks, or do we discover unknowns?
- (d) Should we hoist `runCampaign` to a new package, or keep in `agent-eval`?

Once approved, this becomes the v1.0 implementation track. Tracked as a single multi-week initiative, not a series of lifts.
