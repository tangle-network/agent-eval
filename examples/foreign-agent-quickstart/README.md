# Foreign-agent quickstart

**Goal:** wire any agent behind a `Dispatch`, define a few scenarios + a
judge, and run a real self-improvement loop in 15 minutes. No Tangle
sandbox. No Tangle account. No hosting.

## What you get

After this walkthrough you have:

1. A repeatable evaluation harness against scenarios you control.
2. A judge that scores agent output on dimensions you define.
3. A closed self-improvement loop: campaign → judge → proposer → gate →
   next generation. Stops when the gate ships or the budget exhausts.
4. Traces + artifacts you own. Locally on disk or in-memory for edge
   runtimes.

No Tangle infrastructure required at any step.

## Install

```sh
npm i @tangle-network/agent-eval
```

`agent-eval` depends on the shared `@tangle-network/agent-interface`
profile contract and does not install sandbox or agent-runtime. Add those
packages only when you want their execution backend or production-runtime
helpers. The LAND tier in this quickstart uses neither.

## The five types

```ts
import {
  type Dispatch,        // your agent, behind one function
  type Scenario,        // what you evaluate against
  type JudgeConfig,     // what "good" means
  type SurfaceProposer, // how to propose the next surface
  type Gate,            // promotion guard
} from '@tangle-network/agent-eval/contract'
```

Every type in `/contract` is committed under semver — new minors only
add, nothing here changes shape in a 0.x minor.

## The four functions

```ts
import {
  runEval,                  // one-off evaluation, returns a score
  runCampaign,              // structured cells (scenarios × seeds × reps)
  runImprovementLoop,       // closed self-improvement loop
  defaultProductionGate,    // standard held-out promotion gate
} from '@tangle-network/agent-eval/contract'
```

## Two storage backends

```ts
import {
  fsCampaignStorage,        // writes to disk (Node default)
  inMemoryCampaignStorage,  // no FS (Workers, edge, tests)
} from '@tangle-network/agent-eval/contract'
```

## Wiring your agent — three steps

### 1. Declare scenarios

A scenario is just an `id` + `kind` + your domain fields. Whatever your
agent eats, model it here.

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

### 2. Wrap your agent as a `Dispatch`

One function: scenario in, artifact out. Your agent stays exactly as it
is — call OpenAI, LangChain, Anthropic, a local model, anything. The
engine doesn't care.

```ts
const dispatch: Dispatch<MarketingScenario, MarketingArtifact> = async (scenario, ctx) => {
  const rewrite = await callYourAgent(scenario, { signal: ctx.signal })
  return { rewrite, modelUsed: 'whatever' }
}
```

`ctx` carries a per-cell `signal` (cancel propagation), a scoped trace
writer, an artifact writer, and a cost meter. Use them or ignore them.

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
    // your scoring — LLM, heuristic, ensemble, anything.
    // Must return { dimensions, composite, notes }.
    return { dimensions, composite, notes }
  },
}
```

Throw on judge failure — the substrate records it as a failed cell. Do
not silently fold errors into a zero score.

## Run a baseline

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

## Run the closed self-improvement loop

```ts
import { gepaProposer, defaultProductionGate } from '@tangle-network/agent-eval/contract'

const baselineSurface = 'You are a senior copywriter. ...'

const result = await runImprovementLoop({
  scenarios: trainScenarios,         // optimize against these
  baselineSurface,
  dispatchWithSurface: (surface, scenario, ctx) =>
    yourAgent.runWithPrompt(surface as string, scenario, ctx),
  proposer: gepaProposer({
    llm: { apiKey: process.env.OPENAI_API_KEY, baseUrl: '...' },
    model: 'gpt-4o-mini',
    target: 'marketing copywriting system prompt',
    mutationPrimitives: [
      'Tighten the hook: lead with the concrete user outcome.',
      // ...
    ],
  }),
  judges: [judge],
  populationSize: 2,
  maxGenerations: 3,
  holdoutScenarios,                  // kept out of training, used by the gate
  gate: defaultProductionGate({
    holdoutScenarios,
    deltaThreshold: 0.05,
  }),
  autoOnPromote: 'none',             // 'pr' to auto-open a PR with the winner
  storage: inMemoryCampaignStorage(),
  runDir: 'mem://my-improve',
})

if (result.gateResult.decision === 'ship') {
  console.log('Shipped:', result.winnerSurface)
}
```

The gate's `decision` is `'ship'` | `'hold'` | `'need_more_work'` |
`'model_ceiling'` | `'arch_ceiling'`. You decide what each means in your
deploy pipeline — we don't push code without consent.

## Try it now

```sh
cd examples/foreign-agent-quickstart
pnpm tsx index.ts                            # heuristic-only — no API key needed
OPENAI_API_KEY=sk-... pnpm tsx index.ts      # real LLM + real gepa-driven lift
```

Without `OPENAI_API_KEY`, the example still runs end-to-end against a
deterministic stub agent + heuristic judge so the wiring is verifiable
in CI. With a key, you see the actual reflective-mutation loop earn
its lift over the baseline.

## What this does NOT install

- No `@tangle-network/sandbox` — nothing is provisioned, nothing runs in
  a Tangle sandbox, no auth required.
- No hosted orchestrator — traces stay on your machine.
- No background daemons — `runEval` and `runImprovementLoop` complete
  in-process and return.

If you later want hosted dashboards, cross-run intelligence, or our
sandbox as a swap-in backend, those are opt-in:
[`docs/design/external-agent-wedge.md`](../../docs/design/external-agent-wedge.md).

## Common extensions

| You want | Use |
|---|---|
| Multiple judges (ensemble) | `judges: [a, b, c]` — runEval averages across them per cell |
| RL training data | `@tangle-network/agent-eval/rl` — `campaignToRunRecords`, `extractPreferences` |
| Deployment outcomes feeding back into the gate | `OutcomeStore` + `predictiveValidityResearcher` from `/rl` |
| Worker / edge runtime (no FS) | `inMemoryCampaignStorage()` instead of `fsCampaignStorage()` |
| LangChain agent | `@tangle-network/agent-eval/adapters/langchain` (in the next release) |
| Custom mutation strategy | Implement `SurfaceProposer` directly, or `evolutionaryProposer({ mutator })` |
| Custom promotion logic | `composeGate(defaultProductionGate(...), yourCustomGate)` |

## Where to go next

- `examples/production-loop/` — end-to-end demo with a real GitHub PR
  on a successful promotion.
- `docs/design/external-agent-wedge.md` — the broader story: how this
  LAND tier composes into the EXPAND (hosted) and PLATFORM (sandbox)
  tiers when you're ready.
- `README.md` — the shortest current path through `analyzeRuns()` and
  `selfImprove()`.
