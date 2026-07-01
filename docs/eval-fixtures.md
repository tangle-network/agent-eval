# Eval Fixtures

Use eval fixtures when you want the easiest coding-agent eval shape:

```text
evals/
  fix-login/
    PROMPT.md
    EVAL.ts
    package.json
    src/...
```

This copies the best Vercel-style DX without adding a second runner. Fixtures
become `Scenario` rows, `planEvalFixtureRun()` tells you what is cached vs what
will run, and `runCampaign()` remains the only execution primitive.

## When To Use It

Use fixtures when:

- a human or agent should add a new eval by creating one folder
- the prompt, starter files, and validation file should fingerprint together
- you want a dry run before spending model tokens
- a runtime or sandbox dispatch already knows how to run one scenario

Do not use fixtures to bypass campaign scoring, held-out gates, traces, or
backend checks. The fixture folder is input data; the dispatch still owns agent
execution.

## API

```ts
import {
  discoverEvalFixtures,
  loadEvalFixtureScenarios,
  planEvalFixtureRun,
  runCampaign,
} from '@tangle-network/agent-eval/campaign'
```

| Export | Use |
| --- | --- |
| `discoverEvalFixtures(evalsDir)` | Return nested fixture names containing exact-case `PROMPT.md`. |
| `loadEvalFixture(evalsDir, name)` | Load one fixture, validate `EVAL.ts`/`EVAL.tsx` and `package.json`, compute a file fingerprint. |
| `loadEvalFixtureScenarios(evalsDir)` | Convert fixtures into `Scenario` rows for `runCampaign`. |
| `planEvalFixtureRun(opts)` | Preview cached vs runnable fixture cells without invoking the agent. |
| `planCampaignRun(opts)` | Same preview for any campaign scenario set. |

`validation: 'vitest'` is the default and requires `PROMPT.md`,
`EVAL.ts` or `EVAL.tsx`, and `package.json` with `"type": "module"`.
Use `validation: 'none'` for prompt-only corpora.

## Minimal Flow

```ts
const scenarios = loadEvalFixtureScenarios('evals', {
  fingerprintConfig: {
    model: 'claude-sonnet-4-6@2026-06-01',
    tools: ['shell', 'edit'],
  },
})

const plan = planEvalFixtureRun({
  evalsDir: 'evals',
  runDir: '.agent-eval/runs/coding',
  dispatchRef: 'codex/sandbox/v1',
  fingerprintConfig: {
    model: 'claude-sonnet-4-6@2026-06-01',
    tools: ['shell', 'edit'],
  },
})

if (plan.cellsToRun > 0) {
  await runCampaign({
    scenarios,
    dispatch,
    dispatchRef: 'codex/sandbox/v1',
    judges,
    runDir: '.agent-eval/runs/coding',
    expectUsage: 'assert',
  })
}
```

`dispatchRef` is part of the campaign manifest. Change it when the dispatch's
real behavior changes: model, tool set, sandbox profile, prompt wrapper, or
runtime strategy. That keeps resume caches honest.

## What Agents Should Extend

Agents should add capability in this order:

1. Add a fixture folder under `evals/<name>/`.
2. Put the user task in `PROMPT.md`.
3. Put deterministic checks in `EVAL.ts` when the task has a code artifact.
4. Add starter files beside it.
5. Update the dispatch that maps `EvalFixtureScenario` to the real runtime or
   sandbox run.
6. Add or tune judges only after deterministic checks exist.
7. Run `planEvalFixtureRun()` before `runCampaign()` and report the counts.

Do not add a parallel cache. `runCampaign` stores `manifestHash` on each cached
cell and refuses stale reuse.

## Example

Run the offline quickstart:

```sh
pnpm tsx examples/eval-fixtures-quickstart/index.ts
```

The example prints the plan before and after a run so you can see the cache
transition from `2 to run / 0 cached` to `0 to run / 2 cached`.
