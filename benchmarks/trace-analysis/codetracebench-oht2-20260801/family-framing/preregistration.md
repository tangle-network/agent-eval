# Pre-registration — family-framing coverage arm, dev-pool smoke (written 2026-08-02, BEFORE any model run)

Decomposition motivating this arm: [`.evolve/family-gap-decomposition-2026-08-02.md`](../../../../.evolve/family-gap-decomposition-2026-08-02.md).
Target class: `far` + `silent` + under-enumeration, 57–58% of OpenHands/Terminus2 gold mass; measured ceiling snapFar +32.3pp (OH) / +25.4pp (T2) in the official currency.

## Arm

One change: `--instructions-file family-framing/oht2-coverage-instructions.txt` (sha256 `ecb8a207…`).
The file is the stock RLM instructions (sha256 `d3829fb8…`, byte-identical extraction from `dist/analyst`) with one coverage-and-enumeration section and two family grammar notes inserted between the task prompt and the RLM output contract.
No step-count, block-count, or width priors (shape-prior lesson: −10 to −15pp).
Engine, model, limits, seed, and repetition count are identical across arms; the instructions text is the only difference.

## Smoke instrument (TUNING-LEGAL dev pools, never cert32)

Eligibility: dev-pool rows with ≥1 gold step AND `step_count` ≥ 40 (the long-trace regime where the family gap concentrates; 72 of 464 OH rows, 34 of 188 T2 rows qualify).
Selection: `sha256("20260802" + "\0" + traj_id)` ascending, first 6 per family; committed as `smoke-labels-openhands.json` (sha256 `1b687899…`, 26 gold steps) and `smoke-labels-terminus2.json` (sha256 `f61fa566…`, 47 gold steps).
2 repetitions, seed 0, so 12 observations per family per arm; 48 total across 4 runs (2 arms x 2 families).
The stock arm runs fresh on the same cases: cert32 numbers do not transfer and the comparison is paired on caseId + repetition.

## Protocol

Strictly serial runs, glm-5.2 via z.ai direct, `--max-output-tokens 16384` (reasoning-model floor), `--concurrency 3`, `--timeout-ms 1200000`, per-run `--max-cost-usd 2.5`.
Expected spend ≈ $6 (cert2 median $0.109/observation x 48 + margin); worst case $10 by per-run caps.
The measurement mutex (`/tmp/ctb-llm-mutex.lock`) is held for the whole paid phase and released on every exit path.

## Gates (fixed now; pooled = both families' 24 observations per arm, official micro)

| Gate | Threshold |
| --- | --- |
| Primary (score) | pooled official micro F1(framing) ≥ pooled F1(stock) + 0.05 |
| Mechanism A (enumeration) | predicted blocks per positive run (framing) ≥ stock + 0.5 |
| Mechanism B (localization) | far share of gold observations (framing) ≤ stock − 10pp |
| No-harm | neither family's official micro F1 < that family's stock − 0.05 |
| Kill | pooled F1 < stock − 0.03, or >10% failed runs in either arm, or pad findings per positive run > stock x 1.6 |

Decision rule: scale to a full dev measurement only if Primary AND (Mechanism A OR Mechanism B) AND No-harm all pass.
Any kill condition stops the arm this round.
Anything in between: no further paid runs this round; the readout feeds the next diagnosis.
The smoke estimates the effect inside the long-trace labeled class; it certifies nothing, and no sealed split is touched.

## Exact commands

```bash
FF=benchmarks/trace-analysis/codetracebench-oht2-20260801/family-framing
for fam in openhands terminus2; do
  for arm in stock framing; do
    extra=""
    [ "$arm" = framing ] && extra="--instructions-file $FF/oht2-coverage-instructions.txt"
    MODEL_API_KEY="$ZAI_GLM_API_KEY" node dist/cli.js analyst-benchmark \
      --dataset codetracebench \
      --analyst dspy-rlm \
      --python clients/python/.venv/bin/python \
      --labels "$FF/smoke-labels-$fam.json" \
      --trace-dir /dev/shm/ctb-oht2-traces-$fam \
      --artifact-dir ~/bench-cache/ctb-20260801/oht2/work/$fam/extracted \
      --out ~/bench-cache/ctb-20260801/family-framing-smoke/$arm-$fam \
      --revision aa213b84ffb6690fc37ca15766d6ca174ec36d4d \
      --split devsmoke-$fam-$arm-20260802 \
      --base-url https://api.z.ai/api/coding/paas/v4 \
      --api-key-env MODEL_API_KEY \
      --model glm-5.2 \
      --limit 6 --seed 0 --concurrency 3 --repetitions 2 \
      --max-output-tokens 16384 --timeout-ms 1200000 --max-cost-usd 2.5 $extra
  done
done
```

Readout: `compare-analyst-runs.mjs` paired per family + pooled, and `decompose-analyst-loss.mjs` per family per arm for the mechanism gates.
