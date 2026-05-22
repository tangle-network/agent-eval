# agent-builder meta-spec — scaffold expansion + execution gaps

Status: ready-to-file. Author: staff/principal engineer review.
Repo: `tangle-network/agent-builder` at `/home/drew/code/agent-builder/`.
Substrate pin: `@tangle-network/agent-eval@^0.31.1`.
Sibling specs: `/tmp/audit/spec-agent-eval-substrate.md`, `/tmp/audit/spec-tax-agent.md`, `/tmp/audit/spec-legal-agent.md`, `/tmp/audit/spec-creative-agent.md`, `/tmp/audit/spec-gtm-agent.md`.

---

## 0. Read-first context

Before opening a PR against this spec, read in order:

1. `/tmp/audit/SYNTHESIS.md` — cross-repo adoption matrix; identifies the three execution gaps and the scaffold-template gap as "the bottleneck for compounding value across the verticals."
2. `/tmp/audit/agent-builder-integration.md` — file-by-file inventory of agent-builder's substrate usage (66 source files, 86 import sites). Sections §3, §4, §5 are the substantive findings; this spec turns those into tasks.
3. `/tmp/audit/agent-eval-catalog.md` — what the substrate ships at 0.31.1. Every primitive named in this spec exists in substrate today; no new substrate symbols are required for Half A or Half B (Half C calls out two upstream lifts).
4. `/home/drew/code/agent-builder/src/lib/.server/eval/canonical-campaign.ts` lines 175-255 — the canonical `buildCanonicalCampaign` shape that all scaffold expansion mirrors.
5. `/home/drew/code/agent-builder/src/lib/.server/scaffold/scaffold-agent.ts` lines 66-260 — current scaffold render entry point; every Half B task adds a template + a `files.push(...)` line here.
6. `/home/drew/code/agent-builder/CLAUDE.md` — comment & doc discipline (no historical narrative in source). All directive comments in this spec follow that rule.

Hard rules that override defaults:

- No `Co-Authored-By:` trailers on commits/PRs in this repo (project CLAUDE.md).
- No `?? defaultValue` on required fields. External-boundary calls return typed outcomes (`{succeeded, value, error}`). See repo "No fallbacks. Fail loud." doctrine.
- TypeScript strict, no semicolons, single quotes, 2-space indent.
- No new markdown docs unless asked. Update `templates/readme.ts` rendered output if a scaffold change needs user-facing doc.

---

## 1. Executive summary

agent-builder is the meta-system that scaffolds tax / legal / creative / gtm and any future vertical agents. Today it embodies the substrate end-to-end for **its own** evals but the scaffolds it emits inherit ~25% of that integration. Three pieces ship in source with passing unit tests but zero production callers. Several composite knobs are hard-coded where they should be config. The result: every newly-built agent starts with an analyst plumbing only — no differential gate, no evolve gate, no auto-promote, no D1-backed observability, no prod-trace harvest, no tool-fidelity, no stream-quality, no 3-judge ensemble, no IRR, no calibration loop.

This spec lands the meta-system fix in three staged PRs:

- **Half A** (PR #1, ~400 LOC, 1 day): wire the three orphaned execution gates so what already exists actually runs.
- **Half B** (PR #2, ~2500 LOC, 3-4 days): expand `src/lib/.server/scaffold/templates/` to emit the full stack; new agents inherit it by default; re-scaffold tax/legal/creative/gtm to absorb it.
- **Half C** (PR #3, ~800 LOC, 2 days): cleanups — env-overridable composite weights, campaign fingerprint persistence, raw-coverage path-to-re-enable doc, analyst entry-point consolidation, substrate up-lifts (`pearson`, `cliffsDelta`).

Half A is independently shippable. Half B depends on Half A landing (so scaffold templates can render the wiring patterns Half A introduces). Half C polishes the surface Half B emits.

End-state: the four reference agents level up by re-scaffold, and every future agent inherits the full integration stack at scaffold time.

---

## 2. Current state inventory

### 2.1. Substrate adoption — what's wired

Verified by reading 66 source files + 86 import sites:

| Capability | Module | Status |
|---|---|---|
| 6-EvalKind canonical campaign | `src/lib/.server/eval/canonical-campaign.ts` lines 175-255 | ✅ wired |
| Substrate `runEvalCampaign` driver | `scripts/eval.ts` lines 85-98, 613 | ✅ wired |
| `assertLlmRoute` + `assertRunCaptured` | `scripts/eval.ts` lines 17-32 | ✅ wired |
| Per-cell `FileSystemRawProviderSink` + `FileSystemTraceStore` | `scripts/eval.ts` lines 86-92 | ✅ wired |
| 3-judge ensemble + `JudgeScoresRecord` shape | `src/lib/.server/eval/forge-chat-judge.ts` lines 39-43, 139-237 | ✅ wired |
| Within-item IRR via `interRaterReliability` | `forge-chat-judge.ts` lines 24-28, 33 | ✅ wired |
| D1-backed `TraceStore` | `src/lib/.server/eval/trace-store-d1.ts` lines 27-437 | ✅ wired |
| D1-backed `TraceAnalysisStore` | `src/lib/.server/eval/d1-trace-analysis-store-adapter.ts` lines 94-802 | ✅ wired |
| D1-backed `OutcomeStore` | `src/lib/.server/eval/outcome-store-d1.ts` | ✅ wired |
| Findings JSONL + D1 mirror | `findings-d1-store.ts`, `src/routes/api.admin.findings.ts` | ✅ wired |
| Proposals queue + UI | `proposals-store.ts`, `src/routes/api.admin.proposals.ts`, `src/routes/app.admin.proposals.tsx` | ✅ wired (PATCH gate ORPHANED — see §2.2) |
| Calibration ingest + UI | `calibration-store.ts`, `src/routes/api.admin.calibration.ts`, `src/routes/app.admin.calibrate.tsx` | ✅ wired |
| Differential A/B harness (B3) | `src/lib/.server/eval/differential-eval.ts` lines 97-188 | ✅ exists, called once at admin route only |
| Evolve unfreeze gate (B4) | `src/lib/.server/eval/evolve-gate.ts` lines 68-100 | ✅ exists, used inside auto-promote (which is also orphaned) |
| Publish hard gate via `HeldOutGate` | `src/lib/.server/eval/publish-gate.ts` line 66 | ✅ wired |
| Tool-fidelity deterministic rubric | `src/lib/.server/eval/tool-fidelity.ts` (240 lines) | ✅ wired into composite at 0.4 |
| Stream-quality (TTFT / max-stall / P95) | `src/lib/.server/eval/stream-quality.ts` (127 lines) | ✅ recorded, NOT in composite weight |
| Adversarial-probe registry | `src/lib/.server/eval/adversarial-scenarios.ts` (503 lines) | ✅ exists |
| Prod-trace harvest cron | `src/lib/.server/eval/prod-trace-harvest.ts` (240 lines) | ✅ wired via `server.ts` line 197-211 at `0 15 * * *` |
| Three-layer scoring via `scoreProject` | `src/lib/.server/eval/session.ts` lines 12-21 | ✅ wired at publish |
| Analyst registry over four kinds (Wave C1) | `scripts/run-canonical-analyst-loop.ts` lines 32-39 | ✅ wired |

### 2.2. The three execution gaps (orphaned production code)

All three modules ship with passing unit tests but have **zero** production callers. Confirmed via:

```
grep -rn "evaluateAutoPromote" src/ scripts/   → only auto-promote.ts:37 (definition)
grep -rn "computeParetoTiers" src/ scripts/    → only pareto-judges.ts:152 (definition)
grep -rn "runDifferentialEval" src/ scripts/   → only differential-eval.ts:97 (definition)
```

**Gap 1 — `evaluateAutoPromote` (Wave C4)** is the cleanest composition of the differential verdict (B3) + the evolve gate (B4) into a single ship-or-not decision. Source at `src/lib/.server/eval/auto-promote.ts` lines 37-89. Decision matrix:
- B4 blocks (calibration / safety / baseline-days) → `blocked`
- B3 `lose` → `reject`
- B3 `tie` → `hold`
- B3 `win` → `promote`

No caller invokes it. Wave C4 is paper.

**Gap 2 — `/api/admin/proposals` PATCH skips the differential gate.** File header at `src/routes/api.admin.proposals.ts` lines 1-15 explicitly admits the deferral:

```
* For now the gate-run is deferred — the PATCH stores the decision
* intent + reviewer; a follow-up CLI / cron actually runs the
* differential. This keeps the admin click latency tight while the
* statistical work runs out-of-band.
```

The follow-up cron does not exist. Result: a proposal can be PATCHed to `promoted` without the differential gate firing. The `decideProposal(db, id, { status, ... })` call at lines 111-115 sets `status` directly. The composition `proposal-approved → differential-eval → auto-promote → apply` is broken at the PATCH boundary.

**Gap 3 — `pareto-judges.ts` (Wave B2) is orphaned.** Designed at `src/lib/.server/eval/pareto-judges.ts` lines 1-208 to switch `DEFAULT_FORGE_JUDGE_MODELS` by `JUDGE_BUDGET_TIER` env. No caller. `forge-chat-judge.ts` lines 39-43 still hard-codes the 3-judge list:

```ts
export const DEFAULT_FORGE_JUDGE_MODELS = [
  'claude-code/sonnet',
  'opencode/zai-coding-plan/glm-5.1',
  'kimi-code/kimi-k2.6',
] as const
```

`resolveJudgeModels(override?)` at `forge-chat-judge.ts` lines 120-129 honors the explicit override and `FORGE_JUDGE_MODELS` env, but never consults `computeParetoTiers`. Cost-aware switch unwired.

### 2.3. The scaffold template gap

Currently 16 templates in `src/lib/.server/scaffold/templates/`:

| Template | Renders | Lines |
|---|---|---|
| `agent-config.ts` | `tests/eval/agent.config.ts` + `tests/eval/analyst-loop.ts` | 520 |
| `auth-billing.ts` | Auth + Stripe modules + webhook | 233 |
| `canonical-eval.ts` | `tests/eval/canonical.ts` — 1-kind persona loop | 299 |
| `cron.ts` | `.github/workflows/autodev.yml` | 92 |
| `db-schema.ts` | `src/lib/.server/db/schema.ts` | 93 |
| `judges.ts` | `tests/eval/lib/judges.ts` — 2-judge default | 189 |
| `landing.ts` | `src/routes/_index.tsx` | 93 |
| `package-json.ts` | `package.json` + `tsconfig.json` + `drizzle.config.ts` | 130 |
| `personas.ts` | 10 YAML seeds | 148 |
| `prompt-evolution.ts` | `tests/eval/run-prompt-evolution.ts` | 248 |
| `readme.ts` | README + AGENTS.md + .gitignore | 127 |
| `retrieval.ts` | optional retrieval indexer | 87 |
| `server.ts` | `server.ts` Worker entry | 81 |
| `system-prompt.ts` | `src/lib/prompt.ts` | 144 |
| `tools-json.ts` | `src/lib/tools.json` + agent-package | 98 |
| `wrangler-toml.ts` | `wrangler.toml` | 60 |

Twelve substantive things agent-builder uses internally that the scaffold does NOT emit:

1. Multi-EvalKind canonical campaign builder (only the 1-kind `canonical-eval.ts` template exists)
2. D1-backed `TraceStore` adapter
3. D1-backed `TraceAnalysisStore` adapter
4. D1-backed `OutcomeStore` adapter
5. D1-mirrored findings store + `/api/admin/findings` + `/app/admin/findings`
6. Differential A/B harness (`pairedWilcoxon` + `pairedBootstrap` + Cliff's δ)
7. `/evolve` unfreeze gate (Pearson + adversarial + baseline-days)
8. Auto-promote composition (B3 + B4)
9. Prod-trace harvest cron
10. Tool-fidelity deterministic rubric folded into composite
11. Streaming-quality dim (TTFT / max-stall / P95)
12. Adversarial-probe registry slot
13. Calibration ingest D1 + admin UI + Pearson
14. 3-judge ensemble + IRR + `JudgeScoresRecord` (current default is 2 judges at `templates/judges.ts:73`)

### 2.4. Other inconsistencies

Confirmed from agent-builder source:

1. **`pearson.ts` is local-only** (`src/lib/.server/eval/pearson.ts` lines 12-40). Substrate has six private `pearsonR` / `pearson` implementations (`src/judge-calibration.ts:157`, `src/pipelines/judge-agreement.ts:98`, `src/rl/reward-hacking.ts:273`, `src/builder-eval/correlation.ts:80`, `src/meta-eval/correlation-study.ts:168`, `src/meta-eval/rubric-predictive-validity.ts:231`) but exports none. Six private copies in substrate + N more in consumers — substrate should export one and this file should re-export from there.

2. **`cliffsDelta` is local** (`differential-eval.ts` lines 83-95) with a self-acknowledging comment: `"the substrate doesn't ship one — it's small enough to keep here."` `grep -rn cliffs /home/drew/code/agent-eval/src/` returns zero hits. Per the substrate spec, lift this alongside `pairedWilcoxon` / `pairedBootstrap`.

3. **Three parallel analyst entry points** producing overlapping outputs:
   - `src/lib/.server/eval/canonical-trace-analyst.ts` — runs `analyzeTraces` over the full campaign corpus, writes `research-report.md/json` to artifact dir.
   - `scripts/run-canonical-analyst-loop.ts` — runs `AnalystRegistry` over OTLP-JSONL with 4 kinds, persists findings JSONL + D1 mirror.
   - `src/lib/.server/eval/forge-deep-analyst.ts` — runs `analyzeTraces` per-build via `D1TraceAnalysisStore`, persists as `JudgeSpan`.

4. **Composite weights hard-coded** at `canonical-campaign.ts` lines 612-627: `0.6 * judges + 0.4 * tool_fidelity`, fail threshold 0.5. No env / config / per-agent override. Tuning requires a code edit.

5. **No campaign-fingerprint emitted to a persistent store** despite `scenario-registry.ts` lines 24-27 promising it. The `result.campaignFingerprint` returned by `runEvalCampaign` is written to `manifest.json` (verified at `scripts/eval.ts:737, 819`) but NOT into `eval_run.code_sha`. `trace-store-d1.ts:40` accepts `code_sha` but the campaign fingerprint isn't fed into it — the column gets `commitSha ?? 'dev'` from the build env instead. Registry drift is not detectable from D1 today.

6. **Raw-coverage integrity DISABLED at campaign level** (`canonical-campaign.ts` lines 216-228): `llmSpansMin:0`, `rawProviderEventsMin:0`, `requireRawCoverageOfLlmSpans:false`. Reasonable — 3 of 6 wrappers (builder-sim, customer-sim, forge-chat-multi-turn) don't route through `callLlm` directly, so the raw sink is empty for those cells. The path to re-enabling it is not documented in the source tree.

7. **Forge-chat composite missing stream-quality dim** despite `stream-quality.ts:18-21` declaring thresholds. The campaign records the metrics (lines 686-693 — `stream_ttft_ms`, `stream_max_stall_ms`, `stream_p95_gap_ms`, etc.) but never folds them into `score`.

8. **`session.ts` re-exports `summarizeTextForTrace`** (`session.ts:25`) — barrel-style hiding the source. Per CLAUDE.md style, inline import preferred.

---

## 3. Target architecture

### 3a. The 6 EvalKinds in scope

Each EvalKind dispatches in `makeCanonicalRunner` at `canonical-campaign.ts:306-353`. Substrate primitives used:

| Kind | Runner | Substrate primitives consumed |
|---|---|---|
| `builder-sim` | `runForgeBuilderSim` (`canonical-campaign.ts:355-414`) | `TraceEmitter.startRun/endRun/abortRun`, `KnowledgeReadinessReport` |
| `customer-sim` | `runCustomerSim` (`canonical-campaign.ts:416-465`) | `TraceEmitter`, `CampaignRunOutcome` |
| `forge-chat` | `runForgeChatThroughRuntime` + judge + tool-fidelity + stream-quality (`canonical-campaign.ts:467-698`) | `runEvalCampaign`, `JudgeScoresRecord`, `interRaterReliability`, `withJudgeRetry` (transitively via callLlmJson retry shape) |
| `forge-chat-multi-turn` | Multi-turn loop + `composeMultiTurnOutcome` (`canonical-campaign.ts:708-840`) | `TraceEmitter`, `JudgeScoresRecord` |
| `knowledge-authoring` | `scoreAuthoredKnowledge` deterministic rubric (`canonical-campaign.ts:850-943`) | `TraceEmitter`, `parseKnowledgePageFromReply` |
| `integration-grant` | `scoreIntegrationGrantFlow` against manifest (`canonical-campaign.ts:953-1075`) | `TraceEmitter`, `ObservedIntegrationCall` |

Substrate primitives the campaign relies on at the boundary: `runEvalCampaign`, `RawProviderSink`, `TraceStore`, `assertLlmRoute`, `assertRunCaptured`, `JudgeScoresRecord`. Substrate primitive the campaign should but does not yet call: `assertRealBackend` (0.31.0). See T-24.

### 3b. The three execution gaps with target callgraphs

#### Gap 1 — `evaluateAutoPromote` wired into PATCH + cron

**Today:**
```
admin clicks Approve → PATCH /api/admin/proposals → decideProposal({status:'promoted'}) → row updated, gate never runs
```

**After Half A:**
```
admin clicks Approve
  → PATCH /api/admin/proposals { id, status:'approved' }   ← cheap path: status='approved', not 'promoted'
  → decideProposal({status:'approved'})
  → (out of band) cron 0 16 * * * fires
    → for each row.status='approved':
      → buildBaselineCandidateScores(agentId, baseline, candidate)
        → runEvalCampaign(...baseline) → per-scenario scores
        → runEvalCampaign(...candidate) → per-scenario scores
      → runDifferentialEval({ ids, baseline, candidate }, { adversarialPassRate, thresholds })
      → evaluateEvolveGate({ calibration, adversarialPassRate, baselineDaysCovered })
      → evaluateAutoPromote({ differential, evolveGate })
      → decideProposal({status: autoPromote.decision === 'promote' ? 'promoted' : 'failed-gate', gateVerdict})
```

The PATCH stays cheap; status goes `pending → approved`. The cron flips `approved → promoted` only after auto-promote returns `'promote'`, else `approved → failed-gate` with the verdict persisted.

The cron also runs after every prod-trace harvest (so post-harvest analyst findings that propose new candidates are gated immediately, not waiting for the next admin click).

#### Gap 2 — same as Gap 1 (the PATCH boundary IS the gap)

The cron above is the missing follow-up.

#### Gap 3 — `pareto-judges` consulted at judge-resolution time

**Today:**
```
forge-chat-judge.scoreForgeChatResponse → resolveJudgeModels(override?) → env FORGE_JUDGE_MODELS → DEFAULT_FORGE_JUDGE_MODELS
```

**After Half A:**
```
forge-chat-judge.scoreForgeChatResponse → resolveJudgeModels({ override, calibration?, costs? })
  → if override → return override
  → if env FORGE_JUDGE_MODELS → return env list
  → if env JUDGE_BUDGET_TIER set AND calibration data present:
    → computeParetoTiers({ calibration, costs, minPearson: 0.6 })
    → return tiers[JUDGE_BUDGET_TIER].judgeIds (recommended fallback when not satisfied)
  → return DEFAULT_FORGE_JUDGE_MODELS
```

Calibration data is read from D1 (`calibration-store.ts`); costs from a small static map in `pareto-judges.ts` or env (`FORGE_JUDGE_COST_<MODEL>=0.005`).

### 3c. The 12 scaffold templates to add/expand

Listed in dependency order (later ones reference earlier ones):

| New / expanded template | Renders to | Depends on |
|---|---|---|
| T06 `db-schema.ts` (expand) | adds `eval_run`, `span`, `trace_event`, `analyst_finding`, `system_prompt_proposal`, `judge_calibration`, `prod_trace_sample` to `src/lib/.server/db/schema.ts` | — |
| T07 `trace-store-d1.ts` (new) | `src/lib/.server/eval/trace-store-d1.ts` (D1 `TraceStore` impl) | T06 |
| T08 `trace-analysis-store-d1.ts` (new) | `src/lib/.server/eval/d1-trace-analysis-store-adapter.ts` (D1 `TraceAnalysisStore`) | T06, T07 |
| T09 `outcome-store-d1.ts` (new) | `src/lib/.server/eval/outcome-store-d1.ts` (D1 `OutcomeStore`) | T06 |
| T10 `findings-store.ts` (new) | `src/lib/.server/eval/findings-d1-store.ts` + `src/routes/api.admin.findings.ts` + `src/routes/app.admin.findings.tsx` | T06 |
| T11 `tool-fidelity.ts` (new) | `tests/eval/lib/tool-fidelity.ts` (pure module) | — |
| T12 `stream-quality.ts` (new) | `tests/eval/lib/stream-quality.ts` (pure module) | — |
| T13 `judges.ts` (expand) | `tests/eval/lib/judges.ts` — 3-judge default + IRR + `JudgeScoresRecord` shape | T11 (composite math) |
| T14 `canonical-campaign.ts` (new) | `tests/eval/lib/canonical-campaign.ts` — `buildCanonicalCampaign({ scenarios, kinds })` | T11, T12, T13 |
| T15 `differential-eval.ts` (new) | `tests/eval/lib/differential-eval.ts` (B3 harness) | — |
| T16 `evolve-gate.ts` (new) | `tests/eval/lib/evolve-gate.ts` (B4 gate) | — |
| T17 `auto-promote.ts` (new) | `tests/eval/lib/auto-promote.ts` (composes T15 + T16) | T15, T16 |
| T18 `proposals.ts` (new) | `src/lib/.server/eval/proposals-store.ts` + `/api/admin/proposals` + `/app/admin/proposals` | T06 |
| T19 `calibration.ts` (new) | `src/lib/.server/eval/calibration-store.ts` + `/api/admin/calibration` + `/app/admin/calibrate` | T06 |
| T20 `prod-trace-harvest.ts` (new) | `src/lib/.server/eval/prod-trace-harvest.ts` + cron wiring in `templates/server.ts` | T06, T07 |
| T21 `cron.ts` (expand) | adds harvest + diff-gate cron triggers to `wrangler.toml`/`server.ts` template | T20 |
| T22 `adversarial.ts` (new) | `tests/eval/lib/adversarial-probes.ts` registry slot | — |

Each template is an ADDITIVE change. `scaffold-agent.ts` lines 80-260 gets a new `files.push(...)` block per template; existing pushes are unchanged. The recipe component map (`recipe.ts:75+`) gets new ids: `differential_gate`, `evolve_gate`, `trace_store_d1`, `findings_mirror`, `proposals_queue`, `calibration_store`, `prod_trace_harvest`, `tool_fidelity`, `stream_quality`, `adversarial_probes`. The judge dimensions (`judges.ts:42-43`) stay the same.

---

## 4. Migration tasks

Tasks are dependency-ordered. Each names file, line range, current code, target code, and a verifiable check.

### 4a. Half A — close the 3 execution gaps (T01-T05)

---

**T01 — Wire `evaluateAutoPromote` into a new cron + a callable from the PATCH path.**

- File to add: `src/lib/.server/eval/auto-promote-runner.ts`
- File to edit: `server.ts` (top-level cron dispatcher)
- File to edit: `wrangler.toml` (add a 4th cron trigger `0 16 * * *`)

Current state: `evaluateAutoPromote` (`auto-promote.ts:37-89`) is unit-tested but uncalled.

Target (new file `auto-promote-runner.ts`):

```ts
/**
 * Promotion gate driver — for every proposal in status='approved',
 * runs the differential A/B against baseline vs candidate, reads the
 * latest calibration + adversarial + baseline-days inputs, composes
 * via evaluateAutoPromote, and persists the verdict.
 *
 * Idempotent — re-running over the same proposal is a no-op once the
 * status moves out of 'approved'.
 */
import { evaluateAutoPromote } from './auto-promote'
import { runDifferentialEval, type PairedScores } from './differential-eval'
import { latestCalibrationCells } from './calibration-store'
import { latestAdversarialPassRate } from './adversarial-scenarios'
import { baselineDaysCovered } from './run-record-store'
import { decideProposal, listProposals } from './proposals-store'
import { buildBaselineCandidateScores } from './differential-driver' // new helper, T03

export interface AutoPromoteRunSummary {
  proposalsConsidered: number
  promoted: number
  rejected: number
  held: number
  blocked: number
  errors: Array<{ proposalId: string; message: string }>
}

export async function runAutoPromoteCron(db: D1Database): Promise<AutoPromoteRunSummary> {
  const rows = await listProposals(db, { status: 'approved', limit: 100 })
  const summary: AutoPromoteRunSummary = {
    proposalsConsidered: rows.length,
    promoted: 0, rejected: 0, held: 0, blocked: 0,
    errors: [],
  }
  for (const row of rows) {
    try {
      const scores = await buildBaselineCandidateScores(db, row)
      const calibration = await latestCalibrationCells(db, { agentId: row.agentId })
      const adversarialPassRate = await latestAdversarialPassRate(db, { agentId: row.agentId })
      const days = await baselineDaysCovered(db, { agentId: row.agentId })
      const differential = runDifferentialEval(scores, { adversarialPassRate })
      const result = evaluateAutoPromote({
        evolveGate: { calibration, adversarialPassRate, baselineDaysCovered: days },
        differential,
      })
      const nextStatus = result.decision === 'promote' ? 'promoted' : 'failed-gate'
      await decideProposal(db, row.id, {
        status: nextStatus,
        reviewerEmail: 'auto-promote-cron',
        reviewerNotes: result.rationale,
        gateVerdict: differential,
      })
      summary[result.decision === 'promote' ? 'promoted' : result.decision === 'reject' ? 'rejected' : result.decision === 'hold' ? 'held' : 'blocked'] += 1
    } catch (err) {
      summary.errors.push({
        proposalId: row.id,
        message: err instanceof Error ? err.message : String(err),
      })
    }
  }
  return summary
}
```

Server wiring (`server.ts:80+` — add a new branch alongside the existing `0 13`, `0 14`, `0 15` blocks):

```ts
} else if (controller.cron === '0 16 * * *') {
  // 16:00 UTC tick — auto-promote driver for approved proposals
  try {
    const out = await runAutoPromoteCron(env.DB)
    console.log(
      `[cron ${controller.cron}] auto-promote: considered=${out.proposalsConsidered} ` +
        `promoted=${out.promoted} rejected=${out.rejected} held=${out.held} ` +
        `blocked=${out.blocked} errors=${out.errors.length}`,
    )
    if (out.errors.length > 0) {
      console.warn(`[cron ${controller.cron}] auto-promote errors:`, JSON.stringify(out.errors.slice(0, 5)))
    }
  } catch (err) {
    console.error(`[cron ${controller.cron}] auto-promote failed:`, err)
  }
}
```

`wrangler.toml:30` becomes:
```toml
crons = ["0 13 * * *", "0 14 * * *", "0 15 * * *", "0 16 * * *"]
```

Test impact:
- New: `tests/unit/auto-promote-runner.test.ts` (≥10 cases — empty, single proposal happy path, B4-blocked, B3-lose, B3-tie, B3-win, error handling on D1 failure, idempotent re-run, partial batch with one error, ≥100-proposal batch performance smoke).
- Extended: existing `tests/unit/auto-promote.test.ts` (no change required — pure module already covered).
- Extended: `tests/integration/cron.test.ts` (add a `'0 16 * * *'` branch assertion).

Completion check:
```bash
pnpm typecheck && pnpm test -- auto-promote
grep -n "runAutoPromoteCron" server.ts                       # must hit
grep -n "0 16 \\* \\* \\*" wrangler.toml                     # must hit
```

---

**T02 — Make `/api/admin/proposals` PATCH end at `approved`, never `promoted`.**

- File to edit: `src/routes/api.admin.proposals.ts` lines 100-117

Current code at line 108:
```ts
if (!VALID_STATUSES.includes(body.status as ProposalStatus)) {
  return Response.json({ error: 'invalid status' }, { status: 400 })
}
```

Target — PATCH may set `approved` or `rejected` only. The gate (T01) is the only path to `promoted`/`failed-gate`:

```ts
const PATCH_ALLOWED_STATUSES: readonly ProposalStatus[] = ['approved', 'rejected'] as const
if (!PATCH_ALLOWED_STATUSES.includes(body.status as ProposalStatus)) {
  return Response.json(
    { error: 'PATCH may set status=approved|rejected only; promotion is gated via the auto-promote cron' },
    { status: 400 },
  )
}
```

Also delete the misleading "deferred" comment block at lines 1-15 and replace with the actual contract:

```ts
/**
 * Admin proposals API — GET list / POST create / PATCH decide.
 *
 * PATCH transitions: pending → approved | rejected.
 * Auto-promote cron (server.ts handler for 0 16 UTC) drives:
 *   approved → promoted        (when B3 differential + B4 evolve gates both pass)
 *   approved → failed-gate     (otherwise; gateVerdict persisted)
 *
 * Auth: session-admin (cookie) for admin clicks, bearer for CLI
 * proposal upload. We allow either via dual gate.
 */
```

Test impact:
- New unit: `tests/unit/api.admin.proposals.test.ts` (PATCH with `status='promoted'` returns 400; PATCH with `status='approved'` returns 200; PATCH transitions through the validated set; unauthorized PATCH returns 401).
- Extended: existing admin-route integration test that exercised promoted-via-PATCH should be updated to go through the cron simulation (`runAutoPromoteCron` with a mocked differential).

Completion check:
```bash
pnpm test -- api.admin.proposals
curl -X PATCH -d '{"id":"x","status":"promoted"}' /api/admin/proposals → 400
```

---

**T03 — `buildBaselineCandidateScores` helper.**

- File to add: `src/lib/.server/eval/differential-driver.ts`

This is the missing link that connects a stored proposal (baselinePrompt + candidatePrompt) to the per-scenario score arrays the differential harness needs. It uses the existing `buildCanonicalCampaign` shape but runs it twice — once per prompt — over the same scenario set + same seeds, then pairs the records by `scenarioId`.

```ts
/**
 * Given a proposal row, run the canonical campaign twice — once
 * with the baseline system prompt and once with the candidate —
 * over the same scenario set + same seed. Pair the per-scenario
 * composite scores by scenarioId and return `PairedScores` for
 * `runDifferentialEval`.
 *
 * Requires AGENT_ID + USER_ID + router credentials wired via env.
 */
import { runEvalCampaign } from '@tangle-network/agent-eval'
import { buildCanonicalCampaign } from './canonical-campaign'
import type { PairedScores } from './differential-eval'
import type { ProposalRow } from './proposals-store'

export async function buildBaselineCandidateScores(
  db: D1Database,
  row: ProposalRow,
): Promise<PairedScores> {
  // Baseline run
  const baselineResult = await runEvalCampaign(
    buildCanonicalCampaign({
      campaignId: `auto-promote-baseline-${row.id}`,
      routerBaseUrl: process.env.TANGLE_ROUTER_URL ?? 'https://router.tangle.tools/v1',
      routerApiKey: process.env.TANGLE_API_KEY ?? '',
      systemPromptOverride: row.baselinePrompt,
      // ... other args from the agent's existing canonical config
    }),
  )
  // Candidate run
  const candidateResult = await runEvalCampaign(
    buildCanonicalCampaign({
      campaignId: `auto-promote-candidate-${row.id}`,
      routerBaseUrl: process.env.TANGLE_ROUTER_URL ?? 'https://router.tangle.tools/v1',
      routerApiKey: process.env.TANGLE_API_KEY ?? '',
      systemPromptOverride: row.candidatePrompt,
    }),
  )

  // Pair by scenarioId.
  const baselineMap = new Map(baselineResult.runs.map((r) => [r.scenarioId, r.score]))
  const candidateMap = new Map(candidateResult.runs.map((r) => [r.scenarioId, r.score]))
  const ids: string[] = []
  const baseline: number[] = []
  const candidate: number[] = []
  for (const [scenarioId, b] of baselineMap) {
    const c = candidateMap.get(scenarioId)
    if (c === undefined) continue
    ids.push(scenarioId)
    baseline.push(b)
    candidate.push(c)
  }
  return { ids, baseline, candidate }
}
```

This requires extending `BuildCanonicalCampaignArgs` to accept `systemPromptOverride` — see T05.

Test impact:
- New unit: `tests/unit/differential-driver.test.ts` — mock the two campaign runs, assert pairing by `scenarioId`, missing-scenario filtering, empty result handling.

Completion check:
```bash
pnpm test -- differential-driver
```

---

**T04 — Wire `pareto-judges.computeParetoTiers` into `forge-chat-judge.resolveJudgeModels`.**

- File to edit: `src/lib/.server/eval/forge-chat-judge.ts` lines 120-129
- File to edit: `src/lib/.server/eval/pareto-judges.ts` (add a tier-resolver entry point that reads D1 calibration)

Current `resolveJudgeModels` at `forge-chat-judge.ts:120-129`:
```ts
export function resolveJudgeModels(override?: readonly string[]): string[] {
  if (override && override.length > 0) return [...override]
  const envVal = (typeof process !== 'undefined' && process.env?.FORGE_JUDGE_MODELS) || ''
  const fromEnv = envVal
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
  if (fromEnv.length > 0) return fromEnv
  return [...DEFAULT_FORGE_JUDGE_MODELS]
}
```

Target:
```ts
export interface ResolveJudgeOpts {
  override?: readonly string[]
  /** When provided, JUDGE_BUDGET_TIER env is consulted and Pareto-optimal
   *  subsets are computed from these calibration cells. */
  calibration?: CalibrationCell[]
  /** Optional per-judge cost overrides. Defaults to FORGE_JUDGE_COSTS env. */
  costs?: JudgeCostCell[]
}

export function resolveJudgeModels(opts: ResolveJudgeOpts = {}): string[] {
  if (opts.override && opts.override.length > 0) return [...opts.override]
  const envVal = (typeof process !== 'undefined' && process.env?.FORGE_JUDGE_MODELS) || ''
  const fromEnv = envVal.split(',').map((s) => s.trim()).filter((s) => s.length > 0)
  if (fromEnv.length > 0) return fromEnv

  // Cost-aware Pareto tier resolution — only when explicitly requested
  // AND calibration data is present. Falls back to DEFAULT on insufficient signal.
  const tier = process.env.JUDGE_BUDGET_TIER as 'low' | 'standard' | 'thorough' | undefined
  if (tier && opts.calibration && opts.calibration.length > 0) {
    const costs = opts.costs ?? loadCostsFromEnv()
    const report = computeParetoTiers({
      calibration: opts.calibration,
      costs,
      minPearson: 0.6,
    })
    const selection = report[tier]
    if (selection.satisfiesBar && selection.judgeIds.length > 0) {
      return selection.judgeIds
    }
    // Fall through — log + fail-loud-ish via warn line; the gate further
    // upstream (evolve-gate Pearson check) will block /evolve anyway.
    console.warn(
      `[resolveJudgeModels] JUDGE_BUDGET_TIER=${tier} did not satisfy minPearson=0.6 ` +
        `— falling back to DEFAULT_FORGE_JUDGE_MODELS`,
    )
  }
  return [...DEFAULT_FORGE_JUDGE_MODELS]
}

function loadCostsFromEnv(): JudgeCostCell[] {
  // FORGE_JUDGE_COSTS env: "claude-code/sonnet:0.012,opencode/zai-coding-plan/glm-5.1:0.005,..."
  const raw = process.env.FORGE_JUDGE_COSTS ?? ''
  return raw.split(',').filter(Boolean).map((entry) => {
    const [judgeId, costStr] = entry.split(':')
    const cost = Number(costStr)
    if (!judgeId || Number.isNaN(cost)) {
      throw new Error(`FORGE_JUDGE_COSTS malformed entry: ${entry}`)
    }
    return { judgeId: judgeId.trim(), costPerCell: cost }
  })
}
```

And one caller site at `scoreForgeChatResponse` (lines 139-143) updates:
```ts
const judgeModels = resolveJudgeModels({
  override: args.judgeModels,
  calibration: args.calibration,        // new field, optional
  costs: args.costs,                    // new field, optional
})
```

Test impact:
- Extended: `tests/unit/pareto-judges.test.ts` (already exists) — add cases for: env tier with no calibration → returns DEFAULT; env tier with calibration that satisfies → returns Pareto pick; env tier with calibration that doesn't satisfy → warns + DEFAULT.
- New: `tests/unit/forge-chat-judge-resolve.test.ts` — pin the precedence ladder explicitly.

Completion check:
```bash
pnpm test -- pareto forge-chat-judge
JUDGE_BUDGET_TIER=low FORGE_JUDGE_COSTS="claude-code/sonnet:0.012,..." node -e \
  "console.log(require('./dist/.../forge-chat-judge').resolveJudgeModels({calibration:[...]}))"
```

---

**T05 — Extend `BuildCanonicalCampaignArgs` to accept `systemPromptOverride`.**

- File to edit: `src/lib/.server/eval/canonical-campaign.ts` lines 93-160 (the `BuildCanonicalCampaignArgs` interface) and inside `makeCanonicalRunner` where `args.forgeChat.systemPrompt` is read (search for `systemPrompt` in the file).

Current shape lacks any system-prompt-override field. T03 needs this so it can re-run the canonical campaign with a candidate prompt without re-instantiating the full args.

Target — add an optional override that, when present, replaces `args.forgeChat.systemPrompt` for forge-chat / forge-chat-multi-turn cells:

```ts
export interface BuildCanonicalCampaignArgs {
  campaignId: string
  routerBaseUrl: string
  routerApiKey: string
  // ... existing fields ...
  /** Optional override applied to forge-chat[-multi-turn] cells only.
   *  Used by the auto-promote driver to run a candidate variant of the
   *  same scenario set without rebuilding the args. */
  systemPromptOverride?: string
}
```

And inside the forge-chat cell runner, prefer the override:
```ts
const systemPrompt = args.systemPromptOverride ?? args.forgeChat.systemPrompt
```

Test impact:
- New unit: `tests/unit/canonical-campaign-override.test.ts` — assert the override propagates to the forge-chat runner and DOES NOT affect builder-sim / customer-sim / knowledge-authoring / integration-grant cells.

Completion check:
```bash
pnpm test -- canonical-campaign-override
```

### 4b. Half B — scaffold templates (T06-T22)

All Half B tasks add to `src/lib/.server/scaffold/templates/` and register the new files in `src/lib/.server/scaffold/scaffold-agent.ts` (lines 80-260). Tests in `tests/unit/scaffold-*.test.ts`.

The high-level pattern: each task adds a `render*` function in a new template file, adds a `files.push(...)` block to `scaffoldAgent`, and adds a unit test that re-scaffolds with `goodInput()` and asserts the new file is present + structurally correct.

---

**T06 — Extend `templates/db-schema.ts` to emit the eval/observability D1 tables.**

- File to edit: `src/lib/.server/scaffold/templates/db-schema.ts` (currently 93 lines, only emits subscription + billing tables)

Current rendered output covers `subscriptions`, `billing_events`. The expanded template renders ALL of agent-builder's eval-side tables. Verified from the live schema by reading `src/lib/.server/db/schema.ts`:

Tables to add (Drizzle TypeScript):
- `eval_run` — campaign run record (run_id PK, project_id, layer, code_sha, prompt_sha, model_fingerprint, seed, env_fingerprint, started_at, ended_at, status)
- `span` — substrate span persistence
- `trace_event` — agent-eval Run event log
- `analyst_finding` — D1 mirror of FindingsStore JSONL
- `system_prompt_proposal` — proposal queue
- `judge_calibration_cell` — per-(judge × dim) Pearson cells
- `judge_calibration_sample` — raw human-vs-judge pairs
- `prod_trace_sample` — harvested stratified samples
- `deployment_outcome` — for `OutcomeStore` three-layer correlation

Target structure: copy the schema definitions from `/home/drew/code/agent-builder/src/lib/.server/db/schema.ts` lines for those tables, parameterise on `${input.slug}_db` where needed, and re-emit as a string from `renderDbSchema(input)`. Use `import { type DBT = D1Database; ... }` style so the template doesn't need a sql migration file (Drizzle generates it).

Test impact:
- Extended: `tests/unit/scaffold-agent.test.ts` — assert `plan.files.find(f => f.path === 'src/lib/.server/db/schema.ts')` contains `analyst_finding`, `system_prompt_proposal`, `judge_calibration_cell`, `prod_trace_sample`.

Completion check:
```bash
pnpm test -- scaffold-agent
ts-node -e "const {scaffoldAgent} = require('./src/lib/.server/scaffold/scaffold-agent'); \
  const plan = scaffoldAgent({...}); \
  const schema = plan.files.find(f => f.path === 'src/lib/.server/db/schema.ts').content; \
  assert(schema.includes('analyst_finding'), 'missing analyst_finding')"
```

---

**T07 — New template: `templates/trace-store-d1.ts` emitting `src/lib/.server/eval/trace-store-d1.ts`.**

- File to add: `src/lib/.server/scaffold/templates/trace-store-d1.ts`

The rendered output mirrors the structure of `/home/drew/code/agent-builder/src/lib/.server/eval/trace-store-d1.ts` (437 lines) — a `D1TraceStore implements TraceStore` with `ON CONFLICT(run_id)` idempotency, span batch insert, event filter querying. The `${input.slug}`-specific bits are: the table names (parameterised, but stable across agents) and the type imports.

Skeleton (the actual rendered content is ~430 lines of TS):
```ts
import type { RecipeInput } from '../recipe-types'

export function renderTraceStoreD1(input: RecipeInput): string {
  return `/**
 * D1-backed TraceStore for the ${input.slug} agent.
 *
 * Implements the substrate's TraceStore contract over D1. Idempotent
 * appendRun via ON CONFLICT(run_id). Span / event inserts batch via
 * d1.batch().
 */
import type {
  Artifact, BudgetLedgerEntry, EventFilter, Run, RunFilter, RunStatus,
  Span, SpanFilter, TraceEvent, TraceStore,
} from '@tangle-network/agent-eval'
// ... [full implementation copied from agent-builder source] ...
`
}
```

Wiring in `scaffold-agent.ts` (insert after the `db-schema` block at line 165):
```ts
files.push({
  path: 'src/lib/.server/eval/trace-store-d1.ts',
  content: renderTraceStoreD1(input),
  component: 'trace_store_d1',
})
```

New recipe component `'trace_store_d1'` in `recipe.ts` + `RECIPE_COMPONENT_IDS`.

Test impact:
- New: `tests/unit/scaffold-trace-store-d1.test.ts` — assert file present, contains `class D1TraceStore`, contains `ON CONFLICT(run_id)`, contains the right table names from T06.

Completion check:
```bash
pnpm test -- scaffold-trace-store
```

---

**T08 — New template: `templates/trace-analysis-store-d1.ts` emitting D1 `TraceAnalysisStore`.**

- File to add: `src/lib/.server/scaffold/templates/trace-analysis-store-d1.ts`

Mirrors `d1-trace-analysis-store-adapter.ts` (802 lines) — implements `TraceAnalysisStore` from `@tangle-network/agent-eval/traces`. Powers per-build deep analyst (T22 would optionally enable it).

Skeleton same shape as T07. Recipe component `'trace_analysis_store_d1'`.

Test impact:
- New: `tests/unit/scaffold-trace-analysis-store.test.ts`.

Completion check:
```bash
pnpm test -- scaffold-trace-analysis-store
```

---

**T09 — New template: `templates/outcome-store-d1.ts` emitting D1 `OutcomeStore`.**

- File to add: `src/lib/.server/scaffold/templates/outcome-store-d1.ts`

Mirrors `outcome-store-d1.ts` (147 lines) — implements substrate's `OutcomeStore` for three-layer correlation via `scoreProject`.

Recipe component `'outcome_store_d1'`.

Test impact:
- New: `tests/unit/scaffold-outcome-store.test.ts`.

---

**T10 — New template: `templates/findings-store.ts` emitting the D1 findings store + admin route + admin UI.**

- File to add: `src/lib/.server/scaffold/templates/findings-store.ts`

Renders three files:
1. `src/lib/.server/eval/findings-d1-store.ts` (mirror of agent-builder's 200-line module)
2. `src/routes/api.admin.findings.ts` (mirror — bearer-gated upsert + session-gated list)
3. `src/routes/app.admin.findings.tsx` (mirror of the React Router admin UI)

The CLI analyst loop (rendered by the existing `agent-config.ts` template at `renderAnalystLoop`) already writes to a JSONL ledger. The new findings-d1 layer adds a one-line `await fetch('/api/admin/findings', { method: 'POST', body: JSON.stringify({findings}) })` after the local persist so the Worker can serve them.

Modify the existing `templates/agent-config.ts` `renderAnalystLoop` rendering (lines 285+) to add the mirror call after the local store write. Inside the rendered `main()` after `result = await runAnalystLoop(...)`:

```ts
// Mirror findings to Worker-readable D1 so /app/admin/findings can serve them.
if (process.env.ADMIN_BASE_URL) {
  await fetch(\`\${process.env.ADMIN_BASE_URL}/api/admin/findings\`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: \`Bearer \${process.env.SIM_ADMIN_TOKEN ?? ''}\`,
    },
    body: JSON.stringify({ findings: result.analystResult.findings }),
  }).catch((err) => console.warn('[eval:improve] D1 mirror failed:', err))
}
```

Recipe components `'findings_mirror'` (D1 + route) + `'findings_review_ui'` (UI page).

Test impact:
- New: `tests/unit/scaffold-findings-store.test.ts` — assert all three files emitted; UI file is a `.tsx` and contains an `export default` React component.
- Extended: `tests/unit/scaffold-agent.test.ts` — bump file count assertion at line 108 (currently `>=22`).

Completion check:
```bash
pnpm test -- scaffold-findings
```

---

**T11 — New template: `templates/tool-fidelity.ts` emitting `tests/eval/lib/tool-fidelity.ts`.**

- File to add: `src/lib/.server/scaffold/templates/tool-fidelity.ts`

Renders the deterministic tool-call fidelity rubric (mirror of `src/lib/.server/eval/tool-fidelity.ts`, 240 lines). Pure module — input is an `ObservedToolCall[]` + `ToolCallMatcher[]`, output is `{ score, breakdown, failures }`. Folded into the composite at T13/T14.

Recipe component `'tool_fidelity'`.

Test impact:
- New: `tests/unit/scaffold-tool-fidelity.test.ts` — assert the rendered module's `computeToolFidelity` produces score=1 for `[] expected + [] observed`, score=0 for `[] expected + [observed_x]`.

Completion check:
```bash
pnpm test -- scaffold-tool-fidelity
```

---

**T12 — New template: `templates/stream-quality.ts` emitting `tests/eval/lib/stream-quality.ts`.**

- File to add: `src/lib/.server/scaffold/templates/stream-quality.ts`

Renders the streaming-quality module (mirror of `src/lib/.server/eval/stream-quality.ts`, 127 lines). Inputs: `startedAt`, `deltaTimestamps[]`, `finalTextLen`, `endedAt`. Outputs: `{ ttft_ms, max_stall_ms, p95_gap_ms, total_ms, delta_count, chars_per_second, tokens_per_second_estimate, failures }`.

Recipe component `'stream_quality'`.

Test impact:
- New: `tests/unit/scaffold-stream-quality.test.ts` — assert TTFT computation, stall detection from synthetic timestamps.

---

**T13 — Expand `templates/judges.ts` — 3-judge ensemble + IRR + `JudgeScoresRecord` shape.**

- File to edit: `src/lib/.server/scaffold/templates/judges.ts` lines 38-189

Current rendered output (lines 73-74) defaults to 2 judges:
```ts
const judges = (process.env.${input.slug.toUpperCase().replace(/-/g, '_')}_JUDGE_MODELS ?? 'anthropic/claude-sonnet-4,openai/gpt-5.4')
```

Target — 3 judges (mirror agent-builder's `DEFAULT_FORGE_JUDGE_MODELS`) AND emit `JudgeScoresRecord` shape AND prepend `interRaterReliability` to notes when ≥2 succeed:

```ts
const judges = (process.env.${slugUpper}_JUDGE_MODELS ?? 'claude-code/sonnet,opencode/zai-coding-plan/glm-5.1,kimi-code/kimi-k2.6')
  .split(',').map((s) => s.trim()).filter(Boolean)
```

And replace the `rubricScore` return shape from `Record<RubricDimension, number>` to `JudgeScoresRecord`:

```ts
import {
  interRaterReliability,
  withJudgeRetry,
  type JudgeScore,
  type JudgeScoresRecord,
} from '@tangle-network/agent-eval'

export async function rubricScore(args: ScoreArgs): Promise<JudgeScoresRecord> {
  // ... same fan-out via Promise.allSettled ...
  const failedJudges: string[] = []
  const perJudge: Record<string, Record<string, number>> = {}
  // populate perJudge + failedJudges from outcomes
  // compute perDimMean over surviving judges
  // compute composite = mean(perDimMean[dim] for dim in args.dimensions)
  // build IRR via interRaterReliability(survivingScores)
  const notes = irr !== null ? \`IRR α=\${irr.toFixed(2)}\` : undefined
  return { perJudge, perDimMean, composite, failedJudges: failedJudges.length > 0 ? failedJudges : undefined, notes }
}
```

Mirror the structure from `forge-chat-judge.ts:139-237` of agent-builder.

Test impact:
- Extended: `tests/unit/scaffold-agent.test.ts` — replace assertion at line 169 (`'completeness'`) to also assert the 3-judge default is emitted; assert the rendered file imports `interRaterReliability`, `JudgeScoresRecord`.
- New: `tests/unit/scaffold-judges-shape.test.ts` — instantiate the rendered file in a sandbox `tsx`, assert `JudgeScoresRecord` shape returned.

Completion check:
```bash
pnpm test -- scaffold-judges
```

---

**T14 — New template: `templates/canonical-campaign.ts` emitting `tests/eval/lib/canonical-campaign.ts`.**

- File to add: `src/lib/.server/scaffold/templates/canonical-campaign.ts`

This is THE BIG ONE. Renders a per-agent `buildCanonicalCampaign({...})` modeled after agent-builder's `canonical-campaign.ts:175-255` but parameterised on which EvalKinds the agent declares. The shape:

```ts
import { runEvalCampaign, /* ... */ } from '@tangle-network/agent-eval'
import { rubricScore } from './judges'
import { computeToolFidelity } from './tool-fidelity'   // T11
import { computeStreamQuality } from './stream-quality' // T12

export interface BuildCampaignArgs {
  campaignId: string
  scenarios: ReadonlyArray<Scenario>  // depends on what the agent declares
  // ...
  systemPromptOverride?: string       // honors T05
}

export function buildCanonicalCampaign(args: BuildCampaignArgs): EvalCampaignOptions<Payload> {
  const variants = [{ id: 'canonical', payload: { scenarios: args.scenarios } }]
  // ...
  return {
    campaignId: args.campaignId,
    variants,
    scenarios: args.scenarios.map((s) => ({ scenarioId: s.id, tags: { kind: s.kind } })),
    seeds: args.seeds ?? [0],
    splitTag: 'holdout',
    llmOpts: { baseUrl, apiKey },
    integrity: {
      llmSpansMin: 0,
      rawProviderEventsMin: 0,
      requireOutcome: true,
      requireRawCoverageOfLlmSpans: false,    // documented in comment with path to re-enable
    },
    onIntegrityFailure: 'mark_failed',
    runner: makeRunner({ ... }),
    report: { comparator: 'canonical', rope: { low: -0.02, high: 0.02 } },
    concurrency: 1,
  }
}
```

The `makeRunner` factory dispatches on `scenario.kind` and folds tool-fidelity + stream-quality + judge scores into the composite using a configurable weight (T28). The rendered file is ~400 lines. At minimum it dispatches `forge-chat`, `forge-chat-multi-turn`, `knowledge-authoring`; the four other kinds (`builder-sim`, `customer-sim`, `integration-grant`) only get rendered when the agent declares those surfaces in its RecipeInput.

Wiring: `scaffold-agent.ts` adds:
```ts
files.push({
  path: 'tests/eval/lib/canonical-campaign.ts',
  content: renderCanonicalCampaign(input),
  component: 'judge_ensemble',
})
```

The existing 1-kind `templates/canonical-eval.ts` gets a UNIFIED-DIFF style edit: the `runPersona` loop is replaced by `runEvalCampaign(buildCanonicalCampaign({...}))` so the scaffolded `pnpm eval` driver flows through the campaign dispatcher.

Recipe component `'canonical_campaign'`.

Test impact:
- New: `tests/unit/scaffold-canonical-campaign.test.ts` — type-check the rendered file via `tsx --eval`, assert it returns an `EvalCampaignOptions` shape with `runner`, `scenarios`, `integrity`.
- Extended: `tests/unit/scaffold-agent-extended.test.ts` — assert the rendered `tests/eval/canonical.ts` no longer contains the local `runPersona` loop and instead delegates to `buildCanonicalCampaign`.

Completion check:
```bash
pnpm test -- canonical-campaign
```

---

**T15 — New template: `templates/differential-eval.ts` emitting `tests/eval/lib/differential-eval.ts`.**

- File to add: `src/lib/.server/scaffold/templates/differential-eval.ts`

Mirror of agent-builder's `differential-eval.ts` (188 lines). The `cliffsDelta` impl moves to the substrate per T26; pre-substrate-release the rendered file keeps a local copy with a comment pointing at the substrate symbol.

Recipe component `'differential_gate'`.

Test impact:
- New: `tests/unit/scaffold-differential-eval.test.ts` — render + tsx-eval — assert `runDifferentialEval`, `cliffsDelta` exports present and behave under happy path.

---

**T16 — New template: `templates/evolve-gate.ts` emitting `tests/eval/lib/evolve-gate.ts`.**

- File to add: `src/lib/.server/scaffold/templates/evolve-gate.ts`

Mirror of agent-builder's `evolve-gate.ts` (~100 lines).

Recipe component `'evolve_gate'`.

Test impact:
- New: `tests/unit/scaffold-evolve-gate.test.ts`.

---

**T17 — New template: `templates/auto-promote.ts` emitting `tests/eval/lib/auto-promote.ts`.**

- File to add: `src/lib/.server/scaffold/templates/auto-promote.ts`

Mirror of agent-builder's `auto-promote.ts` (89 lines) — same decision matrix.

Recipe component `'auto_promote'`.

Test impact:
- New: `tests/unit/scaffold-auto-promote.test.ts`.

---

**T18 — New template: `templates/proposals.ts` emitting the proposals queue + admin route + admin UI.**

- File to add: `src/lib/.server/scaffold/templates/proposals.ts`

Renders three files:
1. `src/lib/.server/eval/proposals-store.ts` (mirror of agent-builder's 117-line module)
2. `src/routes/api.admin.proposals.ts` (mirror of the corrected-by-T02 version — PATCH only allows `approved|rejected`)
3. `src/routes/app.admin.proposals.tsx` (mirror of the admin UI)

Recipe component `'proposals_queue'`.

Test impact:
- New: `tests/unit/scaffold-proposals.test.ts` — assert all three files render, PATCH validation block is present.

---

**T19 — New template: `templates/calibration.ts` emitting the calibration store + admin route + UI.**

- File to add: `src/lib/.server/scaffold/templates/calibration.ts`

Renders three files (mirror of agent-builder's calibration surface — `calibration-store.ts` 111 lines, `api.admin.calibration.ts`, `app.admin.calibrate.tsx`).

Recipe component `'calibration_store'`.

Test impact:
- New: `tests/unit/scaffold-calibration.test.ts`.

---

**T20 — New template: `templates/prod-trace-harvest.ts` emitting the harvest module.**

- File to add: `src/lib/.server/scaffold/templates/prod-trace-harvest.ts`

Mirror of agent-builder's `prod-trace-harvest.ts` (240 lines). Sweeps `D1DurableRunStore` from `@tangle-network/agent-runtime`, stratifies by `(numToolCalls bucket, length quantile)`, picks top-K per cluster, writes to `prod_trace_sample` (T06).

Recipe component `'prod_trace_harvest'`.

Test impact:
- New: `tests/unit/scaffold-prod-trace-harvest.test.ts` — assert module renders, contains `runProdTraceHarvest(db, opts)`.

---

**T21 — Expand `templates/server.ts` + `templates/wrangler-toml.ts` for the harvest + auto-promote crons.**

- File to edit: `src/lib/.server/scaffold/templates/server.ts` lines 63-79
- File to edit: `src/lib/.server/scaffold/templates/wrangler-toml.ts` lines 50-54

Current `server.ts:63-79` only enqueues KV records on schedule; it doesn't sweep durable runs and doesn't drive auto-promote.

Target — replace the body of `scheduled()` with the same cron dispatcher pattern agent-builder uses in `server.ts:80+`:

```ts
async scheduled(event: ScheduledEvent, env: Env, _ctx: ExecutionContext): Promise<void> {
  const cron = event.cron
  if (cron === '0 6 * * *') {
    // Daily canonical eval enqueue (existing behavior — KV record).
    await env.AGENT_KV.put(\`autodev/queue/\${Date.now()}-canonical-eval\`, ...)
  } else if (cron === '0 8 * * 1') {
    // Weekly prompt evolution enqueue.
    await env.AGENT_KV.put(\`autodev/queue/\${Date.now()}-prompt-evolution\`, ...)
  } else if (cron === '0 15 * * *') {
    // Prod-trace harvest.
    const { runProdTraceHarvest } = await import('./src/lib/.server/eval/prod-trace-harvest')
    const harvest = await runProdTraceHarvest(env.DB, { windowHours: 24, topKPerCluster: 5 })
    console.log(\`[cron \${cron}] prod-trace-harvest: ...\`)
  } else if (cron === '0 16 * * *') {
    // Auto-promote driver (T01).
    const { runAutoPromoteCron } = await import('./src/lib/.server/eval/auto-promote-runner')
    const out = await runAutoPromoteCron(env.DB)
    console.log(\`[cron \${cron}] auto-promote: ...\`)
  } else {
    console.error(\`[cron \${cron}] unrecognized — wrangler.toml has a cron the dispatcher doesn't know\`)
  }
}
```

`wrangler-toml.ts:50-54` becomes:
```toml
[triggers]
crons = [
  "0 6 * * *",    # 06:00 UTC daily — canonical eval enqueue
  "0 8 * * 1",    # 08:00 UTC Monday — prompt evolution enqueue
  "0 15 * * *",   # 15:00 UTC daily — prod-trace harvest
  "0 16 * * *",   # 16:00 UTC daily — auto-promote driver
]
```

Test impact:
- Extended: `tests/unit/scaffold-agent.test.ts` line 119+ — assert wrangler.toml contains all 4 crons; assert server.ts contains the dispatcher branches.

Completion check:
```bash
pnpm test -- scaffold-agent
```

---

**T22 — New template: `templates/adversarial.ts` emitting an adversarial-probe registry slot.**

- File to add: `src/lib/.server/scaffold/templates/adversarial.ts`

Renders `tests/eval/lib/adversarial-probes.ts` — a registry of red-team probes the canonical campaign can attach to its scenario set. Empty by default with documented expansion path; agent-builder's full 20-probe suite lives in `adversarial-scenarios.ts` (503 lines) and would be too coupled to forge-chat to ship as a default. The template renders the *registry shape* + 3 generic domain-agnostic probes (off-topic refusal, prompt-injection resistance, PII-extraction refusal) so the evolve gate has data to read from day one.

Per substrate spec §10, the next substrate release should add `DEFAULT_FORGE_RED_TEAM_CORPUS` so this template can lift to substrate.

Recipe component `'adversarial_probes'`.

Test impact:
- New: `tests/unit/scaffold-adversarial.test.ts` — assert at least 3 probes rendered, each has `id`, `kind: 'adversarial'`, `expectedTools` (empty or refusal pattern).

### 4c. Half C — cleanups (T23-T28)

---

**T23 — Resolve `pearson.ts` duplication.**

- File to edit: `src/lib/.server/eval/pearson.ts` lines 12-40 (the `pearson` function)
- File to edit: substrate (filed against `agent-eval` per `/tmp/audit/spec-agent-eval-substrate.md`)

Two-step:

a) Substrate exports the canonical `pearson` (named `pearson` from `src/statistics.ts` or `src/reporting.ts`, see substrate spec). Until that ships, this task is gated.

b) After substrate publishes the export, replace the local `pearson(xs, ys)` body in `pearson.ts:12-40` with:

```ts
export { pearson } from '@tangle-network/agent-eval'
```

The `computeCalibrationCell` helper at lines 42-64 stays — it's the calibration-cell-specific wrapper.

Test impact:
- Extended: `tests/unit/pearson.test.ts` (if present) — drop the impl-specific edge case tests since substrate owns them now; keep the `computeCalibrationCell` wrapper tests.

Completion check:
```bash
grep -n "function pearson" src/lib/.server/eval/pearson.ts   # must not hit
grep -n "from '@tangle-network/agent-eval'" src/lib/.server/eval/pearson.ts  # must hit
pnpm test -- pearson
```

---

**T24 — Upstream `cliffsDelta` to substrate; consume from there.**

- File to edit: `src/lib/.server/eval/differential-eval.ts` lines 83-95

Gated on substrate releasing `cliffsDelta` per substrate spec (`/tmp/audit/spec-agent-eval-substrate.md`). Once shipped, replace the local 12-line impl with:

```ts
import { cliffsDelta } from '@tangle-network/agent-eval'
```

(deleting lines 73-95). The `runDifferentialEval` body at lines 97-188 stays.

Test impact:
- Extended: `tests/unit/differential-eval.test.ts` — assert `cliffsDelta` import works; existing impl tests pass through to the substrate symbol.

---

**T25 — Consolidate the three analyst entry points.**

Current state:
- `src/lib/.server/eval/canonical-trace-analyst.ts` (campaign-level `analyzeTraces`)
- `scripts/run-canonical-analyst-loop.ts` (`AnalystRegistry` over OTLP, 4 kinds)
- `src/lib/.server/eval/forge-deep-analyst.ts` (per-build `analyzeTraces` over D1)

Each produces different ledgers / different artifact shapes. Owners need to read three files to understand "what analyst ran where."

Target — converge on the **`AnalystRegistry`** path. `canonical-trace-analyst.ts` becomes a thin wrapper that constructs an `AnalystRegistry` over the same 4 kinds + a campaign-scope analyst (new kind: `CAMPAIGN_OVERVIEW_KIND_SPEC` produced by `createTraceAnalystKind`) and produces both the per-finding JSONL AND the human-readable `research-report.md`. `forge-deep-analyst.ts` keeps the D1 path but switches its internal `analyzeTraces` call to `AnalystRegistry.run({ kinds: [FAILURE_MODE_KIND_SPEC, IMPROVEMENT_KIND_SPEC] })` so it reuses the same primitive.

Concretely:

a) Rename / refactor `canonical-trace-analyst.ts`:
- Drop the direct `analyzeTraces` call.
- Build an `AnalystRegistry` over `[...DEFAULT_TRACE_ANALYST_KINDS, CAMPAIGN_OVERVIEW_KIND_SPEC]`.
- Persist findings via `FindingsStore` (campaign-level slot).
- Emit `research-report.md` by templating from `result.analystResult` instead of from `analyzeTraces` return shape.

b) Add a new local kind spec — `CAMPAIGN_OVERVIEW_KIND_SPEC` — in `canonical-trace-analyst.ts`:
```ts
export const CAMPAIGN_OVERVIEW_KIND_SPEC = createTraceAnalystKind({
  id: 'campaign-overview',
  description: 'Cross-cell synthesis of the entire campaign...',
  // ...
}, { /* opts */ })
```

c) `forge-deep-analyst.ts` lines 38-46 — keep imports, swap `analyzeTraces` call for `registry.run`. Persist as `JudgeSpan` (current behavior) AND optionally upsert finding via the shared `FindingsStore`.

Test impact:
- Extended: `tests/unit/canonical-trace-analyst.test.ts` — assert `CAMPAIGN_OVERVIEW_KIND_SPEC` is registered; assert findings JSONL emitted; `research-report.md` shape preserved.
- Extended: `tests/unit/forge-deep-analyst.test.ts` — assert it runs through `AnalystRegistry.run`.

Completion check:
```bash
pnpm test -- canonical-trace-analyst forge-deep-analyst
```

---

**T26 — Move composite weights + fail threshold to env-overridable config.**

- File to edit: `src/lib/.server/eval/canonical-campaign.ts` lines 612-627

Current hard-coded block:
```ts
const FAIL_THRESHOLD = 0.5
let score: number
if (!binaryPass) {
  score = 0
} else if (judgeScores && toolFidelity) {
  score = 0.6 * judgeScores.composite + 0.4 * toolFidelity.score
} else if (judgeScores) {
  // ...
```

Target — read weights + threshold from env / args once at module init:

Add a new file `src/lib/.server/eval/composite-config.ts`:
```ts
/**
 * Composite-score weights + fail threshold for forge-chat.
 *
 * Tunable via env at runtime so /evolve can experiment with weights
 * without a code edit. Defaults match the Wave A6 baseline.
 *
 *   FORGE_COMPOSITE_JUDGE_WEIGHT     default 0.6
 *   FORGE_COMPOSITE_TOOL_WEIGHT      default 0.4
 *   FORGE_COMPOSITE_STREAM_WEIGHT    default 0.0    (T27 enables ≠0)
 *   FORGE_COMPOSITE_FAIL_THRESHOLD   default 0.5
 *
 * Sum of weights must equal 1.0 — module load asserts this and throws.
 */
export interface CompositeConfig {
  judgeWeight: number
  toolWeight: number
  streamWeight: number
  failThreshold: number
}

export function loadCompositeConfig(): CompositeConfig {
  const judgeWeight = Number(process.env.FORGE_COMPOSITE_JUDGE_WEIGHT ?? '0.6')
  const toolWeight = Number(process.env.FORGE_COMPOSITE_TOOL_WEIGHT ?? '0.4')
  const streamWeight = Number(process.env.FORGE_COMPOSITE_STREAM_WEIGHT ?? '0')
  const failThreshold = Number(process.env.FORGE_COMPOSITE_FAIL_THRESHOLD ?? '0.5')
  const sum = judgeWeight + toolWeight + streamWeight
  if (Math.abs(sum - 1) > 0.0001) {
    throw new Error(
      `loadCompositeConfig: weights must sum to 1.0 (got ${sum}); ` +
        `judge=${judgeWeight} tool=${toolWeight} stream=${streamWeight}`,
    )
  }
  if (failThreshold < 0 || failThreshold > 1) {
    throw new Error(`loadCompositeConfig: failThreshold must be in [0,1] (got ${failThreshold})`)
  }
  return { judgeWeight, toolWeight, streamWeight, failThreshold }
}
```

`canonical-campaign.ts:612-627` becomes:
```ts
const cfg = loadCompositeConfig()
let score: number
if (!binaryPass) {
  score = 0
} else {
  let sum = 0
  let weightUsed = 0
  if (judgeScores) { sum += cfg.judgeWeight * judgeScores.composite; weightUsed += cfg.judgeWeight }
  if (toolFidelity) { sum += cfg.toolWeight * toolFidelity.score; weightUsed += cfg.toolWeight }
  if (streamQuality && cfg.streamWeight > 0) { sum += cfg.streamWeight * streamQuality.score; weightUsed += cfg.streamWeight }
  score = weightUsed > 0 ? sum / weightUsed : 1
}
const pass = binaryPass
  && (judgeScores === null || judgeScores.composite >= cfg.failThreshold)
  && (toolFidelity === null || toolFidelity.score >= cfg.failThreshold)
```

Note: stream-quality's current type at `stream-quality.ts:38-49` lacks a single `score` scalar. T27 adds one.

Test impact:
- New unit: `tests/unit/composite-config.test.ts` — assert defaults, env overrides, weight-sum validation, threshold validation.
- Extended: `tests/integration/canonical-campaign.test.ts` (if present) — set env weights, run campaign, assert composite reflects them.

Completion check:
```bash
FORGE_COMPOSITE_JUDGE_WEIGHT=0.5 FORGE_COMPOSITE_TOOL_WEIGHT=0.5 pnpm test -- composite
```

---

**T27 — Fold stream-quality into the composite (depends on T26).**

- File to edit: `src/lib/.server/eval/stream-quality.ts` (add a `score` scalar to `StreamQualityResult`)
- File to edit: `canonical-campaign.ts` lines 581-605 (the `streamQuality = ...` block) — emit the score into the composite when the env weight is non-zero

Currently `stream-quality.ts:38-49` returns `{ ttft_ms, max_stall_ms, p95_gap_ms, total_ms, delta_count, chars_per_second, tokens_per_second_estimate, failures }` — no scalar.

Target — add a `score` derived from the failures + thresholds:

```ts
export interface StreamQualityResult {
  // ... existing fields ...
  /** Composite stream-quality score in [0,1].
   *  1.0 when failures is empty AND TTFT < ttftSlowMs AND max_stall < maxStallMs.
   *  Drops linearly with each ms over threshold, floored at 0. */
  score: number
}
```

`computeStreamQuality` body adds:
```ts
const ttftPenalty = ttft_ms !== null && ttft_ms > thresholds.ttftSlowMs
  ? Math.min(1, (ttft_ms - thresholds.ttftSlowMs) / (thresholds.ttftSlowMs * 2))
  : 0
const stallPenalty = max_stall_ms > thresholds.maxStallMs
  ? Math.min(1, (max_stall_ms - thresholds.maxStallMs) / (thresholds.maxStallMs * 2))
  : 0
const noDeltasPenalty = failures.includes('stream_no_deltas') ? 1 : 0
const score = Math.max(0, 1 - 0.4 * ttftPenalty - 0.4 * stallPenalty - 0.2 * noDeltasPenalty)
```

Test impact:
- Extended: `tests/unit/stream-quality.test.ts` — assert score=1 for clean stream, score=0 for `stream_no_deltas`, score decays monotonically with TTFT.

---

**T28 — Persist campaign fingerprint to `eval_run.code_sha`.**

- File to edit: `scripts/eval.ts` (the campaign result already has `result.campaignFingerprint`)
- File to edit: `src/lib/.server/eval/trace-store-d1.ts:40` (the existing `code_sha` insert path)

Current: `result.campaignFingerprint` is written to `manifest.json` (verified at `scripts/eval.ts:737`) but `D1TraceStore.appendRun` (`trace-store-d1.ts:30-99`) is called by the substrate's `runEvalCampaign` BEFORE the campaign fingerprint is computed, so `code_sha` gets the build's `DEPLOY_SHA` instead.

Target — pass the campaign fingerprint into the run record's `codeSha` field (substrate-side this requires `CampaignRunOutcome.codeSha` or threading the fingerprint into the per-run record before persist). Two options:

a) (preferred) The substrate's `runEvalCampaign` already exposes the campaign fingerprint to the runner via `ctx.campaignFingerprint` (substrate spec required addition — see /tmp/audit/spec-agent-eval-substrate.md). Once that ships, each cell's `CampaignRunOutcome` includes `codeSha: ctx.campaignFingerprint`.

b) (local fallback) Compute the fingerprint locally in `buildCanonicalCampaign` (deterministic over `scenarios.map((s) => s.id).sort()` + the variant id list + the seeds) and stamp it into every `CampaignRunOutcome.raw.campaignFingerprint`. Then `trace-store-d1.ts:80-100` (where `code_sha` is inserted on update) reads that field instead of the env `DEPLOY_SHA`.

Local fallback is cheaper to ship; substrate option is cleaner long-term. Recommend local fallback in Half C, file the substrate ask under T-S5 in the substrate spec.

Add to `buildCanonicalCampaign(args)`:
```ts
const fingerprint = await computeCampaignFingerprint(scenarios, variants, seeds)
return {
  // ...
  metadata: { ...args.metadata, campaignFingerprint: fingerprint },
}
```

And in `makeCanonicalRunner` / each cell runner, propagate via `outcome.raw.campaignFingerprint = ctx.campaign.metadata.campaignFingerprint`.

Test impact:
- New: `tests/unit/campaign-fingerprint.test.ts` — assert determinism across identical scenario sets, different fingerprint on add/remove.
- Extended: `tests/integration/trace-store-d1.test.ts` — assert `code_sha` row contains the campaign fingerprint, not `DEPLOY_SHA`.

Completion check:
```bash
pnpm test -- fingerprint
ts-node scripts/eval.ts --kind forge-chat --dry-run | jq -r .campaignFingerprint  # repeatable
```

---

**T29 — Document the path to re-enable raw-coverage integrity at campaign level.**

- File to edit: `src/lib/.server/eval/canonical-campaign.ts` lines 216-228

Current relaxed integrity block lacks a documented re-enable path. Replace the comment with:

```ts
// Path to re-enable raw-coverage:
//   1. forge-builder-sim wrapper routes its LLM calls through `callLlm`
//      (currently uses `streamText` via the agent-runtime collector — the
//      raw sink doesn't see them).
//   2. customer-sim wrapper does the same.
//   3. forge-chat-multi-turn wrapper threads the per-turn raw events into
//      the per-cell sink (currently each turn re-instantiates an internal
//      sink that's discarded at turn end).
// Once those three land, flip these flags:
//   llmSpansMin: scenarios.length,   // at least one LLM span per cell
//   rawProviderEventsMin: scenarios.length,
//   requireRawCoverageOfLlmSpans: true,
integrity: {
  llmSpansMin: 0,
  rawProviderEventsMin: 0,
  requireOutcome: true,
  requireRawCoverageOfLlmSpans: false,
},
```

Test impact: documentation only; existing campaign integration tests cover the relaxed state.

Completion check:
```bash
grep -A 3 "Path to re-enable raw-coverage" src/lib/.server/eval/canonical-campaign.ts
```

---

**T30 — Inline `summarizeTextForTrace` import in `session.ts`.**

- File to edit: `src/lib/.server/eval/session.ts` line 25

Current:
```ts
export { summarizeTextForTrace } from './text-summary'
```

Target — drop the re-export; callers import directly from `./text-summary`. Find all importers via:
```bash
grep -rn "from.*session.*summarizeTextForTrace\|summarizeTextForTrace.*from.*session" src/ scripts/ tests/
```

Then update each importer to `from './text-summary'` (or relative equivalent), then delete the re-export line.

Test impact: typecheck-only; if every importer updates correctly, no behavior changes.

Completion check:
```bash
pnpm typecheck
grep -n "from.*session" src/lib/.server/eval/ -r | grep summarizeTextForTrace  # must be empty
```

---

## 5. Completion checklist (52 boxes)

### Half A — execution gaps

- [ ] T01.1 Add `src/lib/.server/eval/auto-promote-runner.ts` with `runAutoPromoteCron(db)` + `AutoPromoteRunSummary` shape.
- [ ] T01.2 Wire `runAutoPromoteCron` into `server.ts` under `else if (controller.cron === '0 16 * * *')` branch.
- [ ] T01.3 Add `0 16 * * *` to `wrangler.toml:30` crons array.
- [ ] T01.4 Add `tests/unit/auto-promote-runner.test.ts` (≥10 cases).
- [ ] T01.5 `pnpm test -- auto-promote` passes.
- [ ] T02.1 `api.admin.proposals.ts` PATCH rejects `status=promoted|failed-gate` (returns 400).
- [ ] T02.2 PATCH only allows `status=approved|rejected`.
- [ ] T02.3 File-header comment block at lines 1-15 rewritten with the actual contract.
- [ ] T02.4 Existing test that exercised promoted-via-PATCH updated to flow through the cron.
- [ ] T03.1 Add `src/lib/.server/eval/differential-driver.ts` with `buildBaselineCandidateScores(db, row)`.
- [ ] T03.2 `tests/unit/differential-driver.test.ts` covers happy path + missing-scenario filter + empty.
- [ ] T04.1 `forge-chat-judge.ts:120-129` `resolveJudgeModels` accepts `{ override, calibration, costs }` opts shape.
- [ ] T04.2 Pareto resolution branch when `JUDGE_BUDGET_TIER` env set + calibration non-empty.
- [ ] T04.3 `loadCostsFromEnv()` helper parses `FORGE_JUDGE_COSTS` env or throws on malformed.
- [ ] T04.4 Extended `tests/unit/pareto-judges.test.ts` cover all precedence paths.
- [ ] T05.1 `BuildCanonicalCampaignArgs` gets `systemPromptOverride?: string`.
- [ ] T05.2 Forge-chat + forge-chat-multi-turn cells prefer the override.
- [ ] T05.3 `tests/unit/canonical-campaign-override.test.ts` asserts override only applies to forge-chat kinds.
- [ ] Half A PR builds, typechecks, all tests pass; CI green.

### Half B — scaffold templates

- [ ] T06 `templates/db-schema.ts` emits all 9 eval-related tables.
- [ ] T06 schema test covers `analyst_finding`, `system_prompt_proposal`, `judge_calibration_cell`, `prod_trace_sample`.
- [ ] T07 `templates/trace-store-d1.ts` renders the D1 TraceStore implementation.
- [ ] T08 `templates/trace-analysis-store-d1.ts` renders the D1 TraceAnalysisStore.
- [ ] T09 `templates/outcome-store-d1.ts` renders the D1 OutcomeStore.
- [ ] T10 `templates/findings-store.ts` renders store + admin route + admin UI (3 files).
- [ ] T10 `agent-config.ts` analyst-loop rendering adds D1 mirror call after the local store write.
- [ ] T11 `templates/tool-fidelity.ts` renders `tests/eval/lib/tool-fidelity.ts`.
- [ ] T12 `templates/stream-quality.ts` renders `tests/eval/lib/stream-quality.ts`.
- [ ] T13 `templates/judges.ts:73` default flips to 3-judge list; `JudgeScoresRecord` shape; IRR via `interRaterReliability`.
- [ ] T14 `templates/canonical-campaign.ts` renders `tests/eval/lib/canonical-campaign.ts` with the 6-kind dispatcher (or subset matching agent's declared surfaces).
- [ ] T14 `templates/canonical-eval.ts` rendered output delegates to `buildCanonicalCampaign` instead of a local `runPersona` loop.
- [ ] T15 `templates/differential-eval.ts` renders the B3 harness.
- [ ] T16 `templates/evolve-gate.ts` renders the B4 gate.
- [ ] T17 `templates/auto-promote.ts` renders the C4 composition.
- [ ] T18 `templates/proposals.ts` renders store + admin route + admin UI (3 files); PATCH validates `approved|rejected`.
- [ ] T19 `templates/calibration.ts` renders store + admin route + admin UI (3 files).
- [ ] T20 `templates/prod-trace-harvest.ts` renders the harvest module.
- [ ] T21 `templates/server.ts` cron dispatcher branches: `0 6`, `0 8`, `0 15`, `0 16`.
- [ ] T21 `templates/wrangler-toml.ts:50-54` emits all 4 cron triggers.
- [ ] T22 `templates/adversarial.ts` renders `tests/eval/lib/adversarial-probes.ts` with at least 3 generic probes.
- [ ] `scaffold-agent.ts:80-260` registers every new template via `files.push(...)` calls.
- [ ] `recipe.ts` declares new component ids: `trace_store_d1`, `findings_mirror`, `findings_review_ui`, `differential_gate`, `evolve_gate`, `auto_promote`, `proposals_queue`, `calibration_store`, `prod_trace_harvest`, `tool_fidelity`, `stream_quality`, `adversarial_probes`, `canonical_campaign`.
- [ ] `RECIPE_COMPONENT_IDS` array exports them.
- [ ] `meta-agent-judge.ts` predicate map updated for new components.
- [ ] Integration smoke: scaffold a fresh agent via `scaffoldAgent(goodInput())`, write to a temp dir, run `pnpm install && pnpm typecheck` inside — passes.
- [ ] Regression smoke: re-scaffold one of `tax-agent` / `legal-agent` / `creative-agent` / `gtm-agent` against the new templates — produces a diff that adds the missing files and DOES NOT break the existing files (per-file content diff readable).
- [ ] Regression: agent-builder's own canonical eval still passes (`pnpm eval --kind forge-chat`).
- [ ] Half B PR builds, typechecks, all tests pass; CI green.

### Half C — cleanups

- [ ] T23 `pearson.ts:12-40` replaced with substrate re-export OR substrate ask filed if not yet shipped.
- [ ] T24 `differential-eval.ts:83-95` `cliffsDelta` replaced with substrate import OR substrate ask filed.
- [ ] T25 `canonical-trace-analyst.ts` uses `AnalystRegistry` + `CAMPAIGN_OVERVIEW_KIND_SPEC` instead of bare `analyzeTraces`.
- [ ] T25 `forge-deep-analyst.ts:38-46` uses `AnalystRegistry.run` instead of bare `analyzeTraces`.
- [ ] T26 `composite-config.ts` added with `loadCompositeConfig()` + weight-sum assertion.
- [ ] T26 `canonical-campaign.ts:612-627` reads weights from `loadCompositeConfig()`.
- [ ] T27 `stream-quality.ts` `StreamQualityResult` gains `score: number`.
- [ ] T27 `canonical-campaign.ts` folds stream-quality into composite when `FORGE_COMPOSITE_STREAM_WEIGHT > 0`.
- [ ] T28 Campaign fingerprint computed in `buildCanonicalCampaign` and threaded through every `CampaignRunOutcome` into `D1TraceStore.code_sha`.
- [ ] T29 `canonical-campaign.ts:216-228` carries the documented re-enable path.
- [ ] T30 `session.ts:25` re-export removed; importers updated.
- [ ] Half C PR builds, typechecks, all tests pass; CI green.

### Cross-cutting

- [ ] No `Co-Authored-By:` trailer on any commit or PR body.
- [ ] No new `?? defaultValue` on a required field anywhere in the diff.
- [ ] Every new file's header comment describes WHAT and WHY, no historical narrative.
- [ ] `pnpm typecheck && pnpm build && pnpm test` clean on each PR.

---

## 6. Test plan

### 6a. Unit additions (per task)

| Task | New test files | Existing files to extend |
|---|---|---|
| T01 | `tests/unit/auto-promote-runner.test.ts` | `tests/unit/auto-promote.test.ts` (no change) |
| T02 | `tests/unit/api.admin.proposals.test.ts` | n/a |
| T03 | `tests/unit/differential-driver.test.ts` | n/a |
| T04 | `tests/unit/forge-chat-judge-resolve.test.ts` | `tests/unit/pareto-judges.test.ts` |
| T05 | `tests/unit/canonical-campaign-override.test.ts` | n/a |
| T06 | n/a | `tests/unit/scaffold-agent.test.ts` (line 108 file-count +N, line 169 schema content) |
| T07 | `tests/unit/scaffold-trace-store-d1.test.ts` | n/a |
| T08 | `tests/unit/scaffold-trace-analysis-store.test.ts` | n/a |
| T09 | `tests/unit/scaffold-outcome-store.test.ts` | n/a |
| T10 | `tests/unit/scaffold-findings-store.test.ts` | n/a |
| T11 | `tests/unit/scaffold-tool-fidelity.test.ts` | n/a |
| T12 | `tests/unit/scaffold-stream-quality.test.ts` | n/a |
| T13 | `tests/unit/scaffold-judges-shape.test.ts` | `tests/unit/scaffold-agent.test.ts` |
| T14 | `tests/unit/scaffold-canonical-campaign.test.ts` | `tests/unit/scaffold-agent-extended.test.ts` |
| T15 | `tests/unit/scaffold-differential-eval.test.ts` | n/a |
| T16 | `tests/unit/scaffold-evolve-gate.test.ts` | n/a |
| T17 | `tests/unit/scaffold-auto-promote.test.ts` | n/a |
| T18 | `tests/unit/scaffold-proposals.test.ts` | n/a |
| T19 | `tests/unit/scaffold-calibration.test.ts` | n/a |
| T20 | `tests/unit/scaffold-prod-trace-harvest.test.ts` | n/a |
| T21 | n/a | `tests/unit/scaffold-agent.test.ts` (crons assertion) |
| T22 | `tests/unit/scaffold-adversarial.test.ts` | n/a |
| T23 | n/a | `tests/unit/pearson.test.ts` |
| T24 | n/a | `tests/unit/differential-eval.test.ts` |
| T25 | n/a | `tests/unit/canonical-trace-analyst.test.ts`, `tests/unit/forge-deep-analyst.test.ts` |
| T26 | `tests/unit/composite-config.test.ts` | n/a |
| T27 | n/a | `tests/unit/stream-quality.test.ts` |
| T28 | `tests/unit/campaign-fingerprint.test.ts` | `tests/integration/trace-store-d1.test.ts` |
| T29 | n/a | documentation only |
| T30 | n/a | typecheck only |

All new unit tests follow the project's `tests-that-matter` doctrine — every test names a regression it would catch, asserts exact shapes (not `toBeTruthy`), and exercises at least one adversarial input (empty arrays, malformed env, undefined fields).

### 6b. Integration: re-scaffold one of tax/legal/creative/gtm against the new templates as a smoke

Pick one (recommend `tax-agent` because its tree is the densest and exercises the most surfaces). Procedure:

```bash
cd /home/drew/code/agent-builder
pnpm build
# Build a RecipeInput approximating tax-agent's recipe — read tax-agent's
# package.json + system prompt + persona corpus to recover the recipe shape:
node -e "const {scaffoldAgent} = require('./dist/lib/.server/scaffold/scaffold-agent'); \
  const plan = scaffoldAgent({ \
    slug: 'tax-agent', \
    domain: 'tax-compliance', \
    persona: 'individual taxpayer', \
    capability: 'produces an annotated 1040 + W-2 reconciliation', \
    businessKpiWeight: 0.6, \
    needsRetrieval: true, \
    /* ... rest from recipe-types ... */ \
  }); \
  for (const f of plan.files) require('fs').mkdirSync(require('path').dirname('/tmp/tax-rescaffold/' + f.path), {recursive: true}); \
  for (const f of plan.files) require('fs').writeFileSync('/tmp/tax-rescaffold/' + f.path, f.content);"
cd /tmp/tax-rescaffold
pnpm install
pnpm typecheck
git diff --no-index /home/drew/code/tax-agent/ /tmp/tax-rescaffold/ | head -200
```

Expected: the diff contains the new files (`tests/eval/lib/tool-fidelity.ts`, `differential-eval.ts`, `evolve-gate.ts`, `auto-promote.ts`, `canonical-campaign.ts`, `stream-quality.ts`, the D1 store adapters, the proposals + calibration + findings UI/route/store triads, the adversarial probes registry) and DOES NOT clobber tax-agent's hand-tuned `src/lib/prompt.ts` or `tests/eval/personas/`. The 4 verticals' real-world adoption push will be a one-line `git apply` of the diff after manual review of the prompt-related sections.

### 6c. Regression: agent-builder's own canonical eval still green

```bash
cd /home/drew/code/agent-builder
TANGLE_API_KEY=... pnpm eval --kind forge-chat --seeds 0
# expected: 6 EvalKind scenarios pass, pass-rate ≥ 0.85, fingerprint persisted in eval/.runs/<runId>/manifest.json AND in D1 eval_run.code_sha after T28.
```

```bash
pnpm typecheck
pnpm test          # all unit + integration tests pass
pnpm build         # tsup bundles cleanly
```

The auto-promote driver (T01) should NOT alter agent-builder's existing promotion behavior — there are no `status='approved'` proposals at land time, so the first cron run is a no-op.

---

## 7. Rollout

### 7a. Single PR vs staged — staged

Three PRs, in this order:

1. **PR #1 — Half A (execution gaps).** ~400 LOC across 6 files (`auto-promote-runner.ts`, `differential-driver.ts`, edits to `api.admin.proposals.ts`, `forge-chat-judge.ts`, `canonical-campaign.ts`, `server.ts`, `wrangler.toml`). Lands as `feat(eval): wire auto-promote + Pareto judge resolution`. Independent value: makes Wave C4 actually run.

2. **PR #2 — Half B (scaffold expansion).** ~2500 LOC across 17 new templates + edits to `scaffold-agent.ts`, `recipe.ts`, `meta-agent-judge.ts`, and tests. Lands as `feat(scaffold): emit full eval stack to scaffolded agents`. Largest PR — recommend a draft review pass before opening for merge. Includes a worked smoke at the end (T-integration step) showing a re-scaffolded tax-agent typechecks cleanly.

3. **PR #3 — Half C (cleanups + tunability).** ~800 LOC. Lands as `chore(eval): env-overridable composite + fingerprint + analyst consolidation`. Depends on substrate releasing `pearson` + `cliffsDelta` exports for the T23 / T24 substrate-side parts; if those slip, ship those tasks behind a feature flag (`USE_SUBSTRATE_PEARSON=true`) and complete the swap in a follow-up.

### 7b. Branch naming

```
feat/eval-execution-gaps          # PR #1 / Half A
feat/scaffold-eval-templates      # PR #2 / Half B
chore/eval-composite-cleanups     # PR #3 / Half C
```

### 7c. Re-scaffold cadence for the 4 consumers

After Half B merges:

- Week 1: re-scaffold `tax-agent` (densest tree, highest signal); manual review of diff; land as `feat(eval): adopt agent-builder scaffold v2`.
- Week 2: `legal-agent` (dead `production-loop` module already needs an explicit decision — see SYNTHESIS.md item 6).
- Week 3: `creative-agent` + `gtm-agent` in parallel (both have lighter trees + active prod-loop crons that need careful coordination).
- Week 4: verify all four are at parity; close out the `^0.25.0` docstring drift sweep noted in SYNTHESIS.md item 10.

Each re-scaffold PR carries the consumer-specific sibling spec as a checklist (`/tmp/audit/spec-{tax,legal,creative,gtm}-agent.md`) so the resulting integration matches the meta-system's full surface end-to-end.

---

## 8. Risks + non-goals

### Risks

1. **Recipe component count grows from 10 to ~22.** Adding components mechanically dilutes the `meta-agent-judge` recipe_completeness score unless the predicate map is updated in lockstep. Mitigation: T-checkin in Half B explicitly updates `meta-agent-judge.ts` predicate map (in the checklist).

2. **Re-scaffold disruption to the 4 consumers.** Each vertical has hand-tuned `prompt.ts`, persona corpus, and per-domain skills. The re-scaffold MUST preserve those. Mitigation: scaffold is purely additive at the path level (new files don't collide with existing prompt/persona files), and the smoke test in 6b exercises this.

3. **D1 schema migration burden across consumers.** Adding 9 new tables means each consumer needs to run Drizzle migrations. Mitigation: render the migration alongside the schema; document the one-time `wrangler d1 migrations apply` step in the rendered README.

4. **`@tangle-network/agent-runtime` coupling.** `D1DurableRunStore` (used by prod-trace harvest) lives in agent-runtime, not agent-eval. Consumers that don't already depend on agent-runtime would need to add it. Mitigation: render the dependency in `package.json.ts` only when `recipeInput.needsProdTraceHarvest === true`; default true for new scaffolds but allow opt-out.

5. **Composite weight env surface introduces foot-guns.** Wrong weights silently change the canonical pass-rate. Mitigation: `loadCompositeConfig()` asserts weights sum to 1.0 ± 0.0001 AND that threshold ∈ [0, 1] AND throws on parse failure — no silent fallback.

6. **PATCH change in T02 is a behavior change.** Existing CLI / scripts that PATCH `status=promoted` directly will now 400. Mitigation: search for callers via grep before merging Half A; document the migration in the PR body.

7. **Auto-promote cron at `0 16` may race with `0 15` prod-trace harvest** if the harvest writes proposals. Mitigation: the harvest does NOT write proposals (it only writes samples for analyst ingestion). Proposals are generated by the analyst loop separately. Order-of-operations stays clean.

### Non-goals

- Adopting `/pipelines`, `/governance`, `/meta-eval`, `/prm`, `/control`, `/optimization`, `/reporting`, `/telemetry`, `/wire`, `/benchmarks` substrate subpaths into the scaffold (per SYNTHESIS.md §"12 of 16 subpaths" — those are separate adoption pushes).
- Lifting the five hand-rolled patterns (`assertCrossFamily`, `captureFetchToRawSink`, `weightedComposite`, `flattenOtlpExportToNdjson`, `assertSingleBackend`) into substrate — those belong to `/tmp/audit/spec-agent-eval-substrate.md`.
- Migrating consumers (tax/legal/creative/gtm) themselves — Half B lands the templates; consumer re-scaffold PRs are owned by their respective specs (`/tmp/audit/spec-{tax,legal,creative,gtm}-agent.md`).
- Backfilling adversarial probe corpora for the four verticals — the template (T22) renders a 3-probe starter set; each vertical extends in its own spec.
- Adopting `assertRealBackend` (0.31.0) into every campaign — file as a substrate-side follow-up; the scaffold template can wire it once consumers acquire it.
- Resurrecting `legal-agent`'s dead `production-loop` module or `tax-agent`'s idle weekly cron — that's per-consumer rollout (their specs).

---

## 9. Citations

Verified against `/home/drew/code/agent-builder/` at session start. Line numbers correspond to files as committed at HEAD. All snippets are excerpts from real source.

- `src/lib/.server/eval/auto-promote.ts` lines 1-89 — `evaluateAutoPromote` definition, no production callers (verified `grep -rn evaluateAutoPromote`).
- `src/lib/.server/eval/differential-eval.ts` lines 25, 83-95, 97-188 — substrate import line; local `cliffsDelta`; `runDifferentialEval` body.
- `src/lib/.server/eval/evolve-gate.ts` lines 52-100 — `DEFAULT_EVOLVE_GATE_THRESHOLDS` + gate body.
- `src/lib/.server/eval/pareto-judges.ts` lines 17-22, 152-208 — Wave B2 design comment; `computeParetoTiers` definition; no production callers (verified `grep -rn computeParetoTiers`).
- `src/lib/.server/eval/forge-chat-judge.ts` lines 39-43, 120-129, 139-237 — `DEFAULT_FORGE_JUDGE_MODELS`; `resolveJudgeModels` (env precedence only); `scoreForgeChatResponse` ensemble.
- `src/lib/.server/eval/pearson.ts` lines 12-40 — local `pearson` impl.
- `src/lib/.server/eval/canonical-campaign.ts` lines 28-38, 175-255, 306-353, 612-627 — substrate imports; `buildCanonicalCampaign`; `makeCanonicalRunner` dispatcher; hard-coded composite weights.
- `src/lib/.server/eval/scenario-registry.ts` lines 22-30, 48-54, 173-255 — fingerprint promise; EvalKind union; `buildCanonicalScenarios`.
- `src/lib/.server/eval/prod-trace-harvest.ts` lines 1-60 — Wave C5+C6 design; `HarvestOpts`.
- `src/lib/.server/eval/proposals-store.ts` lines 1-117 — full module; `decideProposal` does not run the gate.
- `src/lib/.server/eval/stream-quality.ts` lines 26-59 — `StreamQualityInput` + `StreamQualityResult` (no `score` field today).
- `src/lib/.server/eval/tool-fidelity.ts` lines 1-70 — `ToolCallMatcher`, `ToolFidelityFailureCode`, breakdown shape.
- `src/lib/.server/eval/session.ts` lines 12-25 — substrate import block; `summarizeTextForTrace` re-export.
- `src/lib/.server/eval/canonical-trace-analyst.ts` lines 1-58 — campaign analyst design.
- `src/lib/.server/eval/forge-deep-analyst.ts` lines 38-46 — per-build deep-analyst imports.
- `src/lib/.server/eval/trace-store-d1.ts` lines 27-99 — `D1TraceStore`; `code_sha` insert path.
- `src/routes/api.admin.proposals.ts` lines 1-15, 100-117 — file-header deferred-gate comment; PATCH that calls `decideProposal` directly.
- `src/routes/api.admin.findings.ts` lines 1-60 — Wave C2 mirror endpoint contract.
- `src/lib/.server/scaffold/scaffold-agent.ts` lines 66-260 — `scaffoldAgent` render entry.
- `src/lib/.server/scaffold/recipe.ts` lines 1-80 — recipe component spec shape.
- `src/lib/.server/scaffold/templates/agent-config.ts` lines 30-126, 127-507 — `renderAgentConfig` + `renderAnalystLoop`.
- `src/lib/.server/scaffold/templates/canonical-eval.ts` lines 1-299 — current 1-kind canonical eval template.
- `src/lib/.server/scaffold/templates/judges.ts` lines 38-189 — current 2-judge default at line 73.
- `src/lib/.server/scaffold/templates/wrangler-toml.ts` lines 50-54 — current 2-cron triggers.
- `src/lib/.server/scaffold/templates/server.ts` lines 51-79 — current scheduled() KV-only handler.
- `server.ts` lines 20, 100-211 — top-level cron dispatcher; `runProdTraceHarvest` wiring.
- `wrangler.toml:30` — `crons = ["0 13 * * *", "0 14 * * *", "0 15 * * *"]`.
- `scripts/eval.ts` lines 85-98, 613, 725-820 — substrate imports; campaign invocation; manifest emission with `campaignFingerprint`.
- `scripts/run-canonical-analyst-loop.ts` lines 32-39 — AnalystRegistry analyst-loop CLI imports.
- `tests/unit/{auto-promote,pareto-judges,evolve-gate,differential-eval,scaffold-agent}.test.ts` — existing test files referenced.
- `package.json:55` — `@tangle-network/agent-eval: ^0.31.1` pin.

Substrate references:
- `/home/drew/code/agent-eval/src/statistics.ts:` — `pairedWilcoxon`, `pairedBootstrap`, `interRaterReliability`, `corpusInterRaterAgreement{,FromJudgeScores}` exported.
- `/home/drew/code/agent-eval/src/{judge-calibration,pipelines/judge-agreement,rl/reward-hacking,builder-eval/correlation,meta-eval/correlation-study,meta-eval/rubric-predictive-validity}.ts` — six private `pearson` / `pearsonR` impls; none exported.
- `grep -rn cliffs /home/drew/code/agent-eval/src/` — zero hits (Cliff's delta not in substrate).

---

## 10. Coordination with sibling specs

This spec depends on / coordinates with:

| Sibling | Coordination |
|---|---|
| `/tmp/audit/spec-agent-eval-substrate.md` | T23 (`pearson` re-export), T24 (`cliffsDelta` upstream), T28 (substrate-side `CampaignRunOutcome.codeSha` thread-through) — file these against substrate first; this spec's tasks are gated on those landing. T-S5 in substrate spec is the campaign-fingerprint thread-through. Half C of THIS spec can land local-only versions of T23/T24/T28 if substrate slips. |
| `/tmp/audit/spec-tax-agent.md` | Half B Week 1 re-scaffold consumer. Spec carries the consumer-side adoption checklist. |
| `/tmp/audit/spec-legal-agent.md` | Half B Week 2 re-scaffold; also owns the dead `production-loop` decision. |
| `/tmp/audit/spec-creative-agent.md` | Half B Week 3 re-scaffold (parallel with gtm). |
| `/tmp/audit/spec-gtm-agent.md` | Half B Week 3 re-scaffold (parallel with creative). |

### Dependency order between specs

```
spec-agent-eval-substrate ─┬─► spec-agent-builder (this spec)
                           │       │
                           │       ├── Half A (independent)
                           │       │
                           │       ├── Half B (depends on Half A)
                           │       │     │
                           │       │     ├──► spec-tax-agent       (week 1)
                           │       │     │
                           │       │     ├──► spec-legal-agent     (week 2)
                           │       │     │
                           │       │     ├──► spec-creative-agent  (week 3)
                           │       │     │
                           │       │     └──► spec-gtm-agent       (week 3)
                           │       │
                           │       └── Half C (depends on substrate T23/T24/T28, can ship local fallback)
                           │
                           └─► (T23, T24, T28 substrate-side exports)
```

substrate spec lands first OR Half C ships with local fallbacks and a follow-up sweeps them once substrate exports the symbols.

Half A is independently shippable and provides immediate value — the three execution gaps close in a single PR.

Half B is the high-leverage bet — landing it once + re-scaffolding the four consumers gives the entire fleet the full integration stack.

Half C is the polish that makes the scaffolded surface tunable + the substrate surface non-duplicative.

