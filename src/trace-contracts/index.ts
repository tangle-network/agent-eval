/**
 * Trace contracts — deterministic, judge-free checks over the spans one agent
 * run emitted.
 *
 * A contract is a list of rules; each rule is one operator over flat
 * `SpanPredicate`s:
 *
 *   - `always(p)`, `never(p)`, `eventually(p)` — every / no / some span.
 *   - `precedes(a, b, { order })` — both `a` and `b` occur, and `a` comes
 *     first. A missing endpoint FAILS: a required successor that never ran is
 *     a broken path, not a vacuous pass.
 *   - `neverUnless(p, prior, { order })` — the conditional guard: every
 *     `p`-match needs an earlier `prior`-match; a run with no `p` passes.
 *   - `atMost(p, max)` — call-count ceilings.
 *   - `tokensAtMost(p, max)` — token ceilings; a matching span whose token
 *     count is unknown fails the rule rather than counting as zero.
 *   - `run({ requireCompleted, allowedStatuses, maxDurationMs })` — the run's
 *     terminal status and duration.
 *   - `argument(p, { pointer, check, occurrence })` — a JSON Pointer check on
 *     tool-call arguments; a call without captured arguments fails.
 *   - `toolsOffered(declared)` — the tools the harness offered the model
 *     (`gen_ai.tool.definitions`) are recorded, every call is one of them, and
 *     every offered tool is declared. No record fails: enforcement is unknown.
 *   - `retrySafe({ reads, writes })` — a tool called again with the same
 *     arguments repeats its side effect: reads may repeat, writes only under
 *     one idempotency key, and an undeclared tool may not repeat.
 *
 * Ordering has three modes. `start-order` (the default) needs an `a` that
 * started strictly before each `b`; `finish-before-start` needs an `a` that
 * finished at or before each `b` started; `all-occurrences` needs every `a` to
 * finish before each `b` starts. A span whose needed timestamp is missing
 * fails the rule: array position is never taken as evidence of time.
 *
 * A contract may be `scope`d to one subtree — the span matching `scope.root`
 * and its descendants — so one sub-agent or one search-tree node is checked
 * on its own. It may also carry `alternatives`: named rule sets of which at
 * least one must pass, for legitimate alternate paths such as a cache hit.
 *
 * Every rule reports `pass`, `fail`, or `error` (the rule could not be
 * evaluated: its predicate threw, or the scope selected no unique subtree) in
 * `ruleExecutions`. A verdict with any errored rule has status `error` and is
 * never valid. Contracts with no rules are rejected before evaluation.
 *
 * A built `TraceContract` is a serializable plain object (RegExp matchers are
 * normalized to `SerializedRegex`), so one definition checks recorded eval
 * traces (`store.spans({ runId })`) and spans a reader such as `traces check`
 * maps from OTLP. `custom` predicate
 * functions are the one non-serializable escape hatch: the builder stamps
 * `requiresCustom: true`, which survives JSON, so a deserialized contract that
 * lost its function is rejected instead of silently weakening.
 *
 * The declarative JSON form ({@link compileTraceContractSpec}, `spec.ts`)
 * compiles onto these operators.
 *
 * Naming: the root barrel exports ci-gate's threshold-contract
 * `evaluateContract`, so the evaluators here are `evaluateTraceContract` /
 * `checkTraceContracts`.
 */

export { type ArgumentRuleOptions, type OrderOptions, traceContract } from './builder'
export { checkTraceContracts, evaluateTraceContract } from './evaluate'
export { explainTraceContract } from './explain'
export {
  type AlternativeSpec,
  type ContractLintFinding,
  compileTraceContractSpec,
  type LlmSpec,
  lintTraceContractSpec,
  type PathSpec,
  type RetriesSpec,
  type ToolArgumentSpec,
  type ToolsSpec,
  type TraceContractSpec,
} from './spec'
export * from './types'
