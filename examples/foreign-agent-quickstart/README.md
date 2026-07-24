# Use Agent Eval With An Existing Agent

Your agent does not need to use Tangle's runtime or sandbox.
Agent Eval only needs a function that accepts the candidate prompt or configuration plus one scenario, then returns the artifact to score.

## Install

```sh
npm install @tangle-network/agent-eval
```

## Run The Example

From this repository:

```sh
pnpm tsx examples/foreign-agent-quickstart/index.ts
```

The default path is offline and deterministic.
Set `OPENAI_API_KEY` to run the agent and judge through an OpenAI-compatible endpoint.

## Adapt Your Agent

Define four inputs:

1. `scenarios`: representative tasks with stable IDs.
2. `agent`: calls your existing SDK, service, workflow, or local model.
3. `judge`: returns dimension scores and a composite score from `0` to `1`.
4. `baselineSurface`: the prompt or configuration you use today.

```ts
import {
  defineAgentEval,
  type JudgeConfig,
  type Scenario,
} from '@tangle-network/agent-eval/contract'

interface SupportScenario extends Scenario {
  question: string
}

interface SupportAnswer {
  text: string
}

const judge: JudgeConfig<SupportAnswer, SupportScenario> = {
  name: 'support-quality',
  dimensions: [
    { key: 'correct', description: 'The answer resolves the question correctly' },
  ],
  score: ({ artifact }) => {
    const correct = artifact.text.includes('expected fact') ? 1 : 0
    return { dimensions: { correct }, composite: correct, notes: '' }
  },
}

const evalKit = defineAgentEval<SupportScenario, SupportAnswer>({
  scenarios,
  baselineSurface: 'Answer accurately and briefly.',
  agent: async (surface, scenario, ctx) => ({
    text: await yourAgent({
      systemPrompt: String(surface),
      question: scenario.question,
      signal: ctx.signal,
    }),
  }),
  judge,
  expectUsage: 'off',
})

const baseline = await evalKit.evaluate()
const candidate = await evalKit.evaluate({
  surface: 'Answer accurately, briefly, and cite the relevant policy.',
})
```

Wrap top-level calls in your application's existing async entry point.
Use `evalKit.improve()` with a caller-owned `SurfaceProposer` when you are ready to generate and evaluate candidates automatically.
Use `compareOptimizationMethods()` when official GEPA or SkillOpt should own the complete search procedure.

## Failure And Data Handling

- Throw when the agent or judge cannot produce a valid result.
- Pass `ctx.signal` to downstream calls so cancellation stops work already in progress.
- Use in-memory storage for ephemeral runs or filesystem storage for resumable local runs.
- No hosted service is required.
- Data leaves your process only through providers and exporters you configure.

The runnable implementation is [`index.ts`](./index.ts).
For lower-level campaign control, read [`docs/campaign-proposers.md`](../../docs/campaign-proposers.md).
