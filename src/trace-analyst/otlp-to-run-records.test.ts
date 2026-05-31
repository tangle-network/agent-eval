import { describe, expect, it } from 'vitest'
import { isRunRecord, type RunRecord, validateRunRecord } from '../run-record'
import { otlpToRunRecords, otlpToTraceRunRecords } from './otlp-to-run-records'

/** Destructure the two-record result with a present-assertion so the strict
 *  `noUncheckedIndexedAccess` compiler doesn't widen each to `T | undefined`. */
function twoRecords(records: RunRecord[]): [RunRecord, RunRecord] {
  expect(records).toHaveLength(2)
  return [records[0]!, records[1]!]
}

/**
 * Fixture grounded in the REAL AppWorld / HALO OpenInference OTLP wire shape
 * (verified against /tmp/halo-repo/tests/fixtures/*.jsonl): one OTLP span per
 * line, span.kind in `openinference.span.kind`, LLM tokens in both the
 * inference-export vocab (`inference.llm.input_tokens`) and the OpenInference
 * vocab (`llm.token_count.prompt`), tool I/O in `input.value`/`output.value`,
 * and a `STATUS_CODE_ERROR` non-fatal tool failure.
 *
 * Two traces == two AppWorld tasks:
 *   - task-clean : AGENT + 2 LLM + 1 TOOL, all OK.
 *   - task-error : AGENT + 1 LLM + 1 TOOL, the TOOL span errors.
 */
function spanLine(o: Record<string, unknown>): string {
  return JSON.stringify(o)
}

const TASK_CLEAN = 'tr-appworld-clean-0001'
const TASK_ERROR = 'tr-appworld-error-0002'

const FIXTURE = [
  // ── task-clean: 1 AGENT, 2 LLM, 1 TOOL, no errors ──────────────────
  spanLine({
    trace_id: TASK_CLEAN,
    span_id: 's-clean-agent',
    parent_span_id: '',
    name: 'AppWorld task',
    start_time: '2026-04-23T05:32:00.000000000Z',
    end_time: '2026-04-23T05:32:09.000000000Z',
    status: { code: 'STATUS_CODE_OK', message: '' },
    resource: { attributes: { 'service.name': 'appworld-agent' } },
    attributes: { 'openinference.span.kind': 'AGENT', 'inference.agent_name': 'react' },
  }),
  spanLine({
    trace_id: TASK_CLEAN,
    span_id: 's-clean-llm-1',
    parent_span_id: 's-clean-agent',
    name: 'chat.completions',
    start_time: '2026-04-23T05:32:01.000000000Z',
    end_time: '2026-04-23T05:32:03.000000000Z',
    status: { code: 'STATUS_CODE_OK', message: '' },
    attributes: {
      'openinference.span.kind': 'LLM',
      'llm.provider': 'openai',
      'inference.llm.model_name': 'gpt-4o-mini-2024-07-18',
      'inference.llm.input_tokens': 325,
      'inference.llm.output_tokens': 21,
      'llm.token_count.prompt': 325,
      'llm.token_count.completion': 21,
      'inference.llm.cost.total': 0.0012,
      'input.value': 'You are an AppWorld agent. Pay my Venmo balance.',
    },
  }),
  spanLine({
    trace_id: TASK_CLEAN,
    span_id: 's-clean-tool',
    parent_span_id: 's-clean-agent',
    name: 'function.execute',
    start_time: '2026-04-23T05:32:03.500000000Z',
    end_time: '2026-04-23T05:32:04.000000000Z',
    status: { code: 'STATUS_CODE_OK', message: '' },
    attributes: {
      'openinference.span.kind': 'TOOL',
      'tool.name': 'apis.venmo.pay',
      'input.value': '{"amount": 20}',
      'output.value': '{"ok": true}',
    },
  }),
  spanLine({
    trace_id: TASK_CLEAN,
    span_id: 's-clean-llm-2',
    parent_span_id: 's-clean-agent',
    name: 'chat.completions',
    start_time: '2026-04-23T05:32:05.000000000Z',
    end_time: '2026-04-23T05:32:08.000000000Z',
    status: { code: 'STATUS_CODE_OK', message: '' },
    attributes: {
      'openinference.span.kind': 'LLM',
      'inference.llm.model_name': 'gpt-4o-mini-2024-07-18',
      'inference.llm.input_tokens': 410,
      'inference.llm.output_tokens': 35,
      'inference.llm.cost.total': 0.0018,
      'output.value': 'apis.venmo.pay(amount=20)  # task complete',
    },
  }),
  // ── task-error: 1 AGENT, 1 LLM, 1 TOOL (errors) ───────────────────
  spanLine({
    trace_id: TASK_ERROR,
    span_id: 's-err-agent',
    parent_span_id: '',
    name: 'AppWorld task',
    start_time: '2026-04-23T06:00:00.000000000Z',
    end_time: '2026-04-23T06:00:05.000000000Z',
    status: { code: 'STATUS_CODE_OK', message: '' },
    resource: { attributes: { 'service.name': 'appworld-agent' } },
    attributes: { 'openinference.span.kind': 'AGENT', 'inference.agent_name': 'react' },
  }),
  spanLine({
    trace_id: TASK_ERROR,
    span_id: 's-err-llm',
    parent_span_id: 's-err-agent',
    name: 'chat.completions',
    start_time: '2026-04-23T06:00:01.000000000Z',
    end_time: '2026-04-23T06:00:02.000000000Z',
    status: { code: 'STATUS_CODE_OK', message: '' },
    attributes: {
      'openinference.span.kind': 'LLM',
      'inference.llm.model_name': 'gpt-4o-mini-2024-07-18',
      'inference.llm.input_tokens': 300,
      'inference.llm.output_tokens': 18,
      // no cost attribute on this span — exercises the unpriced path
      'input.value': 'List the files in tools/',
    },
  }),
  spanLine({
    trace_id: TASK_ERROR,
    span_id: 's-err-tool',
    parent_span_id: 's-err-agent',
    name: 'function.list_files',
    start_time: '2026-04-23T06:00:02.500000000Z',
    end_time: '2026-04-23T06:00:03.000000000Z',
    status: {
      code: 'STATUS_CODE_ERROR',
      message: 'Error running tool (non-fatal): No such file or directory',
    },
    attributes: {
      'openinference.span.kind': 'TOOL',
      'tool.name': 'apis.file_system.list_files',
      'input.value': '{"subdir": "tools"}',
    },
  }),
].join('\n')

const baseOpts = {
  experimentId: 'appworld-bench',
  candidateId: 'gepa',
  commitSha: 'abc1234',
  promptHash: 'p-deadbeef',
  configHash: 'c-cafef00d',
  seed: 7,
}

describe('otlpToRunRecords', () => {
  it('produces one validated RunRecord per trace_id with aggregated LLM tokens', () => {
    const records = otlpToRunRecords(FIXTURE, baseOpts)
    expect(records).toHaveLength(2)
    // Deterministic order: sorted by trace_id → clean before error.
    const [clean, error] = twoRecords(records)
    expect(clean.scenarioId).toBe(TASK_CLEAN)
    expect(error.scenarioId).toBe(TASK_ERROR)

    // Every produced row passes the strict validator (regression: a
    // half-built record or a bare-alias model would throw here).
    for (const r of records) expect(isRunRecord(r)).toBe(true)
    expect(() => records.map(validateRunRecord)).not.toThrow()

    // Identity / cell metadata is threaded through verbatim.
    expect(clean.experimentId).toBe('appworld-bench')
    expect(clean.candidateId).toBe('gepa')
    expect(clean.commitSha).toBe('abc1234')
    expect(clean.promptHash).toBe('p-deadbeef')
    expect(clean.configHash).toBe('c-cafef00d')
    expect(clean.seed).toBe(7)
    expect(clean.splitTag).toBe('holdout')
    expect(clean.runId).toBe(`otlp:appworld-bench:gepa:${TASK_CLEAN}`)
  })

  it('sums LLM-span tokens across the trace (input + output, both dialects)', () => {
    const clean = otlpToRunRecords(FIXTURE, baseOpts)[0]!
    // 325 + 410 input, 21 + 35 output across the two clean LLM spans.
    expect(clean.tokenUsage).toEqual({ input: 735, output: 56 })
    expect(clean.outcome.raw.prompt_tokens).toBe(735)
    expect(clean.outcome.raw.completion_tokens).toBe(56)
    expect(clean.outcome.raw.llm_span_count).toBe(2)
    expect(clean.outcome.raw.tool_span_count).toBe(1)
    expect(clean.outcome.raw.agent_span_count).toBe(1)
    expect(clean.outcome.raw.span_count).toBe(4)
  })

  it('sums per-span LLM cost when present, and prices nothing it cannot see', () => {
    const [clean, error] = twoRecords(otlpToRunRecords(FIXTURE, baseOpts))
    // clean: 0.0012 + 0.0018 from the two LLM cost attributes.
    expect(clean.costUsd).toBeCloseTo(0.003, 6)
    expect(clean.outcome.raw.cost_unpriced).toBeUndefined()
    // error trace: no cost attribute anywhere → 0 BUT flagged loudly.
    expect(error.costUsd).toBe(0)
    expect(error.outcome.raw.cost_unpriced).toBe(1)
  })

  it('prices an unpriced trace from priceUsdPerToken when supplied', () => {
    const [, error] = twoRecords(
      otlpToRunRecords(FIXTURE, { ...baseOpts, priceUsdPerToken: 0.000002 }),
    )
    // (300 + 18) tokens * 0.000002 = 0.000636
    expect(error.costUsd).toBeCloseTo(0.000636, 9)
    expect(error.outcome.raw.cost_unpriced).toBeUndefined()
  })

  it('maps STATUS_CODE_ERROR → failureMode and the error-derived default score', () => {
    const [clean, error] = twoRecords(otlpToRunRecords(FIXTURE, baseOpts))
    // No-error trace: failureMode unset, default holdout score 1.
    expect(clean.failureMode).toBeUndefined()
    expect(clean.outcome.holdoutScore).toBe(1)
    expect(clean.outcome.raw.error_span_count).toBe(0)
    // Error trace: failureMode carries the real status message; score 0.
    expect(error.failureMode).toBe('Error running tool (non-fatal): No such file or directory')
    expect(error.outcome.holdoutScore).toBe(0)
    expect(error.outcome.raw.error_span_count).toBe(1)
  })

  it('pads a bare-alias model to a snapshot the validator accepts', () => {
    const bare = FIXTURE.replaceAll('gpt-4o-mini-2024-07-18', 'gpt-4o-mini')
    const clean = otlpToRunRecords(bare, baseOpts)[0]!
    // bare alias → preserved base name + the fallback snapshot token.
    expect(clean.model).toBe('gpt-4o-mini@otlp')
    expect(isRunRecord(clean)).toBe(true)
  })

  it('keeps a model that already carries a snapshot verbatim', () => {
    const clean = otlpToRunRecords(FIXTURE, baseOpts)[0]!
    expect(clean.model).toBe('gpt-4o-mini-2024-07-18')
  })

  it('honors an explicit per-trace score (AppWorld world.evaluate → TGC/SGC)', () => {
    const records = otlpToRunRecords(FIXTURE, {
      ...baseOpts,
      splitTag: 'search',
      scoreForTrace: (traceId) => (traceId === TASK_CLEAN ? 0.8 : 0.0),
    })
    const [clean, error] = twoRecords(records)
    expect(clean.outcome.searchScore).toBe(0.8)
    expect(clean.outcome.holdoutScore).toBeUndefined()
    expect(error.outcome.searchScore).toBe(0.0)
    expect(clean.splitTag).toBe('search')
  })

  it('carries verbatim prompt/completion text on otlpToTraceRunRecords', () => {
    const rows = otlpToTraceRunRecords(FIXTURE, baseOpts)
    const clean = rows.find((r) => r.record.scenarioId === TASK_CLEAN)!
    // First LLM span input.value, last LLM span output.value.
    expect(clean.promptText).toBe('You are an AppWorld agent. Pay my Venmo balance.')
    expect(clean.completionText).toBe('apis.venmo.pay(amount=20)  # task complete')
  })

  it('computes wallMs from the span time-span of the trace', () => {
    const clean = otlpToRunRecords(FIXTURE, baseOpts)[0]!
    // 05:32:00 → 05:32:09 == 9000ms.
    expect(clean.wallMs).toBe(9000)
  })

  it('throws on zero valid spans (fail-loud, not a silent empty array)', () => {
    expect(() => otlpToRunRecords('', baseOpts)).toThrow(/zero valid spans/)
    expect(() => otlpToRunRecords('not json\n{bad', baseOpts)).toThrow(/zero valid spans/)
  })

  it('tolerates a stray malformed line among valid spans', () => {
    const withGarbage = `${'garbage not json'}\n${FIXTURE}\n\n`
    const records = otlpToRunRecords(withGarbage, baseOpts)
    expect(records).toHaveLength(2)
  })

  it('throws when scoreForTrace returns a non-finite score', () => {
    expect(() =>
      otlpToRunRecords(FIXTURE, { ...baseOpts, scoreForTrace: () => Number.NaN }),
    ).toThrow(/non-finite/)
  })

  it('attaches judge metadata when supplied per trace', () => {
    const clean = otlpToRunRecords(FIXTURE, {
      ...baseOpts,
      judgeMetadataForTrace: () => ({
        model: 'gpt-5-mini@2026-01-01',
        promptVersion: 'v1',
        confidence: 0.9,
        fallback: false,
      }),
    })[0]!
    expect(clean.judgeMetadata?.model).toBe('gpt-5-mini@2026-01-01')
    expect(clean.judgeMetadata?.confidence).toBe(0.9)
  })
})
