# Unreleased: evaluation definition identity

Static `jevJudge` and `jevAnalyst` versions now bind authored question order and
Choice alternative order in addition to their canonical content. The request is
not sorted or rewritten. Optional undefined SDK fields remain absent from the
JSON document, so JSON round-trips retain the same identity.

This intentionally changes static evaluator version hashes. A cached verdict from
the previous identity scheme must not be treated as evidence for a reordered
classifier definition. Existing caches remain stored under their previous versions;
this change does not delete or migrate them.

`asJudge` and `asAnalyst` capture callback references when constructed and detach
metadata arrays/objects from the supplied options. Replacing `options.evaluate`,
`options.map` or `options.record` later no longer changes an already-versioned
adapter. Construct another adapter with a new version for an intentional change.

This is not a sandbox or closure serializer. Callers must still version opaque
renderer/mapping behavior and mutable state captured inside their own functions.
Dynamic question builders remain supported; retain each actual request through
the existing observation path. No model calls, thresholds, domain policies,
transport defaults or execution machinery are added.

Regression tests cover version collisions from reordering, preserved dispatch
order, SDK-style undefined fields, metadata mutation and callback replacement
through the real paid-call ledger. They establish code contracts, not classifier
quality or deployed outcome improvements.
