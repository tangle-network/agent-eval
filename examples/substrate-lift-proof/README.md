# Substrate lift proof — gepaDriver promotes a real held-out gain

The first controlled-but-real demonstration that `gepaDriver` +
`runImprovementLoop` + `defaultProductionGate` produce a **measured held-out
lift through a real LLM backend**. Retires the `real-unproven` status the
substrate's honesty docs assign `gepaDriver` (#101/#106), whose unit tests
only ever drove a fake fetch.

## What it does

- **Task**: structured field extraction — each scenario is a transaction
  sentence; the worker emits `{merchant, amount, date, category}`.
- **Judge**: a deterministic exact-match checker (no LLM, no variance) scores
  the fraction of correct fields → composite in `[0,1]`. Lift is unambiguous.
- **Weak baseline**: `"Extract the transaction info from the message as JSON."`
  — under-specified, so the search split scores low and the driver has real
  failures to reflect on (wrong keys like `vendor`, `Dining` casing, `$`).
- **Split**: 8 search scenarios (`gepaDriver` optimizes against) + 6 held-out
  (never seen by the driver; the gate scores baseline-vs-candidate here).
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

`gepaDriver` rewrote the weak one-liner into a schema-pinned prompt: exact
keys, bare-number amount, ISO `YYYY-MM-DD` date, fixed category taxonomy —
precisely the failure classes the baseline exhibited. The lift is per-scenario
monotone (no held-out scenario regressed).

The wiring is also covered deterministically (offline, no network) in
`tests/campaign/presets.test.ts` — `gepaDriver → runImprovementLoop →
defaultProductionGate` both ships a real gain and holds a no-op.
