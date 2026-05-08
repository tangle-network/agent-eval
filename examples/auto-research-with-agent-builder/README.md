# Auto-research loop driving agent-builder

End-to-end demo: a user says *"build me an agent that does X"*, the system builds it,
evaluates it, learns from the failures, builds a better version, repeat. The loop
closes — and we ship the most capable agent we can produce within budget.

This is the canonical use case for the auto-research thesis the package was
designed around. Every other consumer (legal-agent, tax-agent, redteam, physim)
is a domain-flavored variant of the same pattern.

## What the loop does, end-to-end

```
                       ┌──────────────────────┐
                       │    agent-builder     │
                       │  runForgeBuilderSim  │ ← (build with prompt variant V_n)
                       └──────────┬───────────┘
                                  │  ForgeBuilderSimReport
                                  ▼
                       ┌──────────────────────┐
                       │   runEvalCampaign    │ ← (score against scenarios)
                       │  (capture-integrity)  │
                       └──────────┬───────────┘
                                  │  RunRecord[]
                                  ▼
                       ┌──────────────────────┐
                       │ analyzeOptimizationResult │
                       │    (RL bridge)       │ ← (preferences, hacking, MDE)
                       └──────────┬───────────┘
                                  │  PreferenceTriple[]
                                  ▼
                       ┌──────────────────────┐
                       │   reflective-mutator │ ← (propose V_{n+1} prompt)
                       └──────────┬───────────┘
                                  │
                                  ▼
                              (loop)
```

Three primitives compose:

1. **agent-builder's `runForgeBuilderSim`** — the actual builder; produces a
   `ForgeBuilderSimReport` with verification + readiness + transcript.
2. **agent-eval's `runEvalCampaign`** — captures every cell with integrity
   guarantees and produces a canonical `RunRecord[]`.
3. **agent-eval's `analyzeOptimizationResult`** — extracts preferences,
   verifiable rewards, anytime-valid sequential verdict, and reward-hacking
   diagnosis from the campaign output.
4. **`reflective-mutation`** (already in agent-eval) — proposes the next
   variant from the top/bottom trial set.

## Why this is non-trivial

Today agent-builder's `runForgeBuilderSim` runs **once** per call (single build,
multi-turn-internal but no outer iteration). The user's product vision is a
`build-me-the-best-agent` flow that runs ~5-10 builds with prompt variants and
returns the winner. This example is the prototype: agent-eval primitives close
the outer loop that agent-builder doesn't own.

## Code

`auto-research-with-agent-builder.ts` is fully runnable but uses a synthetic
`runForgeBuilderSim` shim by default so the example doesn't need credentials or
GPUs. To run against the real agent-builder:

```ts
// Replace the shim:
import { runForgeBuilderSim } from '@tangle-network/agent-builder/eval'

const runner = (variant: ForgeVariant) => runForgeBuilderSim({
  personaId: variant.personaId,
  agentId: 'demo-agent',
  userId: 'demo-user',
  maxTurns: 4,
  systemPromptOverride: variant.systemPrompt,
})
```

The `RunRecord` projection logic, scoring, preference extraction, and outer
iteration loop are unchanged.

## Reading order

1. `auto-research-with-agent-builder.ts` — top to bottom.
2. The `runAutoResearchLoop` function is the integration point.
3. The output prints what each iteration does to the score / preferences.

## Adapting for your product

For each consumer (tax-agent, legal-agent, redteam, etc.) the wiring is
identical; the only thing that changes is:

- The **builder runner** — what produces a candidate (your domain agent's
  build / configure step).
- The **scoring runner** — what produces a score per scenario for that
  candidate (your domain's eval task).
- The **mutation strategy** — how to propose the next variant given the
  preference triples (prompt rewrite, tool addition, knowledge backfill).

Everything in between (campaign integrity, preferences, sequential
verdict, reward-hacking) is shared agent-eval primitive.

## Status

Example status: **runnable, synthetic-driver-by-default**. Real-driver
mode (against agent-builder's `runForgeBuilderSim`) is documented above
and works once you bump agent-builder to `agent-eval@^0.23.0`.

The composition pattern is stable. The auto-research thesis is genuinely
load-bearing in this loop — every iteration's data informs the next, and
the campaign artifact is the contract between the two halves.
