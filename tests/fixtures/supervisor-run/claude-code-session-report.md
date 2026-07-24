# Run report — fa9c4333-d5e7-411e-863e-ac08ab49dc00 [claude-code]

```
RUN-REPORT fa9c4333-d5e7-411e-863e-ac08ab49dc00 [claude-code]
  steers=11 queued / 11 delivered
  waves=35 sizes=[1,2,1,1,1,1,1,1,1,1,2,1,1,1,1,2,1,2,1,2,1,4,1,1,1,2,1,2,4,1,1,3,3,1,1] workers=52 settled=47 cancelled=0
  concurrency max=6 utilization=1.117 idle=66.1min (0.5%) wall=14524.6min
  respawns=51 evidence→respawn=34 blind-respawn=17 depth=1
  accepted=unavailable — Claude Code runs no per-worker verify step — a subagent reports prose, not pass/fail rejected=unavailable — Claude Code runs no per-worker verify step — a subagent reports prose, not pass/fail empty-pass=unavailable — Claude Code runs no per-worker verify step — a subagent reports prose, not pass/fail
  brain=$unavailable — Claude Code transcripts record token usage but never a price — usd is not in the store total=$unavailable — Claude Code transcripts record token usage but never a price — usd is not in the store judge.resolved=unavailable — judge.json absent score=unavailable — judge.json absent verify=unavailable — result.json absent or has no verify_pass
  gaps(7): driverSteerCalls: driver.log absent; accepted: Claude Code runs no per-worker verify step — a subagent reports prose, not pass/fail; totalUsd: Claude Code transcripts record token usage but never a price — usd is not in the store; brain.brainTruncations: brain.jsonl absent — loops predates the brain-call tap, so truncation cannot be ruled out; patch: Claude Code retains no per-worker patch — subagents commit to git, they do not hand back a diff; judge: judge.json absent; verifyPass: result.json absent or has no verify_pass
```

- Run: `/home/drew/.claude/projects/-home-drew-code-supervisor-lab/fa9c4333-d5e7-411e-863e-ac08ab49dc00.jsonl`
- Supervisor: `fa9c4333-d5e7-411e-863e-ac08ab49dc00`
- Generated: 2026-07-24T02:00:00.000Z

## Orchestration

| Metric | Value |
|---|---|
| Workers spawned | 52 |
| Workers settled | 47 |
| Workers cancelled | 0 |
| **Steers (mid-task messages to live workers)** | **11** |
| Steers delivered | 11 |
| Outer-driver `supervisor_steer` calls | unavailable — driver.log absent |
| Spawn waves | 35 |
| Wave sizes | [1, 2, 1, 1, 1, 1, 1, 1, 1, 1, 2, 1, 1, 1, 1, 2, 1, 2, 1, 2, 1, 4, 1, 1, 1, 2, 1, 2, 4, 1, 1, 3, 3, 1, 1] |
| Max concurrency | 6 |
| Respawns (spawns after first settle) | 51 |
| Repeated labels | none |
| Delegation depth | 1 |
| Time to first spawn | 64.5min |
| Supervisor wall | 14524.6min |
| Idle (zero live workers) | 66.1min (0.5%) |
| Worker utilization (Σ worker wall ÷ supervisor wall) | 1.117 |

### Steers per worker

| Worker | Queued | Delivered |
|---|---:|---:|
| `Wire GEPA reflection input into prompt improver` | 0 | 0 |
| `Link local packages into bench + E2E reflection smoke` | 0 | 0 |
| `Evolve loops supervisor: evidence flow + budgets + best-effort` | 0 | 0 |
| `Fix worker clone to inherit build artifacts` | 0 | 0 |
| `Analyze new dotfiles skills + smoke brain path + relaunch rematch` | 0 | 0 |
| `Round 3: strict self-tests + reviewer gate in loops` | 0 | 0 |
| `Pre-register holdout: 6 gold-calibrated SWE instances` | 0 | 0 |
| `Unification audit: map hh harness onto substrate seams` | 0 | 0 |
| `Build swe-arena M1: backtest replay of the head-to-head` | 0 | 0 |
| `Merge master into loops branch, resolve, push, PR` | 0 | 0 |
| `Build swe-arena M2: typed execution path` | 0 | 0 |
| `Address reviewer findings on PRs 373 and 555` | 1 | 1 |
| `Build round-4 automated outer loop (improve + ensemble)` | 1 | 1 |
| `Post-crash rebuild: inputs + clock fix + re-fire gen-1` | 0 | 0 |
| `Fix worktree-tamper false positive + salvage + re-fire gen-1` | 2 | 2 |
| `Gen-2 preflight: pin baseline, guards, launch` | 0 | 0 |
| `Debug author-shot exit 1 + re-fire gen-2` | 0 | 0 |
| `Run holdout certification on gen-2 winner` | 0 | 0 |
| `Push + PR the swe-arena bench branch` | 0 | 0 |
| `Reconcile self-improve-e2e with main + open main PR` | 0 | 0 |
| `Substrate PRs: 4 additive improve-loop options` | 0 | 0 |
| `Consumer refactor: lib-owned scoring/cost/manifest in outer-loop` | 0 | 0 |
| `Drop fallbacks now that substrate merged; land refactor branch` | 0 | 0 |
| `Release agent-eval + agent-runtime with new options` | 1 | 1 |
| `Build gen-3: proposer fan-out, 2-rep holdout, wider set` | 1 | 1 |
| `Crash-orphan ledger reconciliation + re-fire gen-3` | 0 | 0 |
| `Build quant-arena: self-contained strategy-improvement pilot` | 1 | 1 |
| `agent-eval: README overhaul + evidence-based cleanup` | 0 | 0 |
| `agent-runtime: README overhaul + evidence-based cleanup` | 1 | 1 |
| `supervisor-lab: present the program clearly + clean` | 0 | 0 |
| `Survey backtesting frameworks + OMS strategy-contract standards` | 0 | 0 |
| `Quant-arena v2: onBar contract + vectorbt worker + parity` | 0 | 0 |
| `Build + fire gen-4: model-diverse proposers + Pareto parents` | 0 | 0 |
| `Build observatory: deterministic run-record charts` | 0 | 0 |
| `Research: SOTA self-improvement + RL rollout data standards` | 0 | 0 |
| `Build rollout ledger: tangle.rollout.v1 capture + backfill` | 0 | 0 |
| `Build HF dataset release pipeline on rollout ledger` | 0 | 0 |
| `Build gen-5: full SOTA-protocol integration bundle` | 0 | 0 |
| `Worker-model ablation: same supervisor, stronger workers` | 2 | 2 |
| `Wire GEPA as a proposer seat in swe-arena` | 0 | 0 |
| `Purge handrolled proposer sketches superseded by real GEPA` | 0 | 0 |
| `Collapse two rollout implementations into one (agent-eval core)` | 1 | 1 |
| `Design+pilot factory-bench: e2e feature instances from our repo history` | 0 | 0 |
| `Build factory-bench runner per pilot design` | 0 | 0 |
| `Clear the agent-runtime PR backlog via merge train` | 0 | 0 |
| `Deterministic run-report: auto-answer the autopsy questions` | 0 | 0 |
| `Solo-loop control arm on factory-bench` | 0 | 0 |
| `Move supervisor-tree reader into the trace-analysis layer` | 0 | 0 |
| `Remove output-token caps on the supervisor brain path` | 0 | 0 |
| `Placement audit for long-horizon supervisor mechanics` | 0 | 0 |
| `Re-land durable resume + refilling dispatch in agent-runtime` | 0 | 0 |
| `Prove tree reader generalizes to third-party harnesses` | 0 | 0 |

## Decision quality

| Metric | Value |
|---|---|
| Settled by status | completed=47 |
| Settled verdicts | unavailable — Claude Code runs no per-worker verify step — a subagent reports prose, not pass/fail |
| Accepted (verify green + patch bytes) | unavailable — Claude Code runs no per-worker verify step — a subagent reports prose, not pass/fail |
| Rejected (verify red) | unavailable — Claude Code runs no per-worker verify step — a subagent reports prose, not pass/fail |
| Empty pass (green, no patch) | unavailable — Claude Code runs no per-worker verify step — a subagent reports prose, not pass/fail |
| Evidence → respawn sequences | 34 |
| Respawn with no settled evidence in front | 17 |
| Review actions (steers + worker questions) | 11 |
| Worker evidence returned | 75398 bytes |

## Economics

| Role | Tokens in | Tokens out | Cache read | Cache write | USD | Source |
|---|---:|---:|---:|---:|---:|---|
| brain | 182710 | 1224083 | 623246558 | 23208124 | unavailable — Claude Code transcripts record token usage but never a price — usd is not in the store | journal metered events (n=1) |
| workers | 22970 | 960195 | 462902249 | 11100686 | unavailable — Claude Code transcripts record token usage but never a price — usd is not in the store | journal settled spend + claude-code subagent transcripts sessions (n=19) |

- Brain completions truncated (finish_reason=length): unavailable — brain.jsonl absent — loops predates the brain-call tap, so truncation cannot be ruled out
- Total USD: unavailable — Claude Code transcripts record token usage but never a price — usd is not in the store (source: Claude Code transcripts record token usage but never a price — usd is not in the store)
- Cost per accepted patch: unavailable — Claude Code transcripts record token usage but never a price — usd is not in the store
- Worker wall (n=51): min 65.5s / p50 18.5min / p90 75.3min / max 359.7min / Σ 1767.7min

| Worker | Wall | Tokens in | Tokens out | Patch bytes | Verify passed |
|---|---:|---:|---:|---:|---|
| `Wire GEPA reflection input into prompt improver` | 16.7min | unavailable — store does not attribute tokens per worker | unavailable — store does not attribute tokens per worker | unavailable — no worker patch file | unavailable — no finished event |
| `Link local packages into bench + E2E reflection smoke` | unavailable — no start/finish pair | unavailable — store does not attribute tokens per worker | unavailable — store does not attribute tokens per worker | unavailable — no worker patch file | unavailable — no finished event |
| `Evolve loops supervisor: evidence flow + budgets + best-effort` | 18.5min | unavailable — store does not attribute tokens per worker | unavailable — store does not attribute tokens per worker | unavailable — no worker patch file | unavailable — no finished event |
| `Fix worker clone to inherit build artifacts` | 10.5min | unavailable — store does not attribute tokens per worker | unavailable — store does not attribute tokens per worker | unavailable — no worker patch file | unavailable — no finished event |
| `Analyze new dotfiles skills + smoke brain path + relaunch rematch` | 3.3min | unavailable — store does not attribute tokens per worker | unavailable — store does not attribute tokens per worker | unavailable — no worker patch file | unavailable — no finished event |
| `Round 3: strict self-tests + reviewer gate in loops` | 13.8min | unavailable — store does not attribute tokens per worker | unavailable — store does not attribute tokens per worker | unavailable — no worker patch file | unavailable — no finished event |
| `Pre-register holdout: 6 gold-calibrated SWE instances` | 13.4min | unavailable — store does not attribute tokens per worker | unavailable — store does not attribute tokens per worker | unavailable — no worker patch file | unavailable — no finished event |
| `Unification audit: map hh harness onto substrate seams` | 6.9min | unavailable — store does not attribute tokens per worker | unavailable — store does not attribute tokens per worker | unavailable — no worker patch file | unavailable — no finished event |
| `Build swe-arena M1: backtest replay of the head-to-head` | 15min | unavailable — store does not attribute tokens per worker | unavailable — store does not attribute tokens per worker | unavailable — no worker patch file | unavailable — no finished event |
| `Merge master into loops branch, resolve, push, PR` | 7.4min | unavailable — store does not attribute tokens per worker | unavailable — store does not attribute tokens per worker | unavailable — no worker patch file | unavailable — no finished event |
| `Build swe-arena M2: typed execution path` | 28.7min | unavailable — store does not attribute tokens per worker | unavailable — store does not attribute tokens per worker | unavailable — no worker patch file | unavailable — no finished event |
| `Address reviewer findings on PRs 373 and 555` | 75.3min | unavailable — store does not attribute tokens per worker | unavailable — store does not attribute tokens per worker | unavailable — no worker patch file | unavailable — no finished event |
| `Build round-4 automated outer loop (improve + ensemble)` | 359.7min | unavailable — store does not attribute tokens per worker | unavailable — store does not attribute tokens per worker | unavailable — no worker patch file | unavailable — no finished event |
| `Post-crash rebuild: inputs + clock fix + re-fire gen-1` | 34.2min | unavailable — store does not attribute tokens per worker | unavailable — store does not attribute tokens per worker | unavailable — no worker patch file | unavailable — no finished event |
| `Fix worktree-tamper false positive + salvage + re-fire gen-1` | 31.2min | unavailable — store does not attribute tokens per worker | unavailable — store does not attribute tokens per worker | unavailable — no worker patch file | unavailable — no finished event |
| `Gen-2 preflight: pin baseline, guards, launch` | 12min | unavailable — store does not attribute tokens per worker | unavailable — store does not attribute tokens per worker | unavailable — no worker patch file | unavailable — no finished event |
| `Debug author-shot exit 1 + re-fire gen-2` | 18.1min | unavailable — store does not attribute tokens per worker | unavailable — store does not attribute tokens per worker | unavailable — no worker patch file | unavailable — no finished event |
| `Run holdout certification on gen-2 winner` | 6.5min | unavailable — store does not attribute tokens per worker | unavailable — store does not attribute tokens per worker | unavailable — no worker patch file | unavailable — no finished event |
| `Push + PR the swe-arena bench branch` | 3.3min | unavailable — store does not attribute tokens per worker | unavailable — store does not attribute tokens per worker | unavailable — no worker patch file | unavailable — no finished event |
| `Reconcile self-improve-e2e with main + open main PR` | 26.9min | unavailable — store does not attribute tokens per worker | unavailable — store does not attribute tokens per worker | unavailable — no worker patch file | unavailable — no finished event |
| `Substrate PRs: 4 additive improve-loop options` | 29.3min | unavailable — store does not attribute tokens per worker | unavailable — store does not attribute tokens per worker | unavailable — no worker patch file | unavailable — no finished event |
| `Consumer refactor: lib-owned scoring/cost/manifest in outer-loop` | 32.5min | unavailable — store does not attribute tokens per worker | unavailable — store does not attribute tokens per worker | unavailable — no worker patch file | unavailable — no finished event |
| `Drop fallbacks now that substrate merged; land refactor branch` | 31min | unavailable — store does not attribute tokens per worker | unavailable — store does not attribute tokens per worker | unavailable — no worker patch file | unavailable — no finished event |
| `Release agent-eval + agent-runtime with new options` | 131.4min | unavailable — store does not attribute tokens per worker | unavailable — store does not attribute tokens per worker | unavailable — no worker patch file | unavailable — no finished event |
| `Build gen-3: proposer fan-out, 2-rep holdout, wider set` | 39min | unavailable — store does not attribute tokens per worker | unavailable — store does not attribute tokens per worker | unavailable — no worker patch file | unavailable — no finished event |
| `Crash-orphan ledger reconciliation + re-fire gen-3` | 8.6min | unavailable — store does not attribute tokens per worker | unavailable — store does not attribute tokens per worker | unavailable — no worker patch file | unavailable — no finished event |
| `Build quant-arena: self-contained strategy-improvement pilot` | 45.7min | unavailable — store does not attribute tokens per worker | unavailable — store does not attribute tokens per worker | unavailable — no worker patch file | unavailable — no finished event |
| `agent-eval: README overhaul + evidence-based cleanup` | 11.2min | unavailable — store does not attribute tokens per worker | unavailable — store does not attribute tokens per worker | unavailable — no worker patch file | unavailable — no finished event |
| `agent-runtime: README overhaul + evidence-based cleanup` | 14.6min | unavailable — store does not attribute tokens per worker | unavailable — store does not attribute tokens per worker | unavailable — no worker patch file | unavailable — no finished event |
| `supervisor-lab: present the program clearly + clean` | 9.6min | unavailable — store does not attribute tokens per worker | unavailable — store does not attribute tokens per worker | unavailable — no worker patch file | unavailable — no finished event |
| `Survey backtesting frameworks + OMS strategy-contract standards` | 10.2min | unavailable — store does not attribute tokens per worker | unavailable — store does not attribute tokens per worker | unavailable — no worker patch file | unavailable — no finished event |
| `Quant-arena v2: onBar contract + vectorbt worker + parity` | 36.2min | unavailable — store does not attribute tokens per worker | unavailable — store does not attribute tokens per worker | unavailable — no worker patch file | unavailable — no finished event |
| `Build + fire gen-4: model-diverse proposers + Pareto parents` | 20.7min | unavailable — store does not attribute tokens per worker | unavailable — store does not attribute tokens per worker | unavailable — no worker patch file | unavailable — no finished event |
| `Build observatory: deterministic run-record charts` | 15.6min | 224 | 40259 | unavailable — no worker patch file | unavailable — no finished event |
| `Research: SOTA self-improvement + RL rollout data standards` | 6.4min | 9764 | 16683 | unavailable — no worker patch file | unavailable — no finished event |
| `Build rollout ledger: tangle.rollout.v1 capture + backfill` | 17.2min | 258 | 46878 | unavailable — no worker patch file | unavailable — no finished event |
| `Build HF dataset release pipeline on rollout ledger` | 11min | 158 | 49138 | unavailable — no worker patch file | unavailable — no finished event |
| `Build gen-5: full SOTA-protocol integration bundle` | 29.4min | 384 | 92942 | unavailable — no worker patch file | unavailable — no finished event |
| `Worker-model ablation: same supervisor, stronger workers` | 136.6min | 582 | 60025 | unavailable — no worker patch file | unavailable — no finished event |
| `Wire GEPA as a proposer seat in swe-arena` | 22.2min | 328 | 49810 | unavailable — no worker patch file | unavailable — no finished event |
| `Purge handrolled proposer sketches superseded by real GEPA` | 10min | 148 | 29647 | unavailable — no worker patch file | unavailable — no finished event |
| `Collapse two rollout implementations into one (agent-eval core)` | 27.6min | 446 | 82820 | unavailable — no worker patch file | unavailable — no finished event |
| `Design+pilot factory-bench: e2e feature instances from our repo history` | 15.5min | 1794 | 35431 | unavailable — no worker patch file | unavailable — no finished event |
| `Build factory-bench runner per pilot design` | 52.5min | 324 | 58569 | unavailable — no worker patch file | unavailable — no finished event |
| `Clear the agent-runtime PR backlog via merge train` | 81.2min | 622 | 31142 | unavailable — no worker patch file | unavailable — no finished event |
| `Deterministic run-report: auto-answer the autopsy questions` | 19.9min | 374 | 41658 | unavailable — no worker patch file | unavailable — no finished event |
| `Solo-loop control arm on factory-bench` | 80.9min | 514 | 60050 | unavailable — no worker patch file | unavailable — no finished event |
| `Move supervisor-tree reader into the trace-analysis layer` | 35.8min | 586 | 103416 | unavailable — no worker patch file | unavailable — no finished event |
| `Remove output-token caps on the supervisor brain path` | 26.3min | 564 | 58517 | unavailable — no worker patch file | unavailable — no finished event |
| `Placement audit for long-horizon supervisor mechanics` | 10.5min | 5270 | 29436 | unavailable — no worker patch file | unavailable — no finished event |
| `Re-land durable resume + refilling dispatch in agent-runtime` | 46.9min | 594 | 70555 | unavailable — no worker patch file | unavailable — no finished event |
| `Prove tree reader generalizes to third-party harnesses` | 65.5s | 36 | 3219 | unavailable — no worker patch file | unavailable — no finished event |

## Outcome

| Metric | Value |
|---|---|
| Supervisor status | running |
| Supervisor verdict | unavailable — no state.json / result.json verdict |
| Delivered | unavailable — no delivered flag in state.json or result.json |
| Judge resolved | unavailable — judge.json absent |
| Judge score | unavailable — judge.json absent |
| Judge passed / total | unavailable — judge.json absent / unavailable — judge.json absent |
| Judge source | unavailable — no judge.json and no ledger row |
| Verify gate | pass=unavailable — result.json absent or has no verify_pass rc=unavailable — result.json absent or has no verify_rc |
| Patch | unavailable — Claude Code retains no per-worker patch — subagents commit to git, they do not hand back a diff |

## Gaps

- driverSteerCalls: driver.log absent
- accepted: Claude Code runs no per-worker verify step — a subagent reports prose, not pass/fail
- totalUsd: Claude Code transcripts record token usage but never a price — usd is not in the store
- brain.brainTruncations: brain.jsonl absent — loops predates the brain-call tap, so truncation cannot be ruled out
- patch: Claude Code retains no per-worker patch — subagents commit to git, they do not hand back a diff
- judge: judge.json absent
- verifyPass: result.json absent or has no verify_pass

> Harness-session view of the same run (model calls, stuck loops, tool errors): `npx --yes @tangle-network/traces@latest analyze --harness claude-code --session fa9c4333-d5e7-411e-863e-ac08ab49dc00`
