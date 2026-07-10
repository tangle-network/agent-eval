# Loop taxonomy: execution driver, worker, measurement, and surface proposer

This is the canonical vocabulary for the Tangle agent stack. It exists because
the same word ("loop", "shot", "worker") was being used at three different
layers, and the layers were getting conflated. Every role below has exactly
one meaning. Use these words and nothing else.

Cross-links: [`concepts.md`](../concepts.md) (eval mental model),
[`campaign-proposers.md`](../campaign-proposers.md) (proposer catalog),
[`multi-shot-optimization.md`](../multi-shot-optimization.md) (GEPA), and
[`auto-research-loop-end-to-end.md`](../auto-research-loop-end-to-end.md)
(analyst / autoresearch).

## Core Roles

| Role | Definition | Lives at |
|---|---|---|
| **Execution driver** | The thing that decides or routes the next turn/action inside a sandbox or worker conversation. | Inner layer only |
| **Surface proposer** | The thing that proposes the next prompt/config/code surface for the improvement loop to measure. | Outer layer only |
| **Worker** | An agent harness instance (Claude Code, Codex, OpenCode, …) running inside a sandbox. Does the actual work; responds in chat. | Inner layer only |
| **Sandbox** | A multi-harness VM. Hosts **1..N workers**, which can share a workspace. Not an agent — the substrate an agent runs in. | Inner layer only |
| **Measurement** | Runs the worker over a set of scenarios and judges the outputs into a scorecard with confidence intervals. This is `runCampaign`. | Outer layer |

Two facts that trip people up:

1. **A sandbox is not a worker.** One sandbox can hold ten workers — a driver
   can coordinate CC + Codex + OpenCode siblings sharing one workspace, or a
   fleet spread across machines. `runLoop`'s placement encodes exactly this:
   `{ sibling, sandboxId }` = co-located workers; `{ fleet, fleetId,
   machineId, sandboxId }` = workers across machines.

2. **"Driver" is reserved for execution.** The outer loop uses a
   **surface proposer**: it proposes the next prompt / tool config / code
   surface for the measurement loop.

## The nesting

There are two loops. The outer one improves the thing the inner one runs.

```
runImprovementLoop                         OUTER loop — improve the agent over time
│
├─ PROPOSER = SurfaceProposer              proposes a candidate SURFACE
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
- The outer improvement loop has **no single worker** — its proposer proposes a
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
`(input, output, reward)` tuples. The optimization proposer later samples from
that corpus to evolve the surface. So:

> Running *any* loop — even one whose purpose is not optimization — builds the
> dataset that optimization needs. The flywheel turns whether or not you are
> currently optimizing.

This is enforced, not aspirational: `runImprovementLoop` **refuses**
`tracing: 'off'` whenever a proposer is wired, precisely because a loop that
doesn't feed the dataset is a loop that breaks the flywheel.

Temporal-split discipline (train vs holdout, `capturedBefore`) and
default-off-for-training of `production-trace` are enforced at the
`LabeledScenarioStore.sample()` boundary so the flywheel cannot contaminate
the holdout it is judged against. See `src/campaign/labeled-store/`.

## One improvement loop, pluggable proposers

The improvement loop is **proposer-agnostic**. `runOptimization` (the loop body)
and `runImprovementLoop` (the gated-promotion shell) call
`proposer.propose(...)` → measure → `proposer.decide(...)`. They do not know
which strategy proposed the candidate. The API interface is `SurfaceProposer`:

```ts
interface SurfaceProposer<TFindings = unknown> {
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

| Implementation | Strategy | How it proposes | Where it lives |
|---|---|---|---|
| `evolutionaryProposer` | Evolutionary (GEPA / AxGEPA) | Standalone `SurfaceProposer`. Mutates the current best surface into N candidates, blind to history beyond the current best. Optimizes against the dataset's rewards. | **agent-eval** (pure: dataset → surface, no sandbox) |
| Runtime reflective proposer | Reflective | Cheap generator: drafts patches from the report and applies them into a worktree (shots=1, no sandbox). | **agent-runtime** — implements agent-eval's proposer contract |
| Runtime agentic proposer | Agentic | Full generator: runs a coding harness in the worktree (≤ `maxImprovementShots`) to edit in place. | **agent-runtime** |

This resolves the prior duplication where `runImprovementLoop` (evolutionary,
agent-eval) and `runAnalystLoop` (reflective, agent-runtime) were two parallel
loops doing "propose change → measure → gate → PR". There is **one loop** and
one proposer contract. The reflective and agentic paths are two settings of the
same cost dial, not separate outer loops. The dependency direction permits this
cleanly: agent-eval is the leaf and owns the proposer contract; agent-runtime
imports agent-eval and implements it.

## What "the surface" is — improvement tiers

`MutableSurface` is the thing the proposer changes. It has tiers, least → most
invasive. `MutableSurface = string | CodeSurface` spans all of them: `string`
for tiers 1–2, and a finalized `CodeSurface` for tier 4. A code surface's
worktree path is only its locator; exact base/candidate commits, final tree,
and binary-patch digest are its portable identity. Call `verifyCodeSurface`
before executing the checkout so a moved ref or post-finalization mutation
fails before measurement. Verification hashes raw files and executable modes
without Git filters and rejects external symlinks or submodules whose bytes are
not represented by the candidate tree.

| Tier | Surface | Generator that changes it | Blast radius |
|---|---|---|---|
| 1 | System prompt / prompt-signature addendum | `evolutionaryProposer` (GEPA), `reflectiveGenerator` | prompt only |
| 2 | Tool config / tool signatures | `reflectiveGenerator` | which tools, their schemas |
| 3 | Knowledge (wiki / knowledge graph) | agent-knowledge's knowledge adapter | what the agent *knows* |
| 4 | Code / scaffolding | `agenticGenerator` (coding harness reads codebase + report) → worktree / PR | the implementation itself |

The cost/capability distinction:

- **`reflectiveGenerator`** updates the *signatures* — prompt + tool surface
  (tiers 1–2). Cheap (drafts patches, no sandbox), reversible, measured
  directly against the dataset.
- **`agenticGenerator`** updates the *code* (tier 4). A coding harness reads
  the repository + the report, edits in a worktree, iterates up to
  `maxImprovementShots` — measured by re-running the inner loop against the
  changed code.

Both are implementations of the one proposer contract (propose → measure → gate
→ PR). They differ only in *what* they edit and *how invasive* it is — and both
consume the **same dataset** the flywheel builds.

## Vocabulary quick reference

- **shot** — one conversational turn (driver says X, worker responds Y). Used
  in `runMultishot`. Never used to mean a whole eval run.
- **runMultishot** — many shots in one conversation; persona-driver ↔ one
  router-agent. agent-eval.
- **runLoop** — driver ↔ workers in sandboxes; topology-agnostic execution.
  agent-runtime.
- **runCampaign** — a measurement: a surface scored over N scenarios × M reps.
  agent-eval. (A "campaign" = a coordinated batch of measurements.)
- **runOptimization** — the improvement loop body: proposer suggests surfaces,
  each measured by a campaign, top-K promoted per generation. agent-eval.
- **runImprovementLoop** — `runOptimization` + holdout re-score + release gate
  + optional PR. agent-eval.
- **runAnalystLoop** — reflective autoresearch: findings + knowledge updates +
  improvement proposals. agent-runtime.
- **SurfaceProposer** — the contract a surface proposer implements.
  `evolutionaryProposer` (agent-eval) is one; agent-runtime can provide
  reflective or agentic implementations.
- **CandidateGenerator** — the byte-producing seam inside a runtime proposer;
  `reflectiveGenerator` (cheap, no sandbox) and `agenticGenerator` (coding
  harness in the worktree) are the two cost settings. agent-runtime.
