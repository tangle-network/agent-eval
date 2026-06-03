# Multi-Shot Optimization

> **Renamed.** `runMultiShotOptimization` was retired. The live API is
> `runImprovementLoop` (driver-agnostic, gated promotion) driven by `gepaDriver`,
> with `compareDrivers` for head-to-head driver lift. This doc was rewritten to the
> live API; see also [feature-guide.md](./feature-guide.md) and [concepts.md](./concepts.md).

`runImprovementLoop` is the public entry for GEPA-style optimization over a whole
task trajectory — the thing you improve is not a single model call but an agent
system prompt, tool descriptions, a routing policy, or any scaffolding that affects
the entire run. It is the OUTER loop: it improves the SURFACE the inner workers run.

## The shape

You own a few seams; the loop owns the release-critical glue (paired seeds, the
held-out re-score, the promotion gate, provenance):

- **`baselineSurface`** — the current surface (a prompt string, or a `CodeSurface`).
- **`dispatchWithSurface(surface, scenario, ctx)`** — run one task to completion
  under a candidate surface; return the artifact the judges score.
- **`judges`** — score the artifact (`{ composite, dimensions }`).
- **`driver`** — proposes candidate surfaces each generation: `gepaDriver`
  (reflective + Pareto frontier) or `evolutionaryDriver` (mutator).
- **`gate`** — `defaultProductionGate` (held-out significance + red-team +
  reward-hacking + canary). Ships ONLY on a CI-lower-bound held-out lift.

## Minimal example

```ts
import {
  runImprovementLoop,
  gepaDriver,
  defaultProductionGate,
} from '@tangle-network/agent-eval/contract'

const result = await runImprovementLoop({
  baselineSurface: currentSystemPrompt,
  scenarios: trainScenarios, // optimizer-visible
  holdoutScenarios, // DISJOINT — only the gate sees these
  dispatchWithSurface: async (surface, scenario) =>
    runYourAgentToCompletion({ scenario, prompt: String(surface) }),
  judges: [myJudge],
  driver: gepaDriver({
    llm: { apiKey, baseUrl },
    model: 'gpt-5',
    target: 'enforce a strict output schema',
  }),
  populationSize: 4,
  maxGenerations: 4,
  gate: defaultProductionGate({ holdoutScenarios, deltaThreshold: 0 }),
  autoOnPromote: 'none', // or 'pr' (+ ghOwner/ghRepo) to open a PR on ship
  runDir,
})

if (result.gateResult.decision === 'ship') {
  deploy(result.winnerSurface) // the driver's proposal, gated on a real held-out lift
}
```

## Discipline (what makes it trustworthy)

- **Holdout is disjoint + gated.** `holdoutScenarios` must not overlap the training
  pool. The gate re-scores baseline vs winner on the holdout and ships only when the
  paired-bootstrap CI lower bound clears `deltaThreshold`; a few-instance swing at
  thin `n` is held (`few_runs`), not promoted.
- **No-op never ships.** If no candidate beats the baseline, the winner IS the
  baseline (empty diff) and the loop forces `hold` — it does not score
  baseline-vs-itself and read model noise as lift.
- **Provenance falls out.** `result.promotedDiff` + `emitLoopProvenance` give the
  auditable candidate→gate→promote chain (rationale, content hashes, a held-out lift
  recomputable from the emitted record).

Reach for `compareDrivers` when the question is "which DRIVER wins" rather than
"improve this surface", and see `tests/campaign/presets.test.ts` for the executable
contract (no-op guard, fail-loud holdout, gate promotion).
