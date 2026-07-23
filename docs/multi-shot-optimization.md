# Improve One Surface

`runImprovementLoop` generates candidate prompts or configs, runs them on training scenarios, and checks the selected candidate on separate holdout scenarios.

Use it when the question is: "Can this method improve my current surface?"
Use [`compareOptimizationMethods`](./campaign-proposers.md#compare-complete-methods) when the question is: "Which complete optimization method performs best?"

## Inputs

| Input | Meaning |
|---|---|
| `baselineSurface` | Current prompt or config. |
| `scenarios` | Training scenarios used to generate and score candidates. |
| `holdoutScenarios` | Separate scenarios used by the release rule after search. |
| `dispatchWithSurface` | Runs one scenario with one candidate surface. |
| `judges` | Scores the returned artifact. |
| `proposer` | Generates candidate surfaces. |
| `gate` | Applies the caller's release rule to baseline and winner results. |
| `runDir` | Stores run artifacts, traces, and resumable state. |

## Example

```ts
import {
  defaultProductionGate,
  gepaProposer,
  runImprovementLoop,
} from '@tangle-network/agent-eval/campaign'

const result = await runImprovementLoop({
  baselineSurface: currentSystemPrompt,
  scenarios: trainScenarios,
  holdoutScenarios,
  dispatchWithSurface: async (surface, scenario, ctx) =>
    runYourAgent({ prompt: String(surface), scenario, signal: ctx.signal }),
  judges: [qualityJudge],
  proposer: gepaProposer({
    llm: { apiKey, baseUrl },
    model,
    target: 'the complete system prompt',
  }),
  populationSize: 4,
  maxGenerations: 4,
  gate: defaultProductionGate({
    holdoutScenarios,
    deltaThreshold: 0,
  }),
  autoOnPromote: 'none',
  runDir,
})

if (result.gateResult.decision === 'ship') {
  deploy(result.winnerSurface)
}
```

## Behavior

- Training and holdout scenario IDs must be disjoint.
- Candidate generation cannot read holdout judge scores through `SurfaceProposer`.
- The selected candidate is measured against the baseline on holdout scenarios.
- A selected surface identical to the baseline is held instead of treating model variance as lift.
- `result.cost` includes worker, candidate-generation, and judge calls recorded through the shared cost ledger.
- `result.promotedDiff` describes the exact selected surface change.

The release decision is only as useful as the scenarios and judges supplied by the caller.
Calibrate the judge on known strong and weak outputs before using it for promotion.
