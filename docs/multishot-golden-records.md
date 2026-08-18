# Multishot golden records

`@tangle-network/agent-eval/multishot/golden` holds frozen recordings of what a multishot conversation engine produces on a closed set of deterministic scenarios.
Point your engine at them and any orchestration drift surfaces as a named field.

## What a record holds

Each scenario records two things.

**The request ledger** — every transport call each leg received, in issue order: the model, the temperature, the token budget, the advertised tool definitions, and the full message log.
Tools are compared by value, not by array identity: an engine may rebuild the array, but a changed name, description or parameter schema changes what the agent is offered.
This is where two orchestrators diverge without their return value changing: a wrong follow-up token budget, a driver rotation that stops one model early, a point-of-view translation that drops a tool row from the driver's view.

**The outcome** — either the `MultishotResult` without its wall-clock `durationMs`, or the throw reduced to its constructor name, its message, and the cell spend it declares for the cost ceiling.

The matrix scenarios add the returned `MatrixResult`, the judge calls, and every file the run persisted under its run directory.

Wall-clock and run-identity keys (`durationMs`, `meanDurationMs`, `matrixId`, `runId`) are removed before comparison — no two runs agree on them.
The summary Markdown keeps its text with the rendered duration masked.

## Use it

```ts
import { describe, it } from 'vitest'
import {
  assertMultishotGoldenScenario,
  multishotGoldenScenarios,
} from '@tangle-network/agent-eval/multishot/golden'
import { runMyEngine } from './my-engine'

describe('my engine reproduces the multishot golden records', () => {
  for (const scenario of multishotGoldenScenarios()) {
    it(scenario.description, async () => {
      await assertMultishotGoldenScenario({ engine: runMyEngine, scenario })
    })
  }
})
```

`assertMultishotGoldenScenario` throws `MultishotGoldenMismatchError` listing every field that moved.
`checkMultishotGoldenScenario` returns the same report without throwing, for a caller that wants to inspect it.
`checkMultishotGolden` runs every SHOT scenario in one call; the matrix scenarios have their own pair below.
It refuses an `only` id the catalog does not hold, so a stale id after a rename stops the check instead of greening a run of zero scenarios.

The matrix pair is `assertMultishotMatrixGoldenScenario` / `checkMultishotMatrixGoldenScenario`; both take a `runDir` the engine may write into, and both install a deterministic judge wire on `globalThis.fetch` for the duration of the run.
That wire is process-wide, so run matrix checks serially within one process and keep other fetch traffic out of it.
Both rules are enforced, not just documented: a second concurrent install throws, and the wire fails loud on any request it does not recognise rather than answering it.

## Determinism rules

Every scenario is a closed system: scripted transports, scripted tool executors, a fixed persona and profile, fixed token budgets.
No network, no random number, and no clock in a COMPARED field — the fixture envelope carries a `recordedAt` stamp as provenance, and nothing compares it.
Matrix cells run one at a time, so the request ledger is a property of the conversation engine rather than of how two engines interleave their microtasks.

Judge calls fan out across three slots through `Promise.all`, so their issue order is a detail of the cell body rather than observable behaviour.
Their content is behaviour, so they are compared as a set with a stable order.

## Records are frozen

A version file is written once and never edited.
A golden record that can be regenerated over itself proves nothing: a regression would simply be re-recorded as the new truth.

`scripts/record-multishot-golden.ts` refuses to overwrite an existing version.
A deliberate behaviour change mints a NEW version file, registers it in `src/multishot/golden/records/index.ts` beside the old one, and moves `CURRENT_MULTISHOT_GOLDEN_VERSION`.
The diff between the two files is the reviewable evidence of what moved, and the previous contract stays runnable through `goldenRecords('v1')`.

## The reference engine

`runMultishot` is this package's reference conversation engine, and the suite proves the records against it on every run.
The suite also perturbs the engine: one scenario runs it with a changed token budget and requires the check to name the moved field.
The records are therefore proved able to detect a change, not merely able to pass.

The recorder accepts an engine from outside the repository, so a consumer's engine can mint a version.
Minting every version that way would let a product's wiring define this package's frozen contract, which the layering rule in `CLAUDE.md` forbids.
That is why the reference engine ships here.

## Regenerate

The recorder never picks an engine for you: the reference has to be named.
A script that silently picked one would record the wrong thing.

```bash
pnpm tsx scripts/record-multishot-golden.ts \
  --version v2 \
  --engine <module>#<export> \
  --matrix-engine <module>#<export>
```

`<module>` resolves from the repository root and may point outside it, so a reference engine that lives in a consumer works:

```bash
pnpm tsx scripts/record-multishot-golden.ts \
  --version v2 \
  --engine ../gtm-agent/eval/lib/multishot-graph.ts#runMultishotGraph \
  --matrix-engine ../gtm-agent/eval/lib/multishot-matrix-graph.ts#runMultishotMatrixGraph
```

Then register the new file in `src/multishot/golden/records/index.ts` and move `CURRENT_MULTISHOT_GOLDEN_VERSION` to it.
The recorder writes the file and nothing else; until it is registered, `goldenRecords()` still resolves the old version and the new file is inert.

Every scenario is captured twice and the two captures must agree.
A scenario that is not reproducible cannot detect a regression, so an unstable capture fails the run instead of freezing a coin flip.
Captures run with the network refused and with the same `durationMs` contract the check enforces, so the recorder cannot freeze a record its own reference engine would fail.

## Adding a scenario

Add it to `multishotGoldenScenarios()` in `src/multishot/golden/scenarios.ts`, then mint a new version.
The record-set integrity test requires one record per catalog scenario in catalog order, so a scenario with no record fails the suite rather than passing silently.

A version may be dropped once no supported consumer checks against it and its behaviour is fully covered by a later version. Until then every version stays: an old record is how a consumer still on an older engine keeps a runnable contract.

`v1` was captured from the `./multishot` loop at agent-eval 0.145.21 — the engine the merged loop-to-graph parity proofs compared against.
