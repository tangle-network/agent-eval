# CodeTraceBench GLM-5.2 Run

This directory records three real-model runs on the same 32 public CodeTraceBench trajectories.

- [`result.json`](./result.json) is Agent Eval with final test artifacts.
- [`fair-result.json`](./fair-result.json) is Agent Eval with trajectories only.
- [`codetracer-result.json`](./codetracer-result.json) is CodeTracer with trajectories only and memory disabled.
- [`verification.json`](./verification.json) records input, source, result, resume, cost, and secret-scan hashes.

The result is useful but not strong.
Agent Eval accounted for every provider call and beat this CodeTracer run on the published metric, but all three arms had low precision, weak repeatability, and frequent false positives on solved trajectories.

**Implementation provenance.**
These numbers were produced by the retired one-shot direct runner at implementation SHA-256 `4dba263b6256a30d56c7fdb2d992d3a953c0035d731f359b704db806f68f75ac` (the value recorded in every artifact here).
The current Agent Eval analyst is a recursive DSPy RLM engine with a different implementation digest; the reproduce commands below therefore run a different analyst and will produce different numbers.
These results describe only the retired runner, and no number here may be cited for the current engine until a fresh certified run replaces this directory.

## Inputs

| Field | Value |
| --- | --- |
| Date | 2026-07-30 |
| Dataset | [`NJU-LINK/CodeTraceBench`](https://huggingface.co/datasets/NJU-LINK/CodeTraceBench) |
| Dataset revision | `aa213b84ffb6690fc37ca15766d6ca174ec36d4d` |
| Cases | 16 labeled positive, 8 solved label-empty, 8 failed label-empty |
| Trajectory steps | 935 |
| OTLP spans | 1,897 |
| Analyst model | `glm-5.2` |
| Repetitions | 2 |
| Agent Eval source files | 61 |
| Agent Eval source SHA-256 | `4dba263b6256a30d56c7fdb2d992d3a953c0035d731f359b704db806f68f75ac` |
| Dependency lock SHA-256 | `1e03f2daed356d60316aabefb407ec1e437ac94d408d61eea4ae096e9c6fbb5b` |
| CodeTracer revision | `2d302191dd07e7c0c2da6f7a5e9451c7cbb62d34` |

The 32 rows are every pinned mini-SWE trajectory supported by CodeTracer's normalizer in this dataset snapshot.
They are not a representative sample of all 1,000 verified CodeTraceBench trajectories.

## Results

| Measure | Agent Eval + tests | Agent Eval trajectory only | CodeTracer trajectory only |
| --- | ---: | ---: | ---: |
| Valid runs | 63/64 | 62/64 | 61/64 |
| Published all-row F1 | 13.47% | 15.02% | 11.61% |
| Matched / expected bad steps | 45/110 | 44/110 | 38/110 |
| Predicted steps on scored rows | 165 | 174 | 166 |
| Scored precision / recall / F1 | 27.27% / 40.91% / 32.73% | 25.29% / 40.00% / 30.99% | 22.89% / 34.55% / 27.54% |
| Solved false positives | 14/15 completed | 15/16 | 12/14 completed |
| Failed label-empty predictions | 16/16 | 14/16 | 13/15 completed |
| Repeat prediction agreement | 46.59% | 48.55% | 47.34% |
| Model calls | 64 | 64 | 933 known, 1 run unknown |
| Uncached input tokens | 1,972 | 2,542 | 10,437,890 |
| Cached input tokens | 1,843,200 | 1,766,912 | not reported |
| Output tokens | 46,072 | 45,797 | 458,006 |
| Latency p50 / p95 / max | 11.87 / 19.92 / 27.15 s | 11.22 / 22.68 / 29.68 s | 92.10 / 408.07 / 600.00 s |
| Same-rate estimated cost | $1.208462 | $1.162426 | $7.270347 over 63 known runs |

CodeTracer also reported $63.6392 using its own model-price configuration.
That estimate is not comparable to the Agent Eval estimates, so the table reprices its reported tokens at the same GLM rates used by Agent Eval.
One CodeTracer timeout has unknown calls, tokens, and cost.

Final test artifacts did not produce a clear quality gain over the trajectory-only Agent Eval arm.
The arms were separate stochastic runs with two repetitions, so the 1.55 percentage-point F1 difference favoring the trajectory-only arm is not a causal estimate.

## Reproduce

Prepare the pinned archives with CodeTracer's own normalizer:

```bash
uv run \
  --with 'git+https://github.com/NJU-LINK/CodeTracer.git@2d302191dd07e7c0c2da6f7a5e9451c7cbb62d34' \
  benchmarks/trace-analysis/codetracebench-glm52-20260730/prepare.py \
  --labels benchmarks/trace-analysis/codetracebench-glm52-20260730/input-labels.json \
  --out "$PREPARED"
```

Convert the native trajectories with the released traces importer:

```bash
npx --yes @tangle-network/traces@0.9.19 import-codetracebench \
  benchmarks/trace-analysis/codetracebench-glm52-20260730/input-labels.json \
  --trajectory-dir "$PREPARED/normalized" \
  --out "$TRACES" \
  --revision aa213b84ffb6690fc37ca15766d6ca174ec36d4d \
  --concurrency 8
```

Check every trace and final-test artifact before a paid run:

```bash
node scripts/verify-codetracebench-reference-input.mjs \
  --trace-dir "$TRACES" \
  --artifact-dir "$PREPARED/extracted"
```

Run Agent Eval:

```bash
agent-eval analyst-benchmark \
  --dataset codetracebench \
  --labels benchmarks/trace-analysis/codetracebench-glm52-20260730/input-labels.json \
  --trace-dir "$TRACES" \
  --artifact-dir "$PREPARED/extracted" \
  --out "$OUTPUT" \
  --revision aa213b84ffb6690fc37ca15766d6ca174ec36d4d \
  --split verified-miniswe-normalizer-compatible-32 \
  --base-url "$OPENAI_COMPATIBLE_BASE_URL" \
  --api-key-env MODEL_API_KEY \
  --model glm-5.2 \
  --limit 32 \
  --seed 0 \
  --concurrency 5 \
  --repetitions 2 \
  --max-output-tokens 2048 \
  --timeout-ms 120000 \
  --max-cost-usd 1.5
```

Point `--artifact-dir` at an empty directory for the trajectory-only arm.
Use `--resume` with the same arguments to continue an interrupted run.

Run the pinned CodeTracer checkout with isolated configuration and memory disabled:

```bash
export CODETRACER_API_KEY="$MODEL_API_KEY"
export CODETRACER_API_BASE="$OPENAI_COMPATIBLE_BASE_URL"
benchmarks/trace-analysis/codetracebench-glm52-20260730/run-codetracer.sh \
  benchmarks/trace-analysis/codetracebench-glm52-20260730/input-labels.json \
  "$PREPARED/normalized" \
  "$CODETRACER_BIN" \
  "$CODETRACER_OUTPUT"
```

Reduce a CodeTracer run through Agent Eval's existing CodeTracer adapter and scoring code:

```bash
node benchmarks/trace-analysis/codetracebench-glm52-20260730/summarize-codetracer.mjs \
  --labels benchmarks/trace-analysis/codetracebench-glm52-20260730/input-labels.json \
  --run-dir "$CODETRACER_OUTPUT" \
  --revision 2d302191dd07e7c0c2da6f7a5e9451c7cbb62d34 \
  --output "$CODETRACER_RESULT"
```

## Limits

- CodeTraceBench labels incorrect steps, not complete root-cause explanations.
- Failed label-empty rows are unlabeled and excluded from precision.
- Two repetitions expose instability but do not estimate the full output distribution.
- CodeTracer and Agent Eval use different control policies.
- Provider cache telemetry was available for Agent Eval and unavailable for CodeTracer.
- The committed results prove these runs, not general superiority over CodeTracer or other trace-analysis systems.
