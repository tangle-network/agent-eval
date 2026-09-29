# One physical request budget for structured inference

Schema negotiation now runs inside the existing `callLlm` attempt loop instead of starting a
second retry batch. Schema, temperature and transient-error retries share `maximumAttempts`,
the elapsed deadline and monotonically increasing raw-observation attempt indices.
`maximumChargeForLlmRequest` reserves that same total request/output bound rather than doubling
it for another schema batch. No additional transport, scheduler, ledger or retry configuration.

## Compatibility

`maximumAttempts: 1` means one physical request, including structured output. It no longer
performs an uncounted `json_schema` to `json_object` retry. For a known JSON-object-only model,
configure the existing `jsonSchemaTransport: 'json-object'` option before execution; this still
works in one request. For unknown support, explicitly allow the needed negotiation attempts.
Native schema support and runtime schema validation remain separate concerns: validate the
returned artifact using the caller's existing schema.

The default remains three total attempts. A schema rejection followed by a temperature
rejection can still succeed on the third request. An exhausted or elapsed attempt budget
returns the original typed failure; it is not silently reset for a different response format.

## Accounting boundary

Raw provider capture, when enabled, sees one attempt sequence. The successful return value
still describes the terminal response, not an invented sum of all provider charges. Owners
requiring one paid-call identity per request should use one attempt and retain each receipt
through their existing execution owner. Publish and install the actual release containing
this change before deleting guards in consumers pinned to older versions.

The HTTP regression suite counts actual requests and verifies fallback bodies, attempt
indices, elapsed-budget behavior and the preselected JSON-object path. It is a loopback
protocol proof, not a live-provider compatibility survey or wallet-settlement proof.
