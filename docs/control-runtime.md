# Agent Control Runtime

`runAgentControlLoop` is the smallest reusable runtime for agentic tasks:

```text
observe state -> validate state -> decide next action -> act -> repeat
```

It is intentionally not a topology framework. Direct execution, driver
intervention, critique/revision, specialist fan-out, and user escalation are
all just actions selected by policy.

Use it when an agent should keep working until objective state says the task is
done, blocked, too expensive, or no longer improving.

## Core API

```ts
import {
  objectiveEval,
  runAgentControlLoop,
  subjectiveEval,
} from '@tangle-network/agent-eval'

const result = await runAgentControlLoop({
  intent: 'Create a final answer with citations and no math errors.',
  budget: { maxSteps: 6, maxWallMs: 180_000, maxCostUsd: 1.50 },

  async observe() {
    return await readCurrentTaskState()
  },

  async validate({ state }) {
    return [
      objectiveEval({
        id: 'citations-present',
        passed: state.citations.length >= 2,
        severity: 'critical',
      }),
      objectiveEval({
        id: 'math-reconciles',
        passed: state.mathErrors.length === 0,
        severity: 'critical',
      }),
      subjectiveEval({
        id: 'answer-usefulness',
        passed: state.judgeScore >= 0.8,
        score: state.judgeScore,
        severity: 'warning',
      }),
    ]
  },

  async decide({ evals, history }) {
    const failed = evals.filter((e) => !e.passed)
    if (!failed.length) return { type: 'stop', pass: true, reason: 'done' }
    return {
      type: 'continue',
      action: { type: 'revise', failures: failed.map((e) => e.id) },
      reason: `fix ${failed.map((e) => e.id).join(', ')}`,
    }
  },

  async act(action) {
    return await worker.act(action)
  },

  getActionCostUsd: ({ result }) => result.costUsd,
  stopPolicies: {
    maxNoProgressSteps: 2,
    maxRepeatedActions: 3,
  },
})
```

## Design Rules

- Keep domain adapters in downstream repos until they are reused by multiple
  integrations.
- Use the same adapter in product, benchmark replay, and optimization. Swapping
  the state reader or worker implementation is fine; changing validators,
  action semantics, or stop policy means you are no longer measuring what users
  experience.
- Prefer objective validators over LLM judges. Use LLM judges for judgment,
  usefulness, clarity, and domain expert review.
- Treat irreversible external actions as domain policy, not runtime policy.
  The runtime can stop loops; the downstream adapter must decide which actions
  require approval before `act()`.
- Use typed state. Do not make the policy reason only over transcript text.
- Make `act()` return cost when possible so `maxCostUsd` can enforce recorded
  spend.

## Product / Eval Contract

The runtime is most useful when a downstream product exposes a small adapter:

```ts
interface ProductControlAdapter<State, Action, ActionResult> {
  observe(): Promise<State>
  validate(state: State): Promise<ControlEvalResult[]>
  decide(ctx: ControlContext<State, Action, ActionResult>): Promise<ControlDecision<Action>>
  act(action: Action): Promise<ActionResult>
}
```

Production passes the adapter real sessions, credentials, and storage. Evals
pass the same adapter replay fixtures, sandboxes, or recorded traces. The
adapter boundary is the transfer point between training and real usage.

Avoid this split:

```text
benchmark harness has one loop
product runtime has another loop
optimizer tunes only the benchmark loop
```

That creates benchmark wins that do not transfer. Keep one loop and vary only
the dependencies behind `observe` and `act`.

## What the Runtime Guarantees

- `maxSteps`, `maxWallMs`, and `maxCostUsd` guard runaway loops.
- repeated-action and no-progress stop policies catch stuck behavior.
- `actionFailure: 'continue'` records worker failures and lets policy recover.
- `actionFailure: 'stop'` fails fast for workflows where a failed action should
  abort.
- observation, validation, decision, stop-policy, and action failures are
  returned as structured `runtimeErrors` instead of disappearing.
- trace sink and `onStep` callback failures are recorded in `runtimeErrors`
  but do not abort the control loop. Agent progress should not depend on
  telemetry availability.
- action-policy preflight belongs before `act()`. Use `evaluateActionPolicy`
  to block or label side effects, budget breaches, and missing expected
  outcomes before any irreversible action runs.
- when a `TraceStore` is supplied, the runtime emits:
  - one run
  - one tool span per control step
  - one judge span per eval result
  - budget ledger entries for recorded spend

## Propose / Review Preset

`runProposeReviewAsControlLoop` adapts the common artifact-refinement loop onto
the generic runtime:

```text
propose -> verify -> review -> propose again
```

Use it when the task is naturally "produce or improve state until verification
passes."

```ts
import { runProposeReviewAsControlLoop } from '@tangle-network/agent-eval'

const report = await runProposeReviewAsControlLoop({
  goal: 'Make the implementation pass tests and satisfy the reviewer.',
  initialState: { workdir },
  maxShots: 5,

  async propose({ state, priorReview }) {
    return await codingAgent.patch({
      workdir: state.workdir,
      instruction: priorReview?.nextShotInstruction,
    })
  },

  async verify(state) {
    const tests = await runTests(state.workdir)
    return {
      pass: tests.ok,
      score: tests.ok ? 1 : 0,
      failingLayers: tests.ok ? [] : ['tests'],
      details: tests,
    }
  },

  async review({ verification }) {
    return await reviewer.explainNextShot(verification)
  },

  failureClassFromVerification(verification) {
    if (verification.failingLayers?.includes('tests')) return 'sandbox_failure'
    return 'unknown'
  },
})
```

Long term, `runProposeReview` should remain the stable convenience API, while
its internals can route through this control-loop preset.

## Domain Patterns

These examples show what belongs in product repos. They should not become core
`agent-eval` adapters until the same adapter shape is reused by multiple
products.

## Shared Sandbox Execution

Yes, harnesses and judges can run against the same sandbox. The common pattern
is to pass one sandbox driver and one workdir through every layer:

```ts
const driver = new SubprocessSandboxDriver({ cwd: workdir, env })
const harness = new SandboxHarness(driver)
```

Use the same sandbox when checks need shared state:

- install dependencies once, then typecheck/build/test in the same workdir
- run a browser/computer-use scenario against the app the harness just started
- let a judge inspect files, logs, screenshots, or traces produced by earlier
  layers

Use separate sandboxes when checks need isolation:

- variants are running in parallel
- a test mutates global state
- credentials or network access differ by phase
- one action can corrupt the workdir for later checks

The important rule is explicit ownership: one driver/workdir means shared state;
multiple drivers/workdirs means isolated state. Do not rely on hidden global
state.

### Coding Agent

```ts
interface CodingState {
  workdir: string
  diffSummary: string
  tests: { typecheck: boolean; unit: boolean; e2e?: boolean }
  generatedFiles: string[]
  runtimeTrace?: string
  reviewerFindings: string[]
}
```

```ts
type CodingAction =
  | { type: 'patch'; instruction: string }
  | { type: 'run_tests'; command: string }
  | { type: 'review_diff' }
  | { type: 'ask_user'; question: string }
```

Validators:

- expected files exist
- typecheck/build/tests pass
- generated app or agent completes a representative runtime scenario
- no hardcoded fake success or placeholder integrations
- reviewer findings resolved or explicitly accepted

Stop policy:

- stop when build and runtime validators pass
- stop on no progress after repeated patch/test cycles
- ask user when task intent or credentials are missing

### Browser / Computer-Use Agent

Use this shape when the agent controls a browser, desktop session, or remote
computer and needs to complete a task end-to-end.

```ts
interface ComputerUseState {
  url?: string
  goal: string
  screenshot?: string
  accessibilityTree?: unknown
  completedSteps: string[]
  openIssues: string[]
  assertions: Array<{ id: string; passed: boolean; detail?: string }>
}
```

```ts
type ComputerUseAction =
  | { type: 'navigate'; url: string }
  | { type: 'click'; selectorOrDescription: string }
  | { type: 'type'; selectorOrDescription: string; text: string }
  | { type: 'inspect' }
  | { type: 'ask_user'; question: string }
```

Validators:

- required page or app state is reached
- no blocking errors are visible
- expected text, data, or UI state is present
- screenshots or accessibility tree support the claimed success
- repeated clicks or navigation loops are detected

Stop policy:

- stop when objective UI assertions pass
- stop on repeated action or no-progress policies
- ask user when credentials, permissions, or ambiguous choices block progress

### Research / Documentation Agent

Use this shape when the agent produces a brief, explanation, migration guide, or
technical research note.

```ts
interface ResearchState {
  question: string
  draft: string
  sources: Array<{ url: string; title?: string; relevant: boolean }>
  unsupportedClaims: string[]
  reviewerFindings: string[]
}
```

```ts
type ResearchAction =
  | { type: 'search'; query: string }
  | { type: 'read_source'; url: string }
  | { type: 'revise_draft'; failures: string[] }
  | { type: 'ask_user'; question: string }
```

Validators:

- every important claim has a source
- sources are relevant and current enough for the task
- unsupported claims are removed or marked as uncertain
- reviewer findings are resolved
- final output answers the original question

Stop policy:

- stop when source coverage and reviewer checks pass
- ask user when the question scope is ambiguous
- stop on repeated research queries with no new evidence

## Integration Checklist

For a new downstream integration:

1. Define typed state.
2. Define domain actions.
3. Write objective validators first.
4. Add subjective judges only for judgment-heavy dimensions.
5. Decide which actions require approval before execution.
6. Add cost extraction for expensive actions.
7. Add no-progress and repeated-action policies.
8. Emit to a `TraceStore` in CI and production-like evals.
9. Keep the adapter downstream until it proves reusable.
