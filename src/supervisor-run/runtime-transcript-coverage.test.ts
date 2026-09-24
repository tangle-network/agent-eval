import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { analyzeSupervisorRunIntegrity } from './integrity'
import { readRuntimeSupervisorRun } from './runtime-reader'

const ROOT = 'coverage-run'
const hex = (c: string): string => c.repeat(64)
const ref = (c: string): string => `sha256:${hex(c)}`
const blob = (dir: string, c: string): string => join(dir, 'blobs', `sha256-${hex(c)}.json`)
const spent = { iterations: 1, tokens: { input: 10, output: 5 }, usd: 0.01, ms: 1000 }
let seq = 0
const at = (): string =>
  new Date(Date.parse('2026-09-24T05:00:00.000Z') + seq++ * 1000).toISOString()
const event = (e: Record<string, unknown>): Record<string, unknown> => ({
  kind: 'event',
  root: ROOT,
  event: { seq: 0, at: at(), ...e },
})
const spawned = (id: string): Record<string, unknown> =>
  event({
    kind: 'spawned',
    id,
    ...(id === ROOT ? {} : { parent: ROOT }),
    label: id === ROOT ? 'root' : 'worker',
    identity: { profileDigest: ref('f') },
  })
const dispatched = (id: string): Record<string, unknown> =>
  event({ kind: 'execution-admitted', id, admission: { phase: 'dispatched' } })
const output = (id: string, c: string): Record<string, unknown> =>
  event({ kind: 'execution-result', id, outRef: ref(c), spent })
const settled = (id: string, harnessTranscript: Record<string, unknown>, status = 'done') =>
  event({
    kind: 'settled',
    id,
    status,
    spent,
    verdict: { valid: status === 'done' },
    harnessTranscript,
  })

/**
 * One Runtime run directory with five workers, each exercising one retention outcome. The
 * shapes are Runtime's own: a turn is a dispatched admission, its record an execution-result
 * blob, and the native session a `harnessTranscript` receipt on the terminal event.
 */
async function runDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'runtime-transcripts-'))
  await mkdir(join(dir, 'blobs'))
  const journal = [
    { kind: 'begin', root: ROOT, at: at() },
    spawned(ROOT),
    // a: one turn retained, native session retained.
    spawned(`${ROOT}:a`),
    dispatched(`${ROOT}:a`),
    output(`${ROOT}:a`, '1'),
    settled(`${ROOT}:a`, { status: 'available', transcriptRef: ref('9'), harness: 'opencode' }),
    // b: two turns dispatched, one retained; the capture found no session files.
    spawned(`${ROOT}:b`),
    dispatched(`${ROOT}:b`),
    output(`${ROOT}:b`, '2'),
    dispatched(`${ROOT}:b`),
    settled(`${ROOT}:b`, { status: 'unavailable', reason: 'no-transcript' }),
    // c: went down mid-turn with nothing retained.
    spawned(`${ROOT}:c`),
    dispatched(`${ROOT}:c`),
    settled(
      `${ROOT}:c`,
      { status: 'unavailable', reason: 'executor-exposes-no-transcript' },
      'down',
    ),
    // d: still running; its current turn is not a loss.
    spawned(`${ROOT}:d`),
    dispatched(`${ROOT}:d`),
    // e: the receipt names a blob the directory no longer holds.
    spawned(`${ROOT}:e`),
    dispatched(`${ROOT}:e`),
    output(`${ROOT}:e`, '3'),
    settled(`${ROOT}:e`, { status: 'available', transcriptRef: ref('8'), harness: 'opencode' }),
  ]
  await writeFile(
    join(dir, 'spawn-journal.jsonl'),
    `${journal.map((line) => JSON.stringify(line)).join('\n')}\n`,
  )
  for (const c of ['1', '2', '3', '9']) await writeFile(blob(dir, c), '{}')
  await writeFile(join(dir, 'root-stream.jsonl'), '{"seq":1}\n')
  return dir
}

describe('Runtime reader transcript coverage', () => {
  it('names each worker transcript Runtime retained, and the turns and sessions it did not', async () => {
    const dir = await runDir()
    const sources = await readRuntimeSupervisorRun(dir)
    expect(sources.rootTranscriptRef).toBe(join(dir, 'root-stream.jsonl'))
    const byId = new Map(sources.workers?.map((worker) => [worker.workerId, worker]))

    expect(byId.get(`${ROOT}:a`)).toMatchObject({
      transcriptRef: blob(dir, '9'),
      turns: { dispatched: 1, retained: 1 },
      nativeSession: { status: 'available', ref: blob(dir, '9') },
    })
    expect(byId.get(`${ROOT}:b`)).toMatchObject({
      transcriptRef: blob(dir, '2'),
      turns: { dispatched: 2, retained: 1 },
      nativeSession: { status: 'unavailable', reason: 'no-transcript' },
    })
    expect(byId.get(`${ROOT}:c`)).toMatchObject({
      transcriptRef: null,
      turns: { dispatched: 1, retained: 0 },
      nativeSession: { status: 'unavailable', reason: 'executor-exposes-no-transcript' },
    })
    expect(byId.get(`${ROOT}:d`)).toMatchObject({
      transcriptRef: null,
      turns: { dispatched: 1, retained: 0 },
      nativeSession: null,
    })
    expect(byId.get(`${ROOT}:e`)).toMatchObject({
      transcriptRef: blob(dir, '3'),
      nativeSession: { status: 'unavailable', reason: 'receipt-blob-missing' },
    })
  })

  it('counts a transcript retained by reference as present, and reports lost turns and sessions', async () => {
    const report = analyzeSupervisorRunIntegrity(await readRuntimeSupervisorRun(await runDir()))
    const byCode = new Map(report.issues.map((issue) => [issue.code, issue]))

    // c has no record at all; d's first turn is still running. Root, a, b and e are retained.
    expect(byCode.get('transcript-unavailable')?.metadata).toMatchObject({
      unavailable_count: 2,
      retained_by_reference_count: 4,
    })
    // b lost its second turn and c its only one; d is live, so its turn is not a loss.
    expect(byCode.get('transcript-incomplete')?.metadata).toMatchObject({
      unavailable_count: 2,
      lost_turns: 2,
    })
    expect(byCode.get('native-session-unavailable')?.metadata).toMatchObject({
      unavailable_count: 3,
      reasons: {
        'no-transcript': 1,
        'executor-exposes-no-transcript': 1,
        'receipt-blob-missing': 1,
      },
    })
  })
})
