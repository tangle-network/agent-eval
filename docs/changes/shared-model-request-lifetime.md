# Model request lifetime and cost interpretation

The existing physical-attempt loop now keeps `timeoutMs` active until the full
response body has been read, for both successful and failed HTTP responses.
`deadlineMs` also bounds each remaining request and retry wait; an already-expired
operation does not dispatch. Cancelling during `Retry-After` or exponential backoff
stops that wait immediately. A late transport response after the deadline fails
with the cancellation error rather than becoming a result or a new retry.

The client reuses `combineAbortSignals` instead of maintaining separate signal
composition. Raw captures retain the existing attempt indices, operation identity
and redaction policy. User-defined capture callbacks must still complete or honor
their own cancellation; this change does not promise to terminate arbitrary code.

Results and receipts use the same reported-cost parser. Invalid negative or
non-finite provider prices are not exposed as observed cost; an explicitly reported
zero remains zero. Token-price estimates, when available, remain estimates. This
is provider-level parsing, not evidence of a Router customer charge: product
consumers must keep their customer receipt and payer attribution.

The full operation continues to use the caller's physical request allowance,
including schema and temperature negotiation. No hidden extra request batch,
dependency, new budget owner, default provider, or automatic result replay is added.

Run `pnpm exec vitest run src/llm-client.test.ts tests/llm-physical-attempts.test.ts`
for the maintained client and real-loopback HTTP contracts. These include a stalled
body after headers, cancellation during server-directed backoff, exhausted deadlines,
request-count conservation, raw-capture ordering and malformed reported prices.
Regenerate only the live analyst implementation pin with
`pnpm analyst:pin:implementation`; historical evidence pins remain fixed.
