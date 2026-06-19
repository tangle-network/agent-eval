import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { GenericSpan, Run } from './schema'
import { FileSystemTraceStore } from './store'

// Wrap node:fs/promises so the loader's readdir order is controllable per-test:
// real FS, but readdir entries are reordered to whatever `readdirOrder` sets.
// This forces the patch-before-base case (otherwise OS-dependent) and lets stat
// yield a macrotask so concurrent appends interleave deterministically.
let readdirOrder: ((files: string[]) => string[]) | undefined
let statDelay = false
vi.mock('node:fs/promises', async (importActual) => {
  const actual = await importActual<typeof import('node:fs/promises')>()
  return {
    ...actual,
    default: actual,
    async readdir(...args: Parameters<typeof actual.readdir>) {
      const out = (await (actual.readdir as (...a: unknown[]) => Promise<unknown>)(
        ...(args as unknown[]),
      )) as string[]
      return readdirOrder ? readdirOrder(out) : out
    },
    stat(...args: Parameters<typeof actual.stat>) {
      if (!statDelay) return actual.stat(...(args as Parameters<typeof actual.stat>))
      return new Promise((resolve, reject) => {
        setTimeout(
          () => actual.stat(...(args as Parameters<typeof actual.stat>)).then(resolve, reject),
          0,
        )
      })
    },
  }
})

function run(id: string, extra: Partial<Run> = {}): Run {
  return {
    runId: id,
    scenarioId: 'scn',
    startedAt: 1_700_000_000_000,
    status: 'running',
    ...extra,
  }
}

function span(id: string, runId: string, extra: Partial<GenericSpan> = {}): GenericSpan {
  return {
    spanId: id,
    runId,
    kind: 'agent',
    name: 'work',
    startedAt: 1_700_000_000_000,
    ...extra,
  }
}

describe('FileSystemTraceStore', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'fs-trace-store-'))
  })
  afterEach(() => {
    readdirOrder = undefined
    statDelay = false
    rmSync(dir, { recursive: true, force: true })
  })

  function diskLines(name: string): string[] {
    const out: string[] = []
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.ndjson')) continue
      if (f === `${name}.ndjson` || f.startsWith(`${name}.`)) {
        out.push(
          ...readFileSync(join(dir, f), 'utf8')
            .split('\n')
            .filter((l) => l.trim()),
        )
      }
    }
    return out
  }

  it('serializes concurrent appends so rollover holds the size bound (mutex)', async () => {
    // Seed the active file already at the bound, then fire a concurrent burst
    // with stat delayed a macrotask so every append observes the same
    // over-size state. Without per-name serialization the stat→rename→append
    // windows interleave: each append renames once then writes to the same
    // fresh active without re-checking, so the active file balloons far past
    // maxBytes — the rollover bound the option exists to enforce is silently
    // violated. Serialized, each append re-stats after the prior one's write,
    // so the active file never holds more than one record over the bound.
    const maxBytes = 200
    const fs = await import('node:fs/promises')
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(join(dir, 'spans.ndjson'), `${'x'.repeat(maxBytes)}\n`, 'utf8')
    statDelay = true

    const store = new FileSystemTraceStore({ dir, maxBytes })
    const n = 20
    const pad = 'y'.repeat(80)
    await Promise.all(
      Array.from({ length: n }, (_, i) =>
        store.appendSpan(span(`s${i}`, 'r1', { attributes: { pad } })),
      ),
    )

    // Active file must not exceed the bound by more than the single record that
    // tipped it over; a no-lock race lets every record pile into one file.
    const recordBytes = Buffer.byteLength(
      `${JSON.stringify(span('s0', 'r1', { attributes: { pad } }))}\n`,
    )
    const activeSize = (await fs.stat(join(dir, 'spans.ndjson'))).size
    expect(activeSize).toBeLessThanOrEqual(maxBytes + recordBytes)

    // And no row is lost across the rolled corpus.
    const ids = new Set(
      diskLines('spans')
        .map((l) => {
          try {
            return (JSON.parse(l) as { spanId?: string }).spanId
          } catch {
            return undefined
          }
        })
        .filter((id): id is string => Boolean(id)),
    )
    expect(ids.size).toBe(n)
  })

  it('surfaces an index-mirror failure to the caller (awaited, not fire-and-forget)', async () => {
    // Populate the lazy index so the next append mirrors into it. A duplicate
    // runId makes the index reject. A floating `void this.insertInto(...)`
    // swallows that as an unhandled rejection and reports success while disk +
    // index diverge; awaiting it surfaces the error to the caller.
    const store = new FileSystemTraceStore({ dir })
    await store.appendRun(run('r1'))
    expect(await store.getRun('r1')).toBeDefined()

    await expect(store.appendRun(run('r1'))).rejects.toThrow(/already exists/)
  })

  it('collapses an _update patch onto its base when reloaded cross-instance', async () => {
    const store = new FileSystemTraceStore({ dir })
    await store.appendSpan(span('span-1', 'r1', { status: 'ok' }))
    await store.updateSpan('span-1', { endedAt: 1_700_000_002_000, status: 'error' })

    const reopened = new FileSystemTraceStore({ dir })
    const spans = await reopened.spans({ runId: 'r1' })
    expect(spans).toHaveLength(1)
    expect(spans[0]!.spanId).toBe('span-1')
    expect(spans[0]!.runId).toBe('r1')
    expect(spans[0]!.status).toBe('error')
    expect(spans[0]!.endedAt).toBe(1_700_000_002_000)
  })

  it('collapses a patch read before its base — no runId-less fragment (two-pass)', async () => {
    // Rollover splits a span's stream across files: the base full span in one
    // file, its `_update` patch in another. Force readdir to return the patch
    // file first. A one-pass loader applies the patch before the base exists,
    // hits the catch, and appends a runId-less fragment → two spans, corrupt
    // counts. Two-pass load defers patches until every base is indexed.
    writeFileSync(
      join(dir, 'spans.base.ndjson'),
      `${JSON.stringify(span('span-1', 'r1', { status: 'ok' }))}\n`,
    )
    writeFileSync(
      join(dir, 'spans.patch.ndjson'),
      `${JSON.stringify({ spanId: 'span-1', status: 'error', endedAt: 1_700_000_002_000, _update: true })}\n`,
    )
    readdirOrder = () => ['spans.patch.ndjson', 'spans.base.ndjson']

    const store = new FileSystemTraceStore({ dir })
    const spans = await store.spans()
    expect(spans).toHaveLength(1)
    expect(spans[0]!.spanId).toBe('span-1')
    expect(spans[0]!.runId).toBe('r1')
    expect(spans[0]!.status).toBe('error')
    expect(spans.every((s) => typeof s.runId === 'string' && s.runId.length > 0)).toBe(true)
  })

  it('collapses a run patch read before its base — no scenarioId-less fragment (two-pass)', async () => {
    writeFileSync(
      join(dir, 'runs.base.ndjson'),
      `${JSON.stringify(run('r1', { status: 'running' }))}\n`,
    )
    writeFileSync(
      join(dir, 'runs.patch.ndjson'),
      `${JSON.stringify({ runId: 'r1', status: 'completed', _update: true })}\n`,
    )
    readdirOrder = () => ['runs.patch.ndjson', 'runs.base.ndjson']

    const store = new FileSystemTraceStore({ dir })
    const runs = await store.listRuns()
    expect(runs).toHaveLength(1)
    expect(runs[0]!.runId).toBe('r1')
    expect(runs[0]!.status).toBe('completed')
    expect(runs[0]!.scenarioId).toBe('scn')
  })

  it('applies patches in write order across rolled files (newest wins), not readdir order', async () => {
    // r1 was running, completed (both in the older rolled file), then failed
    // (in the newer file). Replaying in readdir order with the newer file first
    // lets the OLDER 'completed' patch win and silently restore a stale status;
    // the chronological file sort makes 'failed' (the newest write) win.
    writeFileSync(
      join(dir, 'runs.900.ndjson'),
      `${JSON.stringify(run('r1', { status: 'running' }))}\n${JSON.stringify({ runId: 'r1', status: 'completed', _update: true })}\n`,
    )
    writeFileSync(
      join(dir, 'runs.1000.ndjson'),
      `${JSON.stringify({ runId: 'r1', status: 'failed', _update: true })}\n`,
    )
    // Adversarial: newer rolled file returned first by readdir.
    readdirOrder = () => ['runs.1000.ndjson', 'runs.900.ndjson']

    const store = new FileSystemTraceStore({ dir })
    const runs = await store.listRuns()
    expect(runs).toHaveLength(1)
    expect(runs[0]!.status).toBe('failed')
  })
})
