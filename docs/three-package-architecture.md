# Three-package architecture: agent-eval × agent-knowledge × agent-runtime

The Tangle agent stack splits responsibilities across three TypeScript
packages with explicit, narrow contracts. This doc is the reference for how
they fit together — what each owns, what each consumes from the others, and
the canonical data shapes that move between them.

## Why three packages

Each one has a single, defensible job. Combining them was a real temptation
(less version drift, fewer registries) and we said no on purpose:

- **`@tangle-network/agent-eval`** owns measurement, optimization, and the
  RL bridge. It has no opinion about *what* the agent does or *how* it runs;
  it has strong opinions about whether the answer is good and how to make it
  better.
- **`@tangle-network/agent-knowledge`** owns the data side: source-grounded
  knowledge graphs, source citations, eval-gated knowledge growth, knowledge
  readiness scoring. It is domain-agnostic — legal, tax, coding, research
  workflows define their own policies on top of it.
- **`@tangle-network/agent-runtime`** owns the *execution* side: the task
  lifecycle, knowledge-readiness gating, control-loop orchestration,
  streaming session kernels. It does not own domain policy, models, tools,
  or UI; it standardizes the lifecycle and delegates domain behavior to
  adapters.

Each package can be reasoned about independently. Each can be replaced
without rewriting the others.

## The data interchange — `RunRecord`, `Scenario`, `KnowledgeBundle`

These three types travel between the packages and tie the architecture
together.

### `RunRecord` (owned by agent-eval)

Every measurable thing — a campaign cell, an optimization trial, a
production rollout, a deployment outcome — projects to a `RunRecord`. It
carries identity (`runId`, `experimentId`, `candidateId`, `seed`,
`scenarioId`), provenance (`commitSha`, `model`, `promptHash`, `configHash`),
cost (`costUsd`, `tokenUsage`), and the outcome (per-split scores +
free-form `raw` metric bag).

agent-knowledge consumes `RunRecord[]` for release reporting and
optimization analysis. agent-runtime exposes hooks for projecting its own
task results into `RunRecord` shape. Every consumer of agent-eval's
campaign / RL primitives produces `RunRecord[]`.

### `Scenario` (currently each owner defines its own)

agent-eval's `runEvalCampaign` takes
`{ scenarioId: string; tags?: Record<string,string> }`. agent-knowledge
defines richer scenario types for knowledge-base optimization. agent-runtime
takes `TaskSpec` which is one task at a time, not a scenario set.

This is a known minor friction; not load-bearing yet. When it becomes one,
`Scenario` will get promoted to a shared interface.

### `KnowledgeBundle` (owned by agent-knowledge)

agent-knowledge produces `KnowledgeBundle` (a versioned graph of source
citations + generated content) and `KnowledgeReadinessReport` (gap
analysis). agent-eval's `KnowledgeRequirement` / `KnowledgeBundle` types
are imported from agent-eval into agent-knowledge — agent-knowledge
**adapts** its richer types to agent-eval's wire types, not the other way
around. The wire types are the contract; the rich types are agent-knowledge's
internal model.

## Dependency direction

```
                        ┌────────────────────┐
                        │  agent-runtime     │
                        │  (executor)        │
                        └─────────┬──────────┘
                                  │
                                  ▼ imports
                        ┌────────────────────┐
                        │  agent-eval        │
                        │  (measurement)     │
                        └────────────────────┘
                                  ▲
                                  │ imports
                        ┌─────────┴──────────┐
                        │  agent-knowledge   │
                        │  (data side)       │
                        └────────────────────┘
```

**Both** agent-runtime and agent-knowledge import agent-eval. agent-eval
imports neither. This is deliberate: agent-eval is the leaf — its API is
the bottleneck, so its surface stays narrow and stable.

## What each package contributes to the auto-research loop

```
       ┌────────────────────┐           ┌────────────────────┐
       │  agent-knowledge   │   ────►   │   agent-eval       │
       │                    │           │                    │
       │ - scenario sets    │           │ - runEvalCampaign  │
       │ - knowledge bundle │           │ - capture integrity│
       │ - readiness gates  │           │ - researchReport   │
       │ - source citations │           │ - replayCampaign   │
       │                    │           │ - sequential       │
       │ produces:          │           │ - RL bridge        │
       │   KnowledgeBundle  │           │ - preferences      │
       │   Scenario         │           │ - off-policy       │
       └────────────────────┘           │ - tournament       │
                                        │                    │
                                        │ produces:          │
                                        │   RunRecord[]      │
                                        │   PreferenceTriple │
                                        │   etc.             │
                                        └─────────▲──────────┘
                                                  │
       ┌────────────────────┐                     │
       │   agent-runtime    │   ──────────────────┘
       │                    │
       │ - runAgentTask     │
       │ - runAgentControl  │
       │ - readiness gating │
       │ - SSE / sessions   │
       │                    │
       │ produces:          │
       │   ControlRunResult │
       │   SSE events       │
       └────────────────────┘
```

agent-knowledge brings the *what* (scenarios, knowledge, source data).
agent-runtime brings the *how to run it once* (task lifecycle, control
loop). agent-eval brings the *measurement and improvement* (campaign,
report, RL bridge).

## Cross-package contracts (current state, 0.23+)

| From → To | Type | What it carries |
|---|---|---|
| agent-knowledge → agent-eval | `RunRecord` | (consumed via `runMultiShotOptimization` for knowledge-base optimization) |
| agent-knowledge → agent-eval | `KnowledgeReadinessReport`, `KnowledgeBundle`, `KnowledgeRequirement` | (re-exported from agent-eval; agent-knowledge populates) |
| agent-knowledge → agent-eval | `ControlRuntimeConfig<KnowledgeBaseCandidate>` | (knowledge research adapter) |
| agent-runtime → agent-eval | `runAgentControlLoop`, `scoreKnowledgeReadiness`, `blockingKnowledgeEval` | (consumed; agent-runtime calls these in its task lifecycle) |
| agent-runtime → agent-eval | `RunRecord`, `TraceStore`, `ControlRunResult`, `ControlStep` | (re-exported types; agent-runtime adapters projects into these) |
| agent-eval ↘ neither package | (no upstream imports) | |

## What's missing for the contracts to be S-tier

These are honest gaps, surfaced after the 0.23 audit:

1. **Shared `Scenario` interface.** Each package has its own scenario
   shape. agent-eval will promote a minimal `Scenario` to shared use when
   the second consumer needs it.
2. **`agent-knowledge` is pinned at `agent-eval@^0.20.0`.** It misses
   capture-integrity (0.21), the campaign artifact (0.22), and the RL
   bridge (0.23). On its next `pnpm install` the caret will pick up
   minors — but `RunRecord`'s `scenarioId` field (added in 0.23) won't be
   populated by agent-knowledge's existing run records. A planned bump +
   adapter pass closes this.
3. **`agent-runtime` is pinned at `agent-eval@^0.20.0`.** Same picture —
   misses capture-integrity, campaign, RL bridge. Specifically the
   `RawProviderSink` integration would let every agent-runtime task auto-
   capture its provider HTTP envelope without wiring it per-consumer.
4. **No first-class trace-analyst hook in agent-runtime.** agent-runtime's
   `runAgentTask` can emit traces but doesn't auto-execute the trace
   analyst on completion the way `runEvalCampaign` does. A `onRunComplete`
   hook on agent-runtime would close this — and the implementation is
   one method change.

These are tracked as follow-up bumps after agent-eval 0.23 ships.

## Versioning policy

Each package versions independently. The minor-version axis carries
breaking changes; agent-eval's minor versions are tied to the major
methodological shifts (0.21 = capture integrity; 0.22 = campaign + RL
bridge experimental; 0.23 = RL bridge primitives, examples).

When agent-eval ships a minor, agent-knowledge and agent-runtime get a
follow-up PR to consume the new surface. The follow-up is tracked as a
deliberate change, not a passive caret pickup.
