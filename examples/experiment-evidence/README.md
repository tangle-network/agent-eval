# Track candidates with reps, verdicts, and evidence

## When to use it

Use `ExperimentTracker` when you improve something repeatedly and need each candidate judged against its parent, not against your memory of it.
One experiment holds N repetitions of one candidate.
The tracker recomputes stats and a verdict on every appended rep: `KEEP`, `REGRESSION`, `NOISE` when the sample is too unstable to judge, or `ITERATE` while evidence is still collecting.

Every rep can carry the `runId` that produced it and `EvidenceRef` pointers to traces, artifacts, metrics, or findings.
That makes the log evidence-addressable: a verdict resolves to reps, and each rep resolves to its proof.

Use `HeldOutGate` instead when one candidate needs a ship decision on paired holdout cases.
Use `sealExperiment()` instead when the rules must be registered and hashed before any data arrives.

## How to run it

```sh
pnpm tsx examples/experiment-evidence/index.ts
```

```
baseline: verdict ITERATE — median 62, iqr 2, n=3
tighter-prompt: verdict KEEP — median 70, iqr 1.5, n=3
evidence for candidate-rep-0: file://runs/tighter-prompt/0/report.json, metric://tighter-prompt/0/composite
log persisted at /tmp/experiment-evidence-XXXXXX/experiments.json
```

## Why it is built this way

A single lucky run promotes a regression; the tracker refuses to render a verdict until both candidate and parent have `n >= 3` reps, and calls an unstable sample `NOISE` instead of `KEEP`.
The verdict thresholds are score-scale numbers you configure, not package opinions.

Provenance is captured when the experiment is created — commit, subject line, changed files — so the log records what code produced each candidate.
The default reader shells out to git and fails loudly when git is absent, because a log that silently writes `commit: unknown` cannot support the claims built on it.
This example pins provenance and the clock only to keep its printed output stable.

Persistence is a two-method seam.
`fileExperimentStore(path)` writes one JSON array; swap in your own store for a database without touching the stats.
