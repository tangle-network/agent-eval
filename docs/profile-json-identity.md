# Profile JSON identity

`toAgentProfileJson` converts a profile's JSON document form through
`ledger-core/canonical`, the existing owner of canonical serialization. Object
properties whose value is `undefined` are omitted, including nested optional
properties. Everything else must have a faithful canonical JSON representation.
Functions, symbols, non-finite numbers, BigInt, class instances, Map, Set, sparse
arrays, undefined array members, malformed Unicode and cycles are refused with
`AgentProfileCellValidationError`. Custom `toJSON` functions are not a way to
substitute different evidence.

This fixes an older conversion that used `JSON.stringify` before validation:
functions could disappear and non-finite numbers could become null before the
profile was hashed. Callers must supply portable data rather than depend on those
coercions. An absent measurement is not a measured null or zero.

Cell dimensions preserve every own string key, including `__proto__`. A
previously stored cell whose dimension was omitted from its digest no longer
verifies against that dimension. Do not relabel or rewrite an old cell's digest;
retain the original record as unverifiable and issue a fresh measurement when
needed. Ordinary portable profiles and dimensions keep the same source hashes
and cell IDs.

`sourceProfile.hash` commits to the profile alone. `sourceProfile.kind` also
contributes to the cell ID, so a source identity join should compare both kind
and hash. A loose product-specific fingerprint must not claim to be a validated
canonical AgentProfile merely because it is JSON-serializable.

Regression coverage: `tests/profile-json-canonical.test.ts`, together with the
existing `tests/agent-profile-cell.test.ts`. Run the repository typecheck, full
suite, build and package checks before release. This document does not allocate
or announce a package version; release metadata and downstream peer ranges must
be updated together by the normal release process.
