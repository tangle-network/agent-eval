# Feedback Trajectories

Feedback trajectories are the generic shape behind feedback-driven learning
loops:

```text
candidate artifact/action -> user/judge/environment feedback -> revision chain -> labeled example -> replay/eval/optimization
```

They are deliberately domain-neutral. Legal memo review, tax fact gathering,
browser task completion, code patch review, and research brief revision all fit
the same structure.

## Core Shape

```ts
import {
  createFeedbackTrajectory,
  summarizePreferenceMemory,
  feedbackTrajectoriesToDatasetScenarios,
  feedbackTrajectoriesToOptimizerRows,
} from '@tangle-network/agent-eval'

const trajectory = createFeedbackTrajectory({
  projectId: 'research-agent',
  scenarioId: 'brief-review',
  task: {
    intent: 'Revise a research brief until it is specific and sourced.',
    context: { audience: 'technical reviewer' },
  },
  attempts: [
    {
      id: 'attempt-1',
      stepIndex: 0,
      artifactType: 'research',
      artifact: { summary: 'Initial brief with weak sourcing.' },
      createdAt: new Date().toISOString(),
    },
  ],
  labels: [
    {
      source: 'user',
      kind: 'revision_request',
      value: 'needs stronger evidence',
      reason: 'add primary sources and remove unsupported claims',
      severity: 'error',
      createdAt: new Date().toISOString(),
    },
  ],
})

const memory = summarizePreferenceMemory([trajectory])
const scenarios = feedbackTrajectoriesToDatasetScenarios([trajectory])
const optimizerRows = feedbackTrajectoriesToOptimizerRows([trajectory])
```

## What Belongs In Core

`agent-eval` owns the substrate:

- trajectory and label schemas
- in-memory and JSONL-backed stores
- deterministic train/dev/test/holdout splitting
- JSONL import/export
- conversion into `DatasetScenario`
- conversion into optimizer rows
- preference-memory distillation
- conversion from `runAgentControlLoop` results

Downstream repos own domain adapters:

- how review actions map to labels
- how generated artifacts are represented
- which side effects require approval
- which budgets and metrics matter
- where task-local data is stored

## Label Sources

Labels can come from multiple places:

| Source | Example |
| --- | --- |
| `user` | Approved a draft, rejected a legal paragraph, selected option B. |
| `judge` | LLM/domain judge scores usefulness or voice. |
| `environment` | Browser task completed, tests passed, API call succeeded. |
| `metric` | A measured outcome improved or regressed. |
| `policy` | Budget cap blocked execution, approval required. |
| `system` | Control loop passed or failed. |

The most useful trajectories combine several label sources: user preference
plus objective outcome plus later metric result.

## Multi-Shot Revision

Store every attempt, not only the final artifact:

```text
draft 1 -> user rejects with reason -> draft 2 -> judge passes -> user approves -> metric outcome
```

This supports tests that ask "does the agent improve after feedback?" instead
of only "was the final answer good?"

## Control Runtime Bridge

`controlRunToFeedbackTrajectory` turns a finished control-loop run into a
trajectory:

```ts
const run = await runAgentControlLoop({ ... })
const trajectory = controlRunToFeedbackTrajectory(run, {
  projectId: 'coding-agent',
  scenarioId: 'fix-typecheck',
  artifactType: 'code',
})
```

Use this for tasks where the agent works autonomously and the labels come from
validators, policies, or environment outcomes. Use direct trajectory recording
for review-heavy workflows where a person approves, rejects, edits, ranks, or
comments.

## Optimization Loop

The same stored trajectories can feed three layers:

1. **Immediate memory**: distill labels into short instructions.
2. **Replay/eval**: convert trajectories into dataset scenarios.
3. **Prompt/signature/code optimization**: convert trajectories into optimizer
   rows and evaluate candidate variants on train/dev/holdout splits.

That is the reusable pattern:

```text
normal agent usage -> labeled trajectory -> eval dataset -> optimizer input -> replay against held-out feedback
```
