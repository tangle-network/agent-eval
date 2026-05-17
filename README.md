# @tangle-network/agent-eval

**Substrate for self-improving agents.** Trace what runs, verify the result,
turn outcomes into preferences and rewards, mutate prompts and policies under
anytime-valid evidence, and ship only when the improvement is decisive.

```txt
real product task
  -> observe / act (your runtime)
  -> trace + verifier pipeline (capture integrity)
  -> RunRecord (canonical eval artifact)
       -> judge calibration · paired stats · sequential α
       -> preferences · verifiable rewards · process rewards
       -> GEPA / reflective mutation · auto-research · active curriculum
       -> release gate · replay · contamination probe · tournament rating
  -> next iteration
```

`agent-eval` does **not** own product state, credentials, UI, storage, model
routing, browser drivers, sandbox policy, or deployment. Products own those.
This package owns the loop that closes evaluation → preference → mutation →
redeploy, with capture integrity and statistically rigorous evidence at every
step.

It ships as a TypeScript library (npm) with a generated Python client (PyPI),
both speaking the same wire protocol. MIT, self-hostable, no SaaS dependency.

## Install

```sh
pnpm add @tangle-network/agent-eval
# or, from Python:
pip install agent-eval-rpc
```

## Quick Start — the control loop

```ts
import {
  objectiveEval,
  runAgentControlLoop,
} from '@tangle-network/agent-eval/control'

const result = await runAgentControlLoop({
  intent: task.prompt,
  budget: { maxSteps: 8, maxWallMs: 180_000, maxCostUsd: 2 },

  observe() {
    return product.readState(task.id)
  },

  validate({ state }) {
    return [
      objectiveEval({
        id: 'build-passes',
        passed: state.build.exitCode === 0,
        severity: 'critical',
        metadata: state.build,
      }),
      objectiveEval({
        id: 'preview-serves',
        passed: state.preview.httpStatus === 200,
        severity: 'critical',
      }),
    ]
  },

  decide({ evals }) {
    const failed = evals.filter((e) => !e.passed)
    if (failed.length === 0) {
      return { type: 'stop', pass: true, reason: 'all gates passed' }
    }
    return {
      type: 'continue',
      action: { type: 'repair', failed: failed.map((e) => e.id) },
      reason: 'repair failed gates',
    }
  },

  act(action) {
    return product.runAgentStep(task.id, action)
  },
})

await product.storeEvalResult(task.id, result)
```

Same loop shape in production, replay, benchmark, and optimization. Swap the
dependencies behind `observe()` and `act()`, never the eval contract.

## Production loop — close the eval → prod → eval cycle

Static prompts decay. Yesterday's FTC rule flips today; yesterday's tool quirk
becomes today's incident. The production agents that win are the ones that
**continuously re-train against live failure modes**.

`runProductionLoop` is the orchestration layer that wires the existing eval
substrate into a self-improvement cron:

```ts
import {
  runProductionLoop,
  httpGithubClient,
  FileSystemFeedbackTrajectoryStore,
} from '@tangle-network/agent-eval'
import { FileSystemTraceStore } from '@tangle-network/agent-eval/traces'

const result = await runProductionLoop({
  runId: `weekly-${new Date().toISOString().slice(0, 10)}`,
  target: 'tax-agent',

  // 1. Where production traces + feedback land. Wire the HTTP ingestion
  //    endpoints (POST /v1/traces/ingest, POST /v1/feedback) from your
  //    runtime; the same store reads them here.
  traceStore: new FileSystemTraceStore({ dir: 'data/prod-traces' }),
  feedbackStore: new FileSystemFeedbackTrajectoryStore({ dir: 'data/prod-feedback' }),

  // 2. Cluster threshold: act on failure groups ≥ 20 runs or ≥ 5% of corpus.
  cluster: { minClusterSize: 20, minSeverityRatio: 0.05, maxClustersPerCycle: 1 },

  // 3. Evolve: seed = current prompt, gate against holdout scenarios.
  evolve: {
    baselinePrompt: currentSystemPrompt,
    holdoutScenarios: productionShapeScenarios,
    runner,                            // your agent driver
    scorer,                            // calibrated judge or rubric
    mutator,                           // GEPA-style or addendum-style mutator
    gate: {
      baselineKey: 'baseline',
      minProductiveRuns: 5,
      pairedDeltaThreshold: 0.03,      // require Nσ improvement on holdout
      overfitGapThreshold: 0.10,
    },
  },

  // 4. Ship: when the gate passes, open a PR with the new prompt.
  ship: {
    client: httpGithubClient({ token: process.env.GITHUB_TOKEN! }),
    repo: { owner: 'tangle-network', name: 'tax-agent' },
    branchPrefix: 'eval/auto-improve',
    promptFilePath: 'prompts/tax-agent-system.txt',
    reviewers: ['drew'],
  },

  cron: { cadence: 'weekly' },         // surface-only; consumer schedules
})

console.log(result.decision)            // 'pr_opened' | 'gate_failed' | 'no_actionable_failures' | ...
console.log(result.pullRequest?.prUrl)  // populated when a PR was opened
```

The primitive runs **one cycle**. Schedule it with `workflow_dispatch` + cron in
GitHub Actions. It is **idempotent + replayable**: same `runId` → same plan.
Gate failures are fail-closed — a candidate that beats baseline on search but
overfits on holdout never lands.

Full runnable demo (synthetic traces, no credentials) in
[`examples/production-loop`](./examples/production-loop/README.md).

## Self-improvement loop

Eval doesn't end at "pass/fail." Outcomes become training signal, mutation
proposals, and curriculum updates — all from the same `RunRecord` produced by
the control loop.

```ts
import { runEvalCampaign } from '@tangle-network/agent-eval'
import {
  extractPreferences,
  extractVerifiableReward,
  filterDeterministicallyRewarded,
  offPolicyEstimateAll,
  analyzeOptimizationResult,
} from '@tangle-network/agent-eval/rl'

// 1. Run a matrix of variants × scenarios with capture integrity by construction.
const campaign = await runEvalCampaign({ variants, scenarios, run })

// 2. Convert outcomes into RL signal.
const rewards = extractVerifiableReward(campaign.runs)          // compile/test/schema
const prefs   = extractPreferences(campaign.runs)               // (chosen, rejected) triples
const clean   = filterDeterministicallyRewarded(rewards)        // judge-noise free

// 3. Estimate a candidate policy's value without re-running.
const ope = offPolicyEstimateAll(campaign.runs, candidatePolicy)  // IPS + SNIPS + DR

// 4. Or close the loop end-to-end: score → reflect → mutate → re-run.
const next = await analyzeOptimizationResult(campaign, { researcher })
```

| Step | Primitive | Subpath |
| --- | --- | --- |
| Eval matrix with integrity | `runEvalCampaign` | `/` |
| Deterministic re-judge / audit | `ReplayCache`, `createReplayFetch` | `/` |
| Anytime-valid α across rolling looks | `pairedEvalueSequence` | `/reporting` |
| Judge quality vs gold | `calibrateJudge` (κ, Pearson, MAE, bias probes) | `/` |
| Continuous inter-rater agreement | `calibrateJudgeContinuous`, `continuousAgreement` (κ_w, ICC(2,1), bootstrap CIs) | `/` |
| (chosen, rejected) for DPO/KTO/PPO | `extractPreferences` | `/rl` |
| Verifiable reward signal | `extractVerifiableReward` | `/rl` |
| Step-level / PRM training data | `extractStepRewards`, `prmTrainingPairs` | `/rl` |
| Estimate policy value off-policy | `offPolicyEstimateAll` (IPS + SNIPS + DR) | `/rl` |
| GEPA / reflective prompt mutation | `buildReflectionPrompt`, `parseReflectionResponse`, Ax-GEPA `SteeringOptimizer` | `/` `/optimization` |
| Auto-research (read runs → propose) | `analyzeOptimizationResult`, `PredictiveValidityResearcher` | `/rl` |
| Active curriculum (variance / Thompson) | `allocateCurriculum` | `/rl` |
| Tournament ratings (Bradley-Terry + Elo) | `fitBradleyTerry`, `applyEloUpdate` | `/rl` |
| Adversarial scenario search | `adversarialScenarioSearch` | `/rl` |
| Contamination probe (held-out perturb) | `runContaminationProbe` | `/rl` |
| Reward hacking signatures | `detectRewardHacking` | `/rl` |
| Compute curves (best-of-N, self-consist, Pareto) | `runComputeCurve`, `bestOfN`, `selfConsistency`, `paretoFrontier` | `/rl` |
| Knowledge gap separated from reasoning gap | `scoreKnowledgeReadiness` | `/` |
| Release gate (paired evidence + holdouts) | `evaluateReleaseConfidence`, `HeldOutGate` | `/reporting` |
| Launch report (decision-grade) | `renderReleaseReport`, `researchReport` | `/reporting` |

## Import Paths

| Subpath | Use for |
| --- | --- |
| `@tangle-network/agent-eval/control` | `observe → validate → decide → act`, action policy, propose/review loops |
| `@tangle-network/agent-eval/traces` | trace stores, emitters, TraceAnalyst, replay |
| `@tangle-network/agent-eval/optimization` | feedback trajectories, multi-shot, prompt evolution, GEPA, EvalCampaign |
| `@tangle-network/agent-eval/reporting` | release confidence, paired stats, sequential e-values, launch reports |
| `@tangle-network/agent-eval/rl` | adapters, verifiable rewards, preferences, OPE, PRM, contamination, tournaments, adversarial, compute curves, auto-research |
| `@tangle-network/agent-eval/wire` | HTTP/RPC server + schemas (same protocol the Python client speaks) |
| `@tangle-network/agent-eval/benchmarks` | benchmark adapter contracts and reference wrappers |

The root export remains available for convenience; new code should prefer
focused subpaths. Anything under `/rl`, `/pipelines`, `/meta-eval`, `/prm`,
or `/builder-eval` is only reachable via its subpath.

## API stability

Public exports are tagged with JSDoc stability markers so consumers can see
status at the call site (IDE hover, language server, declaration files).

| Tag | Meaning |
| --- | --- |
| `@stable` | API frozen at this major. Breaking changes require a major bump. |
| `@experimental` | Interface may evolve before becoming `@stable`. Pin the patch version if you depend on it. |
| `@internal` | Not part of the public contract. Use the documented subpath instead. |

The `/rl` subpath is the most active surface. See
[`src/rl/index.ts`](./src/rl/index.ts) for the current stable/experimental
breakdown.

## Capture integrity

Launch-grade benchmark runs need four things that are easy to forget in glue
code: (1) raw HTTP capture alongside the structured spans so a reviewer can
verify which route answered, (2) a preflight assertion that the configured
client points at the intended provider, (3) a run-end assertion that the
expected events were actually written, and (4) auto-execution of the trace
analyst as part of the run lifecycle.

```ts
import {
  TraceEmitter, FileSystemRawProviderSink, callLlm, assertLlmRoute,
  assertRunCaptured, throwIfRunIncomplete,
} from '@tangle-network/agent-eval'
import { traceAnalystOnRunComplete } from '@tangle-network/agent-eval/traces'

const sink = new FileSystemRawProviderSink({ dir: `${workDir}/raw-events` })
assertLlmRoute(llmOpts, { requireExplicitBaseUrl: true, allowedBaseUrls, requireAuth: true })

const emitter = new TraceEmitter(store, {
  onRunComplete: [traceAnalystOnRunComplete({ analyze: analystOpts, save })],
})
await emitter.startRun(/* ... */)
// LLM calls flow through callLlm with `{ rawSink: sink, traceContext: { runId, spanId } }`.
await emitter.endRun({ pass, score })

throwIfRunIncomplete(await assertRunCaptured(store, emitter.runId, {
  llmSpansMin: 1, rawSink: sink, requireRawCoverageOfLlmSpans: true, requireOutcome: true,
}))
```

Directives, rationale, and shipped-bug context are in
[`SKILL.md` § Capture integrity](./.claude/skills/agent-eval/SKILL.md#capture-integrity-required-for-launch-grade-adoption).

## Examples

Each example has its own README with what it demonstrates, expected output,
and runtime. See [`examples/`](./examples/).

- [`examples/multi-shot-optimization`](./examples/multi-shot-optimization/README.md):
  optimize full trajectories with held-out promotion.
- [`examples/same-sandbox-harness`](./examples/same-sandbox-harness/README.md):
  run setup/build/test and evidence checks in one workspace.
- [`examples/benchmarks`](./examples/benchmarks/README.md):
  benchmark adapter shape and reference wrappers.
- [`examples/auto-research-with-agent-builder`](./examples/auto-research-with-agent-builder/README.md):
  closed loop — score, reflect, mutate, re-score, repeat.
- [`examples/fine-tune-with-prime-rl`](./examples/fine-tune-with-prime-rl/README.md):
  RunRecord → preferences → trainer (prime-rl) → next campaign.
- [`examples/production-loop`](./examples/production-loop/README.md):
  ingest prod traces + feedback, cluster failures, evolve, gate, open a PR.

## Docs

Read in this order:

1. [Concepts](./docs/concepts.md) — mental model, 5 min
2. [Product Eval Adoption](./docs/product-eval-adoption.md)
3. [Control Runtime](./docs/control-runtime.md)
4. [Feedback Trajectories](./docs/feedback-trajectories.md)
5. [Multi-Shot Optimization](./docs/multi-shot-optimization.md)
6. [Trace Analysis](./docs/trace-analysis.md)
7. [Knowledge Readiness](./docs/knowledge-readiness.md)
8. [Integration Launch Gates](./docs/integration-launch-gates.md)
9. [Wire Protocol](./docs/wire-protocol.md) — required for non-TypeScript consumers

## CLI / Wire Protocol

```sh
npm i -g @tangle-network/agent-eval
agent-eval serve --port 5005
```

Python:

```sh
pip install agent-eval-rpc
```

```py
from agent_eval_rpc import Client
client = Client()  # auto-detects HTTP server, falls back to subprocess
score = await client.judge(content=output, rubric_name="anti-slop")
```

TypeScript is the source of truth. Python is a thin transport client over the
generated OpenAPI schema. Schema drift is enforced impossible at release time
(version-locked CI).

## Development

```sh
pnpm install
pnpm typecheck
pnpm test
pnpm lint        # biome
pnpm build       # tsup + openapi.json
```

## Related Packages

- [`@tangle-network/agent-runtime`](https://www.npmjs.com/package/@tangle-network/agent-runtime):
  production session/runtime layer.
- [`@tangle-network/agent-knowledge`](https://www.npmjs.com/package/@tangle-network/agent-knowledge):
  source-grounded knowledge bases and readiness.
- [`@tangle-network/agent-integrations`](https://www.npmjs.com/package/@tangle-network/agent-integrations):
  connection, grant, capability, and integration invocation contracts.

Together: `agent-runtime` is where the agent runs; `agent-knowledge` is what
it knows; `agent-integrations` is what it can do; `agent-eval` is how it gets
better.

## License

MIT
