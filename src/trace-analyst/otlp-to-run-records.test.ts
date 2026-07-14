import { describe, expect, it } from 'vitest'
import { isRunRecord, type RunRecord, validateRunRecord } from '../run-record'
import {
  otlpRowsToRunRecords,
  otlpToRunRecords,
  otlpToTraceRunRecords,
} from './otlp-to-run-records'

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
      cache_read_tokens: 1000,
      cache_creation_tokens: 200,
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
    expect(clean.tokenUsage).toEqual({
      input: 735,
      output: 56,
      cached: 1000,
      cacheWrite: 200,
    })
    expect(clean.outcome.raw.prompt_tokens).toBe(735)
    expect(clean.outcome.raw.completion_tokens).toBe(56)
    expect(clean.outcome.raw.cached_tokens).toBe(1000)
    expect(clean.outcome.raw.cache_write_tokens).toBe(200)
    expect(clean.outcome.raw.llm_span_count).toBe(2)
    expect(clean.outcome.raw.tool_span_count).toBe(1)
    expect(clean.outcome.raw.agent_span_count).toBe(1)
    expect(clean.outcome.raw.span_count).toBe(4)
  })

  it('sums per-span LLM cost when present, and prices nothing it cannot see', () => {
    const [clean, error] = twoRecords(otlpToRunRecords(FIXTURE, baseOpts))
    // clean: 0.0012 + 0.0018 from the two LLM cost attributes.
    expect(clean.costUsd).toBeCloseTo(0.003, 6)
    expect(clean.costProvenance).toEqual({ kind: 'observed', usd: 0.003 })
    expect(clean.outcome.raw.cost_unpriced).toBeUndefined()
    // error trace: no cost attribute anywhere → 0 BUT flagged loudly.
    expect(error.costUsd).toBe(0)
    expect(error.costProvenance).toEqual({ kind: 'uncaptured', usd: null })
    expect(error.outcome.raw.cost_unpriced).toBe(1)
  })

  it('reconciles nested aggregate wrappers without duplicating tokens or cost', () => {
    const nested = [
      spanLine({
        trace_id: 'nested-trace',
        span_id: 'nested-trace:root',
        parent_span_id: '',
        name: 'agent.run',
        start_time: '2026-04-23T05:32:00.000Z',
        end_time: '2026-04-23T05:32:04.000Z',
        attributes: {
          'openinference.span.kind': 'AGENT',
          'gen_ai.usage.input_tokens': 9999,
          'gen_ai.usage.output_tokens': 9999,
          'tangle.cost.usd': 0.5,
        },
      }),
      spanLine({
        trace_id: 'nested-trace',
        span_id: 'nested-trace:call-1',
        parent_span_id: 'root',
        name: 'provider.request',
        start_time: '2026-04-23T05:32:01.000Z',
        end_time: '2026-04-23T05:32:02.000Z',
        attributes: {
          'openinference.span.kind': 'LLM',
          'gen_ai.request.model': 'claude-opus-4-8@2026-07-01',
          'gen_ai.usage.input_tokens': 10,
          'gen_ai.usage.output_tokens': 2,
          'tangle.cost.usd': 0.1,
        },
      }),
      spanLine({
        trace_id: 'nested-trace',
        span_id: 'nested-trace:call-2',
        parent_span_id: 'root',
        name: 'provider.request',
        start_time: '2026-04-23T05:32:02.000Z',
        end_time: '2026-04-23T05:32:03.000Z',
        attributes: {
          'openinference.span.kind': 'LLM',
          'gen_ai.request.model': 'claude-opus-4-8@2026-07-01',
          'gen_ai.usage.input_tokens': 20,
          'gen_ai.usage.output_tokens': 3,
        },
      }),
    ].join('\n')

    const run = otlpToRunRecords(nested, baseOpts)[0]!

    expect(run.tokenUsage).toEqual({ input: 30, output: 5 })
    expect(run.costProvenance).toEqual({ kind: 'observed', usd: 0.5 })
    expect(run.outcome.raw.llm_span_count).toBe(2)
    expect(run.outcome.raw.aggregate_prompt_tokens).toBe(9999)
    expect(run.outcome.raw.aggregate_completion_tokens).toBe(9999)
    expect(run.outcome.raw.aggregate_cost_usd).toBe(0.5)
  })

  it('keeps genuine nested model calls when their measurements differ', () => {
    const nestedCalls = [
      spanLine({
        trace_id: 'nested-calls',
        span_id: 'nested-calls:outer',
        parent_span_id: '',
        name: 'outer.request',
        start_time: '2026-04-23T05:32:00.000Z',
        end_time: '2026-04-23T05:32:03.000Z',
        attributes: {
          'openinference.span.kind': 'LLM',
          'gen_ai.usage.input_tokens': 10,
          'gen_ai.usage.output_tokens': 2,
        },
      }),
      spanLine({
        trace_id: 'nested-calls',
        span_id: 'nested-calls:inner',
        parent_span_id: 'outer',
        name: 'inner.request',
        start_time: '2026-04-23T05:32:01.000Z',
        end_time: '2026-04-23T05:32:02.000Z',
        attributes: {
          'openinference.span.kind': 'LLM',
          'gen_ai.usage.input_tokens': 20,
          'gen_ai.usage.output_tokens': 3,
        },
      }),
    ].join('\n')

    const run = otlpToRunRecords(nestedCalls, baseOpts)[0]!

    expect(run.tokenUsage).toEqual({ input: 30, output: 5 })
    expect(run.outcome.raw.llm_span_count).toBe(2)
    expect(run.outcome.raw.aggregate_prompt_tokens).toBeUndefined()
  })

  it('reconciles complementary nested LLM wrappers as one model call', () => {
    const complementaryWrapper = [
      spanLine({
        trace_id: 'complementary-wrapper',
        span_id: 'complementary-wrapper:outer',
        parent_span_id: '',
        name: 'instrumented.request',
        start_time: '2026-04-23T05:32:00.000Z',
        end_time: '2026-04-23T05:32:02.000Z',
        attributes: {
          'openinference.span.kind': 'LLM',
          'gen_ai.usage.input_tokens': 50,
          'gen_ai.usage.output_tokens': 8,
        },
      }),
      spanLine({
        trace_id: 'complementary-wrapper',
        span_id: 'complementary-wrapper:provider',
        parent_span_id: 'outer',
        name: 'provider.request',
        start_time: '2026-04-23T05:32:01.000Z',
        end_time: '2026-04-23T05:32:02.000Z',
        attributes: {
          'openinference.span.kind': 'LLM',
          'gen_ai.request.model': 'claude-opus-4-8@2026-07-01',
          cache_read_tokens: 400,
          cache_creation_tokens: 20,
          'tangle.cost.usd': 0.04,
        },
      }),
    ].join('\n')

    const run = otlpToRunRecords(complementaryWrapper, baseOpts)[0]!

    expect(run.tokenUsage).toEqual({
      input: 50,
      output: 8,
      cached: 400,
      cacheWrite: 20,
    })
    expect(run.costProvenance).toEqual({ kind: 'observed', usd: 0.04 })
    expect(run.outcome.raw.llm_span_count).toBe(1)
    expect(run.outcome.raw.aggregate_prompt_tokens).toBe(50)
    expect(run.outcome.raw.aggregate_completion_tokens).toBe(8)
  })

  it('collapses an exact duplicate model wrapper into separately labeled aggregate usage', () => {
    const duplicateWrapper = [
      spanLine({
        trace_id: 'duplicate-wrapper',
        span_id: 'duplicate-wrapper:outer',
        parent_span_id: '',
        name: 'wrapped.request',
        start_time: '2026-04-23T05:32:00.000Z',
        end_time: '2026-04-23T05:32:03.000Z',
        attributes: {
          'openinference.span.kind': 'LLM',
          'gen_ai.usage.input_tokens': 30,
          'gen_ai.usage.output_tokens': 5,
          'tangle.cost.usd': 0.3,
        },
      }),
      spanLine({
        trace_id: 'duplicate-wrapper',
        span_id: 'duplicate-wrapper:call-1',
        parent_span_id: 'outer',
        name: 'provider.request',
        start_time: '2026-04-23T05:32:01.000Z',
        end_time: '2026-04-23T05:32:02.000Z',
        attributes: {
          'openinference.span.kind': 'LLM',
          'gen_ai.usage.input_tokens': 10,
          'gen_ai.usage.output_tokens': 2,
          'tangle.cost.usd': 0.1,
        },
      }),
      spanLine({
        trace_id: 'duplicate-wrapper',
        span_id: 'duplicate-wrapper:call-2',
        parent_span_id: 'outer',
        name: 'provider.request',
        start_time: '2026-04-23T05:32:02.000Z',
        end_time: '2026-04-23T05:32:03.000Z',
        attributes: {
          'openinference.span.kind': 'LLM',
          'gen_ai.usage.input_tokens': 20,
          'gen_ai.usage.output_tokens': 3,
        },
      }),
    ].join('\n')

    const run = otlpToRunRecords(duplicateWrapper, baseOpts)[0]!

    expect(run.tokenUsage).toEqual({ input: 30, output: 5 })
    expect(run.outcome.raw.llm_span_count).toBe(2)
    expect(run.outcome.raw.aggregate_prompt_tokens).toBe(30)
    expect(run.outcome.raw.aggregate_completion_tokens).toBe(5)
    expect(run.outcome.raw.aggregate_cost_usd).toBeCloseTo(0.3)
    expect(run.costProvenance).toEqual({ kind: 'observed', usd: 0.3 })
  })

  it('reconciles a wrapper against all retained model calls below nested calls', () => {
    const deepWrapper = [
      spanLine({
        trace_id: 'deep-wrapper',
        span_id: 'deep-wrapper:root',
        parent_span_id: '',
        name: 'wrapped.request',
        start_time: '2026-04-23T05:32:00.000Z',
        end_time: '2026-04-23T05:32:04.000Z',
        attributes: {
          'openinference.span.kind': 'LLM',
          'gen_ai.usage.input_tokens': 30,
          'gen_ai.usage.output_tokens': 5,
        },
      }),
      spanLine({
        trace_id: 'deep-wrapper',
        span_id: 'deep-wrapper:outer',
        parent_span_id: 'root',
        name: 'outer.request',
        start_time: '2026-04-23T05:32:01.000Z',
        end_time: '2026-04-23T05:32:03.000Z',
        attributes: {
          'openinference.span.kind': 'LLM',
          'gen_ai.usage.input_tokens': 10,
          'gen_ai.usage.output_tokens': 2,
        },
      }),
      spanLine({
        trace_id: 'deep-wrapper',
        span_id: 'deep-wrapper:inner',
        parent_span_id: 'outer',
        name: 'inner.request',
        start_time: '2026-04-23T05:32:02.000Z',
        end_time: '2026-04-23T05:32:03.000Z',
        attributes: {
          'openinference.span.kind': 'LLM',
          'gen_ai.usage.input_tokens': 20,
          'gen_ai.usage.output_tokens': 3,
        },
      }),
    ].join('\n')

    const run = otlpToRunRecords(deepWrapper, baseOpts)[0]!

    expect(run.tokenUsage).toEqual({ input: 30, output: 5 })
    expect(run.outcome.raw.llm_span_count).toBe(2)
    expect(run.outcome.raw.aggregate_prompt_tokens).toBe(30)
    expect(run.outcome.raw.aggregate_completion_tokens).toBe(5)
  })

  it('does not infer a model call from an unrelated generic cost attribute', () => {
    const businessCost = [
      spanLine({
        trace_id: 'business-cost',
        span_id: 'business-cost:task',
        parent_span_id: '',
        name: 'invoice.process',
        start_time: '2026-04-23T05:32:00.000Z',
        end_time: '2026-04-23T05:32:02.000Z',
        attributes: {
          cost: 7,
        },
      }),
      spanLine({
        trace_id: 'business-cost',
        span_id: 'business-cost:model',
        parent_span_id: 'task',
        name: 'provider.request',
        start_time: '2026-04-23T05:32:01.000Z',
        end_time: '2026-04-23T05:32:02.000Z',
        attributes: {
          'openinference.span.kind': 'LLM',
          'gen_ai.usage.input_tokens': 10,
          'gen_ai.usage.output_tokens': 2,
        },
      }),
    ].join('\n')

    const run = otlpToRunRecords(businessCost, baseOpts)[0]!

    expect(run.tokenUsage).toEqual({ input: 10, output: 2 })
    expect(run.outcome.raw.llm_span_count).toBe(1)
    expect(run.costProvenance).toEqual({ kind: 'uncaptured', usd: null })
    expect(run.outcome.raw.aggregate_cost_usd).toBeUndefined()
  })

  it('preserves an explicit run-total cost without inventing a model call', () => {
    const runCost = spanLine({
      trace_id: 'run-cost',
      span_id: 'run-cost:workflow',
      parent_span_id: '',
      name: 'workflow.run',
      start_time: '2026-04-23T05:32:00.000Z',
      end_time: '2026-04-23T05:32:02.000Z',
      attributes: { 'cost.usd': 0.25 },
    })

    const run = otlpToRunRecords(runCost, baseOpts)[0]!

    expect(run.costProvenance).toEqual({ kind: 'observed', usd: 0.25 })
    expect(run.outcome.raw.llm_span_count).toBe(0)
    expect(run.outcome.raw.aggregate_cost_usd).toBe(0.25)
  })

  it('keeps aggregate-only orchestration usage separate from model-call totals', () => {
    const orchestration = spanLine({
      trace_id: 'orchestration-trace',
      span_id: 'orchestration-trace:root',
      parent_span_id: '',
      name: 'orchestrator.run',
      start_time: '2026-04-23T05:32:00.000Z',
      end_time: '2026-04-23T05:32:04.000Z',
      attributes: {
        'openinference.span.kind': 'CHAIN',
        'gen_ai.usage.input_tokens': 50,
        'gen_ai.usage.output_tokens': 500,
      },
    })

    const run = otlpToRunRecords(orchestration, baseOpts)[0]!

    expect(run.tokenUsage).toEqual({ input: 0, output: 0 })
    expect(run.outcome.raw.llm_span_count).toBe(0)
    expect(run.outcome.raw.aggregate_prompt_tokens).toBe(50)
    expect(run.outcome.raw.aggregate_completion_tokens).toBe(500)
  })

  it('preserves nested provider cache and reasoning details without inflating output', () => {
    const providerDetails = spanLine({
      trace_id: 'provider-details',
      span_id: 'provider-details:call',
      parent_span_id: '',
      name: 'provider.request',
      start_time: '2026-04-23T05:32:00.000Z',
      end_time: '2026-04-23T05:32:01.000Z',
      attributes: {
        'openinference.span.kind': 'LLM',
        'gen_ai.usage.input_tokens': 100,
        'gen_ai.usage.output_tokens': 50,
        'gen_ai.usage.input_tokens_details.cached_tokens': 80,
        'gen_ai.usage.output_tokens_details.reasoning_tokens': 30,
      },
    })

    const run = otlpToRunRecords(providerDetails, baseOpts)[0]!

    expect(run.tokenUsage).toEqual({ input: 100, output: 50, reasoning: 30, cached: 80 })
    expect(run.outcome.raw.reasoning_tokens).toBe(30)
  })

  it('round-trips canonical reasoning as a subset of output', () => {
    const canonical = spanLine({
      trace_id: 'canonical-reasoning',
      span_id: 'canonical-reasoning:call',
      parent_span_id: '',
      name: 'provider.request',
      start_time: '2026-04-23T05:32:00.000Z',
      end_time: '2026-04-23T05:32:01.000Z',
      attributes: {
        'openinference.span.kind': 'LLM',
        'llm.token_count.prompt': 100,
        'llm.token_count.completion': 50,
        'llm.token_count.reasoning': 30,
      },
    })

    expect(otlpToRunRecords(canonical, baseOpts)[0]!.tokenUsage).toEqual({
      input: 100,
      output: 50,
      reasoning: 30,
    })
  })

  it('counts reasoning-only output for calls with partial output coverage', () => {
    const partialOutput = [
      spanLine({
        trace_id: 'partial-output',
        span_id: 'partial-output:visible',
        parent_span_id: '',
        name: 'provider.request',
        start_time: '2026-04-23T05:32:00.000Z',
        end_time: '2026-04-23T05:32:01.000Z',
        attributes: {
          'openinference.span.kind': 'LLM',
          'gen_ai.usage.output_tokens': 5,
        },
      }),
      spanLine({
        trace_id: 'partial-output',
        span_id: 'partial-output:reasoning-only',
        parent_span_id: '',
        name: 'provider.request',
        start_time: '2026-04-23T05:32:01.000Z',
        end_time: '2026-04-23T05:32:02.000Z',
        attributes: {
          'openinference.span.kind': 'LLM',
          'gen_ai.usage.reasoning_output_tokens': 7,
        },
      }),
    ].join('\n')

    const run = otlpToRunRecords(partialOutput, baseOpts)[0]!

    expect(run.tokenUsage).toEqual({ input: 0, output: 12, reasoning: 7 })
    expect(run.outcome.raw.llm_span_count).toBe(2)
  })

  it('does not label a partial model-call cost total as complete', () => {
    const partial = [
      spanLine({
        trace_id: 'partial-trace',
        span_id: 'call-1',
        parent_span_id: '',
        name: 'provider.request',
        start_time: '2026-04-23T05:32:01.000Z',
        end_time: '2026-04-23T05:32:02.000Z',
        attributes: {
          'openinference.span.kind': 'LLM',
          'gen_ai.usage.input_tokens': 10,
          'tangle.cost.usd': 0.1,
        },
      }),
      spanLine({
        trace_id: 'partial-trace',
        span_id: 'call-2',
        parent_span_id: '',
        name: 'provider.request',
        start_time: '2026-04-23T05:32:02.000Z',
        end_time: '2026-04-23T05:32:03.000Z',
        attributes: {
          'openinference.span.kind': 'LLM',
          'gen_ai.usage.input_tokens': 20,
        },
      }),
    ].join('\n')

    const run = otlpToRunRecords(partial, baseOpts)[0]!

    expect(run.costProvenance).toEqual({ kind: 'uncaptured', usd: null })
    expect(run.outcome.raw.partial_observed_cost_usd).toBe(0.1)
  })

  it('prices an unpriced trace from priceUsdPerToken when supplied', () => {
    const [, error] = twoRecords(
      otlpToRunRecords(FIXTURE, { ...baseOpts, priceUsdPerToken: 0.000002 }),
    )
    // (300 + 18) tokens * 0.000002 = 0.000636
    expect(error.costUsd).toBeCloseTo(0.000636, 9)
    expect(error.costProvenance).toEqual({ kind: 'estimated', usd: 0.000636 })
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

  it('produces identical records from parsed rows without a JSONL round trip', () => {
    const rows = FIXTURE.split('\n').map((line) => JSON.parse(line) as Record<string, unknown>)
    expect(otlpRowsToRunRecords(rows, baseOpts)).toEqual(otlpToRunRecords(FIXTURE, baseOpts))
  })

  it('fails loudly when parsed rows contain no valid spans', () => {
    expect(() => otlpRowsToRunRecords([], baseOpts)).toThrow(/zero valid spans/)
    expect(() => otlpRowsToRunRecords([{}], baseOpts)).toThrow(/zero valid spans/)
  })

  it('rejects duplicate span identities instead of corrupting accounting', () => {
    const line = spanLine({
      trace_id: 'duplicate-id',
      span_id: 'duplicate-id:call',
      parent_span_id: '',
      name: 'provider.request',
      start_time: '2026-04-23T05:32:00.000Z',
      end_time: '2026-04-23T05:32:01.000Z',
      attributes: {
        'openinference.span.kind': 'LLM',
        'gen_ai.usage.input_tokens': 10,
      },
    })

    expect(() => otlpToRunRecords(`${line}\n${line}`, baseOpts)).toThrow(/duplicate span id/)
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
