# `@tangle-network/agent-eval`

Run agent evaluations, compare changes on the same cases, and decide whether a candidate has enough evidence to release.

[![npm](https://img.shields.io/npm/v/@tangle-network/agent-eval.svg)](https://www.npmjs.com/package/@tangle-network/agent-eval)
[![pypi](https://img.shields.io/pypi/v/agent-eval-rpc.svg)](https://pypi.org/project/agent-eval-rpc/)
[![tests](https://github.com/tangle-network/agent-eval/actions/workflows/ci.yml/badge.svg)](https://github.com/tangle-network/agent-eval/actions/workflows/ci.yml)
[![license: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

Eval runs in your TypeScript process.
You supply agent execution, judges, and model transports.
It records outputs, failures, costs, and evidence for each comparison.

## Install

```sh
pnpm add @tangle-network/agent-eval
```

## Quickstart

This complete example runs offline.
Replace the agent and judge with your product functions when it works.

```ts
import { defineAgentEval } from '@tangle-network/agent-eval/contract'

interface SupportCase {
  id: string
  kind: 'support'
}

const evalKit = defineAgentEval<SupportCase, string>({
  scenarios: [
    { id: 'refund', kind: 'support' },
    { id: 'shipping', kind: 'support' },
    { id: 'cancel', kind: 'support' },
  ],
  agent: async (prompt, scenario) =>
    String(prompt).includes('ticket') ? `Ticket ${scenario.id}: on it.` : 'On it.',
  judge: {
    name: 'ticket-id',
    dimensions: [{ key: 'present', description: 'The answer includes the ticket id' }],
    score: ({ artifact, scenario }) => {
      const present = artifact.includes(scenario.id) ? 1 : 0
      return { dimensions: { present }, composite: present, notes: '' }
    },
  },
  baselineSurface: 'Answer politely.',
  expectUsage: 'off',
})

console.log((await evalKit.evaluate()).aggregates.byJudge)
console.log(
  (await evalKit.evaluate({ surface: 'Answer politely and cite the ticket id.' })).aggregates
    .byJudge,
)
```

The baseline scores `0`; the candidate scores `1` on all three cases.
These scores describe the three examples.
They do not establish a release decision or performance on new tasks.

A **case** is one task.
A **surface** is the prompt, skill, or configuration being changed.
A **judge** scores the agent's result.

`expectUsage: 'off'` applies because this example makes no paid calls.
Keep the default, `'assert'`, for model calls so missing cost receipts fail visibly.
The [runnable example](./examples/evaluate-a-change/) uses the same evaluation.

## Choose a workflow

| Intent | Start with | Result |
|---|---|---|
| Score one change | [`defineAgentEval()`](./examples/evaluate-a-change/) from `/contract` | Cell results, failures, score distributions, and measured cost. |
| Search for a better surface | [`selfImprove()`](./examples/selfimprove-quickstart/) from `/contract` | A selected surface, final comparison, and `gateDecision`. |
| Compare search methods | [`compareOptimizationMethods()`](./examples/compare-optimization-methods/) from `/campaign` | Paired final comparisons, uncertainty, coverage, and costs under declared budgets. |
| Register evidence and decision rules | [`defineEvaluationClaim()` and `sealExperiment()`](./docs/evaluation-integrity.md) from `/experiment` | A declared population, independent unit, optional practical effect, and sealed rules. |
| Check the evaluator | [`auditEvaluator()`](./docs/evaluation-integrity.md) and [calibration tools](./docs/outcome-validity.md) from `/meta-eval` | Error rates, admission evidence, bias diagnostics, and outcome associations. |
| Analyze completed work | [`analyzeRuns()`](./examples/analyze-existing-runs/) from `/contract`; [trace analysts](./docs/trace-analysis.md) from `/analyst` | Comparisons and findings with links to recorded evidence. |

`defineAgentEval()` also exposes `improve()` when the same agent, cases, judge, and baseline should share configuration.
Use direct [campaign controls](./docs/eval-surface-map.md) for scheduling, durable caches, model matrices, or custom release rules.
The [example index](./examples/README.md) covers fixtures, trace intake, code verification, replay, and training-data exports.

## Make automated improvement accountable

Use reusable evaluations for development feedback.
For a direct edit, compare the baseline and candidate on the same cases.
Claims, evaluator audits, and final-evidence tracking are optional.
Add stronger controls when a result must support performance on new tasks or an adaptive release decision.

1. Pass a `claim` describing the population, sampling frame, and independent unit to the comparison.
   Declare `minimumEffect` when the decision concerns a useful improvement.
2. When introducing an evaluator, check known good and known bad controls with `auditEvaluator()`.
3. Give search separate training and selection cases.
4. For fresh confirmation, supply `finalEvidence` with a shared ledger, request ID, and evaluator digest.
   This reserves final units before search and records exposure before measurement.
5. Inspect the final comparison, gate contributions, exclusions, uncertainty, cost, and search history before releasing.

Repeated attempts on one task do not create new independent tasks.
The top-level `claim` controls unit aggregation for reusable comparisons.
Power checks assess the declared minimum effect.
Optional `finalEvidence` binds fresh confirmation to that claim and refuses reused final units across campaigns sharing the ledger.

The host must enforce access isolation and author/auditor separation.
A digest records identity; it cannot prove secrecy or that a benchmark represents future users.
Custom gates remain responsible for their decision rules.
See [evaluation integrity](./docs/evaluation-integrity.md) for the complete API and its boundaries.

These controls check the evidence behind a result.
They do not establish that an optimizer beats a direct edit or simple search.
The [historical evidence audit](./docs/design/self-improvement-evidence-audit.md) records prior gains, failed transfer, and missing comparisons.

Set `searchHistoryPolicy: 'require-complete'` when every attempted search slot must be accounted for before final evidence is exposed.
The [search-history receipt](./docs/search-history-receipts.md) binds the planned denominator to Eval's existing search ledger.

A `gateDecision` is `ship`, `hold`, `need_more_work`, `model_ceiling`, or `arch_ceiling`.
Gate contributions distinguish missing evidence from measured failures and successful checks.
[Concepts](./docs/concepts.md) explains these decisions and how gates compose.

## Configure model calls

Pass a `ChatClient` to model judges, analysts, and adapters.
Eval obtains credentials from the values you supply; it does not search your environment.

```ts
import { createChatClient } from '@tangle-network/agent-eval/contract'

const chat = createChatClient({
  transport: 'openai-compatible',
  baseUrl: 'https://router.example/v1',
  apiKey: process.env.MY_ROUTER_KEY,
  defaultModel: process.env.EVAL_MODEL_ID,
})
```

Use your deployed model identifier and preserve the returned `servedModel` identity and cost receipt.
For an existing SDK, use `transport: 'custom'` with your `chat` callback and an explicit `maximumAttempts`.
Agent Runtime callers can bind `profileChatClient()` from `@tangle-network/agent-runtime/kernel`.
Eval has no dependency on Runtime.

Official GEPA, SkillOpt, and DSPy integrations use a Python bridge.
Their maintained installation instructions and execution contracts are in [campaign proposers](./docs/campaign-proposers.md).
The [Python client](./clients/python/README.md) and [wire protocol](./docs/wire-protocol.md) support other-language consumers.

## Public imports and evidence

Use `/contract` for a product integration, `/campaign` for execution controls, `/experiment` for registered decisions, and `/meta-eval` for evaluator checks.
Root `Scenario`, `JudgeScore`, and `GateDecision` are the same types as `/contract`.
Product judging retains the explicit root names `ProductScenario` and `DimensionJudgeScore` beside its functions.
`HeldOutGate.evaluate()` returns `HeldOutGateDecision`.

Specialist subpaths and their examples are listed in the [surface map](./docs/eval-surface-map.md).
Current canonical envelopes are required for seals, attestations, and profile identities.
Retired or incomplete formats fail verification; historical reports retain their recorded identities.

Published measurements live in the [evidence registry](./evidence/README.md).
The [benchmark-book review](./docs/design/mlbenchmarks-book-review.md) records the source analysis and reproduced defects behind these integrity changes.
[The charter](./docs/charter.md) defines package ownership and the remaining research boundaries.

## Development

```sh
pnpm install
pnpm typecheck
pnpm typecheck:examples
pnpm typecheck:scripts
pnpm test
pnpm build
pnpm verify:package
```

Python compatibility tests use the locked dependencies:

```sh
cd clients/python
uv sync --frozen --extra dev --group gepa-release
AGENT_EVAL_EXPECT_GEPA_RELEASE=1 \
  uv run --frozen --extra dev --group gepa-release \
  pytest tests/test_gepa_release_compatibility.py tests/test_gepa_bridge.py

uv sync --frozen --extra dev --group skillopt-source --group gepa-source
uv run --frozen pytest

uv sync --frozen --extra dev --extra dspy
uv run --frozen pytest tests/test_dspy_metric.py
```

## License

MIT.
