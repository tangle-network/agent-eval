# compareProposers canonical — the real proposer head-to-head

The **live** companion to the deterministic mechanism gate. The unit tests
(`tests/campaign/compare-proposers.test.ts`, run on every PR in `ci.yml`) prove
the `compareProposers` harness *ranks* correctly with a faked LLM. This example
proves the optimizers move a **real** untouched-test number on a **real** backend and
records **which proposer wins** — the artifact a case study is made of.

It runs `gepa-reflection` vs `gepa-pareto` vs `skill-opt` on one corpus
(transaction-field extraction, a **deterministic** exact-match judge → zero
LLM-judge variance), lets each optimizer adapt on a separate selection split,
scores every winner **uniformly** on the untouched test split,
and reports per-proposer lift + paired-bootstrap CIs. `assertRealBackend` aborts
on a stub (zero-token) run, so a fake `$0` lift can never be reported.

The corpus + judge + worker are shared with `substrate-lift-proof` via
[`../_shared/extraction-task.ts`](../_shared/extraction-task.ts) — one copy, so
both examples measure the same task.

## Run

Any OpenAI-compatible endpoint works:

```bash
# DeepSeek
LLM_BASE_URL=https://api.deepseek.com/v1 LLM_API_KEY=$DEEPSEEK_API_KEY \
LLM_MODEL=deepseek-chat PRICE_IN_PER_M=0.27 PRICE_OUT_PER_M=1.10 \
pnpm tsx examples/compare-proposers-canonical/index.ts

# Tangle router (default)
TANGLE_API_KEY=$(cat /tmp/.tk) pnpm tsx examples/compare-proposers-canonical/index.ts
```

Knobs: `POPULATION` / `GENERATIONS` (GEPA), `EPOCHS` (SkillOpt). The durable
artifact lands in `.evolve/compare-proposers-canonical/<ts>/lift-proposers.json`;
[`lift-proposers.json`](./lift-proposers.json) here is a checked-in reference run.

## Historical result — not valid for proposer ranking

The checked-in June 2026 artifact reused its six “holdout” scenarios for
SkillOpt edit acceptance and final proposer ranking.
Those rows prove the backend and scoring path ran, but the ranking is selection-contaminated and must not support a research claim.
Regenerate it with the current train/selection/test contract before citing a proposer comparison.

| Proposer | Contaminated lift | 95% CI | base → winner | $cost |
|---|---|---|---|---|
| #1 gepa-reflection | **+0.417** | [0.208, 0.583] | 0.583 → 1.000 | $0.0028 |
| #2 skill-opt | +0.417 | [0.208, 0.583] | 0.583 → 1.000 | $0.0035 |
| #3 gepa-pareto | +0.375 | [0.208, 0.583] | 0.583 → 0.958 | $0.0028 |

176 real calls, 16,779 in / 7,175 out tokens, $0.012, 131s.

**Honest reading:** no final proposer-comparison conclusion is licensed by this
artifact because one optimizer adapted to the final scoring rows.
The next run must report all three disjoint denominators and use only the test
rows for lift and pairwise intervals.

## Relationship to CI

- `ci.yml` (every PR): deterministic mechanism gate — no LLM, no cost.
- `empirical-gate.yml` (weekly + manual): this script against a real backend,
  permissive (never blocks ship), uploads the lift artifact. Neutral-skips when
  no `LLM_API_KEY` / `TANGLE_API_KEY` secret is set.
