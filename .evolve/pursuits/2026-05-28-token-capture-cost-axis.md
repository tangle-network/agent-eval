# Pursuit: revive the cost axis — capture real token usage
Generation: 1
Status: ADVANCE — shipped as agent-builder PR #221 (full fix-forward, greenfield, no retroactive billing)

## Metric → product-value claim
- costUsd nonzero on real RunRecords → analyzeRuns cost/quality Pareto carries signal; customers see real $/run, not $0.

## System Audit (verified against real code + on-disk data, not memory)

### The data (decisive)
- agent-builder corpus n=32: 0/32 records have nonzero tokens; **20/20 PASSING runs have zero tokens** → token capture broken at the source, not a failed-run artifact.
- Zero across ALL cell types (forge-chat, forge-builder-sim, customer-sim...) AND all 3 models (claude-code/sonnet, anthropic/claude-sonnet-4-6, opencode/glm-5.1) → not a cli-bridge quirk.

### Root cause (offline-verified)
AI SDK **v6** (`ai@6.0.191`): `LanguageModelUsage = { inputTokens, outputTokens, totalTokens }`.
No `promptTokens`/`completionTokens` (those were v4). Code reads v4 names through a lying cast in TWO places:
- `src/lib/.server/runtime/forge-chat.ts:226` — `result.usage as Promise<UsageSnapshot>` (UsageSnapshot={promptTokens,completionTokens}); `.catch(()=>undefined)` + downstream `?? 0` → {0,0}.
- `src/routes/api.agents.$agentId.chat.ts:417` — same inline cast.
Compounding: reads `result.usage` (LAST step) not `result.totalUsage` (sum); stepCountIs(6) multi-tool turns undercount even after rename.
Cost: eval cells hardcode `costUsd: 0` (canonical-campaign.ts:481,686,851,950,1081); prod computes cost from the (zero) tokens.

### Production blast radius (the headline)
`api.agents.$agentId.chat.ts:556-568`: `inTok = usage?.promptTokens ?? 0` (→0 on v6) → `costUsd = 0` → `chargeAgent({costUsd:0, description:'Forge chat turn (0+0 tok)'})`.
**Every production forge-chat turn is billed $0.** Revenue leakage, not just a dead eval axis.
forge-chat.ts is SHARED: prod chat route imports runForgeChatThroughRuntime (line 27, used 334) → fixing the mapper changes production billing.

### Prerequisite
agent-builder pins agent-eval **0.57.0** (old silent-$0 estimateCost). Cost fix needs bump to **0.58.2**.

## Diagnosis: architectural, cross-cutting, billing-affecting. Not a parameter tune.

## Blocking review gate
- Touches billing/payments/credits? **YES** (chargeAgent + shared usage mapper) → review BLOCKING; scope is Drew's call.

## Design (ready to build on go)
1. forge-chat.ts: `toUsageSnapshot(u: LanguageModelUsage)` mapping v6 inputTokens/outputTokens→snapshot; read `totalUsage` not `usage`; drop the lying cast. (fixes eval + prod runtime-branch billing)
2. chat.ts:417 router branch: same mapper; bill from real tokens.
3. canonical-campaign.ts 5 cells: wire `estimateCost(in,out,modelId)` into costUsd.
4. Bump agent-eval 0.57.0→0.58.2.
5. Offline tests: v6-usage→snapshot mapping nonzero; cell-result builder yields costUsd>0 for a priced model. (live-corpus confirmation gated on sidecar #1393.)
