# CodeTraceBench failure-block contract — measured null result

This run tested one hypothesis and falsified it. The numbers below are the evidence.

## Hypothesis

CodeTraceBench labels arrive as contiguous runs of consecutive incorrect steps.
Measured on the published run, the analyst appeared to locate 23 of 28 labeled blocks while naming only about half the steps inside them.
If under-enumeration inside correctly located blocks were the binding constraint, letting the analyst report a whole block instead of one step should raise recall without costing precision — an arithmetic ceiling of F1 .4512 (+12.4pp).

## What actually happened

| Measure | Published baseline (one-shot, single step) | This run (failure blocks) |
| --- | ---: | ---: |
| Scored F1 | .3273 | **.3407** |
| Precision | .2727 | .2875 |
| Recall | .4091 | .4182 |
| Official all-row F1 | .1347 | .1296 |
| Matched steps | 45 | 46 |
| Predicted steps | 165 | 196 |
| Accused steps landing on a labeled step | 45/228 = **19.7%** | 46/279 = **16.5%** |
| Completed runs | 63/64 | 55/64 |
| Cost | $1.208 | $1.219 |

Both runs: 32 pinned cases × 2 repetitions, GLM-5.2, identical inputs (archive and normalized-step digests verified byte-identical to the published corpus), scored by the unchanged official pipeline.

## The mechanism fired; the premise was wrong

The contract change worked as designed. The analyst emitted **123 blocks with mean width 2.27** (median 2, max 11) against an effective width of 1.0 at baseline, so this is not a case of a prompt failing to take.

It did not convert, because block *placement* is wrong far more often than block *width*:

- **16.3%** of predicted blocks overlap any labeled step.
- The block's own `first_step` lands on a labeled step **13.8%** of the time.
- Widening added 156 steps, of which **18.6%** were labeled.

Enumerating a block the analyst has mislocated adds predictions at roughly the same low hit rate as the seed step. Recall rose by 1 matched step while predictions rose by 31; per-step accuracy fell from 19.7% to 16.5%. The +12.4pp counterfactual assumed the analyst's existing correct hits would expand to fill their true label blocks. Given the freedom to choose boundaries, it chose different ones.

**The binding constraint is localization, not enumeration.** Four out of five accusations land on steps the graders did not mark, and no change to how an accusation is *shaped* can fix where it is *aimed*.

## Threats to validity

- 9 of 64 runs failed on contract violations the model could not satisfy (a consequence step preceding the block's first step, and blocks wider than the 12-step cap). Their labels stay in the 110-step denominator, so recall here is a lower bound. Both defects are fixed in the shipping code; a re-run would raise recall by a few points and would not approach the +11pp threshold that would make the mechanism worth pursuing.
- n = 16 labeled cases, 55 labeled steps per repetition, 28 contiguous label blocks. One case supplies a disproportionate share of all matches. Every figure here is small-sample.
- The 28-block / 55-step ground truth was recounted directly from `input-labels.json`; an earlier analysis reporting 40 blocks and a +20.8pp ceiling was wrong.

## Reproduce

Same corpus, importer, and revision as [`../codetracebench-glm52-20260730`](../codetracebench-glm52-20260730/README.md), with `--analyst direct`.
The published evidence in that directory was produced by the retired one-shot runner at implementation SHA-256 `4dba263b…`; neither directory's numbers may be cited for the recursive DSPy engine, which has never been scored on this corpus.
