# Fine-tune a model on agent-eval data with Prime Intellect's `prime-rl`

End-to-end demo: take the run records from an agent-eval campaign, filter to
high-quality completions, project them into the SFT format `prime-rl` consumes,
and kick off a fine-tune run on a small open model.

This is the bridge from "we collected data while running our agents" to "we
have a fine-tuned model that's better at the task." It closes the loop the
auto-research thesis depends on.

## Honest scope

- **`prime-rl` is online async RL + SFT.** It supports GRPO/GSPO/OPO/RLOO/CISPO + SFT.
- **It does NOT support DPO or PRM trainers natively.** Online GRPO uses a live
  `verifiers.Environment`, not an offline `(prompt, completions[], rewards[])` JSONL.
- **The clean fit between agent-eval and prime-rl is SFT.** The other agent-eval
  exporters (`toDpoRows`, `toGrpoRows`, `toPrmRows`) target other trainers
  (HuggingFace TRL for DPO/PRM, custom verifiers env for offline GRPO).

This example covers the SFT path because that's what's runnable end-to-end
today. Other paths are listed under "Next steps."

## Architecture

```
agent-eval campaign
  → RunRecord[] (collected during your real eval sweeps)
  → filter to high-quality runs (rejection sampling SFT)
  → toSftRows({ promptOf, completionOf, systemOf })
  → JSONL on disk
  → prime-rl SFT trainer
  → fine-tuned checkpoint
```

The fine-tuned checkpoint becomes the new baseline model for the *next*
agent-eval campaign. Loop closed.

## Running this demo

Requirements:

- 1 NVIDIA GPU (any model that can hold Qwen3-0.6B in memory; ~4GB VRAM)
- `uv` (Python package manager)
- `prime-rl` cloned + `uv sync --all-extras`

Steps:

```bash
# 1. From this directory in agent-eval:
pnpm tsx examples/fine-tune-with-prime-rl/export-sft.ts \
  --runs ./synthetic-runs.jsonl \
  --out ./sft-data.jsonl \
  --min-score 0.7

# Output:
#   ✓ read 80 runs from synthetic-runs.jsonl
#   ✓ filtered to 32 high-quality (score ≥ 0.7) runs
#   ✓ wrote 32 SFT rows to sft-data.jsonl
#   ✓ wrote prime-rl config to prime-rl-sft.toml

# 2. Run prime-rl SFT (in a clone of prime-rl):
cd ~/code/prime-rl
uv run sft @ /path/to/agent-eval/examples/fine-tune-with-prime-rl/prime-rl-sft.toml

# Output: a checkpoint at outputs/weights/step_<N>
```

## What the example produces

`export-sft.ts` produces three artifacts:

1. **`sft-data.jsonl`** — one row per filtered run, in the messages-list format
   prime-rl's SFT trainer consumes:
   ```json
   {"messages": [{"role": "system", "content": "..."}, {"role": "user", "content": "..."}, {"role": "assistant", "content": "..."}]}
   ```
2. **`prime-rl-sft.toml`** — a 15-line config pointing at the JSONL file:
   ```toml
   max_steps = 100
   [model]
   name = "Qwen/Qwen3-0.6B"
   [data]
   name = "/abs/path/to/sft-data.jsonl"
   seq_len = 4096
   batch_size = 32
   [optim]
   lr = 2e-5
   ```
3. **A README in this dir** explaining how to swap the synthetic input for
   real campaign output.

## Adapting for your real campaign

Replace `synthetic-runs.jsonl` with the output of any real `runEvalCampaign`
or `analyzeOptimizationResult`. The script reads NDJSON of `RunRecord`s; every
record needs a `runId`, `outcome.holdoutScore`, and either:

- `outcome.raw.prompt` + `outcome.raw.completion` (if you stash the text on the record), OR
- a custom `--prompt-key` and `--completion-key` flag pointing at where the
  text lives in your run's metadata, OR
- a custom lookup callback (read the source — this is a 5-line change).

Most consumers store prompt/completion text in their `TraceStore` or raw
event log, not on the `RunRecord` directly (which only carries hashes). For
those cases, use `iterateRawCalls(rawSink)` from
`@tangle-network/agent-eval/traces` to recover the text from the raw HTTP
event log and join it back to the run records by `runId`.

## Next steps (not in this demo)

- **DPO training:** route preference triples (`extractPreferences`) through
  `toDpoRows` from `@tangle-network/agent-eval/rl` to HuggingFace TRL's
  `DPOTrainer`. Different trainer, same data pipeline.
- **GRPO training:** wrap agent-eval's `MultiLayerVerifier` as a
  `verifiers.Environment` and let prime-rl's online GRPO call into it. Larger
  integration; out of scope for this example.
- **PRM training:** route `prmTrainingPairs` to a custom PRM trainer
  (HuggingFace TRL or in-house). Out of scope here.

## Files

- `README.md` — this file.
- `export-sft.ts` — the export script (~150 LoC).
- `synthetic-runs.jsonl` — example input data; replace with your own
  campaign output.
- `prime-rl-sft.toml` — generated config; not checked in (see `.gitignore`).
