# Coding-agent session intake

A coding agent writes its session to a JSONL transcript.
This package turns that transcript into `RunRecord`s, a provider-neutral action stream, and per-session metrics, so a session that already happened can be scored, compared, and analyzed like any other run.

Import from `@tangle-network/agent-eval/contract`.

## The three steps

```ts
import {
  fromCodexSession,
  parseCodeAgentJsonlFile,
} from '@tangle-network/agent-eval/contract'

const { entries, malformedLines } = await parseCodeAgentJsonlFile('/path/to/rollout.jsonl')
const { runs, diagnostics, metrics, observations } = fromCodexSession({
  entries,
  malformedLines,
  sourcePath: '/path/to/rollout.jsonl',
  scenarioId: 'refactor-billing',
})
```

1. **Read the transcript.** `parseCodeAgentJsonl(text)` for a string you already hold, `parseCodeAgentJsonlFile(path)` for a file. Both return `{ entries, malformedLines }`; a line that is not JSON is counted, never dropped silently.
2. **Convert it.** One function per harness, below. Each returns `runs`, `diagnostics`, `metrics`, and `observations`.
3. **Read `diagnostics` before `runs`.** One `CodeAgentSessionDiagnostic` per session records what the transcript actually carried: `malformedLines`, `hasExplicitTerminalSignal`, `hasFinalOutput`, `hasQualityLabel`, `hasTokenUsage`, `hasCost`, the `costKind` that was used, and any `warnings`. A run whose diagnostic says `hasCost: false` has no cost, not a cost of zero — check the flag before you aggregate the field.

## One function per harness

| Harness | Function |
|---|---|
| Codex | `fromCodexSession` |
| Claude Code | `fromClaudeCodeSession` |
| OpenCode | `fromOpenCodeSession` |
| Kimi Code | `fromKimiCodeSession` |
| Pi | `fromPiSession` |

They share one implementation and one options shape (`CodeAgentSessionIntakeOptions`); the harness decides how a session id, a terminal state, and a cost receipt are read out of the entries.
Supply `experimentId`, `candidateId`, `seed`, `splitTag`, `scenarioId`, `model`, `promptHash`, `configHash`, `commitSha`, and `score` when the surrounding experiment knows them — an unsupplied field stays unknown rather than becoming a zero.
`costProvenance` sets the cost receipt explicitly; without it a source-reported cost wins, then a token-priced estimate, then uncaptured.

`metrics` carries the per-session counts a comparison needs without re-reading the transcript: `userMessages`, `assistantMessages`, `reasoningItems`, `toolCalls`, `toolOutputs`, `toolErrors`, `unclassifiedErrors`, `patchAttempts`, `patchSuccesses`, `patchFailures`, `turnsStarted`.

## Transcripts larger than memory

`parseCodeAgentJsonlFile` holds every entry, so it grows with the transcript.
`streamCodeAgentJsonlFile(path)` is an async generator that keeps live memory bounded by the longest single line — use it when a rollout is large enough that the entry array itself is the problem.
Reading a session above V8's ~512MB string ceiling through the string path throws `ERR_STRING_TOO_LONG`; the streaming path does not.

## The action stream on its own

`observeCodeAgentSession({ source, entries })` returns just the `CodeAgentSessionObservation`: the final text, the terminal state, and the provider-neutral action list.
Raw prompts, tool inputs, and tool outputs stay out of that projection — keep the source JSONL as the evidence for them.

## Traces that are not coding-agent sessions

`parseAgentTrace(records)` indexes a generic agent trace, and `partitionRunsByAuthoringModel(...)` splits its runs by the model that authored them, which is what a contamination check or a per-model comparison needs.
`fromOtelSpans(...)` is the entry point for OTLP spans.

## Related

- [`docs/concepts.md`](./concepts.md) — what a `RunRecord` is.
- [`docs/trace-analysis.md`](./trace-analysis.md) — analyzing the runs once they exist.
