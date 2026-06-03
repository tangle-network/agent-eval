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

## Cross-package contracts

| From → To | Type | What it carries |
|---|---|---|
| agent-knowledge → agent-eval | `RunRecord` | (consumed via `runImprovementLoop` for knowledge-base optimization) |
| agent-knowledge → agent-eval | `KnowledgeReadinessReport`, `KnowledgeBundle`, `KnowledgeRequirement` | (re-exported from agent-eval; agent-knowledge populates) |
| agent-knowledge → agent-eval | `ControlRuntimeConfig<KnowledgeBaseCandidate>` | (knowledge research adapter) |
| agent-runtime → agent-eval | `runAgentControlLoop`, `scoreKnowledgeReadiness`, `blockingKnowledgeEval` | (consumed; agent-runtime calls these in its task lifecycle) |
| agent-runtime → agent-eval | `RunRecord`, `TraceStore`, `ControlRunResult`, `ControlStep` | (re-exported types; agent-runtime adapters projects into these) |
| agent-eval ↘ neither package | (no upstream imports) | |

## Known gaps in the contracts

1. **Shared `Scenario` interface.** Each package has its own scenario
   shape. agent-eval will promote a minimal `Scenario` to shared use when
   the second consumer needs it.
2. **agent-knowledge and agent-runtime pin older agent-eval minors.**
   Until both bump to current, `RunRecord`'s `scenarioId` field won't be
   populated by their existing run records and `RawProviderSink`
   integration is per-consumer rather than automatic.
3. **No first-class trace-analyst hook in agent-runtime.** agent-runtime's
   `runAgentTask` emits traces but doesn't auto-execute the trace analyst
   on completion the way `runEvalCampaign` does. A `onRunComplete` hook
   on agent-runtime would close this.

## Versioning policy

Each package versions independently. The minor-version axis carries
breaking changes; agent-eval's minor versions are tied to major
methodological shifts.

When agent-eval ships a minor, agent-knowledge and agent-runtime get a
follow-up PR to consume the new surface. The follow-up is tracked as a
deliberate change, not a passive caret pickup.
