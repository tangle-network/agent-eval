# multi-shot-optimization

Optimize a surface (a system prompt, tool descriptions, any scaffolding that
affects the whole run) across a small candidate population with a **held-out
promotion gate**: a candidate ships only if it beats baseline on a separate
holdout set, not just the search set it was selected on.

## What it shows

- `runImprovementLoop` — the proposer-agnostic outer loop: optimize → re-score
  baseline vs winner on the disjoint holdout → gate.
- `evolutionaryProposer` wrapping a tiny deterministic `mutator` (the LLM-free
  strategy). The reflective alternative is `gepaProposer`; both conform to
  `SurfaceProposer` and the loop is identical.
- `defaultProductionGate` separating *search* scenarios (selection) from
  *holdout* scenarios (paired-delta promotion) — it ships only on a
  CI-lower-bound held-out lift over `deltaThreshold`.

Imports come from the `@tangle-network/agent-eval/contract` subpath — the
curated public entry for the closed self-improvement loop.

## Run

```sh
pnpm install
pnpm exec tsx examples/multi-shot-optimization/index.ts
```

Runtime: ~1s. No LLM calls — the dispatch echoes the surface and the judge is a
deterministic string check, so the loop mechanics are visible without paying for
inference.

## Expected output

```
{ decision: 'ship', delta: 1, winnerShipped: true, promotedDiff: '--- baseline\n+++ winner\n- Complete the user task.\n+ Complete the user task. VERIFY_EVERY_STEP' }
```

The baseline (no directive) scores 0 on the holdout; the proposer's candidate
(directive appended) scores 1, so the gate ships it. You will also see
`expectUsage` notices that each holdout cell reported zero cost — that is the
substrate's capture-integrity guard correctly flagging the offline stub
dispatch; a real dispatch reports usage via `ctx.cost`.

## Adapt this to your agent

Replace `dispatchWithSurface` with your real agent invocation (report cost via
`ctx.cost`), the `judge` with your verifier or LLM-as-judge, and the
`evolutionaryProposer` mutator with `gepaProposer` for reflective, trace-grounded
proposals. Keep the holdout disjoint from the training scenarios — the gate's
honesty depends on it.
