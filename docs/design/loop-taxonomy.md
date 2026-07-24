# Evaluation And Improvement Model

This document defines the package's internal terms and ownership boundaries.
Public examples should use concrete words such as prompt, skill, case, and agent whenever possible.

## The Evaluation Unit

One evaluation cell contains:

```text
candidate surface
+ scenario
+ repetition
+ dispatch
+ judges
= artifact, scores, trace, usage, cost, and status
```

The dispatch runs the system under test.
A judge converts one artifact into dimension scores and a composite score.
A campaign repeats this process across cases and candidates.

## The Value Being Changed

`MutableSurface` is the API type for the value under optimization.
It can be:

- a prompt string,
- a serialized configuration,
- a code surface owned by a runtime,
- a named component map for multi-part GEPA optimization.

A campaign measures surfaces but does not decide how a product stores or activates them.

## Two Candidate Paths

### Complete Optimization Method

`OptimizationMethod` owns search, candidate history, selection, and stopping.
It receives train and selection cases and returns one selected surface.

Use this path for:

- `gepaOptimizationMethod()`, which calls official GEPA engines and composition functions,
- `skillOptOptimizationMethod()`, which calls Microsoft's official `ReflACTTrainer`,
- another optimizer that already owns its search behavior.

Complete methods run through `compareOptimizationMethods()`.
The comparison function scores selected surfaces on final cases after all optimization finishes.

### Caller-Owned Candidate Generator

`SurfaceProposer` suggests candidates inside Agent Eval's `runImprovementLoop()`.
It receives the current surface, prior campaign history, findings, generation number, requested population size, and cancellation signal.

Use this path when:

- product rules generate candidates,
- agent-runtime delegates candidate creation to a worker,
- a human-authored list defines possible edits.

Do not reproduce an upstream optimizer behind this interface.
Use its complete method adapter so the upstream package retains control of its own search state.

## Three Data Partitions

| Partition | May author candidates | May select candidates | May rank final methods |
|---|---:|---:|---:|
| Train | yes | yes | no |
| Selection | yes | yes | no |
| Final test | no | no | yes |

An `OptimizationMethodInput` has no final-test field.
This structural omission prevents an optimizer from receiving final cases through the normal API.
Official methods receive serialized train and selection cases, so both partitions are optimizer-visible.

Change authors must still avoid indirect leaks through files, environment variables, cached artifacts, or custom scenario descriptions.

## Main APIs

| API | Responsibility |
|---|---|
| `runCampaign()` | Execute and score a fixed set of candidate cells. |
| `runImprovementLoop()` | Search with a caller-owned `SurfaceProposer` and apply a release rule. |
| `compareOptimizationMethods()` | Run complete methods and compare selected surfaces on shared final cases. |
| `gepaOptimizationMethod()` | Adapt official GEPA recipes to Agent Eval execution and scoring. |
| `skillOptOptimizationMethod()` | Adapt official SkillOpt training to Agent Eval execution and scoring. |

## Runtime Ownership

Agent Eval owns measurement:

- scenarios,
- dispatch contracts,
- judges,
- run records,
- cost receipts,
- statistics,
- method comparison.

Agent Runtime owns execution policy:

- agent sessions,
- worker creation,
- steering,
- code edits,
- process placement,
- activation in a running product.

Agent Knowledge owns knowledge state:

- sources,
- retrieval,
- memory adapters,
- knowledge writes,
- freshness and provenance.

Runtime and knowledge packages can expose their values as candidate surfaces and use Agent Eval to measure them.
Agent Eval must not import either consumer package.

## Resume And Parallel Work

Campaign storage keeps cell-level results and cost receipts.
Official optimizer adapters add their own compatible-run identity and process lock.

A compatible official run includes:

- upstream package revision,
- optimizer recipe or trainer settings,
- starting surface,
- train and selection descriptions,
- evaluation revision,
- seed,
- work limits.

SkillOpt and a direct GEPA engine can restore official state.
Composed GEPA recipes restart and report `resumed: false`.
Method-level concurrency and candidate-level concurrency are separate controls.
Each method receives its own run directory and optimization spend account.

## Cost Accounting

Agent and judge calls must report receipts through `DispatchContext.cost`.
Unknown spend remains unknown.

Standard GEPA and SkillOpt model calls pass through Agent Eval's local proxy.
The proxy enforces limits and records provider usage at caller-supplied rates.
Other GEPA engines can report their own spend, but that amount remains incomplete because Agent Eval did not observe those model calls.
Missing usage remains unknown instead of being treated as zero.

## Promotion

Optimization returns a candidate.
Product activation remains a separate caller decision.

The caller should require:

- a calibrated score,
- improvement on cases not used to author candidates,
- acceptable regressions by dimension,
- complete enough cost data for the decision,
- an inspectable exact change.

The package records the decision inputs but does not deploy a prompt, skill, model, code change, memory, or knowledge base.
