# Profile versioning — closing the offline/online drift gap

**Status:** Architecture design. Greenfield, replace existing primitives in place. No V2 suffix.
**Owner:** spans agent-eval + agent-runtime + agent-knowledge + sandbox SDK.
**Tracking:** task #98.
**Date:** 2026-05-27.

## Architecture in one diagram — symmetric fork

Neither writer is privileged. Both branches are first-class. When they reconverge, the substrate's job is to BENCHMARK the branches and propose what to keep — not to be the authority.

```
            AgentProfile lineage
              ╱           ╲
             ╱             ╲
       harness branch   substrate branch
        (per-turn writes)   (selfImprove diff)
             ╲             ╱
              ╲           ╱
             DIVERGENCE EVENT
                     │
                     ▼
            benchmark both branches
            against the same held-out
                     │
            ┌────────┼────────┐
            ▼        ▼        ▼
       ship-harness ship-substrate merge
                     │
                     ▼
              inconclusive → expand
              corpus / human review
```

The substrate becomes a peer, not an owner. The gate verdict names *which* branch won, not just "ship."

## What we are fixing

Two writers, same state, no coordination:

- **Harness writer** — Hermes-style per-turn `spawn_background_review_thread`, agent-runtime's runLoop, any future in-sandbox self-modification. Online, continuous, fires every turn.
- **Substrate writer** — `selfImprove()` running offline against a frozen snapshot, producing a winner with held-out gate confidence. Batch, fires per campaign.

Failure modes today:

1. **Lost update.** Substrate ships a winner. Harness's per-turn updates since baseline evaporate.
2. **Stale eval.** Substrate's lift CI is `winner vs P₀`. Production is at `P_h`. The CI says nothing about `winner vs P_h`.
3. **Gate becomes a lie.** `gateDecision: ship` against `P₀` looks legitimate. Consumer ships. Regresses against `P_h`. Detection fails because metrics moved too.

## The minimum design

Single concept, single operation, content-addressable.

### `AgentProfile` is a versioned, content-addressable object

```typescript
// src/profile/types.ts

export interface AgentProfileVersion {
  /** Content-hash of the materialised profile state. */
  hash: string
  /** Parent in the lineage, null for the genesis profile. */
  parentHash: string | null
  /** Who wrote this version. */
  source: 'harness' | 'substrate' | 'human'
  /** When. */
  timestamp: number
  /** Human-readable label, optional. */
  label?: string
}

export type ProfileDiff =
  | { kind: 'patch'; edits: ProfileEdit[] }
  | { kind: 'replace'; content: MutableSurface }

export interface ProfileEdit {
  /** Which surface inside the profile this edit targets. */
  surface: 'systemPrompt' | 'skill' | 'tool' | 'mcp' | 'subagent' | 'modelByRole'
  /** Surface-scoped identifier — skillName, toolName, mcpId, subagentId, role. */
  surfaceId?: string
  op: 'append' | 'insert_after' | 'replace' | 'delete'
  target?: string
  content: string
  /** Support count from multi-trial evidence. */
  supportCount?: number
  /** Source classification for the merge/rank stage. */
  sourceType?: 'failure' | 'success'
}
```

That's the whole substrate type surface. Two types. No interface explosion.

### `RunRecord` carries the version it was captured at

Replace the existing `commitSha` / `promptHash` / `configHash` triple with a single canonical hash. Greenfield, no compat shim:

```typescript
// src/run-record.ts — IN-PLACE replacement
export interface RunRecord {
  // ... existing fields ...
  /** Content-hash of the AgentProfileVersion that produced this run. */
  agentProfileHash: string
}
```

`commitSha`, `promptHash`, `configHash` become *inputs* to `hashProfile()`, not separate fields.

### `selfImprove()` returns a diff, and the gate becomes 4-way

Replace the current return shape. Greenfield, in place:

```typescript
// src/contract/self-improve.ts — IN-PLACE replacement
export interface SelfImproveResult {
  /** What we measured against. */
  baselineHash: string
  /** What we recommend applying. */
  diff: ProfileDiff
  /** Hash of `applyDiff(baseline, diff)` — verifiable by consumer. */
  winningHash: string
  /** Statistical evidence — paired bootstrap CI vs baseline. */
  lift: LiftInsight
  /** Substrate verdict — see DriftGateDecision below. */
  gateDecision: DriftGateDecision
  insight: InsightReport
}

export type DriftGateDecision =
  | { kind: 'ship-substrate'; reason: string; vs?: 'baseline' | 'harness-live' }
  | { kind: 'ship-harness'; reason: string }
  | { kind: 'merge'; mergedDiff: ProfileDiff; reason: string }
  | { kind: 'inconclusive'; reason: string }
```

When the substrate runs WITHOUT `driftPolicy: benchmark-branches`, only `ship-substrate` / `inconclusive` (or the equivalent `hold` framing) are possible. When `benchmark-branches` is on, all four kinds may surface.

The substrate is now explicit: *"this diff is statistically valid against `baselineHash`. Whether to apply it to your live state is your call — and we'll tell you what we found when we compared branches."*

### The opt-in drift policy

```typescript
selfImprove({
  // ... existing
  driftPolicy?:
    | { kind: 'ignore' }                                   // default — assume single-writer
    | { kind: 'reject-on-drift' }                          // cheap safety mode
    | { kind: 'benchmark-branches'; benchmarkBudget: { generations, populationSize } }
})
```

- **`ignore`** is the default. Same as today. Zero overhead for consumers whose sandbox harness doesn't self-modify.
- **`reject-on-drift`** is the cheap safety mode. Substrate notices `currentHash != baselineHash` at apply time and refuses to ship. Tells the consumer "your profile drifted; re-run selfImprove against current state."
- **`benchmark-branches`** is the full thing — only used when the harness DOES self-modify (Hermes per-turn, Claude Code with skill creation, Codex with user-prompted skill edits, agent-builder RL bridge, any future autonomous improvement loop). Costs an extra mini-campaign. Returns the 4-way `DriftGateDecision`.

### Generalises past Hermes

Any in-sandbox profile mutation appends to the same profile log, regardless of trigger:

- Hermes-style autonomous (per-turn `background_review` fork)
- Claude/Codex user-prompted ("hey, create a skill for X")
- agent-runtime's runLoop self-modifying its prompt addendum
- RL-style policy parameter updates
- Manual user edits via `skill_manage` commands

The substrate doesn't care WHY the harness wrote. It just sees: live profile is at hash X, my baseline was Y. Same merge protocol applies.

### Conflict resolution — the four cases

For the `benchmark-branches` policy, the substrate handles four cases:

1. **No conflict.** Edits target different surfaces (substrate edited `systemPrompt`, harness wrote a new `skill/X.md`). Auto-merge into a combined candidate, benchmark merged vs each branch.

2. **Orthogonal edits to the same surface.** Both touched `systemPrompt` but different H2 sections (subsumed by `GepaProposerConstraints.preserveSections`). Auto-merge by union of edits, benchmark.

3. **Semantic duplication.** Substrate proposed a new skill `summarize-pr`; harness already created `pr-summarizer` (similar purpose, different file). Substrate runs a similarity-detection step: embed both, threshold cosine similarity, surface as a "duplicate-likely" finding. Resolution: head-to-head benchmark with both → keep the winner → archive the loser.

4. **Direct same-region conflict.** Both edited the same paragraph. Three resolution paths the substrate offers:
   - **Head-to-head**: run both branches, pick the winner.
   - **LLM-mediated merge**: prompt an LLM with both candidate edits + the held-out failure trials, ask for a synthesis that addresses both. Benchmark the synthesis.
   - **Human review**: surface the diff with `requires-resolution: true` and stop.

### Sandbox-side merge protocol

```typescript
// agent-runtime exports:
export async function getCurrentProfileVersion(): Promise<AgentProfileVersion>
export async function applyDiff(diff: ProfileDiff): Promise<ApplyResult>

export type ApplyResult =
  | { ok: true; newHash: string }
  | { ok: false; reason: 'conflict'; ancestor: string; ours: string; theirs: string }
  | { ok: false; reason: 'stale-baseline'; expected: string; actual: string }
```

Sandbox keeps an append-only profile log at `~/.tangle/profile-log.jsonl`. Every harness write appends an entry. Every substrate-proposed apply appends or returns conflict.

### The merge algorithm (3-way, surface-scoped)

When substrate proposes `diff(baselineHash → winningHash)` but live state is at `currentHash != baselineHash`:

1. **Walk the lineage** — find common ancestor of `baselineHash` and `currentHash`. If `baselineHash` IS an ancestor of `currentHash`, we have a clean rebase target.
2. **Per-surface 3-way merge** — for each `ProfileEdit` in the diff:
   - If the targeted surface (skillName, toolName, etc.) hasn't been touched in `currentHash` lineage since `baselineHash` → apply.
   - If touched but the textual edit is on a different region → apply (no conflict).
   - If touched on the same region → return `conflict` with ancestor/ours/theirs for the human or substrate to resolve.
3. **Re-eval recommendation** — if non-trivial conflicts, recommend `selfImprove()` re-run against `currentHash` rather than blind merge.

The consumer chooses: rebase + re-eval (statistically clean), force merge (skip re-eval, ship-at-own-risk), or reject (substrate's proposal is too stale).

## How this changes the substrate flow

```
Today:
  ingest_baseline_P0 → eval → winner W → consumer ships W (regardless of drift)

Tomorrow:
  ingest_baseline_hashed → eval → {baselineHash, diff, winningHash, lift, gate}
                                  ↓
  sandbox.applyDiff(diff) → ok | conflict | stale-baseline
                          ↓
  if stale-baseline:    substrate re-eval against currentHash
  if conflict:          substrate proposes targeted resolution OR human reviews
  if ok:                profile log gets a new entry, substrate notified
```

## What changes per package

| Package | Files | Change |
|---|---|---|
| **agent-eval** | `src/profile/types.ts` (new) | `AgentProfileVersion`, `ProfileDiff`, `ProfileEdit` |
| | `src/profile/hash.ts` (new) | `hashProfile()` — content-hash of the materialised state |
| | `src/profile/diff.ts` (new) | `diffProfiles(a, b)`, `applyDiff(profile, diff)`, `threeWayMerge(ancestor, ours, theirs)` |
| | `src/run-record.ts` | REPLACE `commitSha`/`promptHash`/`configHash` triple with `agentProfileHash` (greenfield) |
| | `src/contract/self-improve.ts` | REPLACE `SelfImproveResult` to return `{baselineHash, diff, winningHash, lift, gateDecision, insight}` |
| | `src/contract/analyze-runs.ts` | Add `agentProfileLineage` section to `InsightReport` — what versions ran, drift detected |
| **agent-runtime** | `src/profile/log.ts` (new) | Append-only `~/.tangle/profile-log.jsonl`. `appendVersion()`, `readLineage()`, `findCommonAncestor()` |
| | `src/profile/api.ts` (new) | `getCurrentProfileVersion()`, `applyDiff()` |
| | `src/loops/run-loop.ts` | Every harness-side write to skills/memory/prompt-addendum appends to profile log |
| **agent-knowledge** | `src/skills/version.ts` (new) | Skills become independently versioned objects; profile references them by `skillSetHash` |
| **sandbox** | `src/agent-profile.ts` | Expose `getCurrentProfileVersion()` over the SDK |

## What the gate semantics become

`defaultProductionGate` today: "is the candidate statistically better than the baseline?"

`defaultProductionGate` tomorrow: same question, scoped to the baseline. The consumer (sandbox / human / hosted-tier) decides whether to apply, given the answer + the current live state.

We do NOT downgrade our paired-bootstrap CI. That's our edge over SkillOpt and Hermes. We just stop pretending the ship verdict is a deployment decision — it's a measurement.

## The forcing function (task C from the audit)

Before we commit weeks to this implementation, set up the empirical case:

1. Run Hermes on top of our sandbox.
2. Hermes' per-turn loop mutates skills.
3. Run `selfImprove()` against the baseline at sandbox boot.
4. Observe `gateDecision: ship` produce a winner that, when applied to the now-drifted live state, regresses.
5. Capture the actual lift CI gap between `winner vs baseline` and `winner vs live`.

If that gap is small (< MDE), profile-versioning is over-engineering. If it's large, this work is critical. We should know the number, not the intuition.

## Phasing

### Phase 0 — forcing function (1 week)
Hermes-on-sandbox drift experiment. Real numbers on the gap. Either proves this work is needed or kills it.

### Phase 1 — types + hashing (3 days)
`AgentProfileVersion`, `ProfileDiff`, `ProfileEdit`. `hashProfile()`. `diffProfiles()`. `applyDiff()`. Pure functions, fully tested, no integration yet.

### Phase 2 — substrate-side rewire (5 days)
Replace `RunRecord` triple with `agentProfileHash`. Replace `SelfImproveResult` shape. Update `analyzeRuns` to detect lineage drift. Update tests + all 6 consumer products.

### Phase 3 — sandbox + runtime (1 week)
Profile log primitive in agent-runtime. `getCurrentProfileVersion()` + `applyDiff()` API. Sandbox SDK surface. Three-way merge for surface-scoped edits.

### Phase 4 — agent-knowledge skill versioning (3 days)
Skills become independently versioned. `skillSetHash` referenced from profile.

### Phase 5 — Hermes adapter (3 days)
Bridge: Hermes' `~/.hermes/skills/` write events → our profile log via a runtime hook.

Total: ~3 weeks of focused work. Phase 0 in this session if Drew greenlights.

## Source pointers

- Task: #98
- Related audit: `docs/specs/hermes-self-improvement-audit.md`
- Current pre-versioning `RunRecord`: `src/run-record.ts`
- Current pre-versioning `SelfImproveResult`: `src/contract/self-improve.ts`
- Current gate: `src/campaign/gates/default-production-gate.ts`
