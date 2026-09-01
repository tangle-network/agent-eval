/**
 * Invariants over REAL agent-runtime run directories.
 *
 * `tests/fixtures/supervisor-run/runtime-run-winner` is a complete run written by
 * `createFileRunContext(dir)`: one root driver on a CLI bridge, one sandboxed child that
 * settled `done` with `verdict { valid: true, score: 1 }`, and a `result.json` whose
 * `kind` is `winner`. Nothing about it is synthetic and nothing about it is degraded, so
 * every gap this reader reports on it is a defect in the reader.
 *
 * `runtime-run-mixed-usd` is derived from that journal: the same tree with a second child
 * whose spend Runtime recorded as `usdKnown: false` and `tokensKnown: false`, and with the
 * remaining two records priced. It is the case a single-flag rule collapses — one
 * unreported record must not delete the two measured ones.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { analyzeSupervisorRunSources } from './analyze'
import { readRuntimeSupervisorRun } from './runtime-reader'
import { isUnavailable } from './types'

const FIXTURES = join(process.cwd(), 'tests', 'fixtures', 'supervisor-run')
const WINNER_DIR = join(FIXTURES, 'runtime-run-winner')
const MIXED_DIR = join(FIXTURES, 'runtime-run-mixed-usd')
const T0 = Date.parse('2026-09-01T16:00:00.000Z')
const ROOT = 'runner-smoke-20260901'

describe('real agent-runtime run — a clean run reports no gaps it does not have', () => {
  it('reads the terminal status Runtime wrote', async () => {
    const source = await readRuntimeSupervisorRun(WINNER_DIR)
    const report = analyzeSupervisorRunSources(source, () => T0)

    // `winner` is Runtime's own discriminant on `SupervisedResult`. A reader that only
    // knew `completed`/`interrupted` reported "no state.json / result.json status" on a
    // run whose result.json says exactly what happened.
    expect(report.outcome.supStatus).toBe('winner')
    expect(report.gaps).not.toContain('supStatus: no state.json / result.json status')
    expect(JSON.parse(source.state as string)).toEqual({
      id: ROOT,
      startedAt: '2026-09-01T15:12:25.228Z',
      status: 'winner',
    })
  })

  it('counts the settled valid verdict Runtime recorded as accepted', async () => {
    const report = analyzeSupervisorRunSources(await readRuntimeSupervisorRun(WINNER_DIR), () => T0)

    // Runtime settles the child with `verdict { valid: true, score: 1 }`. FileRunContext
    // retains no per-child patch, which limits the accepted/emptyPass SPLIT — not the
    // acceptance decision the verdict already carries.
    expect(report.decision.accepted).toBe(1)
    expect(report.decision.rejected).toBe(0)
    expect(isUnavailable(report.decision.emptyPass)).toBe(true)
    expect(report.orchestration.workersSpawned).toBe(1)
    expect(report.orchestration.workersSettled).toBe(1)

    if (isUnavailable(report.economics.perWorker)) {
      throw new Error(report.economics.perWorker.unavailable)
    }
    expect(report.economics.perWorker[0]?.passed).toBe(true)
    expect(report.economics.perWorker[0]?.score).toBe(1)
    expect(report.economics.perWorker[0]?.status).toBe('done')
  })

  it('keeps the tokens Runtime measured while both records go unpriced', async () => {
    const report = analyzeSupervisorRunSources(await readRuntimeSupervisorRun(WINNER_DIR), () => T0)

    // Both spend records on this run carry `usdKnown: false`, so there is no priced record
    // to report and the whole price channel is honestly unavailable. The TOKEN channel is
    // complete on both records and stays measured.
    expect(report.economics.brain.tokensIn).toBe(80_509)
    expect(report.economics.brain.tokensOut).toBe(766)
    expect(report.economics.workers.tokensIn).toBe(31_608)
    expect(report.economics.workers.tokensOut).toBe(221)
    expect(isUnavailable(report.economics.totalUsd)).toBe(true)
    expect(isUnavailable(report.economics.brain.usd)).toBe(true)
    expect(report.economics.spend.journalDerived.unknownRecords).toBe(2)
    expect(report.economics.spend.journalDerived.unknownNodes).toEqual([ROOT, `${ROOT}:s0`])
  })

  it('does not report a cache split the provider never gave', async () => {
    const report = analyzeSupervisorRunSources(await readRuntimeSupervisorRun(WINNER_DIR), () => T0)

    // The root metered row carries `cacheWrite: 0` next to `cacheBreakdownKnown: false`.
    // That zero is the provider's silence about the split, not a measurement of it.
    expect(report.economics.brain.cacheRead).toEqual({
      unavailable:
        'Runtime recorded cacheBreakdownKnown:false — the provider reported a total without splitting cache reads from writes',
    })
    expect(isUnavailable(report.economics.brain.cacheWrite)).toBe(true)
  })
})

describe('agent-runtime run with mixed usdKnown — one unreported record deletes nothing', () => {
  it('reports the priced nodes and names the unpriced one', async () => {
    const report = analyzeSupervisorRunSources(await readRuntimeSupervisorRun(MIXED_DIR), () => T0)

    // Two of three spend records carry a price. The partial sum keeps them, and its own
    // record states how much of the run it covers and which node it does not.
    expect(report.economics.spend.journalDerived).toEqual({
      usd: 0.07,
      records: 2,
      unknownRecords: 1,
      partial: true,
      unknownNodes: [`${ROOT}:s1`],
    })
    expect(report.economics.brain.usd).toBe(0.05)
    expect(report.economics.workers.usd).toBe(0.02)
    expect(report.economics.workers.source).toContain('1 unpriced')

    if (isUnavailable(report.economics.perWorker)) {
      throw new Error(report.economics.perWorker.unavailable)
    }
    const [priced, unpriced] = report.economics.perWorker
    expect(priced?.workerId).toBe(`${ROOT}:s0`)
    expect(priced?.usd).toBe(0.02)
    expect(unpriced?.workerId).toBe(`${ROOT}:s1`)
    expect(unpriced?.usd).toBeNull()

    // The collapsed total is a bare number with nothing beside it to say how much of the
    // run it covers, so it names the unpriced node instead of understating the run.
    expect(report.economics.totalUsd).toEqual({
      unavailable: `Runtime recorded usdKnown:false on 1 of 3 spend record(s) (${ROOT}:s1)`,
    })
    expect(report.gaps).toContain(
      `totalUsd: Runtime recorded usdKnown:false on 1 of 3 spend record(s) (${ROOT}:s1)`,
    )
  })

  it('never renders an unreported token count as a measured zero', async () => {
    const report = analyzeSupervisorRunSources(await readRuntimeSupervisorRun(MIXED_DIR), () => T0)

    if (isUnavailable(report.economics.perWorker)) {
      throw new Error(report.economics.perWorker.unavailable)
    }
    const [priced, unreported] = report.economics.perWorker
    expect(priced?.tokensIn).toBe(31_608)
    expect(unreported?.tokensIn).toBeNull()
    expect(unreported?.tokensOut).toBeNull()

    // The worker token total covers one reporting record and one that reported nothing.
    // `Measured<number>` has no field beside it to state that split, so it goes absent
    // with the node named rather than summing to a floor that reads as the total.
    expect(report.economics.workers.tokensIn).toEqual({
      unavailable: `Runtime recorded tokensKnown:false on 1 of 2 spend record(s) (${ROOT}:s1)`,
    })
    expect(report.economics.brain.tokensIn).toBe(80_509)

    // The close record states its own incompleteness, so it is not a second opinion here.
    expect(isUnavailable(report.economics.spend.closeRecord.usd)).toBe(true)
    expect(report.economics.spend.closeRecord.unknownRecords).toBe(1)
  })

  it('is derived from the real journal, not written to pass', () => {
    const real = readFileSync(join(WINNER_DIR, 'spawn-journal.jsonl'), 'utf8')
    const mixed = readFileSync(join(MIXED_DIR, 'spawn-journal.jsonl'), 'utf8')
    for (const shared of [
      '"kind":"begin","root":"runner-smoke-20260901"',
      '"id":"runner-smoke-20260901:s0","parent":"runner-smoke-20260901"',
      '"verdict":{"valid":true,"score":1}',
    ]) {
      expect(real).toContain(shared)
      expect(mixed).toContain(shared)
    }
  })
})
