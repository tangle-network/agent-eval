# TB-Repair continuation policy

The continuation policy answers one question: after an analyst names a failing step `k` and proposes a single action, what happens if the agent keeps working from there?

`Delta-repair = P(tests pass | intervention) - P(tests pass | no-fix control)` is the headline number of TB-Repair.
It only measures the intervention when all three arms run forward under the same policy.
This module makes that symmetry structural rather than promised.

Source: [`src/trace-repair/`](../src/trace-repair/).
The pre-pass that decides which rows the arms run on is in [trace-repair-admission.md](./trace-repair-admission.md).

## What runs

| element | value | why it is fixed |
| --- | --- | --- |
| scaffold | mini-swe-agent | The corpus recorded it, so a continuation stays in the same distribution as the prefix. |
| step budget | 20 model calls | Bounds a rollout without a wall-clock limit, which would end rollouts at different points. |
| temperature | 0 | With a fixed seed, the same prefix draws the same continuation. |
| command timeout | 30 s | The recorded runs used the scaffold's own 30-second limit. A longer limit lets the continuation finish commands the recorded agent could not. |
| network | `none` | A container with a network can install what the recorded run could not. |
| format-error cap | 3 consecutive turns | Ends a rollout that has stopped producing actions. |
| model and seed | chosen per campaign | No default stands in for either. |

`definePinnedContinuationPolicy({ model, seed })` freezes a policy and validates it.
`continuationPolicyDigest(policy)` hashes the policy together with the scaffold text it renders, so an edited template produces a different digest and cannot be pooled with earlier rollouts.

## Why the arms cannot drift apart

Three arms share one code path, and the arm is a label on the record:

- **intervention** — the analyst's action substituted at step `k`.
- **no-fix control** — step `k` replayed unchanged.
- **no-op control** — step `k` replaced by an action that changes nothing.

The arms differ only in the container state handed to the runner, which is the treatment under test.
Three guards keep the policy itself identical:

1. `continuationSeed(policySeed, rowId, rolloutIndex)` cannot read the arm, so paired rollouts across arms draw the same seed.
2. Every rollout records the `policyDigest` it ran under.
3. `assertArmSymmetry(rollouts)` rejects a set whose rollouts disagree on that digest or on a paired seed.

## What a rollout records

Every rollout carries the assistant message, the parsed action, the observation, the return code, the timeout flag, per-call latency, the served model id, token usage, and cost.

Two record rules keep a partial measurement from reading as a complete one:

- `usage.callsWithUsage` below `usage.calls` clears `usage.captured`. Calls that reported nothing are never filled with zeros.
- One unpriced call makes the whole rollout `{ kind: 'uncaptured', usd: null }`. Summing the priced calls would report less than what was spent.

`rolloutRecordedSteps(rollout)` projects the continuation into the `{ src, msg, tools, obs }` steps the trajectory corpus stores, so the replay layer reads a continuation with the reader it already has.
`rolloutDigest(rollout)` hashes the deterministic content — actions, observations, seeds, exit status, usage — and excludes wall-clock fields, which vary between identical runs.

## Exit statuses

| status | meaning |
| --- | --- |
| `submitted` | A command echoed the sentinel and exited 0. The submission text is recorded. |
| `step-budget-exhausted` | The rollout used all 20 calls without submitting. |
| `repeated-format-error` | Three consecutive turns held no single bash block. |
| `model-error` | The provider call failed. The rollout is recorded with `terminalError`, not dropped. |
| `environment-error` | A container call failed. The step keeps the action that hit it. |

## Running one

```ts
import {
  createDockerContinuationEnvironment,
  definePinnedContinuationPolicy,
  nodeProcessRunner,
  runContinuation,
} from '@tangle-network/agent-eval/../src/trace-repair'

const policy = definePinnedContinuationPolicy({ model: 'pinned/model-id', seed: 20260808 })

const rollouts = await runContinuation({
  policy,
  arm: 'intervention',
  rowId: 'break-filter-js-from-html:7',
  prefix, // messages through step k, rebuilt by the replay layer
  rollouts: 3,
  model,
  environments: {
    id: 'docker',
    async create({ arm, rolloutIndex }) {
      return createDockerContinuationEnvironment({
        containerRef: await restoreState({ arm, rolloutIndex }),
        cwd: '/app',
        runProcess: nodeProcessRunner,
        removeOnDispose: true,
      })
    },
  },
})
```

The runner calls `describe()` before the first model call and refuses any container whose network mode is not `none`.
The environment reports the mode the daemon holds, not the mode the caller asked for.

The prefix must start with a system message then a user message, and must end on a user message.
A prefix ending on an assistant turn means the replay left an action unanswered, and the runner rejects it.

Each rollout gets its own environment, because a rollout mutates the container it runs in.
