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

- Keep domain adapters in product repos until they are reused by multiple
  products.
- Prefer objective validators over LLM judges. Use LLM judges for judgment,
  usefulness, clarity, and domain expert review.
- Treat irreversible external actions as domain policy, not runtime policy.
  The runtime can stop loops; the product must decide which actions require
  approval before `act()`.
- Use typed state. Do not make the policy reason only over transcript text.
- Make `act()` return cost when possible so `maxCostUsd` can enforce recorded
  spend.

## What the Runtime Guarantees

- `maxSteps`, `maxWallMs`, and `maxCostUsd` guard runaway loops.
- repeated-action and no-progress stop policies catch stuck behavior.
- `actionFailure: 'continue'` records worker failures and lets policy recover.
- `actionFailure: 'stop'` fails fast for workflows where a failed action should
  abort.
- observation, validation, decision, stop-policy, and action failures are
  returned as structured `runtimeErrors` instead of disappearing.
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
})
```

Long term, `runProposeReview` should remain the stable convenience API, while
its internals can route through this control-loop preset.

## Domain Patterns

These examples show what belongs in product repos. They should not become core
`agent-eval` adapters until the same adapter shape is reused by multiple
products.

### Tax Agent

State:

```ts
interface TaxState {
  facts: Array<{ id: string; value: string; source: 'user' | 'document' }>
  jurisdiction?: string
  taxYear?: number
  draftAnswer: string
  citations: Array<{ claimId: string; source: string; quote?: string }>
  calculations: Array<{ id: string; ok: boolean; detail: string }>
  openQuestions: string[]
}
```

Actions:

```ts
type TaxAction =
  | { type: 'ask_user'; question: string }
  | { type: 'retrieve_authority'; query: string }
  | { type: 'revise_answer'; failures: string[] }
  | { type: 'escalate'; reason: string }
```

Validators:

- filing year present
- jurisdiction present
- every tax claim has a source
- calculations reconcile
- no unsupported deductions or credits
- uncertainty and professional-review boundaries are explicit

Stop policy:

- stop when all critical source/math/fact validators pass
- ask user when jurisdiction, year, or necessary facts are missing
- escalate when advice would require professional judgment beyond available
  facts

### Legal Agent

State:

```ts
interface LegalState {
  matterType: string
  jurisdiction?: string
  userFacts: string[]
  draft: string
  authorities: Array<{ citation: string; relevance: string; current: boolean }>
  risks: string[]
  openQuestions: string[]
}
```

Actions:

```ts
type LegalAction =
  | { type: 'ask_user'; question: string }
  | { type: 'research_authority'; query: string }
  | { type: 'revise_draft'; failures: string[] }
  | { type: 'refuse_or_escalate'; reason: string }
```

Validators:

- jurisdiction identified
- no fabricated case/statute citations
- claims distinguish user facts from legal conclusions
- risk language is present for uncertain or high-impact areas
- current authority check passed when the task requires it

Stop policy:

- stop when draft is grounded and scoped
- ask user for missing jurisdiction/facts
- escalate for high-risk legal advice or unauthorized practice boundaries

### Agent Builder

State:

```ts
interface AgentBuilderState {
  workdir: string
  diffSummary: string
  tests: { typecheck: boolean; unit: boolean; e2e?: boolean }
  generatedFiles: string[]
  runtimeTrace?: string
  reviewerFindings: string[]
}
```

Actions:

```ts
type AgentBuilderAction =
  | { type: 'patch'; instruction: string }
  | { type: 'run_tests'; command: string }
  | { type: 'review_diff' }
  | { type: 'ask_user'; question: string }
```

Validators:

- expected files exist
- typecheck/build/tests pass
- generated agent can complete a representative runtime scenario
- no hardcoded fake success or placeholder integrations
- reviewer findings resolved or explicitly accepted

Stop policy:

- stop when build and runtime validators pass
- stop on no progress after repeated patch/test cycles
- ask user when product intent or credentials are missing

### Film Agent

State:

```ts
interface FilmState {
  brief: string
  script: string
  shotList: Array<{ scene: string; shot: string; purpose: string }>
  assets: Array<{ id: string; type: 'image' | 'audio' | 'video'; licensed: boolean }>
  renderStatus?: { ok: boolean; errors: string[] }
  continuityIssues: string[]
}
```

Actions:

```ts
type FilmAction =
  | { type: 'ask_user'; question: string }
  | { type: 'revise_script'; failures: string[] }
  | { type: 'generate_asset'; assetType: string; prompt: string }
  | { type: 'render_preview' }
  | { type: 'fix_continuity'; issues: string[] }
```

Validators:

- script satisfies the creative brief
- shot list covers every scene
- assets are present and licensed/allowed
- render completes
- continuity errors are below threshold
- brand/tone constraints are met

Stop policy:

- stop when render and creative validators pass
- ask user when taste/brand choices are ambiguous
- fail fast on unavailable or disallowed asset sources

## Product Integration Checklist

For a new product integration:

1. Define typed state.
2. Define domain actions.
3. Write objective validators first.
4. Add subjective judges only for judgment-heavy dimensions.
5. Decide which actions require user approval before execution.
6. Add cost extraction for expensive actions.
7. Add no-progress and repeated-action policies.
8. Emit to a `TraceStore` in CI and production-like evals.
9. Keep the adapter in the product repo until it proves reusable.

