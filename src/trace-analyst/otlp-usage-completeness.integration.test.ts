import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { otlpRowsToRunRecords, otlpToRunRecords } from '../traces'

const directories: string[] = []
const options = { experimentId: 'usage-coverage', candidateId: 'captured-run' }
const model = { 'gen_ai.request.model': 'coverage-proof@immutable' }

function span(id: string, attributes: Record<string, unknown>, parent?: string) {
  return {
    trace_id: '00000000000000000000000000000001',
    span_id: id,
    parent_span_id: parent,
    name: id,
    start_time: '2026-10-25T10:00:00.000Z',
    end_time: '2026-10-25T10:00:00.010Z',
    status: { code: 'OK' },
    attributes,
  }
}

const measured = {
  'openinference.span.kind': 'LLM',
  ...model,
  'gen_ai.usage.input_tokens': 100,
  'gen_ai.usage.output_tokens': 10,
}
const failed = {
  ...span('failed-call', {
    'openinference.span.kind': 'LLM',
    'tangle.supervise.tokens_known': false,
    'tangle.supervise.cost_known': false,
  }),
  status: { code: 'ERROR', message: 'provider disconnected before reporting usage' },
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })))
})

describe('captured OTLP usage through public run-record readers', () => {
  it('retains a failed unknown call and labels a serialized run subtotal as incomplete', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'otlp-usage-coverage-'))
    directories.push(directory)
    const file = join(directory, 'traces.jsonl')
    await writeFile(file, `${JSON.stringify(failed)}\n`)
    const [unknown] = otlpToRunRecords(await readFile(file, 'utf8'), options)
    expect(unknown?.tokenUsage).toEqual({ input: 0, output: 0, tokensKnown: false })
    expect(unknown?.outcome.raw).toMatchObject({ llm_span_count: 1, error_span_count: 1 })
    expect(unknown?.costUsd).toBeNull()

    await writeFile(
      file,
      [span('known-call', measured), failed].map((row) => JSON.stringify(row)).join('\n'),
    )
    const [partial] = otlpToRunRecords(await readFile(file, 'utf8'), options)
    expect(partial?.tokenUsage).toEqual({ input: 100, output: 10, tokensKnown: false })
    expect(partial?.outcome.raw).toMatchObject({ llm_span_count: 2, error_span_count: 1 })
    expect(partial?.costUsd).toBeNull()
  })

  it('distinguishes explicit zero from missing input or output on a model call', () => {
    for (const attributes of [
      { 'gen_ai.usage.output_tokens': 0 },
      { 'gen_ai.usage.input_tokens': 0 },
    ]) {
      const [unknown] = otlpRowsToRunRecords(
        [span('partial-zero', { 'openinference.span.kind': 'LLM', ...model, ...attributes })],
        options,
      )
      expect(unknown?.tokenUsage).toEqual({ input: 0, output: 0, tokensKnown: false })
    }
    const [zero] = otlpRowsToRunRecords(
      [
        span('measured-zero', {
          ...measured,
          'gen_ai.usage.input_tokens': 0,
          'gen_ai.usage.output_tokens': 0,
        }),
      ],
      options,
    )
    expect(zero?.tokenUsage).toEqual({ input: 0, output: 0 })
  })

  it('labels reasoning-only output as a subtotal rather than a complete output measurement', () => {
    const [partial] = otlpRowsToRunRecords(
      [
        span('reasoning-only', {
          'openinference.span.kind': 'LLM',
          ...model,
          'gen_ai.usage.input_tokens': 100,
          'gen_ai.usage.reasoning.output_tokens': 3,
        }),
      ],
      options,
    )
    expect(partial?.tokenUsage).toEqual({ input: 100, output: 3, reasoning: 3, tokensKnown: false })
  })

  it('preserves canonical totals, cache absence versus zero, and reasoning as an output subset', () => {
    const [known] = otlpRowsToRunRecords(
      [
        span('canonical-call', {
          ...measured,
          'llm.token_count.prompt': 75,
          'gen_ai.usage.cache_read.input_tokens': 20,
          'gen_ai.usage.cache_creation.input_tokens': 5,
          'gen_ai.usage.reasoning.output_tokens': 3,
        }),
      ],
      options,
    )
    expect(known?.tokenUsage).toEqual({
      input: 100,
      output: 10,
      cached: 20,
      cacheWrite: 5,
      reasoning: 3,
    })
    const [absent] = otlpRowsToRunRecords([span('cache-unreported', measured)], options)
    expect(absent?.tokenUsage).toEqual({ input: 100, output: 10 })
    const [zero] = otlpRowsToRunRecords(
      [
        span('cache-zero', {
          ...measured,
          'gen_ai.usage.cache_read.input_tokens': 0,
          'gen_ai.usage.cache_creation.input_tokens': 0,
        }),
      ],
      options,
    )
    expect(zero?.tokenUsage).toEqual({ input: 100, output: 10, cached: 0, cacheWrite: 0 })
  })

  it('keeps an explicitly unknown call incomplete when a parent aggregate supplies numbers', () => {
    const root = span('agent', { ...measured, 'openinference.span.kind': 'AGENT' })
    const [partial] = otlpRowsToRunRecords([root, { ...failed, parent_span_id: 'agent' }], options)
    expect(partial?.tokenUsage).toEqual({ input: 100, output: 10, tokensKnown: false })
    expect(partial?.outcome.raw).toMatchObject({ llm_span_count: 1, agent_span_count: 1 })
  })

  it('does not taint complete child usage with an unmeasured parent or count its aggregate twice', () => {
    const [known] = otlpRowsToRunRecords(
      [
        span('agent', {
          'openinference.span.kind': 'AGENT',
          'tangle.supervise.tokens_known': false,
        }),
        span(
          'call-a',
          { ...measured, 'gen_ai.usage.input_tokens': 60, 'gen_ai.usage.output_tokens': 6 },
          'agent',
        ),
        span(
          'call-b',
          { ...measured, 'gen_ai.usage.input_tokens': 40, 'gen_ai.usage.output_tokens': 4 },
          'agent',
        ),
      ],
      options,
    )
    expect(known?.tokenUsage).toEqual({ input: 100, output: 10 })
    expect(known?.outcome.raw).toMatchObject({ llm_span_count: 2, agent_span_count: 1 })
  })
})
