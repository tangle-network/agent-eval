# Live Provider Prompt Improvement Run

This research example runs `gepaProposer`, `runImprovementLoop`, and
`defaultProductionGate` against a real OpenAI-compatible model endpoint.
It records the provider calls, scores the selected prompt on separate tasks,
and stops if the provider traffic cannot be confirmed.

## What it does

- **Task**: structured field extraction: each scenario is a transaction
  sentence; the worker emits `{merchant, amount, date, category}`.
- **Judge**: a deterministic exact-match checker (no LLM, no variance) scores
  the fraction of correct fields → composite in `[0,1]`. Lift is unambiguous.
- **Weak baseline**: `"Extract the transaction info from the message as JSON."`
  This is under-specified, so the search split scores low and the proposer has real
  failures to reflect on (wrong keys like `vendor`, `Dining` casing, `$`).
- **Split**: 8 search scenarios (`gepaProposer` optimizes against) + 6 held-out
  (never seen by the proposer; the gate scores baseline-vs-candidate here).
- **Backend**: token-emitting via the Tangle router. `assertRealBackend`
  (strict, `allowMixed: false`) verdicts `real` or the proof aborts.
- **Bounded**: every `callLlm` carries a 30s per-call timeout + bounded
  retries; population 2 × 2 generations.

## Run it

```sh
TANGLE_API_KEY="$YOUR_API_KEY" \
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
| candidate held-out composite | 1.000 |
| paired delta | +0.333 |
| gate decision | `ship` (all 5 gates passed) |
| cost (token-derived, haiku-4.5) | ~$0.02 |

`gepaProposer` rewrote the weak one-liner into a schema-pinned prompt: exact
keys, bare-number amount, ISO `YYYY-MM-DD` date, fixed category taxonomy -
precisely the failure classes the baseline exhibited. The lift is per-scenario
monotone (no held-out scenario regressed).

## Run Records

After the gate decides, the run calls `emitLoopProvenance` and writes two
durable artifacts under the run dir:

- `loop-provenance.json`: the structured `LoopProvenanceRecord`: every
  candidate with its `{surfaceHash, label, rationale}`, the gate
  decision + reasons + delta, the explicit baseline→winner diff, real
  content hashes (`sha256:...`) that distinguish baseline from winner, and
  backend provenance (`assertRealBackend` verdict + worker call count +
  model). The held-out lift **recomputes** from this record
  (`winnerHoldoutComposite - baselineHoldoutComposite`).
- `loop-provenance-spans.jsonl`: the same chain as OTLP-ingestable
  `TraceSpanEvent`s for the run, generation, candidate, and release decision, keyed by
  `tangle.runId` / `tangle.generation` / `tangle.surfaceHash`. Pass a
  `hostedClient` to `emitLoopProvenance` to ship them to
  `/v1/ingest/traces`.

The same control flow is covered offline in `tests/campaign/presets.test.ts`.
That test checks a gain, a no-op, candidate rationale, content hashes, the prompt diff,
the written files, the provider classification, and recomputation of the score change.
