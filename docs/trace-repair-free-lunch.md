# What unconditional continuation rescues

TB-Repair's admission condition 3 asks whether a row is rescued by continuing from the recorded end state with no intervention.
Both milestone runs answered it under a control pinned to **zero model calls**.
A rollout that makes no model call executes no command, so the container the control graded held the same bytes the end-state check had already graded as failing: on the 32 rows measured here that control returned **0 passes in 96 rollouts**, the only answer it could return.

This is the same question asked with a budget.

Source: [`scripts/tb-repair-freelunch.ts`](../scripts/tb-repair-freelunch.ts).
The control contract is in [trace-repair-admission.md](./trace-repair-admission.md); the policy is in [trace-repair-continuation.md](./trace-repair-continuation.md).

## The answer

**3 of 64 rollouts, 4.7 %.** Two of 32 rows were rescued at least once, 6.2 %.

The 64 rollouts are not 64 independent draws.
A seed-derivation defect (threat 8) made the second pass repeat the first pass's seed, and 14 of the 32 second-pass rollouts are byte-identical action repeats of their first-pass rollout.
Over the 50 distinct rollouts the rate is **3 of 50, 6.0 %**.
All three rescues come from pairs whose two rollouts differ, so no rescue is a repeat counted twice.

| interval, 95 % | rescue rate |
| --- | --- |
| task-clustered bootstrap (3 clusters, 10 000 resamples, seed 7) | 0.0 % – 10.0 % |
| row-clustered bootstrap (32 clusters) | 0.0 % – 12.5 % |
| exact Clopper-Pearson on rollouts | 1.0 % – 13.1 % |

Three clusters cannot carry a stable interval; the row-clustered and exact intervals are reported beside it for that reason.

**The rate is not zero, and it is not noise.** One row, `count-dataset-tokens__HL3ZzrX`, was rescued in **both** of its rollouts on a suite that returned the same verdict in all 16 certification replicates.

## What a rescue looked like

`count-dataset-tokens__HL3ZzrX`, 13 steps, submitted. The recorded agent had computed the right answer and written it in a form the grader rejected. The continuation recomputed the count offline, then found and removed the formatting defect:

```
10. cat /app/answer.txt
11. printf '%s' "$(cat /app/answer.txt)" > /app/answer.txt && cat /app/answer.txt | xxd | head -5
12. printf '%s' "$(cat /app/answer.txt)" > /app/answer.txt && od -c /app/answer.txt
13. echo COMPLETE_TASK_AND_SUBMIT_FINAL_OUTPUT
```

`password-recovery__oDL7kv9`, 19 steps, submitted, rescued in 1 of 2 rollouts. This one is not a formatting fix — it is the task being solved: the continuation searched the disk image, hexdumped it, carved an embedded archive, and wrote the recovered password.

## By task, and the asymmetry that explains it

| task | rows | rollouts | passes | rate | recorded steps that used the network |
| --- | --- | --- | --- | --- | --- |
| `count-dataset-tokens` | 10 | 20 | 2 | 10.0 % | 24.3 % |
| `password-recovery` | 6 | 12 | 1 | 8.3 % | 0 % |
| `sanitize-git-repo` | 16 | 32 | 0 | 0 % | 0 % |

The pinned policy disables the network the recorded agents had. Measured on the continuations' own actions, `count-dataset-tokens` rollouts spent **30.2 % of their steps reaching for a network that was not there** (114 of 377), against 0.8 % for `sanitize-git-repo` and 0 % for `password-recovery`.
`password-recovery` is the clean sub-population: its recordings never used the network, so its 8.3 % is unconfounded by the policy.

## By exit status

| exit status | rollouts | passes | rate |
| --- | --- | --- | --- |
| `submitted` | 15 | 3 | 20.0 % |
| `step-budget-exhausted` | 46 | 0 | 0 % |
| `model-error` | 3 | 0 | 0 % |

Every rescue came from a rollout that decided it was finished. No rollout that burned all 20 steps ever passed.
The three `model-error` rollouts were ended by provider 503s after four retries; they are recorded and graded, never dropped, so the rate is a lower bound by at most those three.

## What it cost

64 rollouts, priced from the token counts the provider reported for this run's own calls at the router's published `glm-5.2` rate.

| quantity | min | median | p90 | max | sum |
| --- | --- | --- | --- | --- | --- |
| prompt tokens | 15 146 | 170 939 | 260 088 | 321 288 | 10 734 764 |
| completion tokens | 151 | 6 663 | 14 961 | 23 866 | 546 346 |
| continuation steps | 1 | 20 | 20 | 20 | 1 143 |
| cost, USD | 0.0138 | 0.1506 | 0.2281 | 0.2821 | **9.4806** |

**$0.1481 per rollout, $0.2963 per row at n = 2.** A paired study can budget-match against those two numbers directly.

Cost is attributed per call, not from the router's account counter: `GET /v1/credits` covers the whole key, and 18 other processes on this host were calling it during the run. The counter's delta over the two passes was $8.60, which is neither this run's cost nor an upper bound on it once other traffic is in both directions.

## What the number means

A **high** rate would have meant unconditional continuation captures most of the available headroom, killing the gated-stop thesis. It did not.

A **low but non-zero** rate means the headroom exists and a gate could claim it — which licenses a paired study without proving it. That is where this lands, with two qualifications that matter more than the point estimate:

- The rescues are **not free**. Each cost $0.148 and up to 20 model calls. A gate that fires on every failed row pays that on every row.
- **Condition 3 is now calibrated.** It has a real screen rate to compare against: 4.7 % of rollouts and 6.2 % of rows, against the 0 % a zero-step control was structurally obliged to report.

## Threats

1. **Reconstructed assistant messages.** The corpus stores each recorded assistant turn as an elided placeholder, so the continuation inherits the bash block without the reasoning that produced it.
2. **Network asymmetry.** The recorded agents had internet; the pinned policy does not. On `count-dataset-tokens` that consumed 30.2 % of continuation steps, so the overall rate is a lower bound for a networked continuation.
3. **Three clusters.** A task-clustered interval over three tasks is coarse by construction.
4. **One model, `glm-5.2` at temperature 0.** Not a statement about continuation in general.
5. **n = 2.** Within-row variance is measured on two draws. One row rescued twice, one rescued once of two.
6. **Wall-time is not clean.** For part of the first pass the measurement seat was not held, because a killed sibling wrapper's exit trap removed a lock it no longer owned. Verdicts and token counts are unaffected; latency and throughput are not clean.
7. **Snapshot boundary.** State moves between container generations as a committed image, so a process the recording left running does not survive.
8. **The two passes shared one seed.** Each pass called `runContinuation` with `rollouts: 1`, and the seed derived from that call's internal index, which is always 0. Shifting `ROLLOUT_BASE` therefore never reached the seed, and both passes sent the provider the index-0 seed on an identical prompt. Measured on the records: 14 of 32 row pairs are byte-identical action sequences, and 31 of 32 share their first action. The runner now forwards the pass's base index through `rolloutBase`, so a future pass draws its own seed.

## Reproducing

```bash
# containers only, no model calls, no seat needed
npx tsx scripts/tb-repair-freelunch.ts --stop-points-only

# one uniform pass over every row, under the measurement seat
TBR_FL_ROLLOUTS=1 TBR_FL_ROLLOUT_BASE=0 TBR_FL_OUT=freelunch-pass1.json \
  npx tsx scripts/tb-repair-freelunch.ts
```

`--plan` prints the denominator chain and the selected rows without opening a container.
The pre-registration, its amendments, and the raw per-rollout records are in `~/bench-cache/freelunch-20260810/`.

## The raw records stay local

`freelunch.json` holds every continuation's actions and observations, which are container state. GitHub push protection refused an earlier commit of it because a container carried a **Hugging Face user access token** in its cached credentials, at `free-lunch-n2.json:1883`.

Raw per-rollout records are therefore kept out of the repository. What is committed is the runner, this report, and the numbers derived from the records. Anyone re-running the campaign should treat the artifact directory as credential-bearing.
