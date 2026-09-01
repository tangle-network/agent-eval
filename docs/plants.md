# Plants: does the grader catch a wrong answer?

A grading run reports how the work scored.
It cannot report whether the grader would have noticed a wrong answer, because every item it saw was authored in good faith.
A plant closes that hole.
A plant is an item authored wrong by construction, mixed into the live grading set, graded by the same path as everything else.
The share of plants the grader refused is the **catch rate**.

The measured motive: a sibling lab ran a deliverable gate that accepted any non-empty submission.
It produced six false certifications in seventeen deliveries.
No agent lied — the gate never asked a question the format could fail.
A catch rate is the number that would have shown it on the first day.

Everything below lives in `src/meta-eval/plants.ts` and is published from `@tangle-network/agent-eval/meta-eval`.

## Three calls

```ts
import { catchRate, definePlant, seedPlants } from '@tangle-network/agent-eval/meta-eval'

const plants = [
  definePlant({
    id: 'plant-throughput',
    kind: 'wrong-value',
    item: { itemId: 'claim-118', humanScore: 0 },
    expectedVerdict: 'reject',
  }),
]

const { items, manifest } = seedPlants(dataset, plants, { seed: 7, acceptThreshold: 0.5 })

// Publish manifest.seal now. Keep `manifest` itself out of the graded workspace.
const results = await grade(items.map((item) => item.itemId))

const report = catchRate(results, manifest)
```

`report` is a `CatchRateReport`:

| Field | Meaning |
| --- | --- |
| `status` | `evaluated`, `incomplete`, or `not_evaluated`. Only `evaluated` carries a rate. |
| `reason` | Why the status is not `evaluated`. Absent when it is. |
| `seeded` / `caught` / `missed` | Plants armed, graded as the seed demands, and graded against it. |
| `indecisive` | The grader answered and declined to decide. Counted apart, in neither side of `rate`. |
| `rate` | `caught / (caught + missed)`, or `null`. |
| `byKind` | The same counts per plant kind. A kind nobody seeded is absent, never zero. |
| `missedIds` | Every plant id the grader got wrong, by name. |
| `missingIds` | Every plant id with no result at all. |
| `unseeded` | How the same grader treated the rest of the set. |

## Authoring the wrong item

`definePlant` takes an item that is already wrong.
It never derives a wrong item from a right one, so every caller used to hand-roll the perturbation.
That is where the measurement breaks quietly.

`plantByPerturbation` is the authoring step.
Give it a claim a grader **verified** and it alters exactly one load-bearing value in the claim's evidence, so the grader is asked a question it must fail.

```ts
import { catchRate, plantByPerturbation, seedPlants } from '@tangle-network/agent-eval/meta-eval'

const derived = plantByPerturbation({
  id: 'plant-throughput',
  itemId: 'claim-118-plant',
  evidence: { check: 'test "$rows" -ge 100', expect: 'rows=42' },
})

// derived.plant     — a `wrong-value` plant the grader owes a `reject`
// derived.evidence  — { check: 'test "$rows" -ge 100', expect: 'rows=43' }
// derived.field     — 'expect'
// derived.how       — 'number-off-by-one'
// derived.original  — '42'
// derived.perturbed — '43'

const { items, manifest } = seedPlants(dataset, [derived.plant], { seed: 7 })
```

Write `derived.evidence` into the item the grader is handed; `derived.plant` goes into the manifest and nowhere the grader can read.
`humanScore` defaults to 0 and must sit below the run's accept threshold, or `definePlant` refuses the record.
The call returns `null` when nothing in the evidence can be perturbed — a claim with no executable evidence cannot be made wrong in a way a grader could execute, and seeding it would measure prose.

`perturbEvidence` is the same rule without the plant record, for callers that already own their item type.

### One value changes, and which one is a safety order

A perturbation that moves two values does not name the defect it seeded, so exactly one changes or the call returns `null`.
The order below is the order of preference, and it is ranked by how likely the change is to keep the check **executing**.

| Rank | Change | Why it sits here |
| --- | --- | --- |
| 1 | The last standalone number in `expect` | It falsifies the claim while the command runs exactly as it did. |
| 2 | A flipped comparison in `check` | It inverts a test that was passing. |
| 3 | The last standalone number in `check` | Last: a number in a command can name an input — a port, a width, a version — rather than a threshold, and renaming an input breaks execution, not the claim. |

The **last** match is taken because a measured value trails its label (`count=42`, `n>=5 OK cells=8`), and because the choice must be deterministic: the same claim has to yield the same plant, or two runs of the authoring step seed two different answer keys for one item.

### The identity-number defect

"Standalone" excludes a digit run glued to a word, a dot, a slash, or a hyphen.

| Not perturbed | What a bump would do |
| --- | --- |
| `python3` | Names a program that is not installed. |
| `file42.txt` | Names a file that does not exist. |
| `1.5` | Rewrites one side of a decimal into a different literal. |
| `utf-8` | Names an encoding that does not exist. |

Each of those stops the check **executing**.
The plant then measures the environment rather than the grader: it reads as caught, for a reason that has nothing to do with the seeded defect.
That is the failure this helper exists to prevent, and it is asserted directly in `src/meta-eval/plants.test.ts`.

Only unambiguous comparison tokens flip — ` -ge `/` -lt `, ` -gt `/` -le `, ` -le `/` -gt `, ` -lt `/` -ge `, ` -eq `/` -ne `, ` -ne `/` -eq `, `>=`/`<`, `<=`/`>`, `==`/`!=`, `!=`/`==`.
A bare `>` or `<` is a shell redirection, never a comparison, so flipping it would rewrite where output goes rather than what the test asks.

A number is bumped with `BigInt`, so a value wider than `Number.MAX_SAFE_INTEGER` moves by exactly one.
Bumped as a `number` it rounds back onto itself, and the plant is then a correct claim the grader is right to verify.

## What each call composes

Plants add no parallel calibration machinery.
Each piece is an existing primitive doing its own job.

| Piece | Primitive it reuses |
| --- | --- |
| The seeded item | `GoldenItem` (`src/judge-calibration.ts`). Its `humanScore` is the grade a working grader owes the item, so the mixed set feeds `calibrateJudge` unchanged. |
| The grader's output | `CandidateScore[]`, the array `calibrateJudge` and `snapshotFromSentinelSet` already read. A `PlantOutcome` is that shape with `score: null` added for "ran, declined to decide". |
| "Caught" | The join in `snapshotFromSentinelSet` (`src/meta-eval/sentinel.ts`) with the labels inverted: the grade lands on the side of `acceptThreshold` the seed demands. |
| The seal | `hashCanonical` (`src/ledger-core/canonical.ts`), the RFC 8785 digest the sealed-experiment path uses. |
| The mix order | `mulberry32` (`src/statistics/random.ts`), the package's one seedable generator. |

`src/canary.ts` is deliberately not this.
Its three detectors — silent judge fallback, calibration drift, distribution shift — all watch the judge's own statistics.
None injects an item the judge can fail.

## The four kinds

`kind` records how the item was authored wrong.
It changes nothing about how the item is graded; it exists so `byKind` can show which defect a grader is blind to.

| Kind | Authored by |
| --- | --- |
| `wrong-value` | Altering one load-bearing value: a number off by one, a comparison flipped. `plantByPerturbation` authors this kind. |
| `self-certifying` | Giving the item a check that passes without testing the claim. |
| `unreachable-input` | Pointing the check at an input that does not exist, so it cannot run at all. |
| `duplicate` | Copying an item already in the set, which is owed a duplicate flag rather than a second grade. |

## Blindness has two halves

This module owns one half.
It never puts a plant flag on a graded item: `seedPlants` returns the mixed set and a manifest, and only the manifest knows which ids are seeded.
Every item in `items` carries the same two fields, so nothing a grader receives says which are plants.

The caller owns the other half, and it is the half that decides whether the measurement means anything.

- Keep the manifest out of the workspace the graded agents can read.
  A truth label inside that tree is readable by the thing being measured.
- Publish `manifest.seal` **before** the grading run.
  A manifest edited afterwards to match the results no longer hashes to its seal, and `catchRate` refuses it with a `CaptureIntegrityError`.
- Write the plant tag into a record only after the verdict is decided, so the tag cannot reach the verdict path.

## What refuses, and why

A catch rate that cannot refuse is not a measurement.

| Condition | Result |
| --- | --- |
| A seeded plant has no result | `status: 'incomplete'`, `rate: null`, `missingIds` names them. A rate over the results that happened to come back is the number a broken run reports as success. |
| Zero plants were seeded | `status: 'not_evaluated'`, `rate: null`. Never 1.0: a grader asked nothing it could fail did not score perfectly. |
| Every seeded plant is indecisive | `status: 'not_evaluated'`, `rate: null`. No check tested the seeded defect, so nothing was measured. |
| The manifest no longer matches its seal | `CaptureIntegrityError`. |
| A result names an id the manifest never handed out, or repeats one | `ValidationError`. The results and the manifest describe different runs, and a rate across two runs is a fabrication. |
| A plant record's `expectedVerdict` disagrees with its `humanScore` | `ValidationError` at `definePlant`. The same item would read as wrong here and as correct to every instrument that joins on the id. |

## Reading the number

`rate` alone can be gamed by a grader that refuses everything: it catches every reject-plant and scores 1.0.
`unseeded` is where that shows.
It reports how the same grader treated the items that were not seeded — `n`, `decided`, `rejected`, and `rejectionRate` — using no labels at all.

- Catch rate 1.0 with `unseeded.rejectionRate` near 1.0 is a refusal reflex, not discrimination.
- Catch rate 1.0 with `unseeded.rejectionRate` near 0 is a grader that separates the two classes.

The stronger form is to seed both directions.
A plant with `expectedVerdict: 'accept'` is a known-good item authored the same way, and a grader that refuses it is scored as a miss exactly like one that certifies a known-wrong item.

## Related

- [`docs/verdicts.md`](./verdicts.md) — where every verifier in this package lands its result.
- [`docs/verification-strategies.md`](./verification-strategies.md) — certifying work that has no answer key at all.
