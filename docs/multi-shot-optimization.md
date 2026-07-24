# Improve One Surface

`runImprovementLoop()` evaluates candidates from a `SurfaceProposer`, selects one on training data, and compares it with the baseline on separate holdout cases.

Use it when your application or runtime owns candidate generation.
Use [`compareOptimizationMethods()`](./campaign-proposers.md) when GEPA, SkillOpt, or another external system owns the complete search procedure.

## Inputs

| Input | Meaning |
|---|---|
| `baselineSurface` | Current prompt or serialized configuration. |
| `scenarios` | Training cases used to generate and score candidates. |
| `holdoutScenarios` | Separate cases used for the release decision after search. |
| `dispatchWithSurface` | Runs one case with one candidate surface. |
| `judges` | Scores the returned artifact. |
| `proposer` | Caller-owned candidate generator. |
| `gate` | Caller-owned release rule for the baseline and selected candidate. |
| `runDir` | Directory for run artifacts, traces, and resumable state. |

## Example

```ts
import {
  defaultProductionGate,
  runImprovementLoop,
  type SurfaceProposer,
} from '@tangle-network/agent-eval/campaign'

const proposer: SurfaceProposer = {
  kind: 'product-rules',
  async propose({ currentSurface, populationSize }) {
    return [
      {
        surface: `${String(currentSurface)}\nReturn JSON only.`,
        label: 'json-only',
        rationale: 'Training failures contained prose around the JSON object.',
      },
    ].slice(0, populationSize)
  },
}

const result = await runImprovementLoop({
  baselineSurface: currentSystemPrompt,
  scenarios: trainScenarios,
  holdoutScenarios,
  dispatchWithSurface: async (surface, scenario, ctx) =>
    runYourAgent({ prompt: String(surface), scenario, signal: ctx.signal }),
  judges: [qualityJudge],
  proposer,
  populationSize: 1,
  maxGenerations: 1,
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

## Rules

- Training and holdout case IDs must be disjoint.
- Candidate generation cannot read holdout scores through `SurfaceProposer`.
- An unchanged selected surface does not receive credit for model variance.
- `result.cost` includes calls recorded through the shared cost ledger.
- `result.promotedDiff` identifies the exact selected change.

Calibrate the judge on known strong and weak artifacts before using its decision in production.
The runnable offline example is [`examples/multi-shot-optimization`](../examples/multi-shot-optimization/).
