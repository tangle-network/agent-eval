# Design rationale

Why this package is shaped the way it is.
This is background reading, not reference.
The API itself is documented in [`concepts.md`](./concepts.md) and the [`README`](../README.md).

## Composition with the Tangle agent stack

`agent-eval` is one package in a larger stack.
It sits at the bottom of the layering: consumers depend on it, it depends on none of them.

```
agent-runtime    Runs agents (chat turns, one-shot tasks, multi-attempt loops), captures every
                 run as a trace, and exposes improve(), which composes agent-eval's improvement
                 loop. Produces the RunRecords + traces agent-eval scores. Depends on agent-eval.

agent-eval       selfImprove, analyzeRuns, runCampaign + surface proposers (GEPA proposer, …),
   (this repo)   the gates (heldOutGate, defaultProductionGate, paretoSignificanceGate), the
                 InsightReport, the RL bridge, the wire protocol. Depends on neither consumer.

agent-knowledge  proposeKnowledgeWrites / applyKnowledgeWriteBlocks. agent-eval's analyst
                 findings feed it; the knowledge gate consumes them. Depends on agent-eval.

sandbox          Sandbox.create, streamPrompt. One execution environment the runtime's
                 loops run on; agent-eval scores what comes back.
```

None of the sibling packages are required to use `agent-eval`; the library stands alone.
The stack context matters only if you adopt more of it later.

## The dependency rule

This section is the public rationale.
The enforceable maintainer rule lives in [`CLAUDE.md`](../CLAUDE.md#repo-layering--this-package-is-the-substrate).

**`agent-eval` has zero upward dependencies on a consumer.**
This is what keeps the package reusable outside our own stack: nothing in here imports from `agent-runtime`, `agent-knowledge`, or `sandbox`, whether at runtime, in development dependencies, or as type-only imports.

The placement test for any shared type: *does this concept make sense without a running agent loop?*

- Yes: it lives here. A judge score, a run record, a scenario, and a pass/fail verdict are all meaningful for a pile of logs with no agent attached.
- No: it lives in the runtime layer. A validation context carrying an abort signal and a concrete sandbox session only exist mid-run.

When in doubt, the type moves down into `agent-eval`: subtracting a dependency from a consumer is always cheaper than adding one here.
Agent profile shape is the shared `@tangle-network/agent-interface` contract, so neither layer owns it.

## Why "surface"

The improvement loop needs one word for "the thing being changed", because it deliberately does not care what that thing is: a system prompt, a config object, a skill file, a set of few-shot examples.
Proposers emit candidate surfaces, campaigns measure them, gates compare them against the baseline surface.
Where a doc can say "prompt" concretely, it should; `surface` appears in API names where the generality is the point.

## Why the report never invents signal

Every section of the `analyzeRuns()` report is opt-in based on what the input data supports.
If runs carry no judge scores, the judge section is empty rather than defaulted.
If there is no baseline/candidate split, no lift is reported.
Missing evidence is never scored as zero; a judge that throws is recorded as a failed cell, not silently folded into the average.
The reasoning: a fabricated zero poisons every statistic downstream, and an eval library that quietly fabricates is worse than no eval at all.

## Maintainer docs

These files record operating conventions for maintainers and internal agents.
They are not adoption reference:

- [`building-doctrine.md`](./building-doctrine.md): conventions our agents follow when consuming this package (reachable model defaults, probe-before-debug, experiment integrity checklist)
- [`design/loop-taxonomy.md`](./design/loop-taxonomy.md): the internal vocabulary for execution drivers, workers, measurements, and proposers
- [`research-report-methodology.md`](./research-report-methodology.md): the evidence standard our own research reports are held to
- [`.claude/skills/agent-eval/SKILL.md`](../.claude/skills/agent-eval/SKILL.md): directives for LLM agents writing integration code, encoding bug classes we have already shipped and fixed once
