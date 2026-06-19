import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { OtlpFileTraceStore } from './store-otlp'

const dir = mkdtempSync(join(tmpdir(), 'otlp-ts-'))

interface Line {
  trace_id: string
  span_id: string
  name?: string
  start_time?: string
  end_time?: string
  status?: { code: string }
  attributes?: Record<string, unknown>
}

function writeOtlp(name: string, lines: Line[]): string {
  const p = join(dir, name)
  writeFileSync(
    p,
    `${lines.map((l) => JSON.stringify({ name: 's', status: { code: 'OK' }, attributes: {}, ...l })).join('\n')}\n`,
  )
  return p
}

describe('OtlpFileTraceStore timestamp handling', () => {
  it('yields a finite duration (0), never NaN/null, when timestamps are empty', async () => {
    const path = writeOtlp('empty.jsonl', [
      { trace_id: 't1', span_id: 'a', start_time: '', end_time: '' },
      { trace_id: 't1', span_id: 'b', start_time: '', end_time: '' },
    ])
    const store = new OtlpFileTraceStore({ path })
    const page = await store.queryTraces({ limit: 10 })
    expect(page.traces[0]!.duration_ms).toBe(0)
    expect(Number.isNaN(page.traces[0]!.duration_ms)).toBe(false)
  })

  it('orders the time range by real time across mixed ISO + epoch-millis dialects', async () => {
    // epoch-ms 1000 (1970) is earlier than the ISO 2024 timestamp; lexical
    // string compare would order them backwards.
    const path = writeOtlp('mixed.jsonl', [
      { trace_id: 't2', span_id: 'a', start_time: '2024-01-01T00:00:00.000Z', end_time: '2024-01-01T00:00:01.000Z' },
      { trace_id: 't2', span_id: 'b', start_time: '1000', end_time: '2000' },
    ])
    const store = new OtlpFileTraceStore({ path })
    const ov = await store.getOverview()
    expect(ov.time_range?.earliest).toBe('1000')
    expect(ov.time_range?.latest).toBe('2024-01-01T00:00:01.000Z')
  })

  it('computes a correct positive duration for a normal ISO trace', async () => {
    const path = writeOtlp('normal.jsonl', [
      { trace_id: 't3', span_id: 'a', start_time: '2024-01-01T00:00:00.000Z', end_time: '2024-01-01T00:00:05.000Z' },
    ])
    const store = new OtlpFileTraceStore({ path })
    const page = await store.queryTraces({ limit: 10 })
    expect(page.traces[0]!.duration_ms).toBe(5000)
  })
})
