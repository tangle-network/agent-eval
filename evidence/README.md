# Where evidence lives

One home, one shape, one index.
This directory is the canonical registry for measured claims about our agents, prompts, policies, and instruments — the numbers that used to rot in per-repo docs, `.evolve/` diaries, results directories, PR comments, and gists.

## The rule

- **A measured claim that anyone will cite later gets a record here.**
  One JSON file per claim in [`records/`](./records/), validated by the exported schema (`evidenceRecordSchema` from `@tangle-network/agent-eval/experiment`).
- **The registry lives in agent-eval** because the measurement substrate owns evidence legitimacy.
  Every other repo keeps at most a pointer file (`docs/EVIDENCE.md`, three lines: "measured results for this repo live in agent-eval `evidence/`; do not restate numbers here").
- **Humans read [`INDEX.md`](./INDEX.md); machines read `records/*.json`.**
  The index is generated (`pnpm run evidence:render`) and drift-checked (`pnpm run evidence:check`, inside `verify:package`), so prose can never drift from data.
- **Session diaries stay diaries.** `.evolve/experiments.jsonl` remains the append-only lab notebook.
  A registry record is the distilled, addressable claim a notebook line earned.

## The record

Each record states, in typed fields: the one-sentence **claim** (written so it can fail), the **instrument**, the exact **command** (`null` = not preserved, a named gap), the **arms**, the denominator **n**, the **result** with uncertainty, **artifacts** (run dirs, PRs, gists — never empty), **cost** (`null` = not captured, never a silent zero), **confounds** (stated before anyone reads the verdict), and an **evidence state**:

| state | meaning |
| --- | --- |
| `CERTIFIED` | pre-registered rule + sealed/held-out data, defended or re-run in the suite |
| `MEASURED-ONCE` | one honest measurement on the real path, not replicated |
| `RESOLVED-NULL` | adequate instrument, effect did not appear under the registered rule |
| `UNVERIFIED` | stated somewhere load-bearing, no independent check yet |
| `KILLED` | refuted, invalidated, or superseded |

When a run was governed by a sealed experiment (`@tangle-network/agent-eval/experiment`), the record carries the seal as `experimentDigest` — the registered rule is the addressing scheme.

## How to add a record

1. Write `records/<id>.json` (`id` = kebab-case filename).
2. `pnpm run evidence:render` — validates and regenerates `INDEX.md`.
3. Commit both. A stale index or invalid record fails `verify:package`.

A result that changes state (replicated, refuted, superseded) gets its state moved or a new record with `supersedes` — never a silent edit of the numbers.
