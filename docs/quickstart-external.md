# Quickstart — self-improvement loop for any agent (15 minutes)

The standalone walkthrough mirroring
`examples/foreign-agent-quickstart/`. Read this first; copy the runnable
example second.

## What you get

After 15 minutes you have a closed self-improvement loop running
against your agent — measured, gated, and reproducible — with no
Tangle sandbox, no Tangle account, and no hosted infrastructure.

## Install

```sh
npm i @tangle-network/agent-eval@^0.44.0
```

The package's `@tangle-network/sandbox` peer is `optional` (as of
0.44.0). Foreign consumers can install agent-eval and run the full LAND
tier without our sandbox or its dependencies.

## Five types, four functions

```ts
import {
  // Types
  type Scenario,        // what you evaluate against (id + kind + your fields)
  type Dispatch,        // your agent, wrapped as one function
  type JudgeConfig,     // pluggable dimensional scorer
  type Mutator,         // proposes a next surface
  type Gate,            // promotion guard

  // Functions
  runEval,
  runCampaign,
  runImprovementLoop,
  defaultProductionGate,

  // Storage
  fsCampaignStorage,
  inMemoryCampaignStorage,
} from '@tangle-network/agent-eval/contract'
```

Every export above is committed under semver. New minors only ADD;
nothing here changes shape in a 0.x minor.

## Three steps to wire your agent

### 1. Scenarios

```ts
interface MarketingScenario extends Scenario {
  blurb: string
  surface: 'landing-hero' | 'tweet' | 'email-subject'
  audience: string
}

const scenarios: MarketingScenario[] = [
  { id: 's1', kind: 'marketing-rewrite', blurb: '...', surface: 'tweet', audience: '...' },
  // ...
]
```

### 2. Wrap your agent as `Dispatch`

```ts
const dispatch: Dispatch<MarketingScenario, MarketingArtifact> = async (scenario, ctx) => {
  const rewrite = await callYourAgent(scenario, { signal: ctx.signal })
  return { rewrite, modelUsed: '...' }
}
```

`ctx` carries `signal` (cancellation), `trace` (write spans), `artifacts`
(write blobs), `cost` (token + $ meter). Use them or ignore them.

### 3. Bring a judge

```ts
const judge: JudgeConfig<MarketingArtifact, MarketingScenario> = {
  name: 'marketing-quality',
  dimensions: [
    { key: 'hook_strength', description: '...' },
    { key: 'voice_match', description: '...' },
    { key: 'cta_clarity', description: '...' },
    { key: 'factual_grounding', description: '...' },
  ],
  async score({ artifact, scenario, signal }) {
    // LLM call, heuristic, ensemble — anything. Return JudgeScore.
    return { dimensions: { ... }, composite: 0.72, notes: '...' }
  },
}
```

Throw on failure; the substrate records it as a failed cell. No silent
zeros.

## Baseline

```ts
const baseline = await runEval({
  scenarios,
  dispatch,
  judges: [judge],
  storage: inMemoryCampaignStorage(),
  runDir: 'mem://my-baseline',
})

const score = Object.values(baseline.aggregates.byScenario)
  .reduce((sum, s) => sum + s.meanComposite, 0) / scenarios.length

console.log(`Baseline composite: ${score.toFixed(3)}`)
```

## Self-improvement loop

```ts
import { gepaDriver, defaultProductionGate } from '@tangle-network/agent-eval/contract'

const result = await runImprovementLoop({
  scenarios: trainScenarios,
  baselineSurface,
  dispatchWithSurface: (surface, scenario, ctx) =>
    runYourAgent({ systemPrompt: surface as string }, scenario, ctx),
  driver: gepaDriver({
    llm: { apiKey: process.env.OPENAI_API_KEY, baseUrl: '...' },
    model: 'gpt-4o-mini',
    target: 'marketing copywriting system prompt',
    mutationPrimitives: [
      'Tighten the hook: lead with the concrete user outcome.',
      'Replace generic adjectives with specific verbs.',
      // ...
    ],
  }),
  judges: [judge],
  populationSize: 2,
  maxGenerations: 3,
  holdoutScenarios,
  gate: defaultProductionGate({
    holdoutScenarios,
    deltaThreshold: 0.05,
  }),
  autoOnPromote: 'none',
  storage: inMemoryCampaignStorage(),
  runDir: 'mem://my-improve',
})

if (result.gateResult.decision === 'ship') {
  // Deploy result.winnerSurface — we don't push it for you.
}
```

The gate decision is `'ship'` | `'hold'` | `'need_more_work'` |
`'model_ceiling'` | `'arch_ceiling'`. You define what each means in
your deploy pipeline.

## What you control

- The agent (any framework, any model, any backend).
- The judge (LLM, heuristic, ensemble; we don't pick).
- The mutation strategy (`gepaDriver` for reflective LLM mutation,
  `evolutionaryDriver({ mutator })` for population search, or
  implement `ImprovementDriver` directly).
- The gate (compose `defaultProductionGate` with custom checks via
  `composeGate`).
- The deploy step (`autoOnPromote: 'pr'` opens a GitHub PR with the
  winner; `'none'` returns the surface and you ship however you ship).

## What this does NOT install

- No `@tangle-network/sandbox` — nothing runs in a Tangle sandbox.
- No hosted orchestrator — traces, artifacts, judge scores stay on
  your machine (or in `inMemoryCampaignStorage` for Workers/edge).
- No daemons — `runEval` and `runImprovementLoop` complete in-process
  and return.

## When you want more

The wedge doc (`docs/design/external-agent-wedge.md`) lays out three
graduated tiers:

| Tier | What you do | What you get |
|---|---|---|
| **LAND** (this quickstart) | `npm i @tangle-network/agent-eval`, wrap dispatch + judge, run loops | Local artifacts; full self-improvement; no Tangle infra |
| **EXPAND** | Point trace/eval data at our hosted orchestrator | Hosted dashboards, cross-run intelligence, billing on data routed to us |
| **PLATFORM** | Move execution into our sandbox | Substrate + orchestrator data pre-wired; sandbox usage billing |

Each tier is opt-in. EXPAND and PLATFORM build on the same primitives;
upgrading is adding configuration, not rewriting your wiring.
