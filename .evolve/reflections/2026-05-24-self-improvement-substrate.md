# Reflect: agent-eval self-improvement substrate session
Date: 2026-05-24

## Run Grade: 7/10

| Dimension | Score | Evidence |
|---|---|---|
| Goal achievement | 7 | Substrate comprehensive (runLoop + coder + researcher + MCP + matrix + ingestion + viewer + 2 skills + OTEL). Live end-to-end proof never landed (sandbox provisioning blocked by infra — ROOT_USER_FORBIDDEN + capacity). |
| Code quality | 8 | Strict TS everywhere, 4 critical audits caught real bugs (PII, auth, fake-worker, silent-swallow), zero slop in load-bearing files. Some respawns indicate spec instability. |
| Efficiency | 5 | 4 failed smoke attempts chasing wrong root cause (OpenAI-compat path → correct diagnosis: eval bypasses harness entirely). 3 matrix implementer respawns (spec changed under it). 2 killed Fix-4 attempts. ~30% of subagent cycles wasted. |
| Self-correction | 8 | Every failure diagnosed honestly. Architecture pivoted when Drew pushed back (drop wrappers, single key name, in-sandbox execution, fully parameterized matrix). Never defended a wrong position past its shelf life. |
| Learning | 9 | MOSS paper alignment validated. Full-tracing mandate emerged. "Eval must use production path" lesson is durable. Two-primitive (task+knowledge) framing survived every stress test. |
| Overall | 7 | Would operator approve? Mostly — substrate is real + published + verified in isolation. Deduction: the single thing that matters most (one real delegation firing end-to-end) didn't land this session. |

## Session Flow Analysis

### Flow 1: Design → Spawn → Audit → Merge → Publish
Trigger: architectural decision reached
Steps: spec → subagent implementer → wait → pull branch → typecheck + test + slop scan → admin-merge → npm publish
Outcome: ~15 successful cycles; 3 failed (respawned with corrected spec)
Automation potential: HIGH — this is a deterministic pipeline. A "ship" skill variant that runs typecheck+test+audit+merge+publish as one invocation.

### Flow 2: Live smoke → fail → diagnose → fix → re-smoke
Trigger: "run the agents end-to-end"
Steps: decrypt key → configure backend → run eval → observe failure → trace root cause → ship fix → retry
Outcome: 4 attempts, 0 successes. Each failure taught something real.
Pattern: EVERY failure was at a BOUNDARY we'd never tested live (eval↔sandbox, auth, image config, backend path mismatch).

### Flow 3: Drew redirects → respawn with corrected spec
Trigger: Drew says "that's wrong" or "why can't we just..."
Steps: absorb correction → kill in-flight → redraft spec → respawn
Outcome: every redirect was correct (AgentProfile not wrapped, single key name, in-sandbox execution, fully parameterized matrix). Signal: I was over-engineering at the boundaries Drew can see clearly.

## Project Health

### @tangle-network/agent-runtime
Trajectory: RAPIDLY IMPROVING (0.18 → 0.22 this session; 0.23 in flight)
Architecture: clean — loops + profiles + MCP + fleet-aware + OTEL export (shipping)
Next: publish 0.23.0 (trace-everything) → run live smoke with working sandbox provisioning

### @tangle-network/agent-eval
Trajectory: IMPROVING (0.35 → 0.36 this session; 0.37 in flight)
Architecture: good — matrix adds N-axis cartesian; judges+analysts getting traced
Next: merge 0.37.0 (judge+analyst tracing + OTEL pipeline)

### @tangle-network/agent-knowledge
Trajectory: STABLE (1.4.0 shipped; researcherProfile landed)
Architecture: clean but PARTIAL — multi-tenant scoping enforced at profile-validator, not promoted to substrate types
Next: promote multi-tenant + provenance types to substrate-wide

### gtm-agent
Trajectory: MOST WIRED (MCP mounted, viewer, 6 delegation scenarios, production-profile reuse, fake-worker fixed)
Blocker: sandbox provisioning (ROOT_USER_FORBIDDEN → orchestrator fix needs deploying)
Next: deploy orchestrator → re-run closed-loop smoke → first real delegation

## Critical Findings

### 1. Eval MUST use the production path
The session's most expensive lesson. Spent hours chasing "why won't tools fire" when the root cause was: eval's "sandbox backend" was a lie — it did bareback fetch() to /chat/completions, never spawning a real sandbox with a harness that handles MCP. The production chat handler uses `ensureWorkspaceSandbox` + `streamSandboxPrompt` which goes through the real harness. The eval needs to use the exact same path.

### 2. Full tracing is non-negotiable
Judges, analysts, mutators, workers — all opaque today. Can't improve the improver without observing it. OTEL export required for customer observability stacks.

### 3. Infrastructure boundaries are where bugs hide
Every live smoke failure was at a boundary: eval↔sandbox, auth keys, container user config, host capacity. Unit tests with stubs CANNOT catch these. The "production-readiness" rating stays at 6.5/10 until one real boundary-crossing succeeds.

### 4. The MOSS paper validates our architecture but exposes gaps
Strong alignment: orchestrator/worker separation, multi-provider, runtime replay, keypoint matrices, artifact trail. Gaps: sealed-batch lifecycle, verdict taxonomy (model-ceiling / arch-ceiling), full 7-stage pipeline, automatic rollback.

## Skill Effectiveness

| Skill | Used | Outcome |
|---|---|---|
| agent-eval-adoption | Invoked by subagents | Effective for substrate patterns; MISSING eval-must-use-production-path lesson |
| agent-stack-adoption | Written this session | Comprehensive 9-phase runbook; MISSING Phase 10 (full tracing + OTEL) |
| Neither | — | MISSING the MOSS-paper concepts (sealed batch, verdict taxonomy, failure-evidence abstraction) |

## Skills improvement needed: YES

### 1. agent-stack-adoption needs Phase 10
Add: "Phase 10 — Full distributed tracing + OTEL export. Every judge, analyst, mutator, worker, delegation, MCP dispatch emits spans. Cross-sandbox join via exportTraceBundle. OTEL_EXPORTER_OTLP_ENDPOINT auto-exports everything. Non-negotiable for customer-facing deployment."

### 2. Both skills need the "eval-production-path-parity" anti-pattern
Add to anti-patterns list: "Eval routes through a different backend than production → tools/MCP won't fire → scores are fictional. The eval MUST use `ensureWorkspaceSandbox` / `streamSandboxPrompt` (or equivalent) so the harness handles MCP natively. Never evaluate delegation scenarios through bareback OpenAI-compat fetch()."

### 3. agent-eval-adoption needs MOSS-paper concepts
Add: failure-evidence abstraction (EvidenceItem with suspectedSurface + replayInstructions), sealed-batch lifecycle, verdict taxonomy (CONVERGED / NEED_MORE_WORK / MODEL_CEILING / ARCHITECTURE_CEILING).

### 4. Both skills need OTEL export as first-class
Not optional, not Phase-N. It's the contract: when a user sets `OTEL_EXPORTER_OTLP_ENDPOINT`, EVERYTHING exports. Judges, analysts, mutators, workers, delegations — all of it.

## Proposed Automations

1. **ship-and-publish skill** — typecheck → test → audit (slop scan) → merge → npm publish as one invocation. Used 15 times this session manually.
2. **live-smoke skill** — configures env from devops secrets, boots sandbox, runs one persona turn, reports tool_calls, verifies traces landed. Used 4 times manually (and failed each time for different reasons).
3. **respawn-with-correction skill** — when Drew redirects, automatically kill in-flight + draft corrected spec based on his feedback + respawn. Used 4+ times manually.

## Action Items (ordered by impact)

1. **Deploy orchestrator root-user fix** to production → unblocks ALL live smoke attempts
2. **Merge 0.23.0 + 0.37.0** (trace-everything + OTEL) when implementer returns → closes the trace gap
3. **Update both skills** with Phase 10 + eval-production-path anti-pattern + MOSS concepts
4. **Add `--backend harness` to eval canonical** that uses real `ensureWorkspaceSandbox` → closes the eval↔production gap permanently
5. **Run closed-loop smoke** once orchestrator deploys → flip production-readiness from 6.5 to 8+
6. **MOSS-paper primitives** (EvidenceItem, FailureBatch, Verdict taxonomy) → add to agent-eval 0.38

## Next dispatch

`Next: deploy orchestrator fix (2dd58b216 from develop → production) → then /ship the closed-loop smoke script as proof-of-architecture`

The skills DO need improvement. The three additions (Phase 10 tracing, eval-production-parity anti-pattern, OTEL-as-first-class) are all lessons from this session that future sessions will trip on if not encoded.
