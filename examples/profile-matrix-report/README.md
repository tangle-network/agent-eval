# Turn profile-matrix cells into a decision page

## When to use it

Use `renderProfileMatrixReport()` when a profile matrix has run and the question is which profile to keep.
It takes `RunRecord`s, from `runProfileMatrix()`, `finalizeProfileMatrix()`, `raceProfileMatrix()` or rows you convert yourself, and returns one self-contained HTML page: inline SVG and CSS, no network, light and dark.
`analyzeProfileMatrix()` returns the same numbers as data.

Use `raceProfileMatrix()` before the full matrix when most profiles will lose.
It runs doubling case batches, drops a profile once its paired interval against the leader lies wholly below zero, always keeps the baseline, and leaves the rows it skipped claimable so `finalizeProfileMatrix()` can still complete the plan.

## How to run it

This example converts cells you already ran, one JSONL file per cell, into records and renders the page.
No model is called.

```sh
pnpm tsx examples/profile-matrix-report/index.ts <rows-dir> \
  --truth <truth.json> --label <field> --slice <field> --cluster <field> \
  --baseline <cell> --out page.html
```

Each file is named `<harness>-<model>-<effort>[-<instructions>].jsonl`, which gives the cell's factor levels.
Each row is `{ case, label, seconds, tokens: { input, output, reasoning, cache_read } }`; a row without a label is a failed attempt.
The truth file maps each case to its true label and the fields named by `--slice` and `--cluster`.
The run prints, per cell, the cases scored, accuracy on the cases every cell scored, the paired difference from the baseline with its interval, median seconds and mean tokens.

## Why it is built this way

Every comparative number on the page is paired on the cases every compared profile scored, so a profile that ran easier cases cannot look better.
Intervals are clustered when you pass a cluster per case (for example one per docket), because cases from one source are not independent.
Quality is drawn against tokens and seconds as well as dollars, so the page stays useful on flat-rate seats where dollars are not measured.
The power line says the smallest difference this design could detect, so an unresolved row reads as "not measurable here" rather than "equal".

A race chooses its leader on the cases it raced, so the leader's score there reads high.
The race result and the page both say so; confirm the leader on fresh held-out cases before acting on it.
