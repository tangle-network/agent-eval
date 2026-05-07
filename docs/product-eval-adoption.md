# Product Eval Adoption

This guide is for teams adding `@tangle-network/agent-eval` to a real agent
product. The package supplies evaluation contracts and runtime primitives. Your
product supplies the actual workflow adapter, state, credentials, tools, UI, and
storage.

## Goal

Use the same loop for production, replay, and optimization:

```txt
real user task
  -> product adapter observes state
  -> validators and judges grade state
  -> control loop decides next action
  -> product agent acts in the real environment
  -> trace + feedback trajectory are stored
  -> datasets and optimizers replay the same adapter
```

If production and eval use different loops, benchmark gains will not transfer.

## What The Product Owns

The product owns:

- task state and domain models
- credentials, tenant policy, approval, and side-effect rules
- browser, sandbox, CLI, connector, or voice drivers
- database and trace persistence
- user/reviewer feedback collection
- deployment and live canary routing
- model gateway configuration

`agent-eval` owns:

- trace, run, dataset, feedback, and score contracts
- control-loop mechanics
- verifier and judge orchestration
- failure taxonomy
- paired statistics and holdout gates
- optimizer inputs and promotion reports

## Minimal Production Adapter

Start with a small adapter that mirrors one real workflow.

```ts
interface ProductEvalAdapter<TState, TAction> {
  observe(taskId: string): Promise<TState>
  validate(state: TState): Promise<ControlEvalResult[]>
  decide(input: {
    state: TState
    evals: ControlEvalResult[]
    history: unknown[]
  }): Promise<TAction | 'stop'>
  act(taskId: string, action: TAction): Promise<void>
}
```

Keep the adapter product-owned until at least two products need the same shape.

## Validator Order

Use deterministic checks before judges.

1. **State validity**: schema, required files, required DB rows, required
   connections.
2. **Runtime gates**: install, build, typecheck, tests, serve, deploy smoke.
3. **Policy gates**: approvals, side effects, budget, credentials, data
   freshness.
4. **Behavior gates**: browser flows, API calls, generated app preview, voice
   transcript checks.
5. **Semantic judges**: intent fit, quality, completeness, safety,
   professional correctness.

Semantic judges should never turn a failed build into a pass.

## Traces And Feedback

Every serious run should record:

- task id and scenario id
- git commit
- model and provider
- prompt/config hashes
- tool calls and retrieval spans
- build/test/deploy output
- cost, latency, and token use
- user/reviewer feedback
- final outcome and failure class

Convert runs into `FeedbackTrajectory` records so normal product usage becomes
replayable eval data.

```txt
production run -> feedback trajectory -> dataset scenario -> optimizer row
```

## Datasets And Holdouts

Use four splits:

- `train`: optimizer search.
- `dev`: tuning and threshold selection.
- `test`: normal reporting.
- `holdout`: promotion-only gate.

Do not inspect or tune against holdout failures during optimization. If a
holdout failure reveals a real product bug, fix the bug and rotate the holdout
set with a signed note.

## Optimization

Use `runMultiShotOptimization()` when the system is a multi-step agent, not a
single prompt.

Good optimization targets:

- system prompt
- tool descriptions
- retrieval policy
- data acquisition policy
- user-question policy
- evaluator threshold
- agent topology
- scaffold/template choice

Bad optimization targets:

- hidden holdout examples
- production credentials
- brittle string checks that do not match user value
- fake workflows that do not call the product adapter

Use actionable side information so the optimizer knows whether a failure belongs
to prompt, tools, retrieval, data acquisition, sandbox, evaluator, or product
runtime.

## Release Gate

A launch or promotion should require:

- enough runs for the target risk level
- paired improvement over the current baseline
- no critical regression on test
- holdout pass or explicit rejection
- cost and latency within budget
- no unresolved canary or contamination failures
- trace evidence for representative successes and failures
- human-readable report with failure clusters and next actions

`evaluateReleaseConfidence()` and the paired statistics helpers provide the
decision data. The product decides the business threshold.

## Product Patterns

### Coding Or Builder Agent

Use sandbox/build/test/serve/browser validators. Add intent and semantic
concept judges only after the generated app runs.

### Browser Agent

Record browser steps, screenshots, network errors, console errors, and final
state. Use deterministic DOM/API assertions before visual or semantic judges.

### Domain Agent

Use domain fixtures, jurisdiction/date metadata, retrieval spans, and
professional judges. Fail missing/stale evidence separately from bad reasoning.

### Workflow Or Integration Agent

Use `@tangle-network/agent-integrations` manifests as readiness inputs. Gate
missing connections, missing scopes, approval-required writes, and stale tokens
before blaming the agent prompt.

For generated apps and sandbox agents, also run the
[Integration Launch Gates](./integration-launch-gates.md). The eval should prove
that app code invokes through the integration bridge, not provider SDKs with raw
OAuth tokens.

### Voice Agent

Record transcript, timing, interruptions, tool calls, and task outcome. Judge
conversation quality separately from tool success and policy compliance.

## Anti-Patterns

- Evaluating only final prose for an agent that actually builds, browses, or
  calls tools.
- Letting an LLM judge override failed tests.
- Optimizing on examples that users will never hit.
- Recording traces as logs but never converting them to datasets.
- Calling every failure a prompt failure when context, data, auth, or runtime
  readiness was missing.
- Shipping reports without run ids, commits, model ids, or evidence links.
