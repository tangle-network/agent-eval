# CodeTraceBench failure evidence taxonomy

This report classifies 239 retained CodeTraceBench trajectories by task outcome and the first annotated incorrect step.
The cases come from the pinned `NJU-LINK/CodeTraceBench` revision `aa213b84ffb6690fc37ca15766d6ca174ec36d4d`.
All 239 have a gold label, normalized steps, and a matching OTLP trace.
The five corpora contain 16,843 spans in total.

The classes describe recorded evidence, not the cause of the final task outcome.
CodeTraceBench labels incorrect steps, but its labels do not explain why a task failed.
No class here estimates failure prevalence for hosted Operator or Majo agents.
The 33 unsolved runs with no annotated incorrect step remain explicitly unknown.
The causal explanation of the other unsolved runs also needs independent review.

## Counts

Every trajectory belongs to exactly one class.
All class members, trace IDs, first gold steps, returncodes, and input hashes are in [taxonomy.json](./taxonomy.json).
The `traceId` matches the OTLP `trace_id` and the normalized directory name.

| Class | Count / 239 | Count / 99 unsolved | Evidence rule |
| --- | ---: | ---: | --- |
| Solved, with annotated incorrect step | 90 | — | `solved=true`, at least one gold incorrect step |
| Solved, no annotated incorrect step | 50 | — | `solved=true`, no gold incorrect step |
| Unsolved, unknown / unclassified | 33 | 33/99 | No gold incorrect step |
| Unsolved, first gold command exited 0 | 24 | 24/99 | Recorded successful command; semantic error remains unverified |
| Unsolved, first gold command exited 127 | 11 | 11/99 | Recorded command-not-found exit |
| Unsolved, first gold command had another nonzero exit | 6 | 6/99 | Recorded shell exit other than 0 or 127 |
| Unsolved, first gold is a pure submit | 9 | 9/99 | `submit` or a sole mini-SWE sentinel echo |
| Unsolved, first gold submit command includes work | 8 | 8/99 | Sentinel occurs with other shell commands; no exit is recorded |
| Unsolved, first gold is SWE-agent ACI edit with no returncode | 8 | 8/99 | Editor action and prose observation, without a shell exit |

The mix differs across the five corpora.
All 11 first-gold exit-127 cases are in holdout-2.
Split-3 has 9 first-gold submit cases, including 7 whose action also names other work.
All 8 first-gold ACI edits are in the SWE-agent corpus.
The per-case artifact preserves these groups and the 33 unknown trace IDs.

## Verified replay cases

The retained replay dataset has 22 unique cases.
Run 2 and run 6 replayed those same cases, giving 44 run rows rather than 44 independent cases.
Run 2 reported 16/22 reproduced, and run 6 reported 13/22 reproduced under the old rule.
Eight of the 22 recorded gold commands exited 0 with no error signature.
The old rule marked 4 of those eight reproduced in run 2 and 3 in run 6.
Run 2 also marked 2 exit-0 cases as fix flips.

The old `signatureStrict` field included cases with no signature.
Among its reproduced strict rows, only 1/13 in run 2 and 1/11 in run 6 actually held a recorded signature.
Nine of the 22 gold commands exited 127 with a command-not-found observation.
The old signature extractor ignored those observations because their message lacked the word `error`.
The updated extractor preserves the command and `not found` suffix.
These historical counts were computed from the retained rows; they were not silently rewritten.

## Five Eval reliability defects and corrections

1. **Successful wrong edits counted as reproduced failures.**
   The gold edit in `miniswe-OpenAI__GPT-5-sveltejs__svelte-11913-1fe8a1b7` exited 0 with empty output.
   The replay reported it reproduced, even though the exit could not check the semantic error.
   `replayVerify` and batch now withhold a reproduced-failure verdict for exit 0.
   The finding wire rejects exit-0 targets before it calls a fix model.

2. **Missing signatures counted as strict matches.**
   The old `failureSignatureMatch` returned true when the signature was null and returncodes matched.
   The historical strict counts above therefore overstated the evidence.
   A strict match now requires a real recorded substring and a matching replay output.

3. **Command-not-found evidence was discarded.**
   The gold `applypatch` action at step 7 of `miniswe-OpenAI__GPT-5-instance_ansible__ansible-4c5ce5a1a9e79a845aff4978cfeb72a0d4ecf7d6-v1055803c3a812189a1133297f7f5468579283f86-6e5a7eaa` recorded `/bin/sh: 1: applypatch: not found`.
   The replay observed `sh: 1: applypatch: not found`, but the old parser retained no output signature.
   Signature extraction now uses the stable `applypatch: not found` suffix.

4. **A submit action with work was discarded as a pure submit.**
   `miniswe-OpenAI__GPT-5-instance_ansible__ansible-1b70260d5aa2f6c9782fd2b848e8d16566e50d85-vba6da65a0f3baefda7a058ebbd0a8dcafb8512f5-0b674c2a` records a gold command containing a sentinel echo and `git add`.
   The old corpus selector skipped it because the sentinel appeared anywhere in the action.
   The selector now skips only a sole sentinel echo.
   It retains the state-changing action, then excludes it when its missing exit prevents verification.

5. **Targets without a recorded returncode entered shell replay.**
   SWE-agent's `str_replace_editor` gold action in `sweagent-OpenAI__GPT-5-huggingface__transformers-13865-44d517cd` has no shell returncode.
   The earlier SWE-agent batch completed 22 rows, with all 22 unreproduced and 21 arm-A exits of 127.
   Corpus selection now rejects a target with no returncode before image preparation or model calls.
   The finding wire rejects the same target before fix generation.
   On the currently retained five prepared trees, 21 cases reach this exclusion after earlier resource checks.
   The retained SWE-agent prepared tree uses `.traj` files, so its cases stop earlier as `no-swe-raw-trajectory`.

Arm B also now requires an in-tolerance prefix before reporting a fix flip.
The retained successful flips had arm-B prefix divergence at or below 10%; the regression tests a controlled divergence above that gate.
No historical flip count is revised on the basis of this unobserved scenario.

After the new admission checks, 22/239 cases are replayable from the retained prepared trees.
The other 217 exclude as follows: 171 without the raw format the replay reader accepts, 21 without a Docker image, 21 without a recorded returncode at the selected gold step, and 4 without a gold incorrect step.
These are replay-resource counts, not additional failure classes.

## Reproduce

The cache contains the retained inputs described in [taxonomy.json](./taxonomy.json).
Run from the agent-eval checkout:

```sh
python3 benchmarks/trace-analysis/reliability-taxonomy-20260923/build.py \
  --cache /home/drew/bench-cache/ctb-20260801 \
  --output /tmp/codetracebench-taxonomy.json
cmp /tmp/codetracebench-taxonomy.json benchmarks/trace-analysis/reliability-taxonomy-20260923/taxonomy.json
pnpm exec vitest run tests/trajectory-replay/steps.test.ts tests/trajectory-replay/batch.test.ts tests/trajectory-replay/verify.test.ts
```

The builder checks label-step alignment, every trace ID, OTLP origin, and both replay files' unique case coverage.
It stores SHA-256 digests for each label file, each steps and trace set, and both replay row files.
It uses no model or sandbox execution.
This investigation made no paid model calls; incremental model spend was $0.
