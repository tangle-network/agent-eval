# @tangle-network/agent-eval

Domain-agnostic evaluation framework for Tangle agent apps. Multi-turn scenario execution, multi-judge scoring, agent-driver meta-testing, convergence tracking. Every agent (tax, legal, film, gtm) imports this to get a reproducible quality harness.

## Install

```bash
npm install @tangle-network/agent-eval
```

## Usage

```ts
import { BenchmarkRunner, ProductClient, defaultJudges } from '@tangle-network/agent-eval'

const client = new ProductClient({
  baseUrl: 'https://my-agent.tangle.tools',
  routes: {
    signup: '/api/auth/sign-up/email',
    chat: '/api/chat',
    // ...
  },
})

const runner = new BenchmarkRunner(client, {
  scenarios: myScenarios,
  judges: defaultJudges('film production'),
  systemPrompt: MY_SYSTEM_PROMPT,
})

const report = await runner.run()
```

## What's in the box

- **ProductClient** — configurable HTTP client (routes are config, not code)
- **ScenarioRegistry** — auto-discovery + filtering
- **executeScenario** — multi-turn executor with artifact collection
- **BenchmarkRunner** — orchestrates scenarios + judges + scoring
- **AgentDriver** — meta-agent that plays personas against a real product
- **MetricsCollector** — per-turn product state metrics
- **ConvergenceTracker** — completion% over turns
- **Reporter** — markdown + console output
- **Judges** — 4 built-in (domain expert, code execution, coherence, adversarial) + `createCustomJudge` factory

## Tier

Marketplace tier of the [agent-builder](https://github.com/drewstone/tangle-agent-builder) three-tier architecture. Uses [`@tangle-network/tcloud`](https://github.com/tangle-network/tcloud) for judge LLM calls.

## Related

- [`@tangle-network/agent-gateway`](https://github.com/tangle-network/agent-gateway) — the gateway agents published through
- [`@tangle-network/agent-client`](https://github.com/tangle-network/agent-client) — consumer SDK for those endpoints
- [`@tangle-network/tcloud`](https://github.com/tangle-network/tcloud) — platform SDK (used internally by judges)

## License

MIT
