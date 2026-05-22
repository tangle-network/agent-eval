# agent-eval substrate spec — pattern absorption (release 0.32.0)

Status: DRAFT — ready to file as GitHub issue in `tangle-network/agent-eval`.
Target release: `@tangle-network/agent-eval@0.32.0` (single minor).
Unblocks: `/tmp/audit/spec-{tax,legal,creative,gtm}-agent.md` and `/tmp/audit/spec-agent-builder.md`.

---

## 0. Read-first context

Source documents this spec is grounded in:

- `/tmp/audit/SYNTHESIS.md` — five-consumer cross-audit, §"Five patterns every vertical hand-rolls — lift candidates for substrate" (lines 51-63 of synthesis)
- `/tmp/audit/agent-eval-catalog.md` — substrate surface at HEAD `f7a567f` (v0.31.1), capability areas + 17 entry points
- `/tmp/audit/tax-agent-integration.md`
- `/tmp/audit/legal-agent-integration.md`
- `/tmp/audit/creative-agent-integration.md`
- `/tmp/audit/gtm-agent-integration.md`
- `/tmp/audit/agent-builder-integration.md`

Source trees re-verified at:

- `/home/drew/code/agent-eval/` (HEAD `f7a567f`, branch `main`)
- `/home/drew/code/tax-agent/`
- `/home/drew/code/legal-agent/`
- `/home/drew/code/creative-agent/`
- `/home/drew/code/gtm-agent/`
- `/home/drew/code/agent-builder/`

Every file:line citation in §9 was re-confirmed against the working tree on 2026-05-22.

Surface invariants this spec MUST respect (from `agent-eval-catalog.md` §4):

- Root re-exports are gated to the capture-integrity surface (see comment at `src/index.ts:482-486`). `./trace`, `./knowledge`, `./governance`, `./trace-analyst` re-export via `*`; the other six modules deliberately do NOT.
- `tests/consumer-contract.test.ts` pins the symbols the five consumers import — additions are fine, removals/renames break the build. New primitives MUST land in this test.
- Stability tags are emitted into `.d.ts`. Every primitive added below is `@stable` unless flagged `@experimental` in its task. Two of the eight are experimental on first ship (T06 `runDurableEval`, T07 `buildPersonaErrorResult` — they wrap an upstream `agent-runtime` surface that is itself stable; the substrate wrapper is new enough that we keep the experimental tag for one minor).
- No silent fallbacks (`CLAUDE.md` "No fallbacks. Fail loud."). Every new primitive throws a typed error on misuse — no `?? defaultValue` on required inputs.

---

## 1. Executive summary

The five-vertical audit identified that all four product consumers (tax, legal, creative, gtm) hand-roll the same five patterns, legal carries two additional patterns that should be universal, and agent-builder ships one effect-size helper (`cliffsDelta`) the substrate is missing. **Eight new primitives** absorb every one of these patterns and unblock ~500 lines of duplicated drift deletion across consumers.

| # | Primitive | File | Surface | Stability |
|---|---|---|---|---|
| **T01** | `assertCrossFamily(judges, opts)` + `judgeFamily(modelId)` | `src/judge-families.ts` | root | `@stable` |
| **T02** | `captureFetchToRawSink(fetch, sink, opts)` | `src/trace/capture-fetch.ts` | root + `./traces` | `@stable` |
| **T03** | `weightedComposite({ dims, weights, threshold? })` | `src/composite.ts` | root | `@stable` |
| **T04** | `flattenOtlpExportToNdjson(export, opts)` | `src/trace-analyst/otlp-flatten.ts` | root + `./traces` | `@stable` |
| **T05** | `assertSingleBackend(agent, judge, opts)` | `src/integrity/single-backend.ts` | root | `@stable` |
| **T06** | `runDurableEval<TPersona, TResult>(opts)` | `src/optimization/durable-eval.ts` | root + `./optimization` | `@experimental` |
| **T07** | `buildPersonaErrorResult(personaId, error, opts)` | `src/optimization/durable-eval.ts` | root + `./optimization` | `@experimental` |
| **T08** | `cliffsDelta(before, after)` + `interpretCliffs(d)` | `src/paired-stats.ts` (extend) | root + `./reporting` | `@stable` |

Effort estimate (calendar): **2-3 engineer days** end-to-end.

- T01, T03, T05, T08: pure-function helpers, ~30-60 LOC each + unit tests. Half a day for all four.
- T02: ~120 LOC + integration tests against a stub backend. Half a day.
- T04: ~80 LOC + golden-file tests round-tripping a real `OtlpExport`. Half a day.
- T06 + T07: ~150 LOC + a crash-resume integration test that simulates the legal scenario. One day.
- Wire up `consumer-contract.test.ts` updates, `package.json` exports, `CHANGELOG.md`, `dist/openapi.json` regenerate. Half a day.

Impact:

- **~500+ lines of duplicated drift deleted** across tax/legal/creative/gtm/agent-builder once consumer specs land (full counts in §2).
- Cross-family judge enforcement consolidated to one regex map. No more drift between `lib/judge-ensemble.ts` versions.
- Fetch capture moves from four hand-rolled implementations (one of which legal has TWO copies of) to one substrate primitive that already understands the redactor + provider-derivation chain.
- Three OTLP flatteners replaced by one canonical projection that round-trips through `OtlpFileTraceStore` without consumers re-deriving the line shape.
- `runDurableEval` lifts legal's stale-lease-reclaim + per-persona checkpoint pattern so tax/creative/gtm can adopt durability without copying 200+ lines of legal's `canonical.ts`.
- `cliffsDelta` becomes a substrate primitive alongside `pairedWilcoxon` + `pairedBootstrap`, removing agent-builder's "the substrate doesn't ship one — it's small enough to keep here" comment at `differential-eval.ts:83`.

Non-goals (explicit, deferred to 0.33 or later — see §8):

- `MultiTurnScenarioPayload<TBehavior>` generic (agent-builder local). Deferred to 0.33 per audit synthesis line 38.
- `MetricsRollup` / `BackendIntegrityReport` extensions. Deferred.
- Scaffold-template propagation (the "biggest lever" finding). That's a separate spec in `agent-builder`, not substrate.

---

## 2. Current state — who hand-rolls what

Table maps each new substrate primitive to the consumer files that hand-roll it today, with rough LOC counts (the LOC delta is the deletion budget once consumer migrations land).

| Primitive | Consumer file | Lines | Notes |
|---|---|---:|---|
| **T01 cross-family** | `/home/drew/code/tax-agent/tests/eval/lib/judge-ensemble.ts` | 143 | `judgeFamily` + `resolveJudgeEnsemble` + `JudgeEnsembleError` |
| | `/home/drew/code/legal-agent/tests/eval/run-prompt-evolution.ts:320-395` | 75 | `judgeFamily` + `resolveJudgeModels` (inline, no error class) |
| | `/home/drew/code/gtm-agent/eval/lib/judge-ensemble.ts` | 138 | Near-identical to tax `judge-ensemble.ts`; same regex map |
| | `/home/drew/code/creative-agent/eval/lib/judge-ensemble.ts` | 129 | Near-identical to tax + gtm |
| | **T01 total deletion** | **~485** | Replaced by ~140 LOC at `src/judge-families.ts` + one re-export in `index.ts` |
| **T02 captureFetch** | `/home/drew/code/tax-agent/tests/eval/canonical.ts:436-509` | 73 | `captureFetchFor` + `buildRawEvent` + redactor helpers |
| | `/home/drew/code/tax-agent/tests/eval/run-prompt-evolution.ts:487-?` | ~70 | Second copy in same repo |
| | `/home/drew/code/legal-agent/tests/eval/canonical.ts:456-548` | 92 | `captureFetchFor` + extended ctx for cli-bridge |
| | `/home/drew/code/legal-agent/tests/eval/run-prompt-evolution.ts:477-?` | ~95 | Second copy — different ctx shape, drift risk |
| | `/home/drew/code/creative-agent/eval/canonical-runner.ts:651+` (via `makeCaptureFetch`) | ~85 | Helper function + caller |
| | `/home/drew/code/creative-agent/eval/run-prompt-evolution.ts:446-?` | ~75 | Second copy |
| | **T02 total deletion** | **~490** | Replaced by ~140 LOC at `src/trace/capture-fetch.ts` + one re-export |
| **T03 composite** | `/home/drew/code/tax-agent/tests/eval/lib/production-loop.ts:73-77` | 5 | `PRODUCTION_LOOP_OBJECTIVE_WEIGHTS` + inline `weightedMean` |
| | `/home/drew/code/gtm-agent/eval/canonical.ts:1209` | 1 | Open-coded `judgeAvg*0.6 + det*0.3 + slop*0.1` |
| | `/home/drew/code/gtm-agent/eval/run-prompt-evolution.ts:460-464` | 5 | `clamp01(...)` with `COMPOSITE_WEIGHTS` |
| | `/home/drew/code/creative-agent/eval/canonical-runner.ts:862-863` | 2 | Unweighted mean of `raw` components |
| | `/home/drew/code/agent-builder/src/lib/.server/eval/canonical-campaign.ts:612-627` | 16 | Custom `judge*0.6 + tool*0.4` + threshold logic |
| | **T03 total deletion** | **~30** | The LOC win is small but the drift risk is high — 5 different weighting policies in 5 repos. |
| **T04 OTLP flatten** | `/home/drew/code/creative-agent/eval/trace-analyst-runner.ts:147-205` | 58 | `nanoToIso` + per-span projection + `oiKind` mapping |
| | `/home/drew/code/gtm-agent/eval/auto-research.ts:154-179, 395-442` | 73 | `projectOtlpSpan` + `otlpAttrsToObject` + `nsToIso` |
| | `/home/drew/code/legal-agent/tests/eval/lib/traces-to-otlp.ts` | 389 | Larger — also reads agent-eval's own NDJSON shards directly. Substrate `T04` covers the per-span projection; the legal-specific shard-merge stays in legal. |
| | **T04 total deletion** | **~150** | The legal shard-merge layer is legal-specific (only it has the `_update: true` patch row situation). The substrate primitive replaces the OTLP→flat-line conversion (which all three repeat). |
| **T05 single backend** | `/home/drew/code/legal-agent/tests/eval/canonical.ts:702-795` | ~95 | `EvalBackendConfig` + `resolveBackendConfig` + `judgeBackendConfig` |
| | **T05 total deletion** | ~25 | Most of legal's 95 LOC stays — backend resolution itself is per-consumer. The substrate primitive replaces the **assertion** that agent and judge backends agree (lines 785-795 of legal `canonical.ts`). |
| **T06 durable eval** | `/home/drew/code/legal-agent/tests/eval/canonical.ts:344-388, 1371-1464` | ~155 | `runDurableResumable` + `stableRunId` + the persona-loop inside `runDurable(...)` |
| | **T06 total deletion** | ~120 | The substrate generic replaces the resumable+per-persona shape; `stableRunId` stays per-consumer (it hashes consumer-specific identity). Other consumers (tax/creative/gtm) **gain** durability without writing the loop themselves. |
| **T07 persona error** | `/home/drew/code/legal-agent/tests/eval/canonical.ts:1167-1223` | ~57 | `buildPersonaErrorResult` returning a `PersonaStepResult` |
| | **T07 total deletion** | ~40 | Substrate primitive returns `{ summary?, record, integrity }` with consumer-typed `summary` via the generic. Legal's `PersonaStepResult` shrinks to a thin wrapper. |
| **T08 cliffsDelta** | `/home/drew/code/agent-builder/src/lib/.server/eval/differential-eval.ts:83-95` | 13 | Local impl with self-acknowledging "the substrate doesn't ship one" comment |
| | **T08 total deletion** | ~13 | Tiny LOC win, but the comment itself is the signal — this should be substrate. Other consumers gain it without re-writing. |

**Aggregate deletion budget**: **~1370+ LOC** of hand-rolled, drift-prone code across five consumer repos collapses to **~600 LOC** of substrate primitives + ~50 LOC of consumer-side re-exports/migrations. Net: a ~770-line reduction in consumer code, with one canonical implementation that the consumer-contract test pins.

---

## 3. Target architecture

This section locates every new primitive in the existing substrate topology and names the capability area it joins.

### File-level layout

```
src/
  judge-families.ts                       (NEW)  T01
  composite.ts                            (NEW)  T03
  trace/
    capture-fetch.ts                      (NEW)  T02
    raw-provider-sink.ts                  (existing — T02 imports `RawProviderSink`, `defaultProviderRedactor`, `providerFromBaseUrl`)
  trace-analyst/
    otlp-flatten.ts                       (NEW)  T04
    store-otlp.ts                         (existing — T04 emits the line shape this store consumes)
  integrity/
    backend-integrity.ts                  (existing)
    single-backend.ts                     (NEW)  T05
  optimization/
    durable-eval.ts                       (NEW)  T06 + T07
  paired-stats.ts                         (EXTEND) T08
  index.ts                                (EDIT — new re-exports for T01, T02, T03, T04, T05, T06, T07, T08)
  optimization.ts                         (EDIT — new re-exports for T06, T07)
  traces.ts                               (EDIT — new re-exports for T02, T04)
  reporting.ts                            (EDIT — new re-export for T08)
tests/
  judge-families.test.ts                  (NEW)  T01
  composite.test.ts                       (NEW)  T03
  trace/capture-fetch.test.ts             (NEW)  T02
  trace-analyst/otlp-flatten.test.ts      (NEW)  T04
  integrity/single-backend.test.ts        (NEW)  T05
  optimization/durable-eval.test.ts       (NEW)  T06 + T07 + crash-resume integration
  paired-stats.test.ts                    (EXTEND) T08
  consumer-contract.test.ts               (EDIT — pin new symbols)
```

### Capability area placement (matches `agent-eval-catalog.md` §2)

| New primitive | Capability area in catalog |
|---|---|
| T01 `assertCrossFamily` / `judgeFamily` | "Judge ensemble" (`src/judges.ts`, `src/judge-runner.ts`, root) — extends the existing area |
| T02 `captureFetchToRawSink` | "Campaign orchestration" → raw-provider sinks subsection (`src/trace/raw-provider-sink.ts`). Sits alongside `FileSystemRawProviderSink` + `defaultProviderRedactor` |
| T03 `weightedComposite` | "Run record + outcome shape" — produces a `{ score, pass, breakdown }` triple that maps directly to `RunOutcome.composite` + `RunOutcome.raw` |
| T04 `flattenOtlpExportToNdjson` | "Trace analyst surface" (`src/trace-analyst/*`) — the line shape `OtlpFileTraceStore` reads |
| T05 `assertSingleBackend` | "Integrity / capture" — joins `assertLlmRoute` + `assertRunCaptured` + `assertRealBackend` |
| T06 `runDurableEval` | "Feedback trajectory + production loop" + new sub-area "Durable eval orchestration". Wraps `runDurable` from `@tangle-network/agent-runtime`. |
| T07 `buildPersonaErrorResult` | Same as T06 |
| T08 `cliffsDelta` / `interpretCliffs` | "Promotion gate / paired stats" (`src/paired-stats.ts`) |

### Where each primitive sits relative to existing substrate primitives

```
                        ┌──────────────────────────────────────────────────┐
                        │              CAPTURE INTEGRITY CHAIN             │
                        │                                                  │
                        │  assertLlmRoute   ── one model, one route        │
                        │  assertRunCaptured ── trace emitter complete     │
                        │  assertRealBackend ── nonzero token usage        │
                        │  assertSingleBackend (NEW T05) ── agent == judge │
                        │                                                  │
                        └──────────────────────────────────────────────────┘

                        ┌──────────────────────────────────────────────────┐
                        │                 JUDGE ENSEMBLE                   │
                        │                                                  │
                        │  defaultJudges()                                 │
                        │  withJudgeRetry(judge, policy)                   │
                        │  aggregateTrialsByMode(...)                      │
                        │  judgeFamily(modelId)        (NEW T01)           │
                        │  assertCrossFamily(judges)   (NEW T01)           │
                        │                                                  │
                        └──────────────────────────────────────────────────┘

                        ┌──────────────────────────────────────────────────┐
                        │              TRACE / RAW PROVIDER                │
                        │                                                  │
                        │  FileSystemRawProviderSink                       │
                        │  InMemoryRawProviderSink                         │
                        │  NoopRawProviderSink                             │
                        │  defaultProviderRedactor                         │
                        │  providerFromBaseUrl                             │
                        │  captureFetchToRawSink(fetch, sink) (NEW T02)    │
                        │                                                  │
                        └──────────────────────────────────────────────────┘

                        ┌──────────────────────────────────────────────────┐
                        │              TRACE ANALYST / OTLP                │
                        │                                                  │
                        │  exportRunAsOtlp(store, runId, attrs)            │
                        │  OtlpFileTraceStore(opts)                        │
                        │  analyzeTraces(input, opts)                      │
                        │  flattenOtlpExportToNdjson(export) (NEW T04)     │
                        │                                                  │
                        └──────────────────────────────────────────────────┘

                        ┌──────────────────────────────────────────────────┐
                        │              PAIRED STATS / RELEASE              │
                        │                                                  │
                        │  pairedWilcoxon(a, b)                            │
                        │  pairedBootstrap(a, b, opts)                     │
                        │  bhAdjust(pvalues)                               │
                        │  cliffsDelta(before, after)   (NEW T08)          │
                        │  interpretCliffs(d)           (NEW T08)          │
                        │                                                  │
                        └──────────────────────────────────────────────────┘

                        ┌──────────────────────────────────────────────────┐
                        │                CAMPAIGN / DURABLE                │
                        │                                                  │
                        │  runEvalCampaign<V>(opts)                        │
                        │  CampaignRunner<V>                               │
                        │  HeldOutGate                                     │
                        │  runDurableEval<TPersona, TResult>  (NEW T06)    │
                        │  buildPersonaErrorResult(...)        (NEW T07)   │
                        │                                                  │
                        └──────────────────────────────────────────────────┘

                        ┌──────────────────────────────────────────────────┐
                        │               COMPOSITE / SCORING                │
                        │                                                  │
                        │  aggregateRunScore(weights, results)             │
                        │  weightedComposite({dims, weights}) (NEW T03)    │
                        │                                                  │
                        └──────────────────────────────────────────────────┘
```

### Non-goals (for 0.32 specifically)

1. **Multi-turn scenario generic** (`MultiTurnScenarioPayload<TBehavior>`). agent-builder ships a local impl; gtm/creative re-derive. Deferred to **0.33**. Reason: the shape is not yet stable across consumers — gtm uses `multiTurnFlow`, creative uses native turns, legal uses `conversation_flow` YAML, tax has no multi-turn. Pinning prematurely would force a churn.

2. **Backend-integrity report extension**. The existing `BackendIntegrityReport` is fine. The `MetricsRollup` (mean cost, p95 latency, tool-call shape histogram) requested in the audit deferral list belongs in `./reporting`, not `./integrity`. Deferred to **0.33**.

3. **Scaffold-template propagation**. This is a `tangle-network/agent-builder` change, not substrate. Tracked in `/tmp/audit/spec-agent-builder.md`.

4. **Resurrecting or deleting `runProductionLoop`**. Documentation-drift sweep is its own PR — pinned for after 0.32.

5. **`/pipelines` view adoption**. View functions already exist (`failureClusterView` etc.). Consumer adoption is a per-consumer spec, not a substrate change.

---

## 4. Implementation tasks

Each task names: file, signature, implementation outline, test plan, export entry, consumer migration note. All eight tasks fit in a single 0.32.0 minor.

---

### T01 — `assertCrossFamily(judges, opts)` + `judgeFamily(modelId)`

**File**: `src/judge-families.ts` (new, ~140 LOC).

**Signature**:

```ts
/**
 * Coarse model-family slug for cross-family judge enforcement. Returns
 * `'unknown'` when no pattern matches AND no tail-prefix can be derived.
 *
 * Family detection is regex-based against well-known prefixes. Falls back
 * to the leading alpha run of the model id's path tail so unknown models
 * still get a stable slug rather than collapsing under `'unknown'`.
 */
export function judgeFamily(modelId: string): string

/**
 * Known families recognised by `judgeFamily`. Stable identifiers — additions
 * are additive, renames are breaking.
 */
export type JudgeFamily =
  | 'anthropic'
  | 'openai'
  | 'kimi'
  | 'glm'
  | 'deepseek'
  | 'qwen'
  | 'google'
  | 'meta'
  | 'mistral'
  | 'grok'
  | 'unknown'
  | string  // tail-prefix fallback

export interface AssertCrossFamilyOptions {
  /** Override the agent model used as the family-exclusion anchor. When
   *  provided, judges that share `agentModel`'s family are rejected unless
   *  `allowSelfJudging` is true. */
  agentModel?: string
  /** Opt-in escape hatch. When true, same-family judges pass through. */
  allowSelfJudging?: boolean
  /** Source label baked into thrown errors — e.g. `'--judges flag'`,
   *  `'TAX_JUDGE_MODELS env'`. Improves diagnosis. */
  source?: string
}

export interface AssertCrossFamilyResult {
  /** Judges that passed the cross-family check, in input order, deduplicated. */
  judges: string[]
  /** Agent model's family (only set when `agentModel` was provided). */
  agentFamily?: string
  /** Judges removed because they shared `agentFamily`. Empty when
   *  `allowSelfJudging` is true. */
  excluded: string[]
}

export class JudgeFamilyError extends AgentEvalError {
  readonly reason: 'self_judging' | 'empty_ensemble' | 'invalid_input'
  constructor(message: string, reason: 'self_judging' | 'empty_ensemble' | 'invalid_input')
}

/**
 * Enforce the no-self-judging rule on a judge ensemble. Returns a
 * normalized `{ judges, agentFamily, excluded }` or throws
 * `JudgeFamilyError` with `reason`:
 *
 *   - `'self_judging'`: an explicit caller-provided judge shares the agent
 *     family and `allowSelfJudging` was not set.
 *   - `'empty_ensemble'`: after dropping same-family judges, zero remain.
 *   - `'invalid_input'`: zero judges supplied or `agentModel` was empty.
 *
 * No silent fallbacks — every failure mode throws with a stable reason
 * code the caller can match on.
 */
export function assertCrossFamily(
  judges: ReadonlyArray<string>,
  opts?: AssertCrossFamilyOptions,
): AssertCrossFamilyResult
```

**Implementation outline**:

1. Regex map (curated from tax + legal + gtm + creative consensus):

```ts
const FAMILY_PATTERNS: ReadonlyArray<readonly [RegExp, JudgeFamily]> = [
  [/(^|[\W_])(claude|sonnet|opus|haiku|anthropic)/i, 'anthropic'],
  [/(^|[\W_])(gpt|o1|o3|o4|openai)/i, 'openai'],
  [/(^|[\W_])(kimi|moonshot)/i, 'kimi'],
  [/(^|[\W_])(glm|zai)/i, 'glm'],
  [/(^|[\W_])deepseek/i, 'deepseek'],
  [/(^|[\W_])qwen/i, 'qwen'],
  [/(^|[\W_])(gemini|google)/i, 'google'],
  [/(^|[\W_])(llama|meta-llama)/i, 'meta'],
  [/(^|[\W_])mistral/i, 'mistral'],
  [/(^|[\W_])grok/i, 'grok'],
]
```

2. `judgeFamily(modelId)`: pure function — string normalise (`(modelId ?? '').toString()`), iterate `FAMILY_PATTERNS`, fall back to tail's leading alpha run, lowercase.

3. `assertCrossFamily(judges, opts)`: dedupe input, normalise `agentModel`, branch on `allowSelfJudging`. Throws `JudgeFamilyError` with named reason on every failure mode. Returns `{ judges, agentFamily, excluded }`.

**Test plan**:

- Unit: every regex pattern matches the model ids in `agent-eval-catalog.md` §2 ("Judge ensemble") + the consumer-side ids from tax/legal/gtm/creative (~30 ids). Snapshot the family slugs.
- Unit: `assertCrossFamily([], { agentModel: 'x' })` throws `'invalid_input'`.
- Unit: `assertCrossFamily(['claude-sonnet-4-6'], { agentModel: 'claude-sonnet-4-6' })` throws `'self_judging'`.
- Unit: `assertCrossFamily(['claude-sonnet-4-6'], { agentModel: 'claude-sonnet-4-6', allowSelfJudging: true })` returns `{ judges: ['claude-sonnet-4-6'], agentFamily: 'anthropic', excluded: [] }`.
- Unit: `assertCrossFamily(['claude-x', 'claude-y', 'claude-z'], { agentModel: 'claude-foo' })` throws `'empty_ensemble'`.
- Unit: deduplication — `assertCrossFamily(['a', 'a', 'b'])` returns `['a', 'b']`.
- Unit: `source` lands in error message: `assertCrossFamily([same-family], { agentModel, source: '--judges flag' })` throws with message containing `'--judges flag'`.
- Regression: consumer-contract test pins `assertCrossFamily`, `judgeFamily`, `JudgeFamilyError`, `JudgeFamily` (type-only, validated via namespace import).

**Export entry**: `src/index.ts` — add:

```ts
export type { AssertCrossFamilyOptions, AssertCrossFamilyResult, JudgeFamily } from './judge-families'
export { assertCrossFamily, judgeFamily, JudgeFamilyError } from './judge-families'
```

**Consumer migration note** (delivered in `/tmp/audit/spec-{tax,legal,creative,gtm}-agent.md`):

- Delete `lib/judge-ensemble.ts` (tax + gtm + creative — 410 LOC combined).
- Delete `judgeFamily` + `resolveJudgeModels` from `run-prompt-evolution.ts:320-395` in legal.
- Replace callers: `resolveJudgeEnsemble({ agentModel, explicit, defaults })` → `assertCrossFamily([...explicit, ...defaults], { agentModel, source: '...' })`. The result shape differs slightly (substrate returns `judges` after applying explicit-vs-defaults policy directly; consumer-side branching on `explicit.length > 0 ? explicit : defaults` happens in consumer code as a one-liner).
- Same-family `JudgeEnsembleError` becomes substrate `JudgeFamilyError` — same `reason` codes (`self_judging` / `empty_ensemble` / `invalid_input`). Substrate version extends `AgentEvalError` so the existing error taxonomy applies.

---

### T02 — `captureFetchToRawSink(fetch, sink, opts)`

**File**: `src/trace/capture-fetch.ts` (new, ~140 LOC).

**Signature**:

```ts
import type { RawProviderSink, RawProviderEvent, ProviderRedactor } from './raw-provider-sink'

export interface CaptureFetchContext {
  /** Logical run id stamped on every captured event. Required — without
   *  it the raw events can't be paired with their parent `Run`. */
  runId: string
  /** Optional logical span id. Required only when the caller wants
   *  span-level filtering via `RawProviderSinkFilter.spanId`. */
  spanId?: string
  /** Resolved base URL (post-normalisation, no trailing slash). Used both
   *  for the captured event's `baseUrl` field and for endpoint-path
   *  extraction. */
  baseUrl: string
  /** Model id the caller intends to invoke. Stamped on every event. */
  model: string
  /** Optional provider override. When omitted, `providerFromBaseUrl(baseUrl)`
   *  is used. */
  provider?: string
}

export interface CaptureFetchOptions {
  /** Override the redactor applied at capture time. Defaults to
   *  `defaultProviderRedactor` (strips Authorization / X-Api-Key / Cookie
   *  headers and credential-shaped body keys). */
  redactor?: ProviderRedactor
  /** Cap on captured response body bytes. Bodies beyond this are
   *  truncated and a `body_truncated` marker is set in `redactedFields`.
   *  Default 2 MiB. */
  responseBodyByteCap?: number
  /** When true, capture failures (sink.record() throwing) propagate to
   *  the caller. Default false — capture is best-effort so a sink-write
   *  failure does NOT take down the underlying LLM call. */
  failClosed?: boolean
}

/**
 * Wrap a `fetch` reference so every request, response, and error against
 * the provider is recorded into `sink` as a `RawProviderEvent` triple.
 * Uses `defaultProviderRedactor` and `providerFromBaseUrl` from
 * `./raw-provider-sink` — no new redaction policy.
 *
 * Captures request and response bodies via `.clone().text()` so the
 * underlying runtime still consumes the un-mutated `Response`. Retries
 * appear as `attemptIndex` 1, 2, … on the captured events; first attempt
 * is 0. Errors (network failure pre-response) emit a single
 * `direction: 'error'` event with `durationMs` set to the elapsed time
 * before the throw.
 *
 * The returned `fetch` is a plain `typeof fetch` — pass it as
 * `fetchImpl` to any OpenAI-compatible backend factory
 * (`createOpenAICompatibleBackend`, `createOpenAIBackend`, …).
 */
export function captureFetchToRawSink(
  fetch: typeof globalThis.fetch,
  sink: RawProviderSink,
  ctx: CaptureFetchContext,
  opts?: CaptureFetchOptions,
): typeof globalThis.fetch
```

**Implementation outline**:

1. Resolve `provider = ctx.provider ?? providerFromBaseUrl(ctx.baseUrl)` and `redactor = opts?.redactor ?? defaultProviderRedactor` at wrapper construction.
2. Return a closure-captured fetch:
   - Extract `url` + `method` from `RequestInfo | URL | Request` input forms.
   - Extract request headers via `Headers.forEach` into a `Record<string, string>` (case-normalised).
   - Best-effort body read: `init.body` if string; `input.clone().text()` if `Request`; JSON-parse with `try { JSON.parse } catch { ... }`.
   - Compute `endpoint` by stripping `baseUrl` prefix from `url`.
   - Record `direction: 'request'` event (via `sink.record`).
   - Invoke real fetch; capture errors as `direction: 'error'` event before rethrow.
   - On success: `.clone()` response, read body bytes up to `responseBodyByteCap` (default 2 MiB), record `direction: 'response'` event with status + headers + (parsed-or-raw) body.
   - Return original `Response` unchanged.
3. Per-call `attemptIndex` — initialise from `0` on the first request; the substrate doesn't yet track retries at this layer (the backend retries via re-invoking `fetchImpl` which re-creates a wrapper context). For 0.32 we ship `attemptIndex: 0` always and let the consumer's wrapper-of-wrapper bump it if needed. Document this.
4. Capture-failure handling: by default swallow sink errors (log to `console.warn` once per wrapper) so an LLM call doesn't die because the sink directory ran out of disk. `failClosed: true` propagates.

**Test plan**:

- Unit: against a stub `RawProviderSink` (in-memory), one fetch call produces exactly two events (`request` + `response`) with stable `runId`, `spanId`, `model`, `provider`, `baseUrl`, `endpoint`.
- Unit: a fetch that rejects with `TypeError` produces one `request` and one `error` event, then re-throws the original error.
- Unit: redactor is applied — Authorization header in the captured event lands in `redactedFields`, not `requestHeaders`.
- Unit: response-body truncation — feed a 5 MiB response with default cap, captured event's `responseBody` is ≤ 2 MiB and `redactedFields` includes `'body_truncated'`.
- Unit: provider derivation — `ctx.baseUrl = 'https://router.tangle.tools/v1'` without explicit `ctx.provider` yields `event.provider === 'tangle-router'`.
- Integration: wired into a real `createOpenAICompatibleBackend` against a local mock server (the existing pattern in `llm-client.test.ts`); assert two events captured for a single chat completion + the underlying response shape is intact.
- Integration: capture-failure path — pass a sink that throws on `.record`, ensure `failClosed: false` (default) lets the original `fetch` complete; `failClosed: true` propagates the sink error.

**Export entry**: `src/index.ts` and `src/traces.ts` re-export. Add:

```ts
// in src/index.ts (root re-export, root carries the trace surface)
export type { CaptureFetchContext, CaptureFetchOptions } from './trace/capture-fetch'
export { captureFetchToRawSink } from './trace/capture-fetch'
```

The `traces.ts` subpath already re-exports `* from './trace'`, so adding `capture-fetch.ts` under `src/trace/` and exporting from `src/trace/index.ts` propagates automatically.

**Consumer migration note**:

- Tax: delete `captureFetchFor` + `buildRawEvent` from `tests/eval/canonical.ts:436-548` and `tests/eval/run-prompt-evolution.ts:487-?`. Replace callers with `captureFetchToRawSink(globalThis.fetch, rawSink, { runId, spanId, baseUrl, model })`.
- Legal: same pattern, two files (`canonical.ts:456+` and `run-prompt-evolution.ts:477+`).
- Creative: delete `makeCaptureFetch` from `canonical-runner.ts:651`, delete `captureFetchFor` from `run-prompt-evolution.ts:446`.
- gtm: already uses substrate `FileSystemRawProviderSink` directly via `LlmClient`'s `rawSink` opt; T02 doesn't apply there (the gtm path doesn't fetch-wrap, it wires `rawSink` to `LlmClientOptions`). Note in spec.

---

### T03 — `weightedComposite({ dims, weights, threshold? })`

**File**: `src/composite.ts` (new, ~60 LOC).

**Signature**:

```ts
export interface WeightedCompositeInput {
  /** Per-dimension scalar scores in [0, 1]. Missing dims default to 0
   *  ONLY when explicitly listed in `weights` (otherwise the dim is
   *  ignored — opting in via the weights map is the contract). */
  dims: Record<string, number>
  /** Per-dimension weights. Need not sum to 1.0 — substrate normalises
   *  to weights.sum so callers can write whole-integer or readable
   *  weights ({helpfulness: 6, harm: 4} === {helpfulness: 0.6, harm: 0.4}).
   *  Empty `weights` throws — every composite must declare its dimensions.
   */
  weights: Record<string, number>
  /** Optional pass-fail threshold. When provided, `pass: composite >= threshold`. */
  threshold?: number
}

export interface WeightedCompositeResult {
  /** Weighted composite in [0, 1]. NaN-free — substrate validates input. */
  score: number
  /** True when `threshold` was provided and `score >= threshold`. Undefined
   *  when no threshold was provided (caller decides pass-fail elsewhere). */
  pass: boolean | undefined
  /** Per-dim weighted contributions. Sum equals `score`. Useful for
   *  attribution: "the composite was 0.62; helpfulness contributed 0.45,
   *  harm contributed 0.17." */
  breakdown: Record<string, number>
  /** Sum of supplied weights — useful for cross-checking caller's weights map. */
  weightSum: number
  /** Effective per-dim weights AFTER normalisation. */
  effectiveWeights: Record<string, number>
}

export class CompositeError extends AgentEvalError {
  constructor(message: string)
}

/**
 * Compute the canonical weighted composite of a per-dim score map.
 *
 *   composite = Σ_i (weights[i] / Σ_j weights[j]) × dims[i]
 *
 * Validates: weights non-empty, every weight finite + non-negative,
 * every dim value finite, threshold (if set) in [0, 1]. Throws
 * `CompositeError` on any violation — never silently treats missing
 * dims as zero unless they're explicitly weighted.
 */
export function weightedComposite(input: WeightedCompositeInput): WeightedCompositeResult
```

**Implementation outline**:

1. Validate: `Object.keys(weights).length > 0`; every weight `Number.isFinite && >= 0`; every value in `dims` is `Number.isFinite`; `threshold` (if present) is `Number.isFinite && >= 0 && <= 1`. Throw `CompositeError` on any failure with a precise message.
2. `weightSum = Σ weights[k]`; if `weightSum === 0`, throw (`'weights must sum > 0'`).
3. `effectiveWeights[k] = weights[k] / weightSum`.
4. `breakdown[k] = effectiveWeights[k] × (dims[k] ?? 0)`. Missing dim is explicitly zero only when its weight is set — but emit a `CompositeError` if the value of a weighted dim is `undefined` AND `dims` did declare the same key with a non-finite value. The exact contract: if `weights[k]` is set, `dims[k]` MUST be set and finite.
5. `score = Σ breakdown`.
6. `pass = threshold === undefined ? undefined : (score >= threshold)`.

**Test plan**:

- Unit: golden case — `weights: {a:0.6,b:0.3,c:0.1}`, `dims: {a:0.9,b:0.7,c:0.5}` → `score = 0.81`.
- Unit: whole-integer normalisation — `weights: {a:6,b:3,c:1}` produces identical `score` and `effectiveWeights: {a:0.6,b:0.3,c:0.1}`.
- Unit: threshold pass/fail — `threshold: 0.8` against the golden case yields `pass: true`; `threshold: 0.85` yields `pass: false`; no threshold yields `pass: undefined`.
- Unit: missing weighted dim throws — `weights: {a:1}, dims: {}` throws `CompositeError`.
- Unit: NaN input throws — `dims: {a: NaN}` throws.
- Unit: negative weight throws.
- Unit: empty weights throws.
- Unit: breakdown sums to score (regression — float comparison within 1e-10).

**Export entry**:

```ts
// src/index.ts
export type { WeightedCompositeInput, WeightedCompositeResult } from './composite'
export { CompositeError, weightedComposite } from './composite'
```

**Consumer migration note**:

- Tax `lib/production-loop.ts:73-77`: replace `OBJECTIVE_WEIGHTS` + inline mean with `weightedComposite({ dims, weights: PRODUCTION_LOOP_OBJECTIVE_WEIGHTS, threshold: 0.7 })`.
- gtm `canonical.ts:1209` + `run-prompt-evolution.ts:460-464`: replace open-coded `judgeAvg*0.6 + det*0.3 + slop*0.1` with `weightedComposite({ dims: { judge, det, slop }, weights: COMPOSITE_WEIGHTS, threshold: FAIL_THRESHOLD })`.
- creative `canonical-runner.ts:862-863`: replace `components.reduce((s,x) => s+x, 0) / components.length` (an unweighted mean!) with `weightedComposite({ dims: raw, weights: rawComponents.map(k => [k, 1]).reduce(...) })` — the substrate version makes the unweighted-mean policy explicit instead of implicit.
- agent-builder `canonical-campaign.ts:612-627`: replace the branchy if/else weighting with `weightedComposite({ dims: { judge, toolFidelity }, weights: { judge: 0.6, toolFidelity: 0.4 }, threshold: FAIL_THRESHOLD })`. The threshold integration becomes one call instead of three guarded comparisons.

---

### T04 — `flattenOtlpExportToNdjson(otlpExport, opts)`

**File**: `src/trace-analyst/otlp-flatten.ts` (new, ~80 LOC).

**Signature**:

```ts
import type { OtlpExport, OtlpSpan } from '../trace/otel'

/**
 * Flat-line JSON object the `OtlpFileTraceStore` index reads (one per
 * `JSON.stringify` line in the NDJSON file).
 */
export interface OtlpFlatLine {
  trace_id: string
  span_id: string
  parent_span_id: string | null
  name: string
  kind: string
  start_time: string  // ISO-8601
  end_time: string    // ISO-8601
  status: { code: 'STATUS_CODE_OK' | 'STATUS_CODE_ERROR' | 'STATUS_CODE_UNSET'; message?: string }
  resource: { attributes: Record<string, string | number | boolean> }
  attributes: Record<string, string | number | boolean>
  events?: Array<{ name: string; timeUnixNano?: string; attributes?: Record<string, unknown> }>
}

export interface FlattenOtlpOptions {
  /**
   * Hint that callers can use to mirror per-span attributes into the
   * OpenInference vocabulary the analyst's `inferKind` reads.
   * - `'openinference'` (default): copies `span.kind` → `openinference.span.kind`
   *   (uppercased), `llm.model` → `llm.model_name`, `tool.name` →
   *   `inference.tool.name`.
   * - `'none'`: passes attributes through untouched.
   */
  attributeVocabulary?: 'openinference' | 'none'
  /** Override the span kind → otlp kind mapping. */
  kindMap?: Partial<Record<string, string>>
}

/**
 * Flatten an `OtlpExport` (the shape `exportRunAsOtlp` produces) into
 * the per-line JSON shape `OtlpFileTraceStore` reads. Returns an array
 * the caller can `.map(JSON.stringify).join('\n')` into an NDJSON file.
 *
 * Pure function — no I/O. Use `writeFileSync` (or async equivalent)
 * at the consumer boundary. The substrate intentionally does NOT
 * write the file because consumers want control over rotation and
 * naming.
 */
export function flattenOtlpExportToNdjson(
  otlpExport: OtlpExport,
  opts?: FlattenOtlpOptions,
): OtlpFlatLine[]
```

**Implementation outline**:

1. Resolve `attributeVocabulary` (default `'openinference'`).
2. Helper `otlpAttrsToObject(attrs)` — fold OTLP attribute array `[{key, value: {stringValue?, intValue?, ...}}]` into a flat object.
3. Helper `nanoToIso(unixNano: string): string` — BigInt-safe nanosecond → ISO. Returns Unix-epoch ISO on parse failure (preserves caller behaviour today).
4. Helper `spanKindToOtlpKind(kind)` — mirror creative + legal mapping (CLIENT for llm/retrieval, INTERNAL for tool/judge/sandbox/agent/custom).
5. Iterate `otlpExport.resourceSpans[].scopeSpans[].spans[]`:
   - `resource.attributes = otlpAttrsToObject(rs.resource.attributes)`.
   - `attributes = otlpAttrsToObject(span.attributes)`.
   - If `vocabulary === 'openinference'`:
     - `if (typeof attrs['span.kind'] === 'string') attrs['openinference.span.kind'] = attrs['span.kind'].toUpperCase()`.
     - `if (typeof attrs['llm.model'] === 'string') attrs['llm.model_name'] = attrs['llm.model']`.
     - `if (typeof attrs['tool.name'] === 'string') attrs['inference.tool.name'] = attrs['tool.name']`.
   - Project `status`: `code === 2 ? 'STATUS_CODE_ERROR' : code === 1 ? 'STATUS_CODE_OK' : 'STATUS_CODE_UNSET'`.
   - Emit `OtlpFlatLine`.

**Test plan**:

- Unit: feed a synthetic `OtlpExport` with one resource span, one scope, two spans (one llm, one tool). Assert exact `OtlpFlatLine[]` output including the openinference projections.
- Unit: `vocabulary: 'none'` skips the openinference projections.
- Unit: round-trip — flatten an export, write NDJSON, load via `OtlpFileTraceStore`, assert the trace summary lists the original spans + attributes.
- Unit: empty `OtlpExport` (zero resource spans) returns `[]`.
- Unit: nanoseconds round-trip — `startTimeUnixNano: '1715000000000000000'` parses to an ISO timestamp matching `new Date(1715000000000)`.
- Unit: malformed nanoseconds (`'abc'`) returns epoch ISO + does NOT throw.
- Regression: feed a real `exportRunAsOtlp` output from an existing test fixture and round-trip via `OtlpFileTraceStore.querySpans`.

**Export entry**:

```ts
// src/trace-analyst/index.ts (already exports * to root via trace-analyst.ts re-export at src/index.ts:292)
export type { FlattenOtlpOptions, OtlpFlatLine } from './otlp-flatten'
export { flattenOtlpExportToNdjson } from './otlp-flatten'

// src/traces.ts (already `export * from './trace-analyst'`)
// → automatic propagation; no edit needed.
```

**Consumer migration note**:

- creative `eval/trace-analyst-runner.ts:147-205`: replace the per-span loop + `nanoToIso` + attribute remapping with `flattenOtlpExportToNdjson(otlp).map(JSON.stringify).join('\n')`. The `oiKind` + `llm.model_name` + `inference.tool.name` projection is now substrate-default.
- gtm `eval/auto-research.ts:154-205, 395-442`: same. Delete `otlpAttrsToObject` (gtm at L395-404) + `projectOtlpSpan` (L410-430) + `nsToIso` (L432-442). Replace with one call to `flattenOtlpExportToNdjson`.
- legal `eval/lib/traces-to-otlp.ts`: the OTLP-→-flat-line portion (`spanToAttributes` + `toLine`) can be replaced. The shard-merge portion (`readMergedShards` handling `_update: true` patch rows) stays — that's legal-specific. Net deletion ~150 LOC of legal's 389.

---

### T05 — `assertSingleBackend(agent, judge, opts)`

**File**: `src/integrity/single-backend.ts` (new, ~70 LOC).

**Signature**:

```ts
import { AgentEvalError } from '../errors'

/**
 * Minimal backend-config shape recognised by the assertion. Consumers can
 * pass their own richer types — the substrate only reads these five fields.
 */
export interface BackendDescriptor {
  /** Backend route — typically `'tcloud' | 'cli-bridge' | 'sandbox' | 'direct-provider'`
   *  but free-form for consumer extensibility. */
  kind: string
  /** Resolved base URL. Compared lexically. */
  baseUrl: string
  /** Model id (with snapshot suffix). Compared lexically. */
  model: string
  /** Optional provider override — when both descriptors set it, the
   *  substrate compares them too. When only one sets it, that's
   *  reported as a divergence. */
  provider?: string
  /** Bearer token. The substrate does NOT compare values (security) —
   *  it only checks that EITHER both are set OR both are empty.
   *  Mismatched presence is a divergence. */
  apiKey?: string
}

export interface AssertSingleBackendOptions {
  /** When true, fail on ANY field divergence. When false (default),
   *  only `kind` and `baseUrl` mismatches throw — `model` divergence
   *  is allowed (cheaper judge model on the same route). */
  strict?: boolean
  /** Source labels baked into the thrown error message. */
  agentLabel?: string
  judgeLabel?: string
}

export interface SingleBackendReport {
  /** True when agent + judge backends agree per the configured strictness. */
  ok: boolean
  /** Field-by-field divergences detected. Empty when `ok` is true. */
  divergences: ReadonlyArray<{
    field: 'kind' | 'baseUrl' | 'model' | 'provider' | 'apiKeyPresence'
    agent: string | undefined
    judge: string | undefined
  }>
}

export class SingleBackendError extends AgentEvalError {
  constructor(message: string, public readonly report: SingleBackendReport)
}

/**
 * Throw `SingleBackendError` when the agent and judge backends diverge
 * in a way that would silently re-route the rubric judge through a
 * different (often paid) backend than the agent.
 *
 * The bug class this defends against: `--backend cli-bridge` rewires
 * the agent but the judge still calls `process.env.TANGLE_API_KEY` →
 * router. Cost gets billed against the router, the eval reports the
 * cli-bridge model, the data is unusable.
 *
 * Default strictness blocks `kind` and `baseUrl` divergence; `model`
 * may differ (legal pattern — cheaper judge model on the same route).
 * `strict: true` blocks ALL field divergence.
 */
export function assertSingleBackend(
  agent: BackendDescriptor,
  judge: BackendDescriptor,
  opts?: AssertSingleBackendOptions,
): SingleBackendReport
```

**Implementation outline**:

1. Build the divergence list:
   - `kind` — string compare.
   - `baseUrl` — string compare (after stripping trailing slash).
   - `model` — string compare (reported but not blocked unless `strict`).
   - `provider` — string compare when both set; flag when one is set and the other isn't.
   - `apiKey presence` — both empty or both non-empty; values not compared.
2. Filter divergences by strictness: default ignores `model` differences; `strict: true` keeps everything.
3. If divergences remain after filter, throw `SingleBackendError` with `agentLabel` / `judgeLabel` baked in.
4. Return the report (callers can log it in either case).

**Test plan**:

- Unit: identical descriptors → `ok: true`, no divergences.
- Unit: same kind, different baseUrl → throws (default strictness).
- Unit: same kind + baseUrl, different model → returns `ok: true` (default), `ok: false` under `strict: true`.
- Unit: agent has apiKey, judge does not → throws with `apiKeyPresence` divergence.
- Unit: `agentLabel` + `judgeLabel` land in the error message.
- Unit: provider divergence reported with both values when both set.
- Regression: against the legal failure case (agent `kind: 'cli-bridge'`, judge `kind: 'tcloud'`), assert the throw fires with `kind` divergence in `report.divergences`.

**Export entry**:

```ts
// src/index.ts (already has the integrity area exports)
export type { AssertSingleBackendOptions, BackendDescriptor, SingleBackendReport } from './integrity/single-backend'
export { assertSingleBackend, SingleBackendError } from './integrity/single-backend'
```

**Consumer migration note**:

- Legal `tests/eval/canonical.ts:785-795` (`judgeBackendConfig`): consumer keeps `resolveBackendConfig` + `judgeBackendConfig` (per-consumer env-var routing stays consumer-side), but adds at canonical-run start:
  ```ts
  const agentBackend = resolveBackendConfig(cli.backend)
  const judgeBackend = judgeBackendConfig(agentBackend)
  assertSingleBackend(agentBackend, judgeBackend, {
    agentLabel: `--backend ${cli.backend}`,
    judgeLabel: `--judge ${cli.judge}`,
  })
  ```
  Removes the "trust the comment" pattern at L702-795 — the contract becomes runtime-enforced.
- Tax/gtm/creative gain this guard by adopting the same call when they wire their backends. Spec'd in each consumer spec.

---

### T06 — `runDurableEval<TPersona, TResult>(opts)`

**File**: `src/optimization/durable-eval.ts` (new, ~150 LOC including T07).

**Stability**: `@experimental` for 0.32 (wraps `@tangle-network/agent-runtime`'s `runDurable` which itself is stable; the substrate wrapper is new). Bump to `@stable` in 0.33 after the four consumers integrate.

**Signature**:

```ts
import type {
  DurableRunStore,
  DurableContext,
  RunDurableInput,
  RunDurableResult,
  DurableRunManifest,
  RunOutcome as DurableRunOutcome,
} from '@tangle-network/agent-runtime'

export interface RunDurableEvalOptions<TPersona, TResult> {
  /** Stable run id — same id resumes a prior crashed run. Use
   *  `stableRunId({commit, config, ...})` per-consumer to derive. */
  runId: string
  /** Durable-run manifest — projectId, scenarioId, task, input, tags. */
  manifest: DurableRunManifest
  /** Store backing the durable run. `FileSystemDurableRunStore` from
   *  agent-runtime is the typical choice for evals; D1DurableRunStore for
   *  Cloudflare prod. */
  store: DurableRunStore
  /** Personas to drive. Each persona becomes one `ctx.step` checkpoint. */
  personas: ReadonlyArray<TPersona>
  /** Caller-supplied identity extractor. Used as the step key (one
   *  checkpoint per personaId — ensures resume idempotence). */
  personaId: (persona: TPersona) => string
  /** Caller-supplied per-persona executor. Returns a JSON-serialisable
   *  `TResult` the durable store will checkpoint. Failures inside this
   *  function are caught by the substrate and converted to a deterministic
   *  failure result via `onPersonaError` — they do NOT crash the loop. */
  runOne: (persona: TPersona, ctx: { stepRunId: string }) => Promise<TResult>
  /** Build a deterministic failure result when `runOne` throws. The
   *  result is checkpointed so resume does NOT re-bill. Typically
   *  delegates to `buildPersonaErrorResult` (T07). */
  onPersonaError: (persona: TPersona, error: Error) => TResult
  /** When true, retry once after a `DurableRunLeaseHeldError` by deleting
   *  the run's stale lease file (FileSystemDurableRunStore only). Default
   *  true — the eval harness is single-process by contract so a held lease
   *  can only mean a crashed prior process. */
  retryOnStaleLease?: boolean
  /** Optional lease ttl override (ms). */
  leaseMs?: number
  /** Optional input fingerprint per persona — passed to ctx.step's
   *  `inputFingerprint` so a step's input divergence is detected. */
  inputFingerprint?: (persona: TPersona) => Record<string, unknown>
  /** Optional default outcome on successful completion. */
  defaultOutcome?: DurableRunOutcome
}

export interface RunDurableEvalResult<TResult> {
  /** Per-persona results in personas-input order. */
  results: ReadonlyArray<TResult>
  /** Underlying durable run record. */
  record: RunDurableResult<TResult[]>['record']
  /** Step records the durable substrate persisted. */
  steps: RunDurableResult<TResult[]>['steps']
  /** True when at least one persona was resumed from a checkpoint
   *  (rather than freshly executed). */
  resumedFromCheckpoint: boolean
}

/**
 * Per-persona durable eval loop. Each persona is one checkpointable
 * step — a mid-eval crash resumes from the next un-completed persona
 * without re-billing the prior LLM calls.
 *
 * Stale-lease reclaim: if `retryOnStaleLease` is true and the store is
 * a `FileSystemDurableRunStore`, a `DurableRunLeaseHeldError` triggers
 * one deletion-then-retry. The substrate assumes single-process eval
 * harnesses (the documented contract of `FileSystemDurableRunStore`).
 *
 * @experimental — 0.32 ships the wrapper; bump to @stable in 0.33 after
 * four-consumer adoption confirms the interface.
 */
export async function runDurableEval<TPersona, TResult>(
  opts: RunDurableEvalOptions<TPersona, TResult>,
): Promise<RunDurableEvalResult<TResult>>
```

**Implementation outline**:

1. Import `runDurable`, `DurableRunLeaseHeldError`, `FileSystemDurableRunStore` from `@tangle-network/agent-runtime` (already used by legal; substrate adds a thin wrapper).
2. Inner `runOnce()` invokes `runDurable({ runId, manifest, store, leaseMs, taskFn })`.
3. `taskFn(ctx)` iterates `opts.personas`:
   - For each persona, derive `personaId = opts.personaId(persona)`.
   - Invoke `ctx.step(personaId, async () => { try { return await opts.runOne(persona, { stepRunId: `${opts.runId}::${personaId}` }) } catch (err) { return opts.onPersonaError(persona, err instanceof Error ? err : new Error(String(err))) } }, { kind: 'llm', inputFingerprint: opts.inputFingerprint?.(persona) ?? { personaId } })`.
   - Append result to a running array.
4. Stale-lease reclaim wrapper: catch `DurableRunLeaseHeldError`; if `retryOnStaleLease` (default true) AND store is `FileSystemDurableRunStore`, derive lease path via `store['dir']` (or via a future `getLeasePath(runId)` method — for 0.32 we can use a public accessor we add at the same time), delete it, retry once. If retry also throws, propagate.
5. Track `resumedFromCheckpoint` by comparing `runDurableResult.steps.length` before/after — any step with `status: 'completed'` and `attempts === 0` at first invocation indicates a replayed step. (The agent-runtime semantics expose this via `StepRecord.attempts`.)
6. Return `{ results, record, steps, resumedFromCheckpoint }`.

**Test plan**:

- Unit (with `InMemoryDurableRunStore`): three personas, all succeed → three results, `resumedFromCheckpoint: false`.
- Unit: persona 2 throws → `onPersonaError` invoked, three results returned, persona 2's result is the error-result shape.
- Integration: write to `FileSystemDurableRunStore`, kill the test mid-loop via `process.exit(137)` after persona 1, re-invoke with same `runId` → resume, persona 1 replays free, personas 2 and 3 execute.
- Integration: simulate stale lease by manually writing `lease.json` then invoking; assert `retryOnStaleLease: true` reclaims and `retryOnStaleLease: false` rethrows.
- Regression: replicate legal's exact `LEGAL_EVAL_CRASH_AFTER_PERSONA` scenario (`canonical.ts:1454-1457`) through the substrate wrapper. Same crash, same resume semantics.

**Export entry**:

```ts
// src/index.ts (root) + src/optimization.ts (subpath)
export type {
  RunDurableEvalOptions,
  RunDurableEvalResult,
} from './optimization/durable-eval'
export { runDurableEval, buildPersonaErrorResult } from './optimization/durable-eval'
```

**Consumer migration note**:

- Legal `tests/eval/canonical.ts:373-388` (`runDurableResumable`) + `1391-1460` (the inline persona loop): replace with one call to `runDurableEval<PersonaYaml, PersonaStepResult>({ runId, manifest, store, personas: filtered, personaId: p => p.id, runOne, onPersonaError, retryOnStaleLease: true })`.
- Tax/creative/gtm: gain durability via adoption (separately spec'd).
- `stableRunId` stays per-consumer — the substrate doesn't pin a hash scheme.

---

### T07 — `buildPersonaErrorResult(personaId, error, opts)`

**File**: Same as T06 (`src/optimization/durable-eval.ts`).

**Signature**:

```ts
import type { RunRecord, RunSplitTag } from '../run-record'

export interface BuildPersonaErrorResultOptions {
  /** experimentId stamped on the resulting RunRecord. */
  experimentId: string
  /** candidateId stamped on the resulting RunRecord. */
  candidateId: string
  /** commitSha stamped on the resulting RunRecord. */
  commitSha: string
  /** Model id stamped on the resulting RunRecord. */
  model: string
  /** Split tag — defaults to `'holdout'` (per legal's pattern). */
  splitTag?: RunSplitTag
  /** Optional caller-supplied tags. */
  tags?: Record<string, string | number | boolean>
}

/**
 * Build a deterministic failure `RunRecord` for a persona whose runtime
 * threw. The record carries zeroed `tokenUsage` + `costUsd`, the
 * canonical `outcome.raw.cost_unknown = 1` marker, and the error
 * message — so a downstream `assertRealBackend` correctly classifies
 * this as a stub-mode record (and not a "real backend failed" record).
 *
 * Use this as the `onPersonaError` impl in `runDurableEval` so a
 * persona-level crash is checkpointed as a completed (failed) step
 * and resume does NOT re-bill the LLM call.
 */
export function buildPersonaErrorResult(
  personaId: string,
  error: Error,
  opts: BuildPersonaErrorResultOptions,
): RunRecord
```

**Implementation outline**:

1. Generate `runId = `${opts.experimentId}::${personaId}`` (stable across replays).
2. Generate `promptHash = sha256('error:' + personaId).slice(0, 16)` (deterministic).
3. Generate `configHash = sha256(JSON.stringify({model, personaId, backend: opts.tags?.backend ?? '', error: 'true'})).slice(0, 16)`.
4. Construct `RunRecord` with mandatory fields: `runId, experimentId, candidateId, seed: 0, model, promptHash, configHash, commitSha, wallMs: 0, costUsd: 0, tokenUsage: {input: 0, output: 0}, outcome: { holdoutScore: 0, raw: { cost_unknown: 1, persona_failed: 1 } }, splitTag, scenarioId: personaId, tags: opts.tags ?? {}, error: error.message`.
5. Validate via `validateRunRecord(record)` to catch any boundary violation.

**Test plan**:

- Unit: returns a `validateRunRecord`-passing record.
- Unit: error message lands in `record.error`.
- Unit: `tokenUsage.input + tokenUsage.output === 0`, `costUsd === 0` → `assertRealBackend([this])` correctly classifies as stub.
- Unit: `splitTag` defaults to `'holdout'`, override respected.
- Unit: two invocations with same `personaId` + opts produce byte-identical `RunRecord` (modulo the error message itself).

**Export entry**: bundled with T06 in `src/optimization/durable-eval.ts`. Re-exported from `src/index.ts` and `src/optimization.ts`.

**Consumer migration note**:

- Legal `tests/eval/canonical.ts:1167-1223` (`buildPersonaErrorResult`): delete and replace with substrate version. Legal's `PersonaStepResult` becomes `{ summary, record, integrity, traceRows }` where `record` is the substrate `RunRecord` and the other three fields stay legal-specific.

---

### T08 — `cliffsDelta(before, after)` + `interpretCliffs(d)`

**File**: `src/paired-stats.ts` (extend; +30 LOC). Tests added to `tests/paired-stats.test.ts`.

**Signature**:

```ts
/**
 * Magnitude classification of Cliff's δ per Romano et al. 2006.
 *   |δ| < 0.147 → negligible
 *   |δ| < 0.33  → small
 *   |δ| < 0.474 → medium
 *   else        → large
 */
export type CliffsMagnitude = 'negligible' | 'small' | 'medium' | 'large'

export interface CliffsDeltaResult {
  /** Paired Cliff's δ in [-1, +1]. Positive ⇒ `after > before` more
   *  often. */
  delta: number
  /** Magnitude interpretation per Romano. */
  magnitude: CliffsMagnitude
  /** Number of paired observations. */
  n: number
  /** Pairs where `after > before`. */
  wins: number
  /** Pairs where `after < before`. */
  losses: number
  /** Pairs where `after === before`. */
  ties: number
}

/**
 * Paired (matched-pair) Cliff's δ — non-parametric effect size for paired
 * data. Both arrays MUST be equal-length; throws otherwise.
 *
 *   delta = (#{after > before} - #{after < before}) / n
 *
 * Returns a typed result including the magnitude bucket via
 * `interpretCliffs`. The legacy form (just the number) is reachable via
 * `result.delta`.
 */
export function cliffsDelta(before: ReadonlyArray<number>, after: ReadonlyArray<number>): CliffsDeltaResult

/**
 * Classify |δ| per Romano et al. 2006. Convenience export so callers that
 * already hold the scalar can derive the magnitude.
 */
export function interpretCliffs(delta: number): CliffsMagnitude
```

**Implementation outline**:

1. Length-mismatch check throws `ValidationError`.
2. Empty arrays return `{ delta: 0, magnitude: 'negligible', n: 0, wins: 0, losses: 0, ties: 0 }`.
3. Iterate pairs, count wins/losses/ties; `delta = (wins - losses) / n`.
4. `interpretCliffs(d)` implements Romano bucketing on `|d|`.

**Test plan**:

- Unit: identical arrays → `{ delta: 0, magnitude: 'negligible', wins: 0, losses: 0, ties: n }`.
- Unit: `after === before + 0.1` for every pair → `delta: 1`, magnitude: `'large'`.
- Unit: half wins / half losses → `delta: 0`, magnitude: `'negligible'`.
- Unit: Romano thresholds — `delta: 0.146` ⇒ `'negligible'`, `0.148` ⇒ `'small'`, etc.
- Unit: length mismatch throws `ValidationError`.
- Regression: against agent-builder's `differential-eval.ts:83-95` local impl, compute Cliff's δ on the same synthetic input and assert identical scalar.

**Export entry**:

```ts
// src/paired-stats.ts already exports types/funs; add new ones
export { cliffsDelta, interpretCliffs } from './paired-stats'  // already exported file
export type { CliffsDeltaResult, CliffsMagnitude } from './paired-stats'

// src/index.ts at the existing paired-stats re-export block (line 988-993):
//   add `cliffsDelta`, `interpretCliffs`, `CliffsDeltaResult`, `CliffsMagnitude`

// src/reporting.ts already exports paired-stats — additive:
export { cliffsDelta, interpretCliffs } from './paired-stats'
export type { CliffsDeltaResult, CliffsMagnitude } from './paired-stats'
```

**Consumer migration note**:

- agent-builder `src/lib/.server/eval/differential-eval.ts:83-95`: delete local `cliffsDelta`; replace with `import { cliffsDelta } from '@tangle-network/agent-eval'`. The local form returns a scalar; substrate returns `{ delta, magnitude, n, wins, losses, ties }`. agent-builder's caller already keeps the scalar in `result.delta`. The magnitude bucket replaces hand-coded thresholds in agent-builder's `DEFAULT_DIFFERENTIAL_THRESHOLDS` (free upgrade).
- Tax/creative/legal/gtm gain Cliff's δ as substrate primitive without writing it (handy for the differential A/B work each will adopt per its own spec).

---

## 5. Completion checklist (43 boxes)

### Primitive ship + test

- [ ] **C01** `src/judge-families.ts` created, `assertCrossFamily` + `judgeFamily` + `JudgeFamilyError` + `JudgeFamily` exported (T01).
- [ ] **C02** `tests/judge-families.test.ts` created, ≥10 cases passing including regex coverage of all 30+ consumer model ids (T01).
- [ ] **C03** `src/trace/capture-fetch.ts` created, `captureFetchToRawSink` exported, redactor and provider-derivation inherited from `./raw-provider-sink` (T02).
- [ ] **C04** `tests/trace/capture-fetch.test.ts` created — happy path, error path, redaction, truncation, capture-failure handling (T02).
- [ ] **C05** Integration test wires `captureFetchToRawSink` into a real `createOpenAICompatibleBackend` against a local stub server (T02).
- [ ] **C06** `src/composite.ts` created, `weightedComposite` + `CompositeError` + types exported (T03).
- [ ] **C07** `tests/composite.test.ts` created — ≥8 cases including NaN rejection, weight normalisation, threshold pass/fail (T03).
- [ ] **C08** `src/trace-analyst/otlp-flatten.ts` created, `flattenOtlpExportToNdjson` + types exported (T04).
- [ ] **C09** `tests/trace-analyst/otlp-flatten.test.ts` created, includes round-trip through `OtlpFileTraceStore` (T04).
- [ ] **C10** `src/integrity/single-backend.ts` created, `assertSingleBackend` + `SingleBackendError` + types exported (T05).
- [ ] **C11** `tests/integrity/single-backend.test.ts` created — ≥7 cases including the legal failure scenario regression (T05).
- [ ] **C12** `src/optimization/durable-eval.ts` created, `runDurableEval` + `buildPersonaErrorResult` + types exported (T06 + T07).
- [ ] **C13** `tests/optimization/durable-eval.test.ts` created — unit cases against `InMemoryDurableRunStore` (T06).
- [ ] **C14** Crash-resume integration test against `FileSystemDurableRunStore` (process.exit mid-loop, re-invoke, assert resume) — replicates legal's `LEGAL_EVAL_CRASH_AFTER_PERSONA` scenario (T06).
- [ ] **C15** Stale-lease reclaim test — manually write `lease.json`, invoke with `retryOnStaleLease: true`, assert recovery (T06).
- [ ] **C16** `buildPersonaErrorResult` test — returns a `validateRunRecord`-passing record that `assertRealBackend` classifies as stub (T07).
- [ ] **C17** `src/paired-stats.ts` extended with `cliffsDelta` + `interpretCliffs` + `CliffsDeltaResult` + `CliffsMagnitude` (T08).
- [ ] **C18** `tests/paired-stats.test.ts` extended — ≥6 cases including Romano-threshold boundaries + parity check vs agent-builder's local impl (T08).

### Export verification (root + subpaths)

- [ ] **C19** `src/index.ts` re-exports added for T01 (`assertCrossFamily`, `judgeFamily`, `JudgeFamilyError`, `JudgeFamily`).
- [ ] **C20** `src/index.ts` re-exports added for T02 (`captureFetchToRawSink`, `CaptureFetchContext`, `CaptureFetchOptions`).
- [ ] **C21** `src/index.ts` re-exports added for T03 (`weightedComposite`, `WeightedCompositeInput`, `WeightedCompositeResult`, `CompositeError`).
- [ ] **C22** `src/index.ts` re-exports added for T04 (`flattenOtlpExportToNdjson`, `FlattenOtlpOptions`, `OtlpFlatLine`) — via the existing `export * from './trace-analyst'` at line 292.
- [ ] **C23** `src/index.ts` re-exports added for T05 (`assertSingleBackend`, `BackendDescriptor`, `SingleBackendReport`, `AssertSingleBackendOptions`, `SingleBackendError`).
- [ ] **C24** `src/index.ts` re-exports added for T06 + T07 (`runDurableEval`, `buildPersonaErrorResult`, `RunDurableEvalOptions`, `RunDurableEvalResult`, `BuildPersonaErrorResultOptions`).
- [ ] **C25** `src/index.ts` paired-stats re-export block (lines 988-993) extended for T08 (`cliffsDelta`, `interpretCliffs`, `CliffsDeltaResult`, `CliffsMagnitude`).
- [ ] **C26** `src/optimization.ts` re-exports added for T06 + T07 (durable-eval subpath surface).
- [ ] **C27** `src/traces.ts` propagation verified — T02 + T04 reachable via `./traces` (no edit needed; verify in build).
- [ ] **C28** `src/reporting.ts` re-exports added for T08 (`cliffsDelta`, `interpretCliffs`, `CliffsDeltaResult`, `CliffsMagnitude`).
- [ ] **C29** `tests/consumer-contract.test.ts`: `ROOT_RUNTIME_SYMBOLS` extended with `assertCrossFamily`, `judgeFamily`, `captureFetchToRawSink`, `weightedComposite`, `flattenOtlpExportToNdjson`, `assertSingleBackend`, `runDurableEval`, `buildPersonaErrorResult`, `cliffsDelta`, `interpretCliffs`.
- [ ] **C30** `tests/consumer-contract.test.ts`: `ROOT_ERROR_CLASSES` extended with `JudgeFamilyError`, `CompositeError`, `SingleBackendError`.
- [ ] **C31** Build artifacts regenerate: `pnpm build && pnpm openapi` — verify `dist/index.d.ts` contains every new export with the correct stability tag (`@stable` for T01/T02/T03/T04/T05/T08; `@experimental` for T06/T07).

### Documentation + release ops

- [ ] **C32** `CHANGELOG.md`: 0.32.0 section authored, every primitive listed with one-line description + audit-driven motivation.
- [ ] **C33** `docs/concepts.md`: update if (and only if) the conceptual mental-model changed. T01-T05 + T08 fit existing capability areas; T06-T07 add a new "Durable eval orchestration" callout in the campaign section.
- [ ] **C34** `.claude/skills/agent-eval/SKILL.md`: add directives for the new primitives so consumer migrations land with the right shape from the first prompt. One directive per primitive, citing the consumer file that motivated it.
- [ ] **C35** No `docs/wire-protocol.md` change required — none of the new primitives sit on the wire surface.

### Consumer migration preparation

- [ ] **C36** `/tmp/audit/spec-tax-agent.md` migration section authored, cross-referencing T01/T02/T03/T05/T08.
- [ ] **C37** `/tmp/audit/spec-legal-agent.md` migration section authored, cross-referencing T01/T02/T04/T05/T06/T07.
- [ ] **C38** `/tmp/audit/spec-creative-agent.md` migration section authored, cross-referencing T01/T02/T03/T04/T05/T08.
- [ ] **C39** `/tmp/audit/spec-gtm-agent.md` migration section authored, cross-referencing T01/T03/T04/T05/T08.
- [ ] **C40** `/tmp/audit/spec-agent-builder.md` migration section authored, cross-referencing T03/T08 (agent-builder doesn't need T01/T02/T04 — already substrate-native; T05/T06 are open enhancements).

### Release

- [ ] **C41** Release branch `release/0.32.0` cut from `main`; PR opened with all eight primitives + tests + exports + changelog.
- [ ] **C42** All tests green in CI (`pnpm test && pnpm typecheck && pnpm lint`); consumer-contract test confirms the new symbols are exported.
- [ ] **C43** `@tangle-network/agent-eval@0.32.0` published to npm; consumer specs unblocked.

---

## 6. Test plan

### Unit (per primitive)

Already enumerated in §4 per task. Aggregate: ~55 new unit cases across the eight tasks. Each primitive ships with at least one negative test (input rejection, error path) and one structural test (shape of the returned value).

### Integration

1. **`captureFetchToRawSink` × `createOpenAICompatibleBackend`**: wire the substrate fetch wrapper into agent-runtime's backend and assert the captured event triple (request + response) shape against a local mock server. Re-uses the existing mock pattern in `llm-client.test.ts`.

2. **`runDurableEval` × `FileSystemDurableRunStore`**: end-to-end crash-resume scenario. Spawn a sub-process that runs three personas via `runDurableEval`, kill after persona 1 via `process.exit(137)`, re-invoke with same `runId`, assert persona 1 replays free and personas 2 + 3 execute. Mirrors legal's `LEGAL_EVAL_CRASH_AFTER_PERSONA` test at `canonical.ts:1454-1457`.

3. **`flattenOtlpExportToNdjson` round-trip**: feed `exportRunAsOtlp` output → flatten → write NDJSON → load via `OtlpFileTraceStore` → assert the trace summary lists the original spans + attribute projection.

4. **`assertSingleBackend` regression**: against the legal failure case (agent `kind: 'cli-bridge'`, judge `kind: 'tcloud'`), assert the throw fires.

5. **Consumer-contract test**: `tests/consumer-contract.test.ts` extended to pin every new symbol — a removal/rename breaks the build.

### Regression (existing suite)

- `pnpm test` — full vitest suite stays green. No existing test should change shape; all additions are additive.
- `pnpm typecheck` — `tsc --noEmit` clean. Especially: the new types must not collide with the existing `BackendIntegrityReport` / `RunIntegrityReport` shapes.
- `pnpm lint` — biome clean.

### Cross-repo dry run

Before publish:

1. `pnpm pack` the 0.32.0 candidate locally → `tangle-network-agent-eval-0.32.0.tgz`.
2. In each of `/home/drew/code/{tax,legal,creative,gtm}-agent/`, `pnpm add file:/path/to/agent-eval-0.32.0.tgz`.
3. Run each consumer's existing test suite — must stay green (the new primitives are additive; existing imports are unchanged).
4. Spot-migrate ONE call site per primitive per consumer (e.g. `legal/tests/eval/canonical.ts` swap `captureFetchFor` → `captureFetchToRawSink`) and re-run that consumer's `pnpm test:eval`. Catches integration breakage before publish.
5. Roll back the spot-migration; the actual full migration lands in the consumer specs after 0.32.0 ships.

---

## 7. Rollout

### Release cadence: single 0.32.0 minor

All eight primitives ship together. Reasoning:

- Each one is small (~30-150 LOC). Bundling avoids eight separate `consumer-contract.test.ts` updates and eight CHANGELOG entries.
- Consumer specs reference 0.32.0 as a single version pin — partial-release (e.g. T01-T05 in 0.32, T06-T08 in 0.33) would split the four consumer specs across two version-bump PRs each.
- Risk surface is well-contained — T06/T07 carry `@experimental` tags so they can iterate in 0.33+ without bumping major. The other six are stable from day one because they're pure-function helpers with clear invariants.

### Branch / release process

1. Branch `release/0.32.0` from `main`.
2. Implement T01 → T08 in dependency order:
   - T01 (no deps) → T03 (no deps) → T05 (depends on `AgentEvalError`) → T08 (depends on existing paired-stats) → T02 (depends on `RawProviderSink`) → T04 (depends on `OtlpExport`) → T07 (depends on `RunRecord`, `validateRunRecord`) → T06 (depends on T07 + `runDurable` from agent-runtime).
3. One commit per primitive (conventional: `feat(0.32): T0X primitive`).
4. One commit for `consumer-contract.test.ts` + `index.ts` re-exports.
5. One commit for `CHANGELOG.md` + skill directives.
6. Open PR, run full CI, get review (per the project's admin-merge pattern for tangletools-authored PRs).
7. Tag `v0.32.0`, publish to npm.
8. Announce in PR closes: each of `/tmp/audit/spec-{tax,legal,creative,gtm}-agent.md` + `spec-agent-builder.md` is now unblocked.

### Deprecation notes

**None required.** Every new primitive is additive — no existing export changes shape or signature. Consumers can migrate at their pace; the hand-rolled versions in tax/legal/creative/gtm/agent-builder keep working until the consumer specs delete them.

A future 0.33 may add stability-tag upgrades (`runDurableEval`, `buildPersonaErrorResult` from `@experimental` → `@stable`) after the four consumers have integrated for at least one minor.

---

## 8. Risks + non-goals

### Risks

1. **`runDurableEval` couples substrate to `@tangle-network/agent-runtime`**. The substrate already imports nothing from agent-runtime — adding this is a new dependency arrow. Mitigation:
   - Make agent-runtime a `peerDependency`, not a direct `dependency`. Consumers already have it installed (every product imports it for `createOpenAICompatibleBackend`).
   - Ship the `runDurableEval` wrapper behind an `@experimental` tag so a breaking change in agent-runtime's `runDurable` signature lets us iterate without bumping substrate major.
   - Test the wrapper against a pinned agent-runtime version in CI.

2. **`assertCrossFamily` family regex map drift**. Vendors ship new model ids constantly (e.g. `claude-opus-5`, `gpt-6`). Mitigation:
   - The regex map is `export`ed (callers can introspect for diagnostics).
   - The tail-prefix fallback ensures unknown-vendor ids still get a stable family slug — they just don't collide with the curated families.
   - Add a directive to the SKILL.md: "When adopting a new vendor, add the regex pattern via PR; do NOT rely on the fallback as a substitute."

3. **`captureFetchToRawSink` body-read can deadlock on streaming responses**. The wrapper calls `response.clone().text()` which buffers the body. For non-streaming responses (the OpenAI Chat Completions API in non-stream mode), this is correct. For streaming responses (`stream: true`), buffering would defeat the stream. Mitigation:
   - For 0.32, document that the wrapper is for non-streaming calls. The four consumers' hand-rolled versions all assume non-streaming today.
   - Streaming-safe capture is deferred to 0.33 (would require a teed-stream approach + a `streaming: true` opt-in).
   - Cap the body read at 2 MiB (default `responseBodyByteCap`) so even a misuse on a streaming endpoint doesn't OOM.

4. **`weightedComposite` rejects missing dims by default**. This is intentional (fail-loud doctrine), but it's stricter than every consumer's current hand-rolled impl (which silently treats missing dims as 0). Mitigation:
   - Document in the migration note that callers must list every dim they weight, OR pass `dims: {a: dims.a ?? 0}` at the call site.
   - The substrate version's strictness is the point — silent zeros are the bug class.

5. **`buildPersonaErrorResult` requires `validateRunRecord` not throwing**. If the substrate later tightens `validateRunRecord` (e.g. requires non-zero `wallMs`), this helper breaks. Mitigation:
   - Pin `wallMs: 0` is currently accepted (the validator only checks `>= 0`, not `> 0`). Verified in `tests/run-record.test.ts`.
   - Future tightening of `validateRunRecord` must update `buildPersonaErrorResult` in the same PR.

### Non-goals (deferred to 0.33 or later)

1. **`MultiTurnScenarioPayload<TBehavior>` generic.** agent-builder ships a local impl (`/home/drew/code/agent-builder/src/lib/.server/eval/*`); gtm and creative re-derive ad-hoc. Audit synthesis line 38 notes the inconsistency. The shape is NOT yet stable across consumers — pinning now would force consumer-side churn. **Revisit in 0.33** after at least two consumers converge on a shape.

2. **`MetricsRollup` over `RunRecord[]`**. The audit deferral list (synthesis §"actions ranked by leverage") calls for a uniform `MetricsRollup` (mean cost, p95 latency, tool-call histogram). Not in scope for 0.32 — every consumer rolls its own dashboard today, and we don't have a shared dashboard target yet. **Revisit in 0.33** alongside the `/pipelines` adoption push.

3. **`BackendIntegrityReport` extension** (latency stats, retry counts). The existing report covers the "is the backend real" question fully. Extensions are dashboards. **Out of scope for 0.32.**

4. **Scaffold-template propagation**. The audit "biggest finding" — agent-builder's scaffold emits ~25% of the integration it uses internally. Fixing this is a `tangle-network/agent-builder` PR series, not substrate. Tracked in `/tmp/audit/spec-agent-builder.md`.

5. **`runProductionLoop` resurrection / deletion**. Tax's idle weekly cron + legal's dead module reference `^0.25.0` in docstrings while the package is at `^0.31.1`. Documentation-drift sweep PR, not substrate. Tracked separately.

6. **`/pipelines` view adoption**. Pure consumer-side adoption, not substrate change. Per-consumer specs.

7. **Adversarial / red-team primitives lift to substrate** (agent-builder's local 20-probe suite → `DEFAULT_FORGE_RED_TEAM_CORPUS`). Cross-pollination lift — out of scope for 0.32.

### Risk: substrate consumer-contract test must accept the new symbols

The contract test at `tests/consumer-contract.test.ts:32-70` pins the symbols five consumers import. Adding new exports doesn't fail this test (it's a positive-list check). **But** new symbols on the ROOT_RUNTIME_SYMBOLS list are not yet pinned — a future minor that renames `assertCrossFamily` to `assertCrossModelFamily` would silently break consumers. C29 in the checklist addresses this: every new primitive lands in the ROOT_RUNTIME_SYMBOLS list as part of 0.32.

### Risk: `runDurableEval` generic backward-compat with `FileSystemDurableRunStore`

Verified: `@tangle-network/agent-runtime`'s `FileSystemDurableRunStore` implements `DurableRunStore` (the same interface `runDurable` consumes). The substrate's `runDurableEval` wraps `runDurable` directly and does NOT redefine the store contract. As long as `agent-runtime` keeps the `DurableRunStore` interface stable across its 0.x minors (which it does — both `D1DurableRunStore` and `FileSystemDurableRunStore` implement the same shape per `dist/index.d.ts:297-372`), the substrate wrapper is safe. CI pins the peer-dep range to `agent-runtime >= 0.X` where X is the current minor at 0.32 ship time.

---

## 9. Citations

### Substrate (agent-eval) source

- `/home/drew/code/agent-eval/src/index.ts:469-486` — current root export surface, including the `export * from './trace'` decision documented at L482-486.
- `/home/drew/code/agent-eval/src/index.ts:292` — `export * from './trace-analyst'` (T04 propagates via this).
- `/home/drew/code/agent-eval/src/index.ts:988-993` — paired-stats re-export block (T08 extends).
- `/home/drew/code/agent-eval/src/integrity/backend-integrity.ts:28-183` — existing `BackendIntegrityReport` / `assertRealBackend` (T05 sits alongside).
- `/home/drew/code/agent-eval/src/paired-stats.ts:1-40` — existing `pairedBootstrap` / `pairedWilcoxon` (T08 extends).
- `/home/drew/code/agent-eval/src/trace/raw-provider-sink.ts:1-295` — existing `RawProviderSink`, `defaultProviderRedactor`, `providerFromBaseUrl`, `FileSystemRawProviderSink` (T02 imports).
- `/home/drew/code/agent-eval/src/trace/index.ts:5` — `export * from './raw-provider-sink'` (T02 propagates via this).
- `/home/drew/code/agent-eval/src/trace-analyst/store-otlp.ts:40-90` — `OtlpFileTraceStore` line-shape contract (T04 emits this shape).
- `/home/drew/code/agent-eval/src/run-record.ts:1-145` — `RunRecord`, `RunOutcome`, `JudgeScoresRecord`, `RunSplitTag`, `validateRunRecord` (T07 consumes).
- `/home/drew/code/agent-eval/tests/consumer-contract.test.ts:1-132` — pinned symbols (C29 + C30 extend).
- `/home/drew/code/agent-eval/package.json:16-100` — exports map (no edit needed for 0.32; T06/T07 land under existing `./optimization` subpath).

### agent-runtime source (peer dep)

- `/home/drew/code/legal-agent/node_modules/@tangle-network/agent-runtime/dist/index.d.ts:297-372` — `DurableRunStore` interface (T06 wraps).
- `/home/drew/code/legal-agent/node_modules/@tangle-network/agent-runtime/dist/index.d.ts:379-389` — `DurableRunLeaseHeldError` (T06 catches).
- `/home/drew/code/legal-agent/node_modules/@tangle-network/agent-runtime/dist/index.d.ts:707-775` — `FileSystemDurableRunStore` (T06 stale-lease reclaim targets).
- `/home/drew/code/legal-agent/node_modules/@tangle-network/agent-runtime/dist/index.d.ts:948-968` — `RunDurableInput` / `RunDurableResult` / `runDurable` (T06 wraps).

### Tax-agent (hand-rolled patterns)

- `/home/drew/code/tax-agent/tests/eval/lib/judge-ensemble.ts:1-143` — T01 motivation. `judgeFamily` (L45-56), `resolveJudgeEnsemble` (L100-132), `JudgeEnsembleError` (L58-63).
- `/home/drew/code/tax-agent/tests/eval/canonical.ts:436-509` — T02 motivation. `captureFetchFor` (L436-509), `buildRawEvent` (L530-?).
- `/home/drew/code/tax-agent/tests/eval/run-prompt-evolution.ts:487` — T02 second copy in same repo.
- `/home/drew/code/tax-agent/tests/eval/run-prompt-evolution.ts:885-902` — T03 + JudgeScoresRecord cast (also a separate audit finding; ties to the audit deferral list).
- `/home/drew/code/tax-agent/tests/eval/lib/production-loop.ts:73-77` — T03 motivation. `PRODUCTION_LOOP_OBJECTIVE_WEIGHTS`.

### Legal-agent (hand-rolled patterns)

- `/home/drew/code/legal-agent/tests/eval/run-prompt-evolution.ts:320-395` — T01 motivation. `judgeFamily` (L333-343), `resolveJudgeModels` (L351-395).
- `/home/drew/code/legal-agent/tests/eval/run-prompt-evolution.ts:477-?` — T02 motivation (one of two copies).
- `/home/drew/code/legal-agent/tests/eval/canonical.ts:456-548` — T02 motivation (second copy). `captureFetchFor` + ctx variations.
- `/home/drew/code/legal-agent/tests/eval/run-prompt-evolution.ts:800-815` — JudgeScoresRecord cast with self-acknowledging "drift comment" at L809-813.
- `/home/drew/code/legal-agent/tests/eval/canonical.ts:702-795` — T05 motivation. `EvalBackendConfig`, `resolveBackendConfig`, `judgeBackendConfig`.
- `/home/drew/code/legal-agent/tests/eval/canonical.ts:344-388` — T06 motivation. `stableRunId` + `runDurableResumable`.
- `/home/drew/code/legal-agent/tests/eval/canonical.ts:1371-1464` — T06 inline persona loop.
- `/home/drew/code/legal-agent/tests/eval/canonical.ts:1167-1223` — T07 motivation. `buildPersonaErrorResult`.
- `/home/drew/code/legal-agent/tests/eval/canonical.ts:1454-1457` — T06 crash-resume test hook (`LEGAL_EVAL_CRASH_AFTER_PERSONA`).
- `/home/drew/code/legal-agent/tests/eval/lib/traces-to-otlp.ts:1-389` — T04 motivation (per-span projection portion; shard-merge portion stays legal-specific).
- `/home/drew/code/legal-agent/tests/eval/analyst-loop.ts:138-152` — T04 motivation. `convertTraceStoresToOtlp` caller.

### Creative-agent (hand-rolled patterns)

- `/home/drew/code/creative-agent/eval/lib/judge-ensemble.ts:87-119` — T01 motivation. `resolveJudgeEnsemble`.
- `/home/drew/code/creative-agent/eval/canonical-runner.ts:651, 664` — T02 motivation. `makeCaptureFetch` + caller.
- `/home/drew/code/creative-agent/eval/run-prompt-evolution.ts:446-633` — T02 second copy + caller.
- `/home/drew/code/creative-agent/eval/canonical-runner.ts:862-863` — T03 motivation (unweighted mean of `raw`).
- `/home/drew/code/creative-agent/eval/trace-analyst-runner.ts:147-205` — T04 motivation. Per-span projection with openinference vocabulary.

### GTM-agent (hand-rolled patterns)

- `/home/drew/code/gtm-agent/eval/lib/judge-ensemble.ts:40-125` — T01 motivation. Near-identical to tax's.
- `/home/drew/code/gtm-agent/eval/canonical.ts:1209` — T03 motivation. Open-coded `judgeAvg*0.6 + det*0.3 + slop*0.1`.
- `/home/drew/code/gtm-agent/eval/run-prompt-evolution.ts:458-464` — T03 motivation. `clamp01(judge*W.judge + structural*W.structural + slop*W.slop)`.
- `/home/drew/code/gtm-agent/eval/auto-research.ts:154-205, 395-442` — T04 motivation. `otlpAttrsToObject` (L395-404), `projectOtlpSpan` (L410-430), `nsToIso` (L432-442).

### Agent-builder (hand-rolled patterns)

- `/home/drew/code/agent-builder/src/lib/.server/eval/differential-eval.ts:83-95` — T08 motivation. Local `cliffsDelta` with self-acknowledging "the substrate doesn't ship one — it's small enough to keep here" comment.
- `/home/drew/code/agent-builder/src/lib/.server/eval/canonical-campaign.ts:612-627` — T03 motivation. Composite + threshold branching.

### Audit synthesis citations

- `/tmp/audit/SYNTHESIS.md:51-63` — "Five patterns every vertical hand-rolls — lift candidates for substrate."
- `/tmp/audit/SYNTHESIS.md:63` — "Bonus — legal-only patterns worth absorbing" → T06, T07, T05.
- `/tmp/audit/SYNTHESIS.md:38` — non-goal: multi-turn scenario generic deferred to 0.33.
- `/tmp/audit/SYNTHESIS.md:115-135` — "Concrete actions, ranked by leverage." Action #3 = this spec.
- `/tmp/audit/agent-eval-catalog.md:344-356` — surface-curation conventions; new exports follow the gated pattern.

---

## 10. Downstream coordination

This is the **first** spec to ship from the cross-repo audit because the four consumer specs and the agent-builder spec all reference substrate primitives that don't exist yet.

### Release ordering

```
        ┌─────────────────────────────────────────────────────────┐
        │  THIS SPEC — agent-eval 0.32.0                          │
        │  ships T01-T08, all 8 primitives                        │
        │  unblocks every consumer migration                       │
        └─────────────────────────────────────────────────────────┘
                                  │
              ┌───────────────────┼───────────────────┐
              │                   │                   │
              ▼                   ▼                   ▼
        spec-tax-agent     spec-legal-agent    spec-creative-agent
        spec-gtm-agent     spec-agent-builder
        (5 specs; can ship in parallel after 0.32.0 lands)
```

### Cross-link verification

Each consumer spec must cite the substrate primitives it depends on, by primitive id (T01-T08). The substrate spec (this doc) does not need to know the consumer details — it just promises the primitives ship at 0.32.0 and pin their signatures.

The audit author's deliverable:

- After this spec is filed as a GitHub issue + 0.32.0 lands, each consumer spec gets a "References substrate primitives: T0X, T0Y, T0Z (delivered in `@tangle-network/agent-eval@0.32.0`)" pin at the top.
- The agent-builder spec (`/tmp/audit/spec-agent-builder.md`) cites T03 + T08 + (optionally) T05/T06.
- No retro-changes to this spec after 0.32.0 publishes — any post-publish iteration is a 0.33.0 spec.

### Communication

PR description must include:

- Link to `/tmp/audit/SYNTHESIS.md` (motivation: five-vertical drift).
- Link to each consumer audit (`tax-agent-integration.md`, `legal-agent-integration.md`, `creative-agent-integration.md`, `gtm-agent-integration.md`, `agent-builder-integration.md`).
- Pin to this spec doc.
- Reviewer hint: every new export must be in `consumer-contract.test.ts:ROOT_RUNTIME_SYMBOLS` (or `ROOT_ERROR_CLASSES` for the three new error classes).

Post-publish:

- Each consumer repo's CLAUDE.md / SKILL.md updates to reference the new primitives in the migration spec — same PR that does the migration.
- A "substrate 0.32.0 adoption" tracking issue in `tangle-network/tangle-ops` (Drew's ops board) lists the four consumer specs and closes each one as it lands.
