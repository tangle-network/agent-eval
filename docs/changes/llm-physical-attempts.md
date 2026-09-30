# Unreleased: one physical-attempt allowance for structured calls

`createChatClient` and structured JSON calls now count schema negotiation,
temperature negotiation and transient retries against one `maximumAttempts`
allowance. Schema fallback no longer starts a second retry loop, resets the
cross-attempt deadline, or restarts raw-provider attempt indices.

`maximumAttempts: 1` makes at most one HTTP request. A provider rejecting the
schema is returned to the caller rather than followed by an unadmitted call.
Callers that allow negotiation can supply enough attempts, or select
`jsonSchemaTransport: 'json-object'` when that protocol is already known.
Low-level `callLlm` retains its existing no-schema-negotiation behavior.

`maximumChargeForLlmRequest` uses the same physical-attempt allowance rather
than reserving two full batches for a schema request. Its input bound still
includes the native schema, and output limits remain enforced per request.
Failed-attempt raw observations keep their order and the operation's original
identity. This does not claim provider-side deduplication or final-response
aggregation of every paid failed attempt; retain the execution evidence and
account at the existing caller-owned boundary.

There is one retry owner and no new public framework, dependency, credential
source, scheduler or product-specific transport. Product fetch guards protecting
older installed versions must remain until a release containing this change is
published and the compatible consumer set is installed and verified.

Proof: `tests/llm-physical-attempts.test.ts` runs the public client against a real
loopback HTTP server. Existing client, transient-status and raw-capture checks
remain in place. These are transport and allowance checks, not live-provider
cost or outcome-quality benchmarks.
