# Package graded runs into a publishable RL dataset

End-to-end demo: take the `RunRecord`s from a graded agent-eval campaign and
package them into a dataset someone can **publish or buy**: the trainer JSONL
plus a manifest and a datasheet.

This is the step *after* [`../fine-tune-with-prime-rl`](../fine-tune-with-prime-rl).
That example projects runs into a single SFT file you train on yourself. This
one emits the whole artifact: GRPO + SFT JSONL, a `manifest.json`, and a
"Datasheet for Datasets" card. The datasheet is the difference between a folder
of JSONL and a dataset a buyer will trust.

## What `buildRlDataset` adds over the raw exporters

The format exporters (`toGrpoRows` / `toSftRows` / `toDpoRows`) produce
trainer-ready shapes. `buildRlDataset` composes them and attaches the
provenance a buyer checks first:

- **Reward source.** `deterministic` means a test, schema, or XPath check decided the reward.
  `probabilistic` means a model-based judge decided it.
  The generated card records this distinction for downstream users.
- **Split discipline.** Record counts per `search` / `dev` / `holdout`. A
  publishable dataset must declare its holdout.
- **Reward distribution, models, prompt/agent versions, commits, tokens, cost.**
  Everything a downstream consumer needs to reproduce or audit the data.
- **License + intended/out-of-scope/limitations.** An unlicensed dataset can't
  be sold; `buildRlDataset` requires the license field.

It fails loud on an empty corpus and on `format: 'dpo'` without preference
triples: an empty or malformed dataset must never be packaged silently.

## Run it

The fixture `taxcalc-runs.jsonl` is **three real graded runs** from the
[TaxCalcBench](https://github.com/column-tax/tax-calc-bench) benchmark: our
agent prepared a US Form 1040 for three synthetic taxpayers, and the
deterministic XPath line-match scored each `1.0` (every 1040 line matched
ground truth). Each record carries the prompt it saw and the 1040 it produced.

```sh
pnpm tsx examples/publish-rl-dataset/build-dataset.ts \
  --runs examples/publish-rl-dataset/taxcalc-runs.jsonl \
  --out ./bundle \
  --name tax-1040-rl --version 0.1.0 --domain tax-1040-ty24 \
  --license "Tangle Commercial" \
  --reward-kind deterministic \
  --reward-source "TaxCalcBench XPath line-match" \
  --reward-desc "fraction of 1040 lines matching ground truth"
```

You get `./bundle/{train.grpo.jsonl, train.sft.jsonl, manifest.json, DATASHEET.md}`.

## Capturing the trajectory text

The exporters resolve prompt/completion text by `runId` through the
`{promptOf, completionOf}` lookups. Records must therefore carry that text. The
two common ways to supply it:

1. **Top-level fields** (what this example reads, via `--prompt-key` /
   `--completion-key`). The TaxCalcBench runner persists `prompt` + `completion`
   directly on each record.
2. **A `TraceStore`.** Real campaigns usually store the message trajectory in a
   trace and recover it with `iterateRawCalls`. That's a ~5-line swap of the two
   lookup functions in `build-dataset.ts`.

If a record is missing its text the script throws rather than ship an empty
completion into a paid dataset.

## Honest scope

- The fixture is **holdout-only** (`holdout: 3`) because the three funded cases
  were holdout-graded.
  The generated datasheet reports the split represented by the input records.
- Reward here is **deterministic** (TaxCalcBench line-match). For domains with
  no objective scorer (e.g. open-ended writing), reward is `probabilistic` and
  the card says so: buyers should price that difference in.

## Token rendering (downstream)

For byte-faithful RL/SFT, tokenize the emitted `messages` / `completions` with
the per-model renderer (DeepSeek-V3 / Kimi-K2 / Qwen3) so token identity and
per-token loss masks survive across tool-call turns: see
[`renderers`](https://github.com/PrimeIntellect-ai/renderers). For online
GRPO/GSPO rollouts against a live policy, express the scorer as a
[`verifiers`](https://github.com/willccbb/verifiers) `Environment` instead of
exporting offline JSONL.
