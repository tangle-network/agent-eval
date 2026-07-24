# Rollout: `tangle.rollout.v1`

`@tangle-network/agent-eval/rollout` is the single owner of the `tangle.rollout.v1` training-row serialization.
One JSONL line per agent invocation, with the full transcript inline, a single scalar reward, and fail-closed split labels.
No other package may write rollout rows; domain repos (e.g. the bench swe-arena backfill) construct lines from their own joins and serialize them exclusively through this module's `writeRolloutLedger` / `appendRolloutLines`.

## Module map

| concern | file | entry points |
| --- | --- | --- |
| schema + validation | `src/rollout/schema.ts` | `RolloutLine`, `validateRolloutLine`, `assertRolloutLine`, `isTrainableSplit` |
| ledger file API | `src/rollout/ledger.ts` | `writeRolloutLedger`, `appendRolloutLines`, `readRolloutLedger` |
| minting from records | `src/rollout/mint.ts` | `mintRolloutRows(records, traceStore)`: RunRecord joined to trace via shared `runId` |
| harness-store intake | `src/rollout/readers/` | `openOpencodeDb` + `readOpencodeSessionMessages` (opencode sqlite), `findClaudeTranscripts` + `readClaudeTranscript` (Claude Code project jsonl) |
| exporters | `src/rollout/exporters.ts` | `toSftRows`, `toRewardRows`, `toVerifiersRolloutOutputs` (Prime Intellect), `toRftItems` (OpenAI RFT), `toJsonl` |
| release pipeline | `src/rollout/release/` | `scrubLines` (9 deterministic rules), `buildDatasetCard`, `buildHfDataset`, CLI `agent-eval rollout-release … [--push org/name]` |

## Schema decision table

The schema reconciles two prior producers: agent-eval's RunRecord-joined rollout rows (PR #410) and the bench rollout-ledger (agent-runtime PR #591).
Rule applied: where fields conflicted, RunRecord-derived semantics won; the ledger's wire shape (snake_case, sectioned) is the serialization.

| field | from | decision |
| --- | --- | --- |
| `schema: "tangle.rollout.v1"` | ledger | wire key is `schema` (PR #410's `format` key retired) |
| `rollout_id` / `parent_rollout_id` | ledger | minted lines use `runId` as `rollout_id` (deterministic); multi-agent producers mint UUIDs and point workers at their supervisor |
| `run_id` | both | `RunRecord.runId` |
| `experiment_id`, `candidate_id` | PR #410 | added to the wire (nullable, optional-on-read for pre-unification ledgers) |
| `generation`, `candidate_index` | ledger | kept as improvement-loop coordinates; now `integer \| null` (`null` = not an improvement loop, `-1` = baseline) |
| `role` | ledger | enum extended with `agent` for solo eval runs (mint default) |
| `task.split` | conflict | **RunRecord semantics win**: canonical trainable value is `search` (the optimizer-readable pool); `dev`/`holdout` as in `RunSplitTag`; ledger's `canary` kept; ledger's `train` validates as a legacy alias of `search` and counts as trainable, but new producers emit `search` |
| `task.seed`, `task.rep` | ledger | seed from `RunRecord.seed`; rep 0 for minted solo runs |
| `policy.*` | ledger | + `prompt_hash`, `config_hash`, `agent_profile_cell_id` from PR #410's RunRecord provenance |
| `messages` | ledger | canonical OpenAI chat-with-tools incl. `reasoning_content`; minted lines inline the final llm span's conversation |
| `steps` | PR #410 | optional trace-span projections (llm/tool), absent on harness-store-derived lines |
| `outcome.reward` | conflict | **merged**: `number \| null`; `null` means no verdict exists (a labeled gap, never 0); minted lines always carry a number (`holdoutScore ?? searchScore ?? 0`), forced to 0 when realness-gated |
| `outcome.realness_gated` | PR #410 | added (optional-on-read, absent = false); the anti-Goodhart gate travels into the data and SFT export refuses gated lines |
| `outcome.reward_source` / `verdict` / `metrics` / `is_completed` / `is_truncated` / `error` | ledger | unchanged; mint fills `metrics` from `RunRecord.outcome.raw` |
| `cost.*` | ledger | superset of PR #410's costUsd/totalTokens; `cost.usd` is `null` when `costProvenance.kind === 'uncaptured'` (never a fake 0) |
| `artifacts.*`, `provenance.*` | ledger | `provenance.capture` gains `mint` alongside `settle-time` / `backfill` |
| gap discipline | ledger | records without trace spans become labeled gap lines (`messages: []`, `provenance.gap`) AND are listed in `missingTraces`; PR #410's silent skip retired |

## Export filters (fail-closed)

- SFT: `reward ≥ 1` (configurable) ∧ not realness-gated ∧ trainable split ∧ non-empty transcript. Rows are `{messages, metadata}`.
- Reward rows: every line with a non-null reward, failures included; unlabeled lines excluded (a gap is not a zero).
- Verifiers / RFT: transcript-bearing lines only; RFT additionally requires prompt turns before the first assistant turn.
- Release (`rollout-release`): trainable split only; proposer lines dropped unless `--include-proposers`; every string value scrubbed by the 9 deterministic rules (idempotent, so a second pass counts zero); `--push` requires `huggingface-cli` + `HF_TOKEN` and never prints the token.
