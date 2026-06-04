# Belief-State Work in agent-eval

**Status:** Planning and tracking artifact.
**Created:** 2026-06-04.
**Owner:** agent-eval research track.
**Scope:** What belongs in `@tangle-network/agent-eval`, what should stay in runtime/knowledge/graph packages, and what must be proven before stable belief-state APIs ship.

## Executive Summary

Belief-state work belongs in `agent-eval` only as an analysis-time and evaluation-time substrate: trace-derived state estimates, calibrated uncertainty, replay/OPE reports, selective action gates, memory policy evaluation, and causal attribution over mutable agent surfaces. It should not become the runtime's memory system, tool executor, workflow registry, or source of truth for production state.

The original "categorize the whole MDP" idea is useful as a research north star but too broad as the first build. The durable characterization is narrower: an agent is a partially observed adaptive control system over mutable surfaces, and `agent-eval` owns the evidence that says whether a proposed state/policy change is valid, calibrated, and worth shipping.

The first year should produce hard evidence: selectors that know when to abstain/verify/retry, OPE/replay for policy changes, memory admission gates, surface-level causal attribution, and held-out reports that beat baselines with confidence intervals. The second year should only happen if year one clears those gates: learned state estimators, graph-native provenance adapters, cross-domain transfer, and an externally defensible benchmark/paper package.

## Source Register

| Source | Location | Durable Claim | Confidence | Next Check |
|---|---|---|---:|---|
| agent-eval current substrate | `README.md`, `src/run-record.ts`, `src/contract/analyze-runs.ts`, `src/trace/schema.ts` | `agent-eval` is the bottom substrate: RunRecord, traces, analysts, OPE, gates, and decision packets belong here. Runtime imports eval; eval must not import runtime. | High | Keep every belief-state primitive trace-derived or consumer-supplied. |
| Self-improvement roadmap | `docs/design/self-improvement-roadmap.md` | Existing program already frames run -> observe -> diagnose -> propose -> evaluate -> gate -> promote. Belief state must plug into this loop, not replace it. | High | Map each belief-state phase to an existing evidence bus, analyst, RL, gate, or report surface. |
| Research roadmap | `docs/research/research-roadmap.md` | The field claim is not "we built an architecture"; it is statistical foundation, two-writer state, and standard benchmark. | High | Require publishable experiments before public belief-state package claims. |
| Empirical proof pursuit | `.evolve/pursuits/2026-06-01-empirical-proof.md` | Mechanism ran end-to-end, but positive lift did not materialize. This is a warning: belief-state work must prove lift under headroom, not just add mechanism. | High | Pre-register baselines and kill criteria. |
| Belief-state bundle | `/Users/drew/code/belief-state-agents` | Good vocabulary: EvidenceAtom, RuntimeSnapshot, belief variables, hypotheses, memory state, action descriptors. Not production-ready; tests exposed Python/TS issues and some policy/math gaps. | Medium | Port concepts only after validating against agent-eval traces. |
| agent-runtime PR 155 | `https://github.com/tangle-network/agent-runtime/pull/155` | Docs-only PR, closed unmerged as of 2026-06-04. Useful as thinking, not landed evidence. | Medium | Do not cite it as product substrate. Extract only claims that survive repo-local verification. |
| PiGraph worldclass kit | `/Users/drew/code/pigraph-worldclass-kit` | Useful as graph/provenance adapter idea. Not core agent-eval: nondeterministic IDs/timestamps and linearized topology need correction before research use. | Medium | Build adapter after trace-derived belief state is measurable. |

## Core Decision

Belief-state work should start in `agent-eval`, but not as "the agent's state." It should start as `agent-eval` research infrastructure for answering four questions:

1. What did the agent appear to believe at each decision point, based only on trace evidence?
2. Was that belief calibrated against later outcomes?
3. Would a different policy over verify/retry/ask/memory/skill/tool/workflow choices have improved the outcome?
4. Which mutable surface caused the improvement or regression?

That framing maps cleanly to existing code:

| Existing Surface | Why It Matters |
|---|---|
| `RunRecord` | Paper-grade run projection with pinned model/config/cost/outcome. Belief-state reports must be joinable to it. |
| `TraceSchema` | Source stream for evidence atoms: LLM spans, tools, retrieval, judges, state mutations, policy violations, budgets. |
| `AnalystRegistry` | Converts traces into findings; belief-state estimators should consume findings, not duplicate analyst pipelines. |
| `analyzeRuns` / `InsightReport` | Decision packet where belief calibration, abstention value, memory policy value, and surface attribution should surface. |
| `/rl/off-policy` | OPE is the correct first tool for "would another policy have done better?" |
| `counterfactual.ts` | Replay and mutation experiments for causal claims. |
| `causal-attribution.ts` | Surface-level variance attribution for model/prompt/tool/memory/workflow changes. |
| `knowledge/readiness.ts` | Existing readiness/gap model for knowledge requirements. Belief state should connect to it, not replace it. |
| `control-runtime.ts` | Generic observe -> validate -> decide -> act loop. Belief-state evaluation can score decisions produced by control loops without owning execution. |

## Boundary Rules

In `agent-eval`:

- Trace-derived evidence atoms.
- State estimator reports.
- Calibration curves and ECE for state confidence.
- Selective prediction/abstention/retry/verify gates.
- OPE/replay for policy changes.
- Memory admission/update evaluation.
- Skill/tool/workflow selection evaluation.
- Prompt/directive/subagent surface attribution.
- Decision packet extensions and held-out promotion gates.

Not in `agent-eval`:

- Runtime memory writes.
- Tool execution.
- Workflow orchestration.
- Subagent lifecycle.
- Prompt registry ownership.
- Production state source of truth.
- Graph database ownership.
- Default LLM-backed researcher brain.

Downstream packages can own mutation and execution. `agent-eval` owns whether the mutation is supported by evidence.

## First-Principles Characterization

The broad MDP frame is not wrong, but it hides the build order. For a real agent, the "state" contains at least:

- Environment state: files, APIs, user session, external systems.
- Agent-observed state: transcript, tool results, retrieved documents, artifacts.
- Internal policy surfaces: model, prompt, directives, skills, subagents, workflows, tool policies.
- Learned state: memory, preferences, playbooks, derived knowledge, failure findings.
- Evaluation state: judges, rubrics, gates, calibration reports, holdouts.
- Governance state: budgets, approvals, consent, risk class, data sensitivity.

The key refinement: do not try to enumerate the full latent state. Build calibrated sufficient statistics for specific decisions.

Concrete example:

- Bad first target: "model the complete belief state of the agent."
- Good first target: "given trace evidence before a risky action, estimate whether the agent should continue, verify, ask, retry, or stop, and prove that policy beats baseline on held-out runs."

## Alternative Characterizations

| Characterization | What It Explains | Best First Use | Belongs Where | Verdict |
|---|---|---|---|---|
| POMDP / belief-state agent | Hidden task state, uncertainty, partial observation | Long-term formalism for papers | `agent-eval` research docs, later optional state-estimator API | Useful but too broad as first API. |
| Selective prediction | Knowing when not to act | abstain/verify/retry/ask gates | `agent-eval` | Build first. Highest signal-to-cost. |
| Off-policy evaluation / contextual bandits | Would another decision policy have done better? | replay old runs under candidate decision policy | `agent-eval/rl` | Build first. Existing substrate already supports it. |
| Typed stochastic computation graph | Provenance and topology of evidence, beliefs, decisions, outcomes | explainability and causal paths | separate graph adapter, fed by `agent-eval` traces | Build later, not core. |
| Causal credit assignment over mutable surfaces | Which change caused lift/regression? | prompt/model/tool/memory/workflow attribution | `agent-eval` | Build after replay corpus exists. |
| Resource-rational control | Cost-aware decide/verify/stop policies | budgeted verification and escalation | `agent-eval` + runtime policy consumer | Build early after selective gates. |
| Memory lifecycle / knowledge governance | When memories should be written, updated, trusted, forgotten | memory admission and poisoning detection | `agent-eval` evaluation; knowledge package execution | Build in year one. |
| Workflow/skill market | Policy over capabilities and subagents | skill/tool/workflow selection experiments | runtime executes; `agent-eval` evaluates | Build after baseline selectors. |
| Agent as self-modifying system | Prompts, skills, workflows, memories mutate over time | long-horizon self-improvement | across eval/runtime/knowledge/graph | Two-year target only. |

Recommendation: use "trace-grounded adaptive control" as the umbrella. Belief state is one estimator family inside that umbrella, not the entire architecture.

## What I Would Do Differently From the Original Idea

Do not start by completely categorizing the MDP. That creates a taxonomy before we know which variables have predictive or causal value.

Start with decision points that are observable and valuable:

1. Continue vs verify vs ask vs stop.
2. Retry same approach vs change approach.
3. Write memory vs skip memory.
4. Retrieve memory vs ignore memory.
5. Use skill/tool/workflow A vs B.
6. Promote prompt/directive/subagent variant vs hold.

For each decision point, require:

- logged context,
- candidate actions,
- outcome,
- cost,
- calibration target,
- baseline policy,
- held-out split,
- replay/OPE support diagnostic,
- failure mode taxonomy,
- promotion gate.

Only after that should we generalize to a broader belief-state estimator.

## Proposed Architecture

Current:

```text
runtime/agents -> traces + RunRecord -> agent-eval analysts/gates/reports
knowledge      -> memory/claims       -> agent-eval readiness/evidence checks
experiments    -> runs                -> agent-eval OPE/replay/causal reports
```

Target:

```text
runtime/agents -> traces + RunRecord ------------------------------+
knowledge      -> claims/memories/readiness -----------------------+
graph adapter  -> optional provenance topology --------------------+
                                                                   v
                 agent-eval belief-state research layer
                 - evidence extraction
                 - state estimator report
                 - calibration + abstention metrics
                 - replay/OPE policy value
                 - memory policy value
                 - surface attribution
                                                                   v
                 InsightReport + HeldOutGate + research artifacts
```

No runtime dependency is added to `agent-eval`. Runtime emits richer traces and consumes gates. Knowledge owns memory writes. A graph adapter consumes traces and emits topology features.

## Minimal Future API Shape

Do not add this stable public API until Phase 1 gates pass. The draft dogfood surface is `@tangle-network/agent-eval/experimental/belief-state`; the likely eventual stable subpath is `@tangle-network/agent-eval/belief-state`.

```ts
export interface BeliefEvidenceAtom {
  id: string
  runId: string
  stepIndex?: number
  source: 'llm' | 'tool' | 'retrieval' | 'judge' | 'memory' | 'policy' | 'runtime'
  subject: string
  signal: string
  value: unknown
  confidence?: number
  timestamp?: number
  metadata?: Record<string, unknown>
}

export interface BeliefStateEstimate {
  runId: string
  stepIndex?: number
  variables: Record<string, { value: unknown; confidence: number }>
  evidenceIds: string[]
  unsupportedVariables: string[]
}

export interface BeliefPolicyEvaluation {
  policyId: string
  baselinePolicyId: string
  decisionKind: 'continue' | 'verify' | 'ask' | 'retry' | 'stop' | 'memory-write' | 'surface-promote'
  n: number
  calibration?: { ece: number; maxGap: number }
  offPolicy?: { value: number; effectiveSampleSize: number; supportWarning?: string }
  lift?: { delta: number; ci95: [number, number] }
  recommendation: 'ship' | 'hold' | 'need_more_data'
}
```

The API should report uncertainty and support problems, not hide them behind a scalar score.

## Year 1 Roadmap

### Q3 2026 - Phase 0: Tracking, Corpus, and Decision Inventory

- [ ] Keep this document current as the research tracker.
- [ ] Create a decision inventory over existing traces: continue, verify, retry, ask, stop, memory-write, memory-read, tool-select, skill-select, workflow-select, prompt-promote.
- [ ] Define trace extraction rules for each decision kind.
- [ ] Define the minimum event fields needed from runtime and knowledge packages.
- [ ] Build a replay corpus from existing `RunRecord` and trace stores.
- [ ] Label at least 200 decision points with outcome, cost, and whether the action was retrospectively correct.
- [ ] Add support diagnostics: missing candidates, missing outcomes, no cost, no raw trace, no held-out split.
- [ ] Decide which decision kind has enough data for Phase 1.

Completion criteria:

- [ ] Corpus has >= 200 labeled decision points across >= 3 projects or task families.
- [ ] Every row joins to a `RunRecord`.
- [ ] Every row has train/dev/holdout split.
- [ ] Backend and capture integrity are checked before analysis.
- [ ] No producerless schema fields are introduced.
- [ ] One baseline policy is recorded for every decision kind under study.

### Q4 2026 - Phase 1: Selective Prediction and Abstention

- [ ] Build abstain/verify/ask/stop evaluation over the chosen decision kind.
- [ ] Compute calibration curves for confidence vs actual outcome.
- [ ] Compare baseline policy vs selective policy on holdout.
- [ ] Add cost-aware utility: quality lift minus verification/ask/retry cost.
- [ ] Add report rows into `InsightReport` or an experimental research report.
- [ ] Run negative controls: shuffled confidence, random abstention, always-verify, never-verify.
- [ ] Pre-register thresholds before holdout.

Completion criteria:

- [ ] Selective policy beats baseline utility with CI.low > 0 on holdout, or the result is recorded as an honest negative.
- [ ] ECE is lower than the uncalibrated baseline.
- [ ] Always-verify does not trivially dominate once cost is counted.
- [ ] No metric improves while user-visible outcome regresses.
- [ ] Report includes abstention coverage, error rate on accepted actions, rejected-action lift, and cost.

### Q1 2027 - Phase 2: OPE and Replay for Decision Policies

- [ ] Convert decision logs into off-policy trajectories.
- [ ] Estimate target policy value using IPS, SNIPS, and DR where support allows.
- [ ] Record effective sample size and max importance weight in every report.
- [ ] Add exact replay where request hashes match.
- [ ] Compare OPE predictions to live A/B or replay outcomes.
- [ ] Add support-mismatch failure mode.

Completion criteria:

- [ ] OPE only claims value when support diagnostics pass.
- [ ] SNIPS/DR estimates agree within pre-registered tolerance or report disagreement.
- [ ] Exact replay validates at least one candidate policy.
- [ ] At least one target policy survives held-out gate.
- [ ] Every result includes n, effective sample size, cost, and split.

### Q2 2027 - Phase 3: Memory and Knowledge Policy Evaluation

- [ ] Evaluate memory write/admit/update/forget policies.
- [ ] Link memory policy decisions to `knowledge/readiness.ts` reports.
- [ ] Add poisoning/staleness/contradiction labels.
- [ ] Measure whether memory retrieval changes outcome, cost, or failure mode.
- [ ] Add counterfactual memory ablations where replay is possible.
- [ ] Define "memory should not have been written" and "memory should have been retrieved" labels.

Completion criteria:

- [ ] Memory policy improves holdout utility or reduces harmful memory events with CI support.
- [ ] Poisoning/staleness detection has measured precision/recall on labeled examples.
- [ ] Memory admission gate is fail-closed for secrets, stale claims, and untrusted sources.
- [ ] Knowledge readiness reports are present for tasks with declared requirements.
- [ ] No runtime memory write is owned by `agent-eval`.

## Year 2 Roadmap

### Q3 2027 - Phase 4: Surface Attribution and Graph Adapter

- [ ] Factor mutable surfaces: model, prompt, directive, skill, tool policy, workflow, memory policy, analyst, gate.
- [ ] Run factorial or quasi-factorial experiments where practical.
- [ ] Extend causal attribution reports to surface families.
- [ ] Build a PiGraph-style adapter from traces to typed provenance graph.
- [ ] Make graph IDs deterministic and topology-preserving before use in research claims.
- [ ] Compare graph features to non-graph features for predictive value.

Completion criteria:

- [ ] Surface attribution report identifies main effects and interactions with confidence intervals or explicit uncertainty.
- [ ] Graph adapter preserves branching topology.
- [ ] Graph features beat a flat trace baseline on at least one prediction task.
- [ ] Any graph claim is reproducible from trace IDs and commit hashes.

### Q4 2027 - Phase 5: Learned State Estimators

- [ ] Train or fit state estimators from trace evidence to outcome-relevant variables.
- [ ] Compare learned estimators to deterministic baselines.
- [ ] Measure calibration, transfer, and drift.
- [ ] Add abstention when estimator confidence is unsupported.
- [ ] Audit leakage from judge outputs, holdout labels, or future trace spans.

Completion criteria:

- [ ] Learned estimator improves a downstream decision policy, not just variable prediction.
- [ ] Calibration holds on a future time split.
- [ ] Leakage audit passes.
- [ ] Estimator outputs unsupported variables explicitly.
- [ ] The estimator can be disabled without breaking existing reports.

### Q1 2028 - Phase 6: Cross-Domain Transfer and Benchmark

- [ ] Build a benchmark with multiple domains and distribution shifts.
- [ ] Include no-belief, heuristic, selective, OPE, graph, and learned-estimator baselines.
- [ ] Publish scenario construction, splits, contamination checks, and scoring.
- [ ] Evaluate transfer: state estimator trained on domain A, used on domain B.
- [ ] Add partner/product traces only if consent, redaction, and governance are solved.

Completion criteria:

- [ ] Benchmark has >= 100 scenarios or >= 1,000 decision points.
- [ ] At least three baselines are strong enough to be credible.
- [ ] Held-out results include confidence intervals.
- [ ] Contamination guard passes.
- [ ] Public artifact can be reproduced from scripts, seeds, model snapshots, and data hashes.

### Q2 2028 - Phase 7: Self-Improving Belief-State Policies

- [ ] Let the system propose candidate state features or decision policies.
- [ ] Gate feature/policy changes through the same held-out machinery.
- [ ] Add reward-hacking checks for estimator/gate manipulation.
- [ ] Add rollback rules for policies that regress production outcomes.
- [ ] Prepare paper/product package only if empirical gates pass.

Completion criteria:

- [ ] Self-proposed policy improves over the previous policy on heldout.
- [ ] Reward-hacking probes pass.
- [ ] Production feedback confirms or falsifies offline estimate.
- [ ] Rollback path is tested.
- [ ] External writeup can state a falsifiable claim without overstating mechanism.

## Completion Checklist

Do not call belief-state work "done" until these are true:

- [ ] Source tracking exists and is updated after each material experiment.
- [ ] Every derived state variable has a producer and evidence path.
- [ ] Every decision policy has a baseline.
- [ ] Every reported lift has split, n, CI, cost, and integrity status.
- [ ] Every OPE result has effective sample size and support diagnostics.
- [ ] Every calibration claim has ECE or equivalent metric.
- [ ] Every memory claim has poisoning/staleness handling.
- [ ] Every graph claim preserves topology and deterministic identity.
- [ ] Every surface attribution claim distinguishes correlation from causal evidence.
- [ ] Every public API is disabled or marked experimental until a replay corpus validates it.
- [ ] No runtime ownership boundary is crossed from `agent-eval`.
- [ ] Negative results are recorded instead of hidden.

## Kill Criteria

Stop or pivot if any of these persist for two consecutive phases:

- OPE support is too weak to make policy claims.
- Selective gates improve eval scores but not real outcomes.
- The best policy is always "ask/verify everything" after cost accounting.
- Memory policy evaluation cannot distinguish useful memory from context bloat.
- Graph features do not beat flat trace features.
- Belief-state variables are mostly hand-labeled and not trace-derived.
- The work requires runtime ownership to make sense.
- The roadmap produces mechanism but no held-out lift or calibrated reduction in risk.

## Immediate Next Build

The first code build should be small and internal:

1. Add a decision-point extraction experiment that reads existing traces and emits JSONL rows joined to `RunRecord`.
2. Add a selective prediction report over one decision kind.
3. Add a calibration report using existing `meta-eval/calibration.ts` patterns.
4. Add a holdout gate that reports honest negative if no utility lift appears.

Do not add a stable public `belief-state` subpath until the first selective policy clears its completion criteria.

## Exact Integration Map

The most succinct integration is an experimental `src/belief-state/` module that consumes existing substrate data and produces a policy-evaluation report. It should not create a second runtime model.

### Existing Abstractions to Extend

| Existing abstraction | Fit | Extension |
|---|---|---|
| `TraceStore` + `TraceSchema` | Good source of evidence. Runs, spans, and custom events already carry the data needed for decision extraction. | Use existing `custom`, `state_mutation`, and `policy_violation` events. Do not add event kinds until producers prove a missing field. |
| `RunRecord` | Good analysis join row: run id, candidate, split, seed, model, hashes, cost, outcome. | Do not change it. Belief decision rows should be sidecar records keyed by `runId`, `scenarioId`, and `stepIndex`. |
| `AnalystFinding` / evidence refs | Good optional semantic evidence layer. | Reference findings by id when present; do not require analysts for deterministic extraction. |
| `/rl/off-policy` | Already owns IPS/SNIPS/DR estimators and support diagnostics. | Add a converter from decision rows to `OffPolicyTrajectory[]` using an explicit named target policy; do not reimplement OPE math. |
| `meta-eval/calibration.ts` | Good calibration shape, but store-bound today. | Add a pure `calibrationFromPairs()` helper and reuse it from both meta-eval and belief-state. |
| `InsightReport` | Correct eventual home for summary rows. | Do not extend in the first internal slice. Add `beliefPolicies?: BeliefPolicyInsight[]` only after one policy clears holdout gates. |
| `control-runtime.ts` | Useful producer shape for typed decisions. | Optional adapter from `ControlRunResult` to decision rows. Do not make belief-state depend on control loops only. |

### Files to Add First

| File | Purpose | Notes |
|---|---|---|
| `src/belief-state/types.ts` | Defines `BeliefDecisionPoint`, `BeliefDecisionKind`, `BeliefActionChoice`, `BeliefDecisionOutcome`, `BeliefEvidenceRef`, `BeliefPolicyEvaluationReport`, `SupportDiagnostics`. | Pure types. No runtime dependency. |
| `src/belief-state/extract.ts` | Extracts decision points from `TraceStore` runs/spans/events. | Structural parsing only. Unknown events are skipped with diagnostics. |
| `src/belief-state/selective.ts` | Evaluates continue/verify/ask/retry/stop policies against observed outcomes. | Computes coverage, accepted-error rate, rejected-action lift, cost-adjusted utility. |
| `src/belief-state/calibration.ts` | Computes confidence calibration for decision predictions. | Calls shared `calibrationFromPairs()` once added. |
| `src/belief-state/ope.ts` | Converts decision rows into `OffPolicyTrajectory[]` for an explicit named target policy and calls `offPolicyEstimateAll`. | Must report ESS and support mismatch; no silent value claims. |
| `src/belief-state/report.ts` | Orchestrates extraction + selective eval + calibration + OPE into one report. | Returns honest negative / need-more-data when unsupported. |
| `src/belief-state/index.ts` | Experimental barrel for the module. | Keep out of root barrel and expose only through `./experimental/belief-state` while evidence gates are open. |

### Files to Change First

| File | Change | Why |
|---|---|---|
| `src/meta-eval/calibration.ts` | Extract pure `calibrationFromPairs(pairs, options)` and keep `calibrationCurve()` as the TraceStore/OutcomeStore wrapper. | Avoid duplicate ECE/binning logic. |
| `src/rl/index.ts` | No change in first slice unless helper types need re-export. | OPE stays under `/rl`; belief-state imports it internally. |
| `docs/research/belief-state-agent-eval-roadmap.md` | Keep this tracker updated with real results. | Prevent mechanism drift and unsupported claims. |
| `.evolve/pursuits/2026-06-04-belief-state-agent-eval.md` | Update phase status and empirical result. | Keeps active research state discoverable. |

### Files Not to Change First

| File | Reason |
|---|---|
| `src/run-record.ts` | Adding belief fields here would pollute the paper-grade run row before producers exist. Use sidecar rows. |
| `src/trace/schema.ts` | Existing `custom` events and span attributes are enough for Phase 0. Schema bumps need producer evidence. |
| `src/contract/index.ts` | `/contract` is the stable LAND-tier surface. Belief-state should not enter it until proven. |
| `src/contract/insight-report.ts` | Do not add `beliefPolicies` until the module has one validated report shape. |
| `src/index.ts` | Root barrel is already broad; do not add experimental research APIs there. |
| `package.json` exports / `tsup.config.ts` | Defer stable `./belief-state` subpath until Phase 1 gates pass. Experimental dogfooding may use `./experimental/belief-state`. |

### Public Export Gate

During the draft phase:

- `tsup.config.ts`: entry `'belief-state/index': 'src/belief-state/index.ts'` may exist to build the experimental subpath.
- `package.json`: export `"./experimental/belief-state"` only.
- Docs and PR bodies must call the surface experimental.

Only after Phase 1 succeeds, promote to stable:

- `package.json`: export `"./belief-state"` to `dist/belief-state/index.js`.
- `docs/feature-guide.md` or a dedicated docs page: document the promotion evidence and remaining caveats.
- `src/contract/insight-report.ts`: optional `beliefPolicies?: BeliefPolicyInsight[]`, only if the report is stable enough for dashboards.

Do not add to `/contract` until at least one downstream product uses it without source imports and the report shape survives a second corpus.

### Minimal Data Model

```ts
export type BeliefDecisionKind =
  | 'continue'
  | 'verify'
  | 'ask'
  | 'retry'
  | 'stop'
  | 'memory-write'
  | 'memory-read'
  | 'tool-select'
  | 'skill-select'
  | 'workflow-select'
  | 'surface-promote'

export interface BeliefDecisionPoint {
  id: string
  runId: string
  scenarioId?: string
  stepIndex: number
  kind: BeliefDecisionKind
  chosenAction: string
  candidateActions?: string[]
  confidence?: number
  behaviorProb?: number
  targetProb?: number
  costUsd?: number
  evidence: BeliefEvidenceRef[]
  outcome?: BeliefDecisionOutcome
  metadata?: Record<string, unknown>
}
```

This is intentionally a decision-point schema, not a global belief-state schema. Global state estimators can be built later from these rows.

### Evaluation Criteria

Phase 0 corpus admission:

- [ ] >= 200 decision points or the report returns `need_more_data`.
- [ ] >= 3 task families or explicit single-domain label.
- [ ] 100% of decision points join to a `RunRecord.runId`.
- [ ] Every row has `kind`, `chosenAction`, `stepIndex`, and at least one evidence ref.
- [ ] Every analyzed run passes backend/capture integrity before scoring.
- [ ] Train/dev/holdout split is present.

Selective policy:

- [ ] Cost-adjusted utility beats baseline on holdout with CI.low > 0, or records honest negative.
- [ ] Accepted-action error rate decreases relative to baseline.
- [ ] Coverage is reported; low coverage cannot masquerade as high quality.
- [ ] Always-verify and never-verify baselines are included.
- [ ] Shuffled-confidence negative control does not pass.

Calibration:

- [ ] ECE is reported.
- [ ] Max bin gap is reported.
- [ ] Calibration improves over uncalibrated confidence or reports failure.
- [ ] Confidence with fewer than 2 bins of support returns `need_more_data`.

OPE:

- [ ] ESS >= 30 and ESS/raw n >= 0.25 before making a value claim.
- [ ] Max importance weight <= configured cap, or report support mismatch.
- [ ] IPS, SNIPS, and DR either agree within tolerance or disagreement is surfaced.
- [ ] No propensity defaults are invented. Missing propensities disable OPE.

Promotion:

- [ ] Recommendation is one of `ship`, `hold`, `need_more_data`.
- [ ] `ship` requires selective-policy lift plus calibration support, not OPE alone.
- [ ] Any missing integrity, split, outcome, cost, or support data forces `need_more_data` or `hold`.

### Test Map

| Test file | Required cases |
|---|---|
| `src/belief-state/extract.test.ts` | extracts from custom trace events; joins run ids; skips malformed events with diagnostics; never throws on unknown payloads. |
| `src/belief-state/selective.test.ts` | baseline vs selective utility; always-verify cost penalty; shuffled confidence negative control; honest negative. |
| `src/belief-state/calibration.test.ts` | ECE bins; equal-width/equal-frequency behavior; too-few-pairs returns unsupported. |
| `src/belief-state/ope.test.ts` | converts to `OffPolicyTrajectory`; explicit target policy required; invalid propensity disables OPE without throwing; low ESS support mismatch; estimator agreement surfaced. |
| `src/belief-state/report.test.ts` | full report status: `ship`, `hold`, `need_more_data`; recommendation cannot ship on OPE alone. |
| `src/meta-eval/calibration.test.ts` | existing `calibrationCurve()` still works after extracting pure helper. |

### Verification Commands

- `pnpm typecheck`
- `pnpm test -- src/belief-state src/meta-eval/calibration.test.ts`
- `pnpm build`
- `pnpm verify:package`

### One-Sprint Implementation Order

1. Add types and extraction.
2. Add pure calibration helper.
3. Add selective-policy evaluator.
4. Add OPE converter using `/rl/off-policy`.
5. Add report orchestrator.
6. Add tests.
7. Run on one existing trace corpus and update this tracker with honest result.

This is the smallest integration that is useful: it answers "when should the agent continue/verify/ask/retry/stop?" with evidence, and it leaves memory, graph topology, and learned estimators for later phases.
