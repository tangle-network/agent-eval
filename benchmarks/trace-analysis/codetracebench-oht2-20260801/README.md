# CodeTraceBench OpenHands + Terminus2 Bulk Import Recipe

This directory turns the verified CodeTraceBench OpenHands and Terminus2 rows into traces-importable inputs.
It extends the mini-SWE recipe in [`../codetracebench-glm52-20260730/`](../codetracebench-glm52-20260730/) from a 32-row single-shot preparation to a per-row fault-tolerant bulk pipeline.

## Provenance

| Field | Value |
| --- | --- |
| Dataset | [`NJU-LINK/CodeTraceBench`](https://huggingface.co/datasets/NJU-LINK/CodeTraceBench) |
| Dataset revision | `aa213b84ffb6690fc37ca15766d6ca174ec36d4d` |
| CodeTracer revision | `2d302191dd07e7c0c2da6f7a5e9451c7cbb62d34` (repository HEAD at recipe date) |
| Manifest | `bench_manifest.verified.jsonl` (1,000 rows: OpenHands 520, Terminus2 222, mini-SWE 150, SWE-agent 108) |

## Why local skills exist

Upstream CodeTracer ships `openhands` and `terminus2` seed parsers, but neither reproduces the CodeTraceBench annotation's step numbering, and the swe_raw OpenHands layout has no upstream parser at any commit.
A trajectory whose steps.json disagrees with the annotation's step ids silently misaligns every label, so each published layout gets a parser whose enumeration was validated against the manifest `step_count` for every verified row:

| Skill | Layout | Convention | Count evidence |
| --- | --- | --- | --- |
| [`skills/openhands_completions`](./skills/openhands_completions/SKILL.md) | swe_raw per-call LiteLLM logs | non-finish assistant tool calls in the fullest call view | 313/313 |
| [`skills/openhands_sessions`](./skills/openhands_sessions/SKILL.md) | session event streams | action events with a cause-paired observation, any action type | 183/199 |
| [`skills/terminus2_commands`](./skills/terminus2_commands/SKILL.md) | episode logs | one step per `commands[]` entry across episodes | 220/222 |

The skills follow the upstream `SKILL.md` + `parser.py` contract and load through `SkillPool(user_dir=...)`, so CodeTracer detects them exactly like seed skills.
The upstream seed parsers stay untouched; family membership in `prepare-bulk.py` routes every row through the annotation-faithful skill and treats any other detection as a `wrong-normalizer` failure.

## Faithfulness decisions

- **Step identity is the contract.** A row only passes when the normalized step count equals the manifest `step_count`; there is no resequencing, deduplication, or padding. Rows whose published data cannot reproduce the annotation view fail loudly and stay out of the labels file.
- **Blank keystrokes stay steps.** Terminus2 and OpenHands agents send bare Enter or empty commands; those are annotated steps, so they render as their JSON literal (`""`, `"\n"`) instead of being dropped, which would shift every later step id.
- **`stage_ranges.json` keeps the upstream default** (one `full` range). The manifest's annotation `stages` stay in the labels file only: CodeTracer's agent context embeds `stage_ranges.json`, so writing annotation-derived stage boundaries into the normalized directory would leak annotation structure to a system under measurement. This matches every previously sealed mini-SWE split.
- **Importer gates run per row before import.** `prepare-bulk.py` mirrors the traces importer's invariants (step id sequence, non-empty actions, observation presence, ref shapes, label-leak scans), because `traces import-codetracebench` is all-or-nothing and one bad row would abort the batch.

## Run

Prepare one family (downloads archives, normalizes, validates, emits labels + receipt):

```bash
uv run \
  --with 'git+https://github.com/NJU-LINK/CodeTracer.git@2d302191dd07e7c0c2da6f7a5e9451c7cbb62d34' \
  prepare-bulk.py \
  --manifest bench_manifest.verified.jsonl \
  --family OpenHands \
  --out "$WORK/openhands" \
  --labels-out "$WORK/ctb-oht2-labels-openhands.json"
```

Convert passing rows with the traces importer:

```bash
traces import-codetracebench "$WORK/ctb-oht2-labels-openhands.json" \
  --trajectory-dir "$WORK/openhands/normalized" \
  --out "$TRACES/openhands" \
  --revision aa213b84ffb6690fc37ca15766d6ca174ec36d4d \
  --concurrency 8
```

`--family Terminus2` runs the same way.
Archives cache in `$WORK/<family>/archives`, so reruns skip completed downloads.
`$WORK/<family>/prepare-bulk-receipt.json` records every row's status, normalizer, step count, hashes, and failure reason.

## Import results (2026-08-01)

| Family | Candidates | Imported | Failed | Failure reasons |
| --- | ---: | ---: | ---: | --- |
| OpenHands | 520 | 496 | 24 | 8 `no-artifact` (manifest rows without archives), 16 `step-count-mismatch` (published session views disagree with the annotated count) |
| Terminus2 | 222 | 220 | 2 | 2 `no-normalizer` (archives containing only empty directories) |

Passing OpenHands rows split 313 `openhands_completions` + 183 `openhands_sessions`.
The 16 OpenHands `step-count-mismatch` rows are condensed or partial session streams where no published view (flat export, events, event_cache) reproduces the annotated step count; importing any of them would misalign labels, so they stay out.
