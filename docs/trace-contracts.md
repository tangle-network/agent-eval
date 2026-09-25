# Trace contracts

A trace contract states which path an agent run must take, and checks the recorded spans against it.
Two runs can give the same answer while one of them calls a forbidden tool; an output check passes both, and a contract fails the wrong one.

The checker is deterministic and calls no model.
It reads any span array that has `name`, `kind` or span-kind attributes, timestamps, and attributes: agent-eval `TraceStore` spans or OTLP rows that `traces check` maps.

## Write a contract

Write the contract as JSON and compile it with `compileTraceContractSpec`:

```json
{
  "name": "refund-desk",
  "description": "Answer refund questions from the orders file without a shell",
  "run": { "requireCompleted": true, "maxDurationMs": 120000 },
  "tools": {
    "required": ["Read"],
    "forbidden": ["Bash"],
    "allowed": ["Read", "Grep", "Glob"],
    "maxCalls": 10
  },
  "llm": { "maxTotalTokens": 200000 }
}
```

| Key | Checks |
|---|---|
| `run.requireCompleted` | The run status is `completed` and its end time is recorded. A failed or aborted run fails. **A trace with no declared `run.status` fails too** — see the note below. |
| `run.allowedStatuses` | The run status is one of `running`, `completed`, `failed`, `aborted`. Same "unknown status fails" rule as above. |
| `run.maxDurationMs` | End minus start. An unknown duration fails. |
| `tools.required` | Each tool is called at least once. |
| `tools.forbidden` | No listed tool is called. |
| `tools.allowed` | Every tool call names a listed tool. A call without a tool name fails. |
| `tools.maxCalls`, `tools.maxCallsPerTool` | Ceilings on tool calls, overall and per tool. |
| `tools.requiredOrder`, `tools.orderMode` | Each tool is called, and each comes before the next. |
| `tools.arguments` | An RFC 6901 JSON Pointer check (`exists`, `equals`, `oneOf`, `type`) on tool-call arguments. A call without captured arguments fails. |
| `llm.maxCalls`, `llm.maxTotalTokens` | Ceilings on model calls and on input plus output tokens. Input includes cache-read and cache-write tokens when the span records them, per the OTel GenAI definition — a cached call's prompt-token count alone omits most of what it spent. An unrecorded token count fails. |
| `tools.enforced` | The trace records the tools the harness offered the model (`gen_ai.tool.definitions`), every call is one of them, and every offered tool is in `tools.allowed`. A trace that records no offered tools fails. |
| `retries.reads`, `retries.writes` | A tool called again with the same arguments repeats its side effect. A read may repeat. A write may repeat only when every call carries the same idempotency key at `idempotencyKey`. Any other tool may not repeat. |
| `llm.allowedModels` | Every model call names a listed model. A call without a model fails. |
| `scope.root` | Check only the one span that matches this predicate and its descendants: one sub-agent or one search-tree node. Zero or several matches make every rule an error. |
| `alternatives.anyOf` | Named paths, each with its own `run`, `tools`, `llm` and `rules`. At least one must pass completely, as well as the base checks. Use it for a legitimate shortcut such as a cache hit. |
| `rules` | Low-level rules for checks the keys above cannot state (see below). |

Tool keys match TOOL spans only, and model keys match LLM spans only.
An LLM span that has a tool's name never satisfies a tool rule.

**A `run` rule needs a reader that declares `run.status`.** The checker never
infers `completed` from a span that merely ended without an error — only a
declared `run.status` attribute or an explicit error status counts, and an
undeclared status is `unknown`, which fails both `run.requireCompleted` and
`run.allowedStatuses`. A saved Claude Code **session transcript** (as opposed
to a `-p`/non-interactive stream, which the harness can mark `running` or
`completed`) carries no run-status record at all — an ordinary finished
interactive session and a truncated one look the same to the reader — so
**every `run` rule fails on a session-transcript trace**, always. Write a
contract for session transcripts with no `run` key, or run it against an
OTLP/eval-store trace that does carry a declared status.

**A `tools`/`llm` rule needs evidence its span kind was captured at all**, not
just a matching span. `tools.forbidden`, `tools.allowed`, `tools.maxCalls*`
and `retries` report `error` — not a silent pass — when the trace has zero
TOOL spans and no `gen_ai.tool.definitions` record either: an exporter that
drops a span kind must not make `forbidden` and `retries` checks pass because
nothing was there to check.

Parsing is strict.
An unknown key or an unknown status is an error that names the closest known word, so a typo never removes a check.
`lintTraceContractSpec` reports contradictions (a tool that is both required and forbidden) and likely mistakes (an order that uses the default `start-order` mode, which passes overlapping calls).
`explainTraceContract` states each compiled rule in one line.

## Check what the harness enforced

A tool list in a prompt or a CLI flag is a declaration, not proof of enforcement.
`tools.enforced` compares three sets: the tools the contract allows, the tools the harness offered the model, and the tools the run called.
`traces` records the offered set from the `system` `init` record of `claude -p --output-format stream-json --verbose` output.
Any OTel GenAI producer that sets `gen_ai.tool.definitions` works the same way.

In a recorded run, `claude -p --tools Read,Grep` also offered eight claude.ai connector tools, so the contract below failed.
The same run with `--strict-mcp-config` offered only `Read` and `Grep`, and passed.

```json
{
  "name": "refund-desk-enforced",
  "tools": { "required": ["Read"], "allowed": ["Read", "Grep"], "enforced": true }
}
```

## Check that a retry cannot apply twice

A write that times out may still have applied.
Calling it again with the same arguments applies it twice unless the target deduplicates on an idempotency key.

```json
{
  "name": "payments",
  "retries": {
    "reads": ["lookup_order"],
    "writes": [{ "tool": "charge_card", "idempotencyKey": "/idempotency_key" }]
  }
}
```

The check groups calls by tool and arguments, without the idempotency key.
A group of more than one call passes for a read, and for a write only when every call carries the same key.
A repeated call of an unlisted tool fails, because its side effect is unknown.
A call without captured arguments fails when its tool is called more than once, because the checker cannot tell whether it repeats.
Grouping matches arguments exactly: a retry that re-encodes a value (`42.5` vs `"42.50"`) is not recognized as the same call.
Independent of grouping, a declared write whose call itself errored (including a timeout) and carries no idempotency key always fails — its outcome at the target is unknown, so nothing proves a retry, however it was encoded, would be safe.

## Rule semantics

Every rule reports `pass`, `fail` or `error` in `ContractVerdict.ruleExecutions`.
`error` means the rule could not be evaluated: its predicate threw, or the scope selected no unique subtree.
A verdict with an errored rule has status `error` and is never valid.
A contract with no rules is rejected before evaluation.

Missing evidence fails the rule.
A required successor that never ran fails `precedes`, a span without the timestamp an order needs fails the order, and an unknown token count fails a token ceiling.

| Operator | Meaning |
|---|---|
| `always(p)`, `never(p)`, `eventually(p)` | Every span, no span, or some span matches `p`. |
| `precedes(a, b, { order })` | Both `a` and `b` occur, and `a` comes first. |
| `neverUnless(p, prior, { order })` | Every `p` has an earlier `prior`. A run without `p` passes. |
| `atMost(p, max)`, `tokensAtMost(p, max)` | Call and token ceilings. |
| `run({ ... })` | The run status and duration. |
| `argument(p, { pointer, check, occurrence })` | A JSON Pointer check on tool arguments. |
| `toolsOffered(declared)` | The offered tools are recorded, every call is one of them, and every offered tool is declared. |
| `retrySafe({ reads, writes })` | No call repeats a side effect that is not proven safe to repeat. |

Ordering has three modes.
`start-order` (the default) needs an `a` that started before each `b`.
`finish-before-start` needs an `a` that finished before each `b` started.
`all-occurrences` needs every `a` to finish before each `b` starts.

In TypeScript, the builder states the same rules:

```ts
import { checkTraceContracts, traceContract } from '@tangle-network/agent-eval'

const contract = traceContract('proposal-before-generation')
  .neverUnless({ tool: /generate/ }, { tool: 'submit_proposal' }, 'generation-needs-proposal')
  .build()
const result = checkTraceContracts(await store.spans({ runId }), [contract])
```

## Gate CI on a contract

**Unreleased.** `traces check` lives on `feat/traces-check` in `/traces` (PR #128), proven against this package but not yet mergeable: it needs the traces/agent-runtime redaction-core migration first, so a `/traces` build on this package's contract API does not crash at load. Until then, call `evaluateTraceContract` / `checkTraceContracts` directly, as shown above.

`traces check` runs a contract over a recorded trace and exits with a code a CI step can read:

```sh
traces check spans.otlp.jsonl --contract refund-desk.contract.json --junit contract.xml
```

| Exit | Meaning |
|---|---|
| 0 | Every rule passed. |
| 1 | A rule failed. |
| 2 | The contract is malformed or contradicts itself, or a rule could not be evaluated. |
| 3 | The trace could not be read. |
| 4 | The trace reference is ambiguous. |
