# Verified-labels flywheel — own-traffic replay eligibility (phase-2 spec)

Phase 1 shipped the dataset pipeline: `src/rl/verified-findings-dataset.ts` joins replay-verify batch verdicts with gold labels and trajectories into execution-verified RL rows (`agent-eval/verified-finding@0`, see `benchmarks/trace-analysis/verified-dataset-v0/README.md`).
Those rows came from public benchmark trajectories (mini-SWE / CodeTraceBench).
The flywheel's real fuel is our own traffic: fleet sessions run inside sandboxes where the image is known.
This document maps which local session classes are replay-eligible today, which are not and why, and the concrete capture changes that make future sessions eligible.

## What replay eligibility requires

Derived from what the run2 replay batch actually consumed (its enumeration excluded 111/133 label entries):

1. **Pinned environment** — a docker image (or digest) the trajectory ran in; `no-docker-image` alone excluded 21 entries.
2. **Working directory** — the cwd commands were executed from.
3. **Ordered step commands** — the exact action string per step; `no-swe-raw-trajectory` excluded 65 entries.
4. **Per-step recorded returncodes** — needed for prefix-divergence checking (the replay batch aborts when >10% of prefix steps diverge from recorded returncodes).
5. **A verifiable target step** — a finding/label on a *command* step (submit-only golds excluded 21 entries; findings on prose are not executable).

## Local session stores surveyed (2026-08-03, this host)

| store | volume | environment (req 1–2) | steps (req 3) | returncodes (req 4) | eligible today |
| --- | --- | --- | --- | --- | --- |
| Claude Code transcripts `~/.claude/projects` | 474 projects, 7,579 session JSONLs, 4.6 GB | no image; `cwd` + `gitBranch` + harness `version` per message | yes — full tool calls + results | **no** — Bash `toolUseResult` records `stdout`/`stderr`/`interrupted` only, no exit code field | no (host env unpinned, no rc) |
| Codex sessions `~/.codex/sessions` | 4,332 rollout files, 113 GB | no image; `session_meta` has `cwd` + git `commit_hash`/`branch`/`repository_url` + `cli_version` | yes | shell events carry exit codes in payloads (format varies by version) | no (host env unpinned) |
| traces CLI normalized envelope (`~/code/traces`, 18 harness adapters: claude, codex, amp, gemini, opencode, pi, copilot, factory, forge, qwen, …) | imports the two stores above | `cwd` filter exists; **no image/sandbox field in the envelope** | yes | adapter-dependent | no — the schema itself cannot express environment identity |
| Sandbox sessions (agent-dev-container `PersistedSession`) | remote fleet; none stored on this host | runtime knows the image — `runtime.ready` event carries `image?` + `sandboxId` + backend — but `PersistedSession` persists only `workspaceRoot` + free-form `metadata`; `image?` is optional even on the event | yes (message store) | via tool parts, not normalized | **almost** — the image is in hand at runtime and dropped at persistence time |
| mini-SWE / CodeTraceBench benchmark trajectories (`~/bench-cache/ctb-20260801`) | 133 labeled, 22 replayable | yes — `mswebench/*` images + cwd | yes | yes — `<returncode>N</returncode>` in every observation | **yes — the only eligible class; run2 proved 16/22 reproduce** |

Conclusion: today only benchmark-imported trajectories are replay-eligible.
Our own sessions fail on environment pinning (all classes) and returncode capture (Claude Code).
The sandbox class is one persistence field away from eligibility — the runtime already knows the image.

## Phase-2 capture changes (ranked by unlock per line of code)

1. **Persist the sandbox image at session start** (agent-dev-container): copy `runtime.ready`'s `image` (as a digest, not a tag) + `sandboxId` into `PersistedSession` as first-class fields, and make `image` required on the event.
   This single change makes every future fleet sandbox session satisfy requirements 1–2 — the highest-leverage line in the flywheel.
2. **Add environment identity to the traces envelope** (traces repo): an optional `environment: { image?, imageDigest?, cwd, gitCommit? }` block on the normalized session, populated by adapters where known.
   Without it, eligible sandbox sessions lose their eligibility at import time.
3. **Record exit codes in Claude Code tool results**: the harness owns `toolUseResult`; until it carries `exitCode`, replay divergence checking cannot run on Claude transcripts even inside a pinned sandbox.
   Workaround for sandboxed Claude sessions: derive returncodes from the sandbox's own command journal instead of the transcript.
4. **Emit a replay descriptor per session** (the join target this package consumes): `{ image, cwd, steps: [{action, returncode}], findings: [{stepId, claim}] }` — exactly the shape `loadVerifiedFindingsDataset` joins today, so phase-3 needs no new pipeline code.

## Why this matters

Run2 measured: 72.7% of eligible trajectories reproduce their recorded failure at the gold step, and 81.8% of generated fixes flip it.
Execution-verified labels at fleet scale are training data that cannot be bought — AgenTracer-8B showed +18pp from a specialist localizer trained on *unverified* labels; ours carry executed proof per row.
Every capture change above turns a session class from "readable" into "verifiable", and the phase-1 pipeline converts verifiable sessions into dataset rows with zero new code.
