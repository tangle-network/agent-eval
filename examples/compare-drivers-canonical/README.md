# compareProposers canonical — the real proposer head-to-head

The **live** companion to the deterministic mechanism gate. The unit tests
(`tests/campaign/compare-drivers.test.ts`, run on every PR in `ci.yml`) prove
the `compareProposers` harness *ranks* correctly with a faked LLM. This example
proves the optimizers move a **real** held-out number on a **real** backend and
records **which proposer wins** — the artifact a case study is made of.

It runs `gepa-reflection` vs `gepa-pareto` vs `skill-opt` on one corpus
(transaction-field extraction, a **deterministic** exact-match judge → zero
LLM-judge variance), scores every winner **uniformly** on the held-out split,
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
pnpm tsx examples/compare-drivers-canonical/index.ts

# Tangle router (default)
TANGLE_API_KEY=$(cat /tmp/.tk) pnpm tsx examples/compare-drivers-canonical/index.ts
```

Knobs: `POPULATION` / `GENERATIONS` (GEPA), `EPOCHS` (SkillOpt). The durable
artifact lands in `.evolve/compare-drivers-canonical/<ts>/lift-drivers.json`;
[`lift-drivers.json`](./lift-drivers.json) here is a checked-in reference run.

## First real result (deepseek-chat, n=6 held-out, integrity `real`)

| Driver | Held-out lift | 95% CI | base → winner | $cost |
|---|---|---|---|---|
| #1 gepa-reflection | **+0.417** | [0.208, 0.583] | 0.583 → 1.000 | $0.0028 |
| #2 skill-opt | +0.417 | [0.208, 0.583] | 0.583 → 1.000 | $0.0035 |
| #3 gepa-pareto | +0.375 | [0.208, 0.583] | 0.583 → 0.958 | $0.0028 |

176 real calls, 16,779 in / 7,175 out tokens, $0.012, 131s.

**Honest reading:** all three drivers produce a **statistically-clear** real
lift (CI low = 0.208 > 0 → `lift-proven`), but they are **tied with each
other** — this task saturates to the ceiling, so it can't separate the
optimizers. To differentiate GEPA from SkillOpt you need a harder corpus with
more headroom (a product persona suite is the next target). The instrument is
proven; the separation experiment is the follow-on.

## Relationship to CI

- `ci.yml` (every PR): deterministic mechanism gate — no LLM, no cost.
- `empirical-gate.yml` (weekly + manual): this script against a real backend,
  permissive (never blocks ship), uploads the lift artifact. Neutral-skips when
  no `LLM_API_KEY` / `TANGLE_API_KEY` secret is set.
