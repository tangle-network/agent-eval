# Loop taxonomy: driver, worker, measurement, and the improvement loop

This is the canonical vocabulary for the Tangle agent stack. It exists because
the same word ("loop", "shot", "worker") was being used at three different
layers, and the layers were getting conflated. Every role below has exactly
one meaning. Use these words and nothing else.

Cross-links: [`three-package-architecture.md`](../three-package-architecture.md)
(who owns what), [`concepts.md`](../concepts.md) (eval mental model),
[`multi-shot-optimization.md`](../multi-shot-optimization.md) (GEPA),
[`auto-research-loop-end-to-end.md`](../auto-research-loop-end-to-end.md)
(analyst / autoresearch).

## The three roles

| Role | Definition | Lives at |
|---|---|---|
| **Driver** | The thing that *decides what happens next*. Plans, then decides whether to continue. | Both layers (see below) |
| **Worker** | An agent harness instance (Claude Code, Codex, OpenCode, …) running inside a sandbox. Does the actual work; responds in chat. | Inner layer only |
| **Sandbox** | A multi-harness VM. Hosts **1..N workers**, which can share a workspace. Not an agent — the substrate an agent runs in. | Inner layer only |
| **Measurement** | Runs the worker over a set of scenarios and judges the outputs into a scorecard with confidence intervals. This is `runCampaign`. | Outer layer |

Two facts that trip people up:

1. **A sandbox is not a worker.** One sandbox can hold ten workers — a driver
   can coordinate CC + Codex + OpenCode siblings sharing one workspace, or a
   fleet spread across machines. `runLoop`'s placement encodes exactly this:
   `{ sibling, sandboxId }` = co-located workers; `{ fleet, fleetId,
   machineId, sandboxId }` = workers across machines.

2. **"Driver" exists at two layers and means the same *kind* of thing
   (a decider) at each, but the things it decides differ:**
   - **Conversation driver** (inner): decides the next *turn* — a persona/user
     simulating chat, or a planner fanning work to workers.
   - **Improvement driver** (outer): decides the next *surface* — what system
     prompt / tool config / code the workers should run.

## The nesting

There are two loops. The outer one improves the thing the inner one runs.

```
runImprovementLoop                         OUTER loop — improve the agent over time
│
├─ DRIVER = ImprovementDriver              proposes a candidate SURFACE
│           (evolutionary mutator |        (the worker's system prompt / tools / config)
│            reflective analyst)            — NOT a conversation turn
│
└─ for each candidate surface:
     │
     runCampaign                           a MEASUREMENT — scores ONE surface
     │
     └─ for each scenario × rep:
          │
          dispatch(scenario)               THE SEAM — topology-opaque, returns an artifact
          │
          └─ runLoop / runMultishot        INNER loop — one conversation
               ├─ DRIVER  = persona / user / planner    chats with ↓
               └─ WORKERS = 1..N agent harnesses in 1..M sandboxes
               │
               → transcript / artifact
        judge(artifact) → score
   → scorecard + CIs
  gate(winner vs baseline) → PR
```

### `dispatch` is the topology-opaque seam

`dispatch(scenario) → artifact` is the boundary between the measurement layer
and the execution layer. The measurement does **not** know or care how the
artifact was produced. Behind the seam can be:

- one LLM call,
- one worker (CC) in one sandbox,
- a conversation driver coordinating 10 workers (CC + Codex + OpenCode)
  sharing a workspace in one sandbox,
- a fleet across machines.

All of it is invisible to `runCampaign`. This is why the substrate has no
opinion about execution topology: the topology lives inside `dispatch`.

### Corrected statements (things that were said backwards)

- The worker is the agent in the sandbox. The driver talks to it. ✓
- `runCampaign` is a **measurement**, not a worker. It *runs the worker* (via
  `dispatch`); the worker does not "run the eval".
- The outer improvement loop has **no single worker** — its driver proposes a
  *surface*, and each surface is scored by a *measurement* that drives the
  inner workers.

## The dataset flywheel — why every loop run matters

**Every loop run, regardless of why it ran, feeds the same dataset.** This is
the through-line that ties measurement and improvement together.

When `runCampaign` runs with a `labeledStore`, each cell captures
`(scenario, artifact, judgeScore, source)` into the `LabeledScenarioStore`.
The `source` discriminates *why* the run happened — but the captured tuple is
identical in shape:

| `captureSource` | The run that produced it |
|---|---|
| `'eval-run'` | a plain evaluation campaign |
| `'production-trace'` | a real user conversation in production |
| `'red-team'` | an adversarial probe |
| `'synthetic'` | a generated scenario |
| `'manual'` | a human-curated example |

That captured corpus **is the GEPA training set.** A basic eval run, a
production conversation, and an autoresearch loop all deposit the same
`(input, output, reward)` tuples. The optimization driver later samples from
that corpus to evolve the surface. So:

> Running *any* loop — even one whose purpose is not optimization — builds the
> dataset that optimization needs. The flywheel turns whether or not you are
> currently optimizing.

This is enforced, not aspirational: `runImprovementLoop` **refuses**
`tracing: 'off'` whenever a driver is wired, precisely because a loop that
doesn't feed the dataset is a loop that breaks the flywheel.

Temporal-split discipline (train vs holdout, `capturedBefore`) and
default-off-for-training of `production-trace` are enforced at the
`LabeledScenarioStore.sample()` boundary so the flywheel cannot contaminate
the holdout it is judged against. See `src/campaign/labeled-store/`.

## One improvement loop, pluggable drivers

The improvement loop is **driver-agnostic**. `runOptimization` (the loop body)
and `runImprovementLoop` (the gated-promotion shell) call
`driver.propose(...)` → measure → `driver.decide(...)`. They do not know which
strategy is driving. Two strategies conform to the same `ImprovementDriver`
interface:

```ts
interface ImprovementDriver<TFindings = unknown> {
  kind: string
  propose(args: {
    currentSurface: MutableSurface
    history: GenerationRecord[]   // what's been tried + scored
    findings: TFindings[]         // external signal (e.g. analyst output)
    populationSize: number
    generation: number
    signal: AbortSignal
  }): Promise<MutableSurface[]>
  decide?(args: { history: GenerationRecord[] }): { stop: boolean; reason?: string }
}
```

| Driver | Strategy | How it proposes | Where it lives |
|---|---|---|---|
| `evolutionaryDriver` | Evolutionary (GEPA / AxGEPA) | Mutates the current best surface into N candidates, blind to history beyond the current best. Optimizes against the dataset's rewards. | **agent-eval** (pure: dataset → surface, no sandbox) |
| `analystDriver` *(planned)* | Reflective | Reads trace findings + generation history, reasons about *why* candidates failed, proposes targeted edits. | **agent-runtime** (runs sandboxes to do research) — implements agent-eval's `ImprovementDriver` |

This resolves the prior duplication where `runImprovementLoop` (evolutionary,
agent-eval) and `runAnalystLoop` (reflective, agent-runtime) were two parallel
loops doing "propose change → measure → gate → PR". There is **one loop**;
the analyst becomes a driver of it. The dependency direction permits this
cleanly: agent-eval is the leaf and owns the `ImprovementDriver` contract;
agent-runtime imports agent-eval and implements the contract.

## What "the surface" is — improvement tiers

`MutableSurface` is the thing a driver changes. It has tiers, least → most
invasive. Today `MutableSurface = string` models tiers 1–2; tiers 3–4 are the
open design question below.

| Tier | Surface | Driver that changes it | Blast radius |
|---|---|---|---|
| 1 | System prompt / prompt-signature addendum | `evolutionaryDriver` (GEPA), `analystDriver` | prompt only |
| 2 | Tool config / tool signatures | `analystDriver` | which tools, their schemas |
| 3 | Knowledge (wiki / knowledge graph) | agent-knowledge's knowledge adapter | what the agent *knows* |
| 4 | Code / scaffolding | autoresearch (reads codebase + traces) → worktree / PR | the implementation itself |

The key distinction Drew drew:

- **Analyst** updates the *signatures* — the prompt and tool surface (tiers
  1–2). Cheap, reversible, measured directly against the dataset.
- **Autoresearch** updates the *code* (tier 4). It reads the repository plus
  the trace findings, opens a worktree, and proposes implementation changes —
  measured by re-running the inner loop against the changed code.

Both are `ImprovementDriver`s in the abstract (propose a change → measure →
gate → PR). They differ only in *what* they edit and *how invasive* it is. And
both consume the **same dataset** the flywheel builds.

## Open design questions (not yet decided)

1. **Should `MutableSurface` widen past `string` to model tiers 3–4?** A code
   edit is not a single string — it's a set of repo changes / a worktree ref.
   Two options:
   - widen `MutableSurface = string | { kind: 'code'; worktreeRef: string; … }`
     so the one loop spans all tiers, **or**
   - keep `MutableSurface = string` for tiers 1–2 and let tier-4 autoresearch
     be a distinct "produce a worktree, gate measures the changed code" path
     that shares the gate + dataset but not the surface type.
   Leaning toward the second (keep the prompt-surface loop pure; model code
   improvement as a sibling that reuses the gate + flywheel) — but undecided.

2. **Does `runAnalystLoop` (agent-runtime) get refactored to construct an
   `analystDriver` + call `runImprovementLoop`, or stay as the autoresearch
   entry point that *emits findings* an `analystDriver` consumes?** The first
   collapses the loops fully; the second keeps the analyst's knowledge-update
   responsibilities (which aren't surface optimization) where they are.

3. **Cross-repo naming.** `runLoop` (agent-runtime, inner execution) and
   `runMultishot` (agent-eval, inner conversation simulation) are the same
   *shape* with different backends (sandbox vs router). Whether they should
   converge into one parameterized primitive, or stay as two clearly-scoped
   entry points, is unresolved.

## Vocabulary quick reference

- **shot** — one conversational turn (driver says X, worker responds Y). Used
  in `runMultishot`. Never used to mean a whole eval run.
- **runMultishot** — many shots in one conversation; persona-driver ↔ one
  router-agent. agent-eval.
- **runLoop** — driver ↔ workers in sandboxes; topology-agnostic execution.
  agent-runtime.
- **runCampaign** — a measurement: a surface scored over N scenarios × M reps.
  agent-eval. (A "campaign" = a coordinated batch of measurements.)
- **runOptimization** — the improvement loop body: driver proposes surfaces,
  each measured by a campaign, top-K promoted per generation. agent-eval.
- **runImprovementLoop** — `runOptimization` + holdout re-score + release gate
  + optional PR. agent-eval.
- **runAnalystLoop** — reflective autoresearch: findings + knowledge updates +
  improvement proposals. agent-runtime.
- **ImprovementDriver** — the pluggable strategy that proposes surfaces;
  `evolutionaryDriver` and (planned) `analystDriver` conform.
