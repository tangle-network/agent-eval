# Multi-Shot Optimization

`runMultiShotOptimization` is the public adapter for GEPA-style optimization over
variable-length agent conversations.

Use it when the thing you want to improve is not a single model call. Typical
targets are agent system prompts, tool descriptions, routing policies, retrieval
plans, or app-specific scaffolding that affects an entire task trajectory.

The primitive is intentionally small. Your app owns the domain logic:

- `seedVariants`: prompt/config/tool-policy candidates
- `runner`: executes one complete task trajectory for one variant
- `scorer`: scores the trajectory and emits actionable side information
- `mutateAdapter`: proposes new variants from top and bottom trials

`agent-eval` owns the release-critical glue:

- stable paired seeds
- search-split prompt evolution
- cost/score Pareto objectives
- failed-run conversion into failed trials
- ASI projection into reflection traces and numeric metrics
- optional paired holdout gating through `HeldOutGate`
- validated `RunRecord` rows for promotion evidence

## Result Contract

The return shape separates discovery from promotion:

- `searchBestVariant`: best variant on the optimizer-visible search scenarios
- `searchBestAggregate`: aggregate for that search winner
- `promotedVariant`: variant callers should ship
- `promotedAggregate`: aggregate for the promoted variant
- `gate`: holdout decision and evidence, or `null` when no gate ran

If a holdout gate is configured and rejects the search winner,
`promotedVariant` is the baseline. Do not ship `searchBestVariant` directly
unless you intentionally run without a holdout gate.

## Actionable Side Information

The scorer should return `asi` rows for concrete failure modes:

```ts
{
  expectationId: 'used-primary-sources',
  message: 'The final answer cited secondary summaries instead of primary sources.',
  severity: 'error',
  responsibleSurface: 'retrieval-policy',
  suggestion: 'Prefer primary-source domains during source-gathering turns.',
}
```

Standard knowledge-related responsible surfaces are:

- `knowledge-requirements`
- `data-acquisition`
- `retrieval-policy`
- `user-question-policy`

These rows become:

- reflection expectations via `trialTraceFromMultiShotTrial`
- aggregate metrics like `asi.error` and `surface.retrieval-policy`
- trace evidence available to downstream reports

This is the main reason to use this primitive instead of reducing each run to a
single scalar reward.

## Holdout Discipline

For release gates, configure `gate`. The first seed variant is the baseline and
`gate.gate.baselineKey` must match its id.

Holdout scenarios must be disjoint from `searchScenarioIds`. The adapter runs
baseline and candidate with the same `(scenarioId, rep)` seed, validates every
row with `validateRunRecord`, then asks `HeldOutGate` whether to promote.

When `gate.searchScenarioIds` is omitted, the adapter reuses
`searchScenarioIds` for the overfit-gap check.

## Minimal Shape

```ts
import {
  runMultiShotOptimization,
  trialTraceFromMultiShotTrial,
  type MultiShotVariant,
} from '@tangle-network/agent-eval'

type Payload = { systemPrompt: string }

const baseline: MultiShotVariant<Payload> = {
  id: 'baseline',
  label: 'baseline',
  generation: 0,
  payload: { systemPrompt: currentPrompt },
}

const result = await runMultiShotOptimization<Payload>({
  runId: `research-agent-${Date.now()}`,
  target: 'research-agent-system-prompt',
  seedVariants: [baseline],
  searchScenarioIds: searchScenarios.map((s) => s.id),
  reps: 2,
  generations: 4,
  populationSize: 4,
  scoreConcurrency: 4,
  runner: {
    async run({ variant, scenarioId, seed }) {
      return runYourAgentToCompletion({ scenarioId, seed, prompt: variant.payload.systemPrompt })
    },
  },
  scorer: {
    async score({ run }) {
      return scoreFullTrajectory(run.trace)
    },
  },
  mutateAdapter: {
    async mutate({ parent, bottomTrials, childCount, generation }) {
      const traces = bottomTrials.map((t) => trialTraceFromMultiShotTrial(t))
      return proposePromptMutations({ parent, traces, childCount, generation })
    },
  },
})

deploy(result.promotedVariant.payload)
```
