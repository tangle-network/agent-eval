# Agent-failure diagnosis

`@tangle-network/agent-eval/diagnosis` exports one engine: `diagnoseSpans(spans, context, options)`.
It reads flat spans and returns a findings document that validates against the diagnosis kit's schema, `https://tangle.tools/schemas/diagnosis-findings-v1.json`.

The engine is a plain function.
It keeps no storage, files no issues, and retains nothing.
In model mode its only network use is the caller's transport; in deterministic mode it makes no call.
The caller owns where the spans come from and where the findings go, so one engine serves an internal mining run and a customer diagnosis on separate data paths.

## Input

Each span is one object in the flat shape that trace-adapters and the traces CLI emit:
`{trace_id, span_id, parent_span_id, name, start_time, end_time, status | status_code, status_message, attributes, resource?}`.
Times may be OTLP nanosecond strings, epoch milliseconds, or ISO-8601.

`context` names the subject (`internal` or `customer`), a label in the owner's words, an optional `focus` question, and `contentIncluded`.
Content is excluded by default: prompt, response, and tool payload attributes are dropped before anything reads the spans.
Only an internal context may carry a `topology` (a run graph); a customer context with one is refused.

## Order of operations

1. The secret filter runs on every string: span attributes, names, status messages, the focus question, and the topology.
   `DIAGNOSIS_SECRET_RULES` holds trace-archive's line-anchored credential-assignment pattern plus token shapes (`sk-`, `sk-ant-`, GitHub, Slack, AWS, Google, JWT, bearer headers, URL passwords, PEM blocks, and JSON or inline `...key=` values).
   A match becomes `[REDACTED:<rule>]`, and the document's `coverage.redaction` counts matches by rule.
2. The deterministic pass reports the trace contract's capability table with the trace's own reasons, execution facts with token and cost accounting, and `observed` findings.
   Each observed finding carries a measure with its denominator and cites the spans it counted.
3. Model mode reads the runs with the most errors through the prime protocol (`runPrimeExchange`).
   A run larger than the inline budget is read as whole segments, most errors first; the segments not read are listed in `coverage.skipped`.
4. Every cited span id must exist in the input and belong to one run.
   A model row that cites an unknown or shared id is rejected with its reason in `result.rejected`.

## Output

`result.document` is the only part a customer report renders.
Every finding has `confidence`: `observed` for a fact read off the spans, `inferred` for the model's reading.
`result.questions`, `result.notes` (operator critique and topology, internal only), `result.facts`, `result.model.usage`, and `result.rejected` support the report without entering the document.

## Model transport

`options.model.transport` is a `PrimeBridgeTransport`: an HTTP bridge (`nodeHttpPrimeBridgeTransport`) or any local runner with the same shape.
tangle-tools `trace-insights/mine` runs prime-agent on the Tangle router with `deepseek/deepseek-v4.1-flash`, in a throwaway home that is deleted after each call.
