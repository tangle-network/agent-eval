# Find Which Numbers Predict A Later Outcome

## When to use this

Use this example when you record many numbers about each change and must choose which few to climb.
A number chosen because it correlates with a good outcome on the data you looked at proves nothing about the next change.
This example tests every number on changes made after a sealed cut, controls false discoveries across all of them, and keeps the admitted numbers you do not climb as guards.

## How to run it

```sh
pnpm install
pnpm build
pnpm exec tsx examples/measure-validity/index.ts
```

No API key is required.
The history is generated from a seeded random source, so the truth is known.

## What it does

The input is a flat table, one row per change: an id, a merge time, a repository, named measures (null where unmeasured) and outcomes (null until their window closes).
`toChange` and `toOutcomes` are the whole mapping; an outcome's capture time is its window's close.

1. `sealMeasureValidityPlan()` registers the cut, the false-discovery level, the minimum counts, the outcome and the measures, and returns a digest.
   Seal it before reading any change made after the cut.
2. `measureValidityStudy()` fixes each measure's direction on changes before the cut, reading only outcomes known by the cut.
   It then tests every measure on changes after the cut, one-sided in that direction, resampling whole repositories, with Benjamini-Hochberg across all 25 measures.
   It reports the statistic pooled across repositories and within each repository.
3. With before and after values, it reports whether a measure moves under change and whether its movement agrees with the outcome.
4. From the measures that predict within repositories it chooses a subset to climb on the changes before the cut and returns the rest as guards.
5. `guardDrift()` reads a later batch in which the first climbed measure was pushed up without the work behind it.

The planted truth:

| Measure | Truth | Expected result |
|---|---|---|
| `review_depth` | Reflects the quality that decides the outcome; unmeasured on one change in ten | `predicts`, coverage about 90%; it or its copy is climbed |
| `review_depth_copy` | A near copy of `review_depth` | `predicts`; whichever of the pair is not climbed is a `redundant` guard |
| `test_delta` | Its movement under change decides the outcome | `predicts`, `moves-with-outcome`, climbed |
| `repo_size` | Constant within a repository; larger repositories keep fewer changes | `predicts-pooled-only`, not climbable |
| `hotfix` | Set on about one change in a hundred | `insufficient` (`too-little-variation`) |
| `noise_00` to `noise_19` | Nothing | Not admitted |

The output is:

```text
plan digest: 5b20e1012f4521137dfd3025309bfc68bcb2c9cd7b1b1ed64e88a1e0a949fad4
seal verifies: true
changes: 1000 before the cut, 1100 after; pooled pairs tested: 24; predicts: 3
review_depth        predicts                                          AUC pooled 0.749  within 0.768  movement not recorded
review_depth_copy   predicts                                          AUC pooled 0.750  within 0.768  movement not recorded
test_delta          predicts                                          AUC pooled 0.670  within 0.658  movement moves-with-outcome
repo_size           predicts-pooled-only (within-unit-not-shown)      AUC pooled 0.631  within 0.500  movement not recorded
hotfix              insufficient (too-little-variation)               AUC pooled n/a    within n/a    movement not recorded
review_depth measured on 90.0% of changes
noise measures not 'not-shown': 0 of 20
climb: review_depth_copy, test_delta
guards: review_depth (redundant)
not climbable: repo_size (pooled-only)
composite AUC after cut: 0.794
drift review_depth_copy: drift, rise over guards 1.71 [1.71, 1.71]
drift test_delta: within-tolerance, rise over guards -0.07 [-0.19, 0.06]
kept-rate shift: -0.063
one-sided: the measure, aligned to the direction fixed before the cut, is above the null for the better outcome; Benjamini-Hochberg per family at the plan level
cause requires: randomized or interleaved assignment of changes, so the measure moves for reasons unrelated to the outcome
```

## Why it is built this way

Every planted truth is recovered.
`review_depth` and its copy score alike, so the copy that ranked first before the cut is climbed and the other becomes its guard.
The gamed batch moves the climbed copy 1.71 before-cut scale units above its guard, an exact shift because the guard is its twin, while the kept rate does not follow.

The cut is the only split, and it is in the seal.
Directions, standardization and the climbed subset come from changes before it; every reported number comes from changes after it.
A number whose direction reverses after the cut is not admitted, however strong it looked before.

The interval resamples repositories, not changes.
Changes in one repository share whatever makes that repository differ, and counting them as independent admits coincidences.

The study reports prediction, not cause.
A climbed number can be moved without the work it used to reflect, which is what the drift check catches.
Records that show cause assign changes at random or interleave them.

See [outcome validity](../../docs/outcome-validity.md#choose-which-measures-to-climb) for every field.
