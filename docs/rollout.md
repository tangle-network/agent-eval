# Rollout: `tangle.rollout.v1`

`@tangle-network/agent-eval/rollout` is the single owner of the `tangle.rollout.v1` training-row serialization.
One JSONL line per agent invocation, with the full transcript inline, a single scalar reward, and fail-closed split labels.
No other package may write rollout rows; domain repos (e.g. the bench swe-arena backfill) construct lines from their own joins and serialize them exclusively through this module's `writeRolloutLedger` / `appendRolloutLines`.

## The hourglass: sources → waist → sinks

Many producers, one waist, many consumers.
Every invariant is enforced once, at the waist, so no sink can be reached by a path that skips it.

```
SOURCES                      WAIST                         SINKS
RunRecord × trace   ─┐                          ┌─→ SFT chat JSONL        (toSftRows)
opencode sqlite     ─┤                          ├─→ reward rows           (toRewardRows)
Claude Code jsonl   ─┼─→  tangle.rollout.v1 ────┼─→ Prime Intellect       (toVerifiersRolloutOutputs)
domain backfills    ─┤     (RolloutLine)        ├─→ OpenAI RFT            (toRftItems)
Harbor ATIF import  ─┘                          ├─→ DPO / GRPO / PRM       (rl exporters)
                                                ├─→ HF dataset release    (buildHfDataset)
                                                └─→ Harbor ATIF export    (toHarborTrajectory)
```

A source's job is to produce a `RolloutLine` and nothing else.
A sink's job is to consume `MintedRolloutLine[]` and nothing else — no sink reads a `RunRecord` or a `TraceStore`, because that would be a second door into training data with no gate on it.

`MintedRolloutLine` is `RolloutLine` plus a nominal brand (a phantom `unique symbol`, absent at runtime, so the JSON is unchanged).
The distinction matters because `RolloutLine` is structural: any object literal of the right shape is one, so declaring `{reward: 0.95, realness_gated: true}` was enough to be accepted by every exporter that "only takes a line".
Three producers mint the brand, and nothing else can:

| producer | how the invariant is established |
| --- | --- |
| `mintRolloutRows` | applies the gate (`trainingReward`) and validates the line it built |
| `readRolloutLedger` | validates every line off disk, then normalizes `realness_gated` to an explicit boolean |
| `assertMinted` / `assertMintedLines` | the explicit escape hatch for a hand-built or reconstructed line — grep it to enumerate every such site |

Readers, analysis, the ledger writer and the Harbor interchange keep taking the plain `RolloutLine`.

Where each invariant lives:

| invariant | enforced at | mechanism |
| --- | --- | --- |
| realness gate (anti-Goodhart) | `validateRolloutLine` (runtime) + the `MintedRolloutLine` brand (compile time) | `reward > 0` together with `realness_gated: true` is an INVALID line: it cannot be written to a ledger, read from one, minted, or handed to an exporter. Mint forces the reward to 0; `toSftRows` additionally refuses gated lines |
| every guard applies every check | `src/rollout/gate-checks.ts` | `GATE_CHECKS` is the one list of gate checks, and each of the four entry points (`validateRolloutLine`, `assertMinted`, `assertRewardGate`, `assertGateReport`) declares a TOTAL `GatePolicy` over it. Adding a check makes every policy a type error until it is wired, an entry point that skips one must write the reason in `omittedBecause(...)`, and each check's `tripwire` is fed to every entry point that claims to enforce it. Four rounds of leaks were all the same defect — a guard composing its checks by hand |
| never-screened ≠ screened-clean | `assertMinted` + `RealnessLabels` on every emitted row | `realness_gated: false` is the screen's VERDICT, so a producer with no screen was claiming "we looked and nothing fired". `realness_screened` separates the claims (`true` ran / `false` declared absent / `null` not stated) and travels beside `realness_gated` on every exported row shape. `assertMinted` refuses a positive reward carrying `realness_screened: false`; supervision-journal rows stay writable and readable, only promotion into training is closed |
| a line-less artifact names ONE invocation | `admitUngatedByInvocation` | `PreferenceTriple` / `PrmTrainingTriple` / `StepReward` carry run ids, and many invocations share a `run_id`. References resolve against `rollout_id` first and fall back to `run_id` only when that run holds exactly one invocation; an ambiguous reference DROPS the item and announces the count, a missing one throws. Keying on `run_id` alone was last-wins, which made the gate depend on array order |
| no hand-rolled score derivation | `src/rollout/score-derivation-guard.ts`, asserted by `reward-invariant.test.ts` | an AST walk over `src/**` flags every READ of `outcome.holdoutScore` / `outcome.searchScore` outside a counted allowlist. It replaced a line regex that seven ordinary reformattings walked past |
| split fail-closed | `isTrainableSplit` at every training sink | only `search` ships by default; held-out data requires explicit consent, while `dev` and `canary` never train |
| unlabeled ≠ zero | schema | `outcome.reward: null` is a labeled gap; reward-row and SFT exporters drop null, they never coerce it to 0 |
| unmeasured ≠ zero, at the record door | mint | `mintRolloutRows` throws a `ValidationError` naming the run and EVERY field the line is built from that the record does not carry: `costProvenance`, `tokenUsage` (+ `.input` / `.output`), `outcome` (+ `.raw`), `terminalOutcome`, `scenarioId`. The first, third and fifth were OPTIONAL through 0.125, so a ledger written then is full of records the TYPE calls complete. Absent provenance used to mint `cost.usd: 0` — the documented uncaptured sentinel published as a measurement — and an absent `terminalOutcome` or `outcome.raw` still minted a claim about a run nobody observed. The door refuses rather than normalising, because `is_completed` has no null to fall back to and only the producer knows whether `costUsd: 0` meant free or unbilled. `unmintableReasons(record)` reports the same list without throwing |
| capture gap is a finding | mint | records without spans become `messages: []` lines with `provenance.gap` AND are listed in `missingTraces` |
| scrub | release pipeline | `scrubLines` applies the 9 deterministic rules to every string before publication |

## Module map

| concern | file | entry points |
| --- | --- | --- |
| schema + validation | `src/rollout/schema.ts` | `RolloutLine`, `validateRolloutLine`, `assertRolloutLine`, `isTrainableSplit` |
| the gate checks themselves | `src/rollout/gate-checks.ts` | `GATE_CHECK_IDS`, `GATE_CHECKS`, `GATE_POLICIES`, `gateErrors(subject, policy)` — the one list every entry point draws from. The subject is the LINE (`{outcome, steps}`), not the outcome alone: a per-step reward is training signal and lives outside `outcome`. `readReward` / `payloadIsPopulated` are the total readers every check narrows through, so a value the gate cannot classify is refused rather than read as clean |
| ledger file API | `src/rollout/ledger.ts` | `writeRolloutLedger`, `appendRolloutLines`, `readRolloutLedger` |
| minting from records | `src/rollout/mint.ts` | `mintRolloutRows(records, traceStore)`: RunRecord joined to trace via shared `runId`. `unmintableReasons(record)`: the same door's refusals, reported without throwing |
| harness-store intake | `src/rollout/readers/` | `openOpencodeDb` + `readOpencodeSessionMessages` (opencode sqlite), `findClaudeTranscripts` + `readClaudeTranscript` (Claude Code project jsonl) |
| interchange | `src/rollout/interchange/harbor.ts` | `toHarborTrajectory` / `toHarborTrajectories` / `fromHarborTrajectory` / `relabelImportedSplit` (Harbor ATIF-v1.7); all root-exported as well as on the `/rollout` subpath |
| exporters | `src/rollout/exporters.ts` | `toSftRows`, `toRewardRows`, `toVerifiersRolloutOutputs` (Prime Intellect), `toRftItems` (OpenAI RFT), `toJsonl` |
| RL exporters | `src/rl/exporters.ts` | `toDpoRows`, `toGrpoRows`, `toSftRows`, `toPrmRows`; all training inputs are `MintedRolloutLine[]` or line-referenced artifacts with explicit line context |
| release pipeline | `src/rollout/release/` | `scrubLines` (9 deterministic rules), `buildDatasetCard`, `buildHfDataset`, CLI `agent-eval rollout-release … [--push org/name]` |

## Schema decision table

The schema reconciles two prior producers: agent-eval's RunRecord-joined rollout rows (PR #410) and the bench rollout-ledger (agent-runtime PR #591).
Rule applied: where fields conflicted, RunRecord-derived semantics won; the ledger's wire shape (snake_case, sectioned) is the serialization.

| field | from | decision |
| --- | --- | --- |
| `schema: "tangle.rollout.v1"` | ledger | wire key is `schema` (PR #410's `format` key retired) |
| `rollout_id` / `parent_rollout_id` | ledger | minted lines use `runId` as `rollout_id` (deterministic); multi-agent producers mint UUIDs and point workers at their supervisor |
| `run_id` | both | `RunRecord.runId` |
| `experiment_id`, `candidate_id` | PR #410 | required keys; `null` means the producer did not record the value |
| `generation`, `candidate_index` | ledger | kept as improvement-loop coordinates; now `integer \| null` (`null` = not an improvement loop, `-1` = baseline) |
| `role` | ledger | enum extended with `agent` for solo eval runs (mint default) |
| `task.split` | conflict | **RunRecord semantics win**: `search` is the trainable pool; `dev` and `holdout` follow `RunSplitTag`; `canary` is retained for release checks |
| `task.seed`, `task.rep` | ledger | seed from `RunRecord.seed`; rep 0 for minted solo runs |
| `policy.*` | ledger | + `prompt_hash`, `config_hash`, `agent_profile_cell_id` from PR #410's RunRecord provenance |
| `messages` | ledger | canonical OpenAI chat-with-tools incl. `reasoning_content`; minted lines inline the final llm span's conversation |
| `steps` | PR #410 | optional trace-span projections (llm/tool), absent on harness-store-derived lines |
| `outcome.reward` | conflict | **merged**: `number \| null`; `null` means no verdict exists (a labeled gap, never 0 — interchange imports and unverdicted ledger lines carry it); minting requires an explicit RunRecord task score and rejects execution-only records instead of labeling them 0; realness-gated scores are forced to 0 |
| `outcome.realness_gated` | PR #410 | required boolean; the anti-Goodhart gate travels into the data, the validator refuses it beside a positive reward, and SFT export refuses gated lines outright. `outcome.realness_screened` rides beside it (optional tri-state) so a screened-clean reward is distinguishable from a never-screened one |
| `outcome.reward_source` / `verdict` / `metrics` | ledger | unchanged; mint fills `metrics` from `RunRecord.outcome.raw` |
| `outcome.is_completed` / `is_truncated` / `error` | conflict | mint derives terminal fields from the required `RunRecord.terminalOutcome`; producers use the explicit `unknown` value when terminal evidence is unavailable |
| `cost.*` | ledger | superset of PR #410's costUsd/totalTokens; `cost.usd` is `null` when `costProvenance.kind === 'uncaptured'` (never a fake 0) |
| `artifacts.*`, `provenance.*` | ledger | `provenance.capture` gains `mint` alongside `settle-time` / `backfill` |
| gap discipline | ledger | records without trace spans become labeled gap lines (`messages: []`, `provenance.gap`) AND are listed in `missingTraces`; PR #410's silent skip retired |

## Export filters (fail-closed)

- SFT, reward rows, Verifiers, and RFT default to completed, non-truncated, error-free, ungated `search` runs with reward greater than `0`.
- `minimumQualityExclusive` can raise the quality floor.
- Held-out rows require `allowHeldOutTrainingData: true`.
- SFT also requires a non-empty transcript.
- Reward rows require a non-empty user prompt.
- Verifiers requires both prompt and completion turns.
- RFT requires prompt turns before the first assistant turn.
- Verifiers / RFT additionally accept `gatedLines: 'zero-and-flag'` — the dataset release's declared disposition — which keeps realness-gated lines and honest failures in the output at their non-positive reward with the gate stated on the row (`info.realness_gated`, `reference.realness_gated`): the reward in those formats is a signed learning signal, and dropping the gamed population would bias the negatives toward honest failures while hiding the gaming from the buyer. The split policy is NOT relaxed by the disposition.
  Reward rows carry the same flag at `metadata.realness_gated`, and SFT rows carry it too even though it is always `false` there.
  Every one of those four shapes also carries `realness_screened` beside it (`RealnessLabels`): the verdict alone cannot say whether a screen ever ran, and a row stating one claim without the other is what let never-screened rewards read as clean.
- Harbor ATIF export: no filter, because the format carries no reward at all — it is an interchange/audit sink, never a training-data door. A realness-gated line is exported with the gate stated in `notes` and in `extra.tangle.outcome.realness_gated`.
- Release (`rollout-release`): trainable split only; proposer lines dropped unless `--include-proposers`; every string value scrubbed by the 9 deterministic rules (idempotent, so a second pass counts zero); `--push` requires `huggingface-cli` + `HF_TOKEN` and never prints the token.
  The per-format gate disposition is stated once as data in `src/rollout/release/gate-report.ts` (`sft: exclude`, everything else `zero-and-flag`), the build measures the rows it is about to write against it, and it writes nothing at all if any config would ship a gated row above reward 0, any positive number that reward was derived from, or a positive reward whose producer declared no screen ran on it.
  Those refusals are not listed in that file: it iterates `GATE_CHECK_IDS` under `GATE_POLICIES.assertGateReport`, so a check added anywhere in the package reaches the last door before a public dataset by default.
- Property tests (`src/rollout/gate-properties.test.ts`) hold the whole exporter surface by GENERATION rather than by example: containment (no gated run's number reaches any exporter, through the minted door AND the raw object-literal door), order independence (leak 1 stated as a law — reordering the input changes no output), and idempotence (the gating transform and the Harbor round-trip). 1000 cases per property by default, `GATE_PROPERTY_RUNS` to raise it; the exporter registry there is a total map, so a new exporter with no probe does not compile.
  The dataset card does not assert anything about the gate — it renders the measured counts (`BuildSummary.gate`) and throws when they disagree with the lines it describes, so a README cannot drift from the data files beside it.

## Harbor ATIF-v1.7 interchange

[Agent Trajectory Interchange Format](https://www.harborframework.com/docs/agents/trajectory-format) (normative RFC: `harbor-framework/harbor` `rfcs/0001-trajectory-format.md`) is the portability format for agent trajectories.
It is both a source and a sink of the hourglass, and it sits below the waist in both directions: `toHarborTrajectory` reads `RolloutLine[]`, `fromHarborTrajectory` writes `RolloutLine[]`.

**ATIF models no reward, no judge verdict, and no task/split coordinates.**
Everything else follows from that one fact.

| our field | ATIF | note |
| --- | --- | --- |
| `rollout_id` | `trajectory_id` | required by the spec on every embedded subagent |
| `parent_rollout_id` | tree placement in `subagent_trajectories` | our flat edge becomes ATIF's embedding; import flattens it back |
| `run_id` | `session_id` | ATIF's session is RUN-scoped, and `run_id` is our run-scoped coordinate; every node of an episode carries it, and two roots of one run therefore group as one session |
| `policy.harness` / `harness_version` | `agent.name` / `agent.version` | ATIF requires both as strings; a null becomes `unknown` / `0.0.0` and is restored exactly from escrow, never guessed back |
| `policy.model` | `agent.model_name` + `step.model_name` | |
| `tool_defs` | `agent.tool_definitions` | byte-identical OpenAI function schema, zero transform |
| `messages[]` | `steps[]` | coalescing fold: ATIF has no `tool` source, so a tool result becomes an `observation.results[]` entry on the step that DECLARED its `tool_call_id` (RFC MUST rule 2), never on whichever step happened to precede it |
| `ChatMessage.is_copied_context` | `step.is_copied_context` | RFC rule 7: a turn copied in from another trajectory. Native field both ways, and `toSftRows` drops those turns |
| `ChatToolCall.function.arguments` (string) | `tool_calls[].arguments` (object) | the raw string is kept in the call's `extra` so a malformed argument blob round-trips verbatim instead of being normalized |
| `cost.usd` / `tokens_in` / `tokens_out` / `cache_read` | `final_metrics.total_*` | omitted, never 0, when not captured |
| `cost.tokens_reasoning` / `cache_write` / `wall_s` / `llm_call_count` | `final_metrics.extra.*` | no ATIF field; `reasoning_tokens` is the key the RFC's own example uses |
| `steps[]` (span projections) | `extra.tangle.spans` + `step.metrics` / `step.llm_call_count` | the whole span stays escrowed (ATIF steps are conversation turns, and folding spans in would double-count the run), but the four RL fields ALSO ride ATIF's native per-step channel — a field only our own reader can see is not an interchange field. Escrow wins on import; the native channel is what a foreign document is read through |
| `task.*`, `policy.*`, `artifacts.*`, `provenance.*`, `role`, ids | `extra.tangle.*` | namespaced escrow; a foreign reader ignores it, our round-trip is exact |
| `outcome.realness_gated` | `extra.tangle.outcome.realness_gated` + `notes` | stated in prose too, because a consumer that ignores `extra` would otherwise see a gamed trajectory with nothing marking it |
| `outcome.reward` / `reward_source` / `verdict` | — **dropped** | not escrowed either: a third party must not be able to mistake an agent-eval judge score for something ATIF sanctioned |

Import consequences, all deliberate:

- Every imported line is **unlabeled**: `reward`, `reward_source` and `verdict` are `null` and `provenance.gap` says `imported from Harbor ATIF; no verdict`. That is the existing "null reward is a labeled gap, never 0" rule — an imported trajectory becomes a training example only once a judge scores it.
- **Every** imported trajectory lands on **`holdout`**, whatever the document says. `extra.tangle` is namespaced, not authenticated: a hand-written or third-party file can set `task.split: 'search'` as easily as our exporter can, and honouring it made "this file says so" enough to reach a training export. Promoting an import to a trainable split is a separate, greppable act — `relabelImportedSplit(lines, split)` — so `grep relabelImportedSplit` enumerates every place foreign data was declared trainable. The claim itself is not destroyed; it stays readable in the source document.
- Round-tripping is **idempotent**: `provenance.gap` is composed as a de-duplicated ordered set (it used to accrete one copy of the import note per pass), and every imported `ChatMessage` is emitted with keys in the canonical schema order, so a ledger hashed on serialized bytes sees no diff on further passes. The first import may re-order a producer's keys — that is the canonicalization.
- We do not synthesize `observation.subagent_trajectory_ref` on export. Our ledger records which *invocation* spawned a worker, not which *step* did; attaching the ref to a guessed step would fabricate a causal claim. The edge lives in the child's escrowed `parent_rollout_id`.
- Multimodal `ContentPart[]` flattens to text (our chat content is `string | null`); image parts become a `[image <media_type> <path>]` marker rather than being dropped silently.
- A cycle in `parent_rollout_id` or `subagent_trajectories` throws instead of emitting zero documents or recursing forever.

### Fields adopted from ATIF

Four optional fields were added to our schema because ATIF carries real RL signal we were not capturing.
All are optional and never back-filled, so every ledger written before they existed still validates: absent means "not captured", which is a different claim from `0` or `[]`.

| field | on | why |
| --- | --- | --- |
| `logprobs` | `RolloutStep` | per-completion-token log probabilities — required for off-policy correction when the rollout came from a different policy than the one being trained |
| `completion_token_ids` | `RolloutStep` | exact completion tokenization; removes the ambiguity of re-tokenizing text at train time |
| `prompt_token_ids` | `RolloutStep` | exact prompt tokenization |
| `llm_call_count` | `RolloutStep` and `RolloutCostBlock` | inferences per span and per invocation; `0` means deterministic dispatch with no model call |
| `is_copied_context` | `ChatMessage` | RFC 0001 rule 7 makes excluding these turns from SFT a MUST — they were authored by another agent, so training on them credits this run for another's work |

The per-step four (`logprobs`, `completion_token_ids`, `prompt_token_ids`, `llm_call_count`) are wired through the interchange in BOTH directions on ATIF's own `step.metrics` / `step.llm_call_count`, not only in our escrow.
Export matches the k-th `llm` span to the k-th agent step; import prefers the escrow when it exists and falls back to the native channel, which is the only thing a Harbor-native producer writes.
A step carrying none of the four produces no span — absent stays absent.

### Why there is no Letta converter

Letta's trajectory-v1 is a strict subset of what we need from ATIF for this purpose: no per-step or aggregate cost, no multi-agent/subagent structure, and no token-id or logprob channel.
A Letta sink would therefore carry strictly less than the ATIF one while adding a second format to keep correct against schema drift.
Do not add one without a concrete consumer that reads Letta and cannot read ATIF.
