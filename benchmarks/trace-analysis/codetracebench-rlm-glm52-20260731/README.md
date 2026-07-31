# CodeTraceBench GLM-5.2 — recursive DSPy RLM analyst

The first scored run of the recursive trace analyst that ships today: the official DSPy RLM investigating each trajectory with the seven allowlisted trace tools, driven by GLM-5.2 through the metered router.
This is the number the retired one-shot runner never measured.

## Result

The recursive engine matches the retired one-shot runner and does not beat it, at more than five times the cost.
Both beat the benchmark's own tool.

| Analyst | Scored F1 | Precision | Recall | Completed | Cost |
| --- | ---: | ---: | ---: | ---: | ---: |
| DSPy RLM (recursive, this run) | 0.3644 | 0.3413 | 0.3909 | 60/64 | $6.73 |
| Direct one-shot (retired, [pinned run](../codetracebench-glm52-20260730/README.md)) | 0.3673 | 0.3333 | 0.4091 | 63/64 | $1.21 |
| CodeTracer (NJU-LINK upstream tool) | 0.3128 | 0.2857 | 0.3455 | 61/64 | — |

Same 32 pinned CodeTraceBench trajectories, two repetitions, one GLM-5.2 model, the unchanged official scorer, inputs verified byte-identical to the pinned corpus.
The 0.003 F1 gap between the recursive and one-shot runners is within the noise of 16 labeled cases and two repetitions; they are tied.

## What this says

Recursion did not improve step localization on this task.
The recursive analyst reads the trace, writes and runs Python over it, and cites real spans — its investigation is genuine — yet its accuracy lands where the single structured call already sat.
That is consistent with the earlier failure decomposition: the binding constraint is *where* an accusation is aimed, not *how much* the analyst investigates before making it.
Depth of investigation is the wrong lever for this benchmark; a grader and a task that reward verified localization are the next thing to build.

The recursive engine's value is not this score.
It is that the same analyst runs against any coding-agent session through the traces CLI and produces findings backed by executed checks — a capability the one-shot runner does not have, and one this benchmark does not measure.

## Completion and cost integrity

60 of 64 cases completed.
Three failed on provider rate limits at concurrency six, and one on a model-emitted failure block wider than the 12-step cap.
About two percent of GLM-5.2 responses arrive with usage the provider omitted; each is charged its reserved maximum against the budget and its completion is still used, so an under-reported call neither inflates the reported cost nor discards a case.
`known_cost_usd` is therefore an honest upper bound.

## Reproduce

Same corpus, importer, and revision as [`../codetracebench-glm52-20260730`](../codetracebench-glm52-20260730/README.md), with `--analyst dspy-rlm --python <agent-eval-rpc[dspy] interpreter>`.
The recursive analyst runs the official `dspy.RLM` in a sandboxed Deno/Pyodide child process; `pip install "agent-eval-rpc[dspy]"` provides it.
The implementation and dependency digests are recorded in `result.json`; this directory's numbers describe the recursive engine only and may not be cited for any other analyst.
