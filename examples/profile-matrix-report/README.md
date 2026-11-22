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
  --baseline <cell> --out page.html [--min-coverage 0.9]
```

Each file is named `<harness>-<model>-<effort>[-<instructions>].jsonl`, which gives the cell's factor levels.
Each row is `{ case, label, seconds, tokens: { input, output, reasoning, cache_read }, probs?, rep? }`; a row without a label is a failed attempt.
`rep` (default 0) says which run of the profile a row belongs to; the converter writes it to `outcome.raw.rep`, where campaign records keep it, and passes each row's label as its answer.
`probs` maps each label to the cell's forecast for it; the forecast for the label it answered feeds the calibration panel.
The truth file maps each case to its true label and the fields named by `--slice` and `--cluster`.
The run prints, per cell, the cases scored, its runs, coverage of the baseline's cases, whether the cell is in the panel, accuracy on its own and on the common cases, the paired n and difference from the baseline with its interval, the verdict and its Holm-adjusted p, median seconds and mean tokens; then, for each cell run more than once, each run's accuracy and how often the runs disagree.

## Why it is built this way

Every difference on the page is paired on the cases both profiles scored, so a profile that ran easier cases cannot look better, and a cell that ran fewer cases still gets its own paired difference without shrinking anyone else's.
The panels that compare all profiles at once (frontiers, error overlap, difficulty, slices, power) use the common cases of the panel: the profiles that scored at least `minCoverage` (default 0.9) of the baseline's cases, or a race's survivors.
The rest appear in a partial-coverage table, so one short cell cannot cut the common set to its size.
When the baseline has run more cases than the other cells, lower `--min-coverage` so they can join the panel; the page says when the panel holds the baseline alone.
Intervals are clustered when you pass a cluster per case (for example one per docket), because cases from one source are not independent.
Quality is drawn against tokens and seconds as well as dollars, so the page stays useful on flat-rate seats where dollars are not measured.
The power line says the smallest difference this design could detect, so an unresolved row reads as "not measurable here" rather than "equal".

A profile run more than once is one profile with replicates, not several profiles: each case scores its mean over the runs, so one lucky run does not read as a win.
Each comparison at a nominal 95% lets about one in twenty profiles that are no different from the baseline clear its interval by chance, so a page of dozens expects a false win.
Better and worse therefore hold the familywise error at 5% (one minus `level`) with Holm's adjustment over every profile-against-baseline comparison on the page, and the page says how many comparisons that is.
A profile whose nominal interval excludes zero but whose adjusted p does not pass is a candidate: it needs more cases or more runs, not a decision.
The run-to-run stability panel shows, for every profile with two or more runs, each run's quality, how many cases change answer or correctness between runs, and how far two runs with nothing changed can land apart at the panel's case count.
Read a single-run difference smaller than that margin as rerun noise; a verdict that rests on one run of the profile is marked "1 run".

A race chooses its leader on the cases it raced, so the leader's score there reads high.
The race result and the page both say so; confirm the leader on fresh held-out cases before acting on it.
