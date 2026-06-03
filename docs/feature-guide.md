# Feature Guide

This page explains the main `agent-eval` primitives in plain English first,
then shows when to use each one.

## Overview

LLM agents can write code, drafts, research, plans, and actions. The hard part
is knowing whether they actually did a good job, whether they should keep
trying, and whether a change made them better or worse.

`agent-eval` gives you reusable tools for that:

- **Judges** grade one output.
- **Verifiers** run several checks in order.
- **Control loops** let an agent keep working until it passes, gets blocked, or
  hits a budget.
- **Feedback trajectories** turn normal user approvals/rejections into training
  and eval data.
- **Datasets and holdouts** keep examples organized so you do not overfit.
- **Optimizers and mutation loops** try prompt/signature/code variants and keep
  the ones that really improve.
- **Traces and telemetry** show what happened, step by step.

## Which Primitive Should I Use?

| Problem | Use | Why |
| --- | --- | --- |
| “Did this single answer/draft pass?” | Judge or rubric | Fast quality signal for one artifact. |
| “Does generated code actually work?” | `BuilderSession`, `MultiLayerVerifier`, sandbox harness | Build/test/runtime gates catch failures judges miss. |
| “Should the agent keep trying?” | `runAgentControlLoop` | Budgeted `observe -> validate -> decide -> act` runtime. |
| “The agent should propose, verify, review, and revise.” | `runProposeReviewAsControlLoop` | Reusable preset over the generic control loop. |
| “Human feedback should become reusable eval data.” | `FeedbackTrajectory` | Captures approvals, rejections, edits, choices, metrics, and policy blocks. |
| “Can this action run, or does it need approval?” | `evaluateActionPolicy` | Generic preflight for side effects, budgets, and required evidence. |
| “I need train/dev/test/holdout examples.” | `Dataset` plus feedback trajectory conversion | Stable splits and contamination control. |
| “Which prompt or signature wins?” | `runImprovementLoop`, steering optimizers | Runs variants on scenarios and compares scores. |
| “Improve a multi-turn agent over real task traces.” | `runImprovementLoop` | GEPA-style trajectory optimization with ASI and held-out promotion. |
| “Improve prompts, then code if prompts plateau.” | `runPromptEvolution`, composite mutator, code mutator | Bounded evolution with telemetry and lineage. |
| “Find why a regression happened.” | bisector, traces, run records | Narrows changes and preserves evidence. |
| “Expose evals to another language.” | Wire protocol and Python client | HTTP/RPC boundary for non-TypeScript apps. |

## Integration Patterns

### Recommended Product Shape

Use this shape when the product needs to keep pushing work forward instead of
only answering once:

```text
user intent
  -> product adapter observes typed state
  -> runAgentControlLoop decides the next driver action
  -> worker executes in the real product environment
  -> validators and judges grade the new state
  -> FeedbackTrajectory records user/environment/reviewer signal
  -> datasets and optimizers replay the same adapter
```

The important part is that production and eval do not use different loops. The
adapter can swap dependencies (real user session, replay fixture, sandbox), but
the state shape, validators, actions, budgets, and stop policies should stay
the same. That is what makes benchmark gains transfer to real usage.

### Agent Runtime Integration

Use when you have a coding, browser, computer-use, research, or documentation agent.

1. Represent the current task state.
2. Validate that state with objective checks first and judges second.
3. Use `runAgentControlLoop` to decide the next action.
4. Record user feedback as `FeedbackTrajectory`.
5. Convert trajectories into datasets and optimizer rows.

Result:

```text
normal agent usage -> labeled examples -> replay/eval -> optimization
```

Implementation ownership:

- Put reusable loop mechanics, trace schemas, budget accounting, split
  assignment, and optimizer row conversion in `agent-eval`.
- Put product state readers, action executors, approval policy, credentials,
  workspace paths, and UI-specific storage in the downstream repo.
- Promote a product adapter into `agent-eval` only after at least two products
  need the same adapter shape.

### Code Generator

Use when an agent writes or patches a repo.

1. Use `BuilderSession` or `MultiLayerVerifier`.
2. Always run static gates like typecheck/build/tests.
3. Add semantic judges only after build gates pass.
4. Store traces and run records for regression debugging.

Result:

```text
generated code -> build/test/runtime gates -> score -> ship or revise
```

### Prompt/Signature Optimizer

Use when you want Ax/GEPA-style improvement.

1. For variable-length agent tasks, use `runImprovementLoop`.
2. Build search/dev/test/holdout splits from the real product loop.
3. Score full trajectories, not just final text.
4. Emit actionable side information for failures the mutator can fix.
5. Promote only `promotedVariant`, never a rejected `searchBestVariant`.
6. Keep run records with prompt hash, model, config, cost, and commit.

Result:

```text
candidate variant -> repeated evals -> statistical comparison -> promotion gate
```

Do not optimize a toy harness if users run a different product loop. Build
training examples from `FeedbackTrajectory` and `controlRunToFeedbackTrajectory`,
then replay them through the same product adapter used at runtime. Train on
`train`, tune on `dev`, report on `test`, and keep `holdout` untouched until a
promotion decision.

### Human Feedback Data

Use when operator or reviewer interaction should create labels.

Capture:

- approve/reject
- select A/B/C
- edit/rewrite
- rank/rate
- comment
- metric outcome
- policy block or budget block

Store as `FeedbackTrajectory`, then derive:

- preference memory for the next run
- dataset scenarios for regression
- optimizer rows for prompt/signature/code changes
- holdout examples to detect overfitting

## Feature Map

| Area | Key exports | Best for | Notes |
| --- | --- | --- | --- |
| Judging | `createCustomJudge`, `createAntiSlopJudge`, wire rubrics | Content, voice, semantic quality | Pair with objective checks when possible. |
| Verification | `MultiLayerVerifier`, `JudgeRunner`, sandbox harness | Code and multi-step gates | Do not let semantic judges override failed builds. |
| Control | `runAgentControlLoop`, `objectiveEval`, `subjectiveEval` | Long-running agent tasks | Supports budgets, cost, stop policies, trace spans. |
| Propose/review | `runProposeReview`, `runProposeReviewAsControlLoop` | Iterative artifact repair | Good for code, docs, plans, briefs. |
| Feedback data | `FeedbackTrajectory`, stores, converters | Human/environment labels | Domain adapters live in downstream repos. |
| Action policy | `evaluateActionPolicy` | Approval/budget preflight | Blocks or labels actions before `act()`. |
| Datasets | `Dataset`, holdout tools, canaries | Train/dev/test/holdout corpora | Keeps optimization honest. |
| Optimization | `runImprovementLoop`, steering optimizers | Prompt/signature comparison | Use held-out gates before promotion. |
| Evolution | prompt/code mutators, sandbox pool, telemetry | Autoresearch and mutation loops | Use budgets and lineage; do not run unbounded. |
| Telemetry | `TraceStore`, OTLP, file sinks | Audit and replay | Treat traces as evidence, not just logs. |
| Reporting | summaries, pareto, cost tracker | Decision support | Useful for PRs, launch gates, research notes. |

## Guardrails

- Prefer deterministic checks before LLM judges.
- Keep holdout data out of optimization.
- Record model, prompt hash, config hash, commit, and cost for every serious
  run.
- Budget every loop: steps, wall time, and dollars.
- Treat external side effects as downstream policy. The runtime can stop loops,
  but your adapter decides what requires approval.
- Store user feedback with enough context to replay it later.
- Run harnesses and judges in the same sandbox when they need shared files,
  logs, screenshots, or browser state. Use separate sandboxes for parallel
  variants or destructive checks.

## Highest-ROI Adoption Order

1. Wrap one real product workflow in `runAgentControlLoop`.
2. Add objective validators that can fail without an LLM.
3. Emit traces and convert completed runs into feedback trajectories.
4. Capture explicit user/reviewer feedback on attempts.
5. Replay those trajectories as train/dev/test/holdout scenarios.
6. Run prompt/signature optimization against that replay adapter.
7. Promote only when held-out trajectories and product telemetry both improve.

## What Stays Out Of Core

Domain-specific adapters should usually stay in downstream repos until they prove
reusable:

- browser site-specific actions
- repo-specific coding commands
- workspace-specific storage paths

Core should provide shapes, stores, runners, scoring, traces, and converters.
Downstream integrations provide domain state, policy, tools, and storage.

## Examples

- `examples/same-sandbox-harness`: one workdir for install/build/test plus
  evidence inspection.
- `examples/multi-shot-optimization`: full-trajectory optimization with a
  holdout gate.
- `examples/benchmarks`: benchmark adapter contracts and reference wrappers.
