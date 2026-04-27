# @tangle-network/agent-eval

**A library for deciding whether an LLM-driven generator did its job.**

You hand it the thing the generator produced — a code scaffold, a patch, a tweet, a JSON config — and you get back a structured verdict: pass/fail, dimension scores, plain-English rationale. Built to catch the LLM failure modes that LLM-as-judge alone misses.

```ts
import { BuilderSession, SubprocessSandboxDriver, InMemoryTraceStore } from '@tangle-network/agent-eval'

const session = new BuilderSession(new InMemoryTraceStore(), { projectId: 'my-app' }, new SubprocessSandboxDriver())
await session.startChat()
const ship = await session.ship({
  harness: { setupCommand: 'pnpm install', testCommand: 'pnpm exec tsc --noEmit', cwd: scaffoldDir, timeoutMs: 180_000 },
})
console.log(ship.result.passed, ship.result.score)
```

## Who this is for

- You ship a code generator (scaffolder, patcher, refactor agent) and need to gate on whether its output actually works.
- You ship a content generator and need quality signal beyond "the LLM said it's good".
- You want a release gate that fails on regressions you can name, not vibes.

If that's you, start with [`docs/concepts.md`](./docs/concepts.md) — 5-minute mental model — then come back here.

## Quickstart

### From any language: HTTP or RPC

The fastest path. agent-eval ships a CLI that runs as either an HTTP server or a stdio RPC binary. Drive it from Python, Rust, Go, anything.

```sh
npm i -g @tangle-network/agent-eval

# HTTP — long-running
agent-eval serve --port 5005

# stdio RPC — one-shot, batch
echo '{"rubricName":"anti-slop","content":"…"}' | agent-eval rpc judge
```

Python:
```sh
pip install tangle-agent-eval
```
```python
from tangle_agent_eval import Client
c = Client()
r = c.judge(content="our scaffold ships zero-copy IO", rubric_name="anti-slop")
print(r.composite, r.failure_modes)
```

See [`docs/wire-protocol.md`](./docs/wire-protocol.md) for the full surface.

### From TypeScript: import directly

In-process; no wire round-trip. Use this when your eval lives in the same Node process as your generator.

```sh
pnpm add @tangle-network/agent-eval
```

The recipe for a code-generator eval is in [`SKILL.md` §Minimal working path](./.claude/skills/agent-eval/SKILL.md#minimal-working-path-builder-of-builders).

## Two ways to read this repo

- **You're a human onboarding** — read [`docs/concepts.md`](./docs/concepts.md) for the mental model, then [`docs/wire-protocol.md`](./docs/wire-protocol.md) if you'll call from another language, or `SKILL.md` if you'll embed in TS.
- **You're an LLM agent writing integration code** — read `SKILL.md`. Every directive there encodes a shipped bug; skipping one reintroduces the bug class.

## What's in the box

| Module | What it does | Doc |
|---|---|---|
| `BuilderSession` | Three-layer eval orchestrator (builder → app-build → app-runtime) for code generators. | concepts.md §three-layer eval |
| `MultiLayerVerifier` | Pipeline of layers (install → typecheck → build → semantic). Skip-on-fail, weighted aggregate. | concepts.md §verifiers |
| `judges`, `createCustomJudge`, `createAntiSlopJudge` | LLM and deterministic judges. | SKILL.md |
| Wire protocol (`agent-eval serve` / `rpc`) | HTTP and stdio RPC interface for cross-language clients. | wire-protocol.md |
| `clients/python/` | First-party Python client (`tangle-agent-eval` on PyPI). Version-locked to npm. | clients/python/README.md |
| `BenchmarkRunner`, `executeScenario`, `ConvergenceTracker` | Multi-turn scenario execution + cross-run tracking. | SKILL.md |
| `ExperimentTracker`, `PromptOptimizer`, `bisector` | A/B prompts, optimize steering, bisect regressions. | SKILL.md |
| `runPromptEvolution`, `createCompositeMutator`, `createSandboxPool`, `createSandboxCodeMutator`, `MutationTelemetry`, `LineageRecorder`, `CostLedger`, `JsonlTrialCache` | Prompt + code evolution loops with bounded sandbox pools, durable JSONL telemetry, plateau-detecting composite mutators, crash-resumable trial cache. | §Evolution loop |
| `reflective-mutation` (`buildReflectionPrompt`, `parseReflectionResponse`, `DEFAULT_MUTATION_PRIMITIVES`) | Trace-conditioned LLM mutator that reasons over top/bottom trials instead of blind rewrites. | inline JSDoc |
| `correlationStudy`, `OutcomeStore`, `ProductRegistry` | Meta-eval: do our scores predict deployment outcomes (revenue, retention)? | inline JSDoc |
| Telemetry (`telemetry/`, `telemetry/file`) | OTLP export, trace replay, file sinks. | inline JSDoc |

## Evolution loop

Closing the loop on a prompt or codebase is **two adapters + a config**. Compose `runPromptEvolution` with `createCompositeMutator` (plateau policy) and you get prompt-only optimization until improvement stalls, then automatic switch to code-channel mutations from a coding agent inside a `SandboxPool`.

```ts
import {
  createSandboxPool,
  createSandboxCodeMutator,
  createCompositeMutator,
  buildReflectionPrompt,
  parseReflectionResponse,
  runPromptEvolution,
  MutationTelemetry,
  LineageRecorder,
  CostLedger,
  JsonlTrialCache,
} from '@tangle-network/agent-eval'

// 1. Prompt mutator — reflective-mutation reasons over top/bottom trials
const promptMutator = {
  async mutate({ parent, topTrials, bottomTrials, childCount }) {
    const ctx = { target: 'forge-prompt', parentPayload: parent.payload, topTrials, bottomTrials, childCount }
    const reflection = buildReflectionPrompt(ctx)
    const raw = await yourLlm(reflection)
    return parseReflectionResponse(raw, childCount).map((p, i) => ({
      id: `${parent.id}.g${parent.generation + 1}.prompt.${i}`,
      payload: p.payload,
      generation: parent.generation + 1,
      parentId: parent.id,
      label: p.label,
      rationale: p.rationale,
    }))
  },
}

// 2. Code mutator — runs a coding agent in a sandbox slot, captures the diff
const pool = createSandboxPool({
  size: 4,
  factory: {
    async create(id) { return await yourSandboxClient.create({ name: id }) },
    async reset(slot) { await slot.resource.exec('git reset --hard origin/main && git clean -fd') },
    async destroy(slot) { await slot.resource.delete() },
  },
})
const codeMutator = createSandboxCodeMutator({
  pool,
  runner: async ({ slot, parent, topTrials, bottomTrials }) => {
    const result = await slot.resource.task(`Improve the prompt at /repo/forge-prompt.ts...`)
    return [{ ok: true, latencyMs: result.durationMs, costUsd: result.costUsd, artifact: { diff: result.diff } }]
  },
  toVariantPayload: (outcome, parent) => ({ ...parent.payload, codeMutation: outcome.artifact }),
})

// 3. Compose — plateau policy auto-switches when prompt evolution stalls
const composite = createCompositeMutator({
  primary: promptMutator,
  secondary: codeMutator,
  policy: 'plateau',
  plateauThreshold: 0.02,
  plateauPatience: 2,
})

// 4. Run — durable telemetry to disk, crash-resumable
const result = await runPromptEvolution({
  runId: `forge_${Date.now()}`,
  target: 'forge-prompt',
  seedVariants: [{ id: 'v0', payload: { text: currentPrompt }, generation: 0, label: 'baseline' }],
  scenarioIds: referenceCorpus.map(s => s.id),
  reps: 3,
  generations: 5,
  populationSize: 4,
  scoreAdapter: { /* runs your eval against (variant, scenario, rep) */ },
  mutateAdapter: composite,
  cache: new JsonlTrialCache('.evolve/cache.jsonl'),
  objectives: [
    { name: 'score', direction: 'maximize', value: a => a.meanScore },
    { name: 'cost', direction: 'minimize', value: a => a.meanCost },
  ],
})
```

The `MutationTelemetry`, `LineageRecorder`, and `CostLedger` pass into the `code-mutator` (and any consumer that wants them) — they emit append-only JSONL of every attempt (success + failure with reason) and a snapshot lineage tree, so a finished run leaves a forensically complete trail under one directory.

For the full primitive surface and rationale, read each module's JSDoc — `prompt-evolution.ts`, `composite-mutator.ts`, `sandbox-pool.ts`, `code-mutator.ts`, `reflective-mutation.ts`, `evolution-telemetry.ts`.

## Tech stack

- TypeScript strict, no semicolons, single quotes, 2-space indent
- `tsup` for bundling, `vitest` for tests
- `@tangle-network/tcloud` for LLM calls (judges, driver)
- `hono` + `@asteasolutions/zod-to-openapi` for the wire protocol

## Develop

```sh
pnpm install
pnpm typecheck
pnpm test
pnpm build
pnpm openapi             # write dist/openapi.json from the wire schemas

# Run the server locally
node dist/cli.js serve --port 5005

# Python client tests (require pnpm build first)
cd clients/python && pip install -e ".[dev]" && pytest
```

## Release

`@tangle-network/agent-eval` (npm) and `tangle-agent-eval` (PyPI) ship from the same git tag in the same CI workflow. If either fails to publish, neither does. Versions are locked.

## Related

- [`@tangle-network/agent-gateway`](https://github.com/tangle-network/agent-gateway)
- [`@tangle-network/agent-client`](https://github.com/tangle-network/agent-client)
- [`@tangle-network/tcloud`](https://github.com/tangle-network/tcloud)

## License

MIT
