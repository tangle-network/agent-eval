# @tangle-network/agent-eval

Reusable evaluation framework for Tangle agent applications.

## What This Is

Domain-agnostic eval package that any Tangle agent (film, GTM, legal, tax) imports to get multi-turn scenario execution, multi-judge scoring, agent driver testing, and convergence tracking. Each agent provides its own scenarios, judges, and system prompts.

## Architecture

```
@tangle-network/agent-eval
├── ProductClient      — configurable HTTP client (routes are config)
├── ScenarioRegistry   — auto-discovery + filtering
├── executeScenario    — multi-turn executor with artifact collection
├── BenchmarkRunner    — orchestrates scenarios + judges + scoring
├── AgentDriver        — meta-agent that plays personas against real product
├── MetricsCollector   — per-turn product state metrics
├── ConvergenceTracker — completion% over turns
├── Reporter           — markdown + console output
└── Judges             — domain expert (configurable), code execution, coherence, adversarial
```

## Key Files

- `src/types.ts` — all shared types
- `src/client.ts` — ProductClient + e2e workflow harness
- `src/judges.ts` — 4 built-in judges + createCustomJudge factory
- `src/executor.ts` — scenario execution with configurable system prompt
- `src/benchmark.ts` — BenchmarkRunner class
- `src/driver.ts` — AgentDriver (meta-agent turn loop)
- `src/metrics.ts` — MetricsCollector
- `src/convergence.ts` — ConvergenceTracker
- `src/registry.ts` — ScenarioRegistry
- `src/reporter.ts` — report formatting

## Tech Stack

- TypeScript strict, no semicolons, single quotes, 2-space indent
- tsup for bundling
- vitest for tests
- @tangle-network/tcloud for LLM calls (judges + driver)

## Commands

```bash
pnpm build        # tsup build
pnpm test         # vitest
pnpm typecheck    # tsc --noEmit
```

## How Agents Use This

```typescript
import { BenchmarkRunner, ProductClient, defaultJudges } from '@tangle-network/agent-eval'

const client = new ProductClient({
  baseUrl: 'https://my-agent.tangle.tools',
  routes: { signup: '/api/auth/sign-up/email', chat: '/api/chat', ... },
})

const runner = new BenchmarkRunner(tc, {
  scenarios: myScenarios,
  judges: defaultJudges('film production'),
  systemPrompt: MY_SYSTEM_PROMPT,
})

const report = await runner.run()
```
