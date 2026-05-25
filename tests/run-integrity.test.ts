import { describe, expect, it } from 'vitest'
import { TraceEmitter } from '../src/trace/emitter'
import { assertRunCaptured, RunIntegrityError, throwIfRunIncomplete } from '../src/trace/integrity'
import { InMemoryRawProviderSink } from '../src/trace/raw-provider-sink'
import { InMemoryTraceStore } from '../src/trace/store'

async function setupRun(
  opts: {
    llmSpans?: number
    judgeSpans?: number
    toolSpans?: number
    outcomePass?: boolean | null
  } = {},
) {
  const store = new InMemoryTraceStore()
  const emitter = new TraceEmitter(store)
  await emitter.startRun({ scenarioId: 'unit', layer: 'app-runtime' })
  for (let i = 0; i < (opts.llmSpans ?? 0); i++) {
    const handle = await emitter.llm({ name: 'llm', model: 'm', messages: [], output: '' })
    await handle.end()
  }
  for (let i = 0; i < (opts.judgeSpans ?? 0); i++) {
    await emitter.recordJudge({
      judgeId: 'j',
      targetSpanId: emitter.runId,
      dimension: 'd',
      score: 1,
      name: 'j',
    })
  }
  for (let i = 0; i < (opts.toolSpans ?? 0); i++) {
    const handle = await emitter.tool({ name: 't', toolName: 't' })
    await handle.end()
  }
  if (opts.outcomePass === null) {
    // skip endRun
  } else {
    await emitter.endRun({ pass: opts.outcomePass ?? true })
  }
  return { store, emitter, runId: emitter.runId }
}

describe('assertRunCaptured', () => {
  it('returns ok=true on a fully captured run', async () => {
    const { store, runId } = await setupRun({ llmSpans: 2, judgeSpans: 1 })
    const report = await assertRunCaptured(store, runId, { llmSpansMin: 1, judgeSpansMin: 1 })
    expect(report.ok).toBe(true)
    expect(report.llmSpanCount).toBe(2)
    expect(report.judgeSpanCount).toBe(1)
    expect(report.issues).toEqual([])
  })

  it('flags missing llm and judge spans with structured issue codes', async () => {
    const { store, runId } = await setupRun({ llmSpans: 0, judgeSpans: 0 })
    const report = await assertRunCaptured(store, runId, { llmSpansMin: 1, judgeSpansMin: 2 })
    expect(report.ok).toBe(false)
    expect(report.issues.map((i) => i.code).sort()).toEqual([
      'missing_judge_spans',
      'missing_llm_spans',
    ])
  })

  it('flags missing raw events when sink is empty', async () => {
    const { store, runId } = await setupRun({ llmSpans: 1 })
    const sink = new InMemoryRawProviderSink()
    const report = await assertRunCaptured(store, runId, { rawSink: sink, rawProviderEventsMin: 1 })
    expect(report.ok).toBe(false)
    expect(report.issues[0]?.code).toBe('missing_raw_events')
  })

  it('flags orphan llm spans when raw coverage is required', async () => {
    const { store, runId, emitter } = await setupRun({ llmSpans: 2 })
    const sink = new InMemoryRawProviderSink()
    // Only one of the two LLM spans gets a raw request event.
    const spans = await store.spans({ runId, kind: 'llm' })
    await sink.record({
      eventId: 'r1',
      runId,
      spanId: spans[0]!.spanId,
      provider: 'p',
      model: 'm',
      endpoint: '/x',
      baseUrl: 'https://x',
      attemptIndex: 0,
      direction: 'request',
      timestamp: Date.now(),
      redactedFields: [],
    })
    const report = await assertRunCaptured(store, runId, {
      rawSink: sink,
      requireRawCoverageOfLlmSpans: true,
    })
    expect(report.ok).toBe(false)
    expect(report.issues.map((i) => i.code)).toContain('orphan_llm_span')
    expect(report.rawSpanCoverage).toEqual({ covered: 1, total: 2 })
    expect(emitter.runId).toBe(runId)
  })

  it('flags missing outcome when requireOutcome is set', async () => {
    const { store, runId } = await setupRun({ outcomePass: null })
    const report = await assertRunCaptured(store, runId, { requireOutcome: true })
    expect(report.ok).toBe(false)
    expect(report.issues[0]?.code).toBe('missing_outcome')
  })

  it('returns no_run when the runId is not present', async () => {
    const store = new InMemoryTraceStore()
    const report = await assertRunCaptured(store, 'missing')
    expect(report.ok).toBe(false)
    expect(report.issues[0]?.code).toBe('no_run')
  })

  it('throwIfRunIncomplete throws RunIntegrityError when not ok', async () => {
    const { store, runId } = await setupRun()
    const report = await assertRunCaptured(store, runId, { llmSpansMin: 5 })
    expect(() => throwIfRunIncomplete(report)).toThrow(RunIntegrityError)
  })
})
