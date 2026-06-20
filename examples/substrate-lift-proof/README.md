# Substrate lift proof — gepaProposer promotes a real held-out gain

The first controlled-but-real demonstration that `gepaProposer` +
`runImprovementLoop` + `defaultProductionGate` produce a **measured held-out
lift through a real LLM backend**. Retires the `real-unproven` status the
substrate's honesty docs assign `gepaProposer` (#101/#106), whose unit tests
only ever drove a fake fetch.

## What it does

- **Task**: structured field extraction — each scenario is a transaction
  sentence; the worker emits `{merchant, amount, date, category}`.
- **Judge**: a deterministic exact-match checker (no LLM, no variance) scores
  the fraction of correct fields → composite in `[0,1]`. Lift is unambiguous.
- **Weak baseline**: `"Extract the transaction info from the message as JSON."`
  — under-specified, so the search split scores low and the proposer has real
  failures to reflect on (wrong keys like `vendor`, `Dining` casing, `$`).
- **Split**: 8 search scenarios (`gepaProposer` optimizes against) + 6 held-out
  (never seen by the proposer; the gate scores baseline-vs-candidate here).
- **Backend**: token-emitting via the Tangle router. `assertRealBackend`
  (strict, `allowMixed: false`) verdicts `real` or the proof aborts.
- **Bounded**: every `callLlm` carries a 30s per-call timeout + bounded
  retries; population 2 × 2 generations. Completes in ~30s.

## Run it

```bash
TANGLE_API_KEY=$(cat /tmp/.tk) \
TANGLE_ROUTER_URL=https://router.tangle.tools/v1 \
pnpm tsx examples/substrate-lift-proof/index.ts
```

The artifact lands at `.evolve/substrate-lift-proof/<ts>/lift-proof.json` and
`.evolve/substrate-lift-proof/latest.json`. `lift-proof.json` in this directory
is a checked-in run.

## A recorded run (`lift-proof.json`)

| metric | value |
| --- | --- |
| backend verdict | `real` (52 calls, ~5k in / ~3k out tokens) |
| baseline held-out composite | 0.667 |
| candidate held-out composite | 0.958 |
| paired delta | +0.292 |
| gate decision | `ship` (all 5 gates passed) |
| cost (token-derived, haiku-4.5) | ~$0.02 |

`gepaProposer` rewrote the weak one-liner into a schema-pinned prompt: exact
keys, bare-number amount, ISO `YYYY-MM-DD` date, fixed category taxonomy —
precisely the failure classes the baseline exhibited. The lift is per-scenario
monotone (no held-out scenario regressed).

## Provenance (the auditable chain)

After the gate decides, the run calls `emitLoopProvenance` and writes two
durable artifacts under the run dir:

- `loop-provenance.json` — the structured `LoopProvenanceRecord`: every
  candidate with its `{surfaceHash, label, rationale}`, the gate
  decision + reasons + delta, the explicit baseline→winner diff, real
  content hashes (`sha256:…`) that distinguish baseline from winner, and
  backend provenance (`assertRealBackend` verdict + worker call count +
  model). The held-out lift **recomputes** from this record
  (`winnerHoldoutComposite − baselineHoldoutComposite`) — the `provenance`
  block of `lift-proof.json` asserts the recompute matches the live delta.
- `loop-provenance-spans.jsonl` — the same chain as OTLP-ingestable
  `TraceSpanEvent`s (root → generation → candidate → gate), pivoted on
  `tangle.runId` / `tangle.generation` / `tangle.surfaceHash`. Pass a
  `hostedClient` to `emitLoopProvenance` to ship them to
  `/v1/ingest/traces`.

The wiring is also covered deterministically (offline, no network) in
`tests/campaign/presets.test.ts` — `gepaProposer → runImprovementLoop →
defaultProductionGate` ships a real gain, holds a no-op, AND asserts the full
provenance chain is emitted + durable (rationale survives, hashes distinguish,
diff present, spans + record written, backend verdict captured, +lift
recomputes from the emitted record).
