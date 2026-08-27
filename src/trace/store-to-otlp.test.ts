import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { convertTraceStoresToOtlp } from './store-to-otlp'

interface FlatSpan {
  trace_id: string
  span_id: string
  parent_span_id: string
  name: string
  kind: string
  status: { code: string; message: string }
  resource: { attributes: Record<string, unknown> }
  attributes: Record<string, unknown>
}

// Fixed timestamps — the converter is deterministic, so the test is too.
const RUN = {
  runId: 'run-1',
  scenarioId: 'scn-1',
  variantId: 'variant-a',
  status: 'completed',
  startedAt: 1_700_000_000_000,
  endedAt: 1_700_000_001_000,
  tags: { personaId: 'p1', complexity: 'high' },
  outcome: { pass: true, score: 0.9, failureClass: 'success' },
}
const LLM_SPAN = {
  spanId: 'span-1',
  runId: 'run-1',
  kind: 'llm',
  name: 'chat.completion',
  model: 'openai/gpt-4o-mini',
  startedAt: 1_700_000_000_100,
  endedAt: 1_700_000_000_500,
  status: 'ok',
  inputTokens: 120,
  outputTokens: 40,
  reasoningTokens: 15,
  cachedTokens: 300,
  cacheWriteTokens: 25,
  costUsd: 0.001,
}

function writeCell(root: string, cell: string): void {
  const dir = join(root, cell)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'runs.ndjson'), `${JSON.stringify(RUN)}\n`)
  writeFileSync(join(dir, 'spans.ndjson'), `${JSON.stringify(LLM_SPAN)}\n`)
}

describe('convertTraceStoresToOtlp', () => {
  let root: string
  let out: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'store-to-otlp-'))
    out = join(root, 'traces.otlp.jsonl')
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  function read(): FlatSpan[] {
    return readFileSync(out, 'utf8')
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as FlatSpan)
  }

  it('emits one run-anchor span + one span per cell, with counts', () => {
    writeCell(root, 'p1')
    const result = convertTraceStoresToOtlp(root, out)
    expect(result).toEqual({ spanCount: 1, runCount: 1, cellCount: 1, cellErrorCount: 0 })
    const lines = read()
    expect(lines).toHaveLength(2)
  })

  it('injects domain attributes via the opts mappers; always emits generic fields', () => {
    writeCell(root, 'p1')
    convertTraceStoresToOtlp(root, out, {
      serviceName: 'unit-svc',
      resourceAttributes: (run) => ({
        'test.persona_id': run.tags?.personaId ?? '',
        'test.complexity': run.tags?.complexity ?? '',
      }),
      runAttributes: (run) => ({ 'test.pass': run.outcome?.pass ?? false }),
    })
    const [anchor, span] = read()
    // generic resource fields always present
    expect(anchor!.resource.attributes['service.name']).toBe('unit-svc')
    expect(anchor!.resource.attributes['agent.name']).toBe('variant-a')
    expect(anchor!.resource.attributes['run.id']).toBe('run-1')
    // injected domain attributes ride along
    expect(anchor!.resource.attributes['test.persona_id']).toBe('p1')
    expect(anchor!.resource.attributes['test.complexity']).toBe('high')
    expect(anchor!.attributes['openinference.span.kind']).toBe('AGENT')
    expect(anchor!.attributes['test.pass']).toBe(true)
    // the LLM span projects model + token counts; parents to the run anchor
    expect(span!.attributes['openinference.span.kind']).toBe('LLM')
    expect(span!.attributes['llm.model_name']).toBe('openai/gpt-4o-mini')
    expect(span!.attributes['llm.token_count.prompt']).toBe(120)
    expect(span!.attributes['llm.token_count.prompt_cache_hit']).toBe(300)
    expect(span!.attributes['llm.token_count.prompt_cache_write']).toBe(25)
    expect(span!.attributes['tangle.llm.context_tokens']).toBe(445)
    expect(span!.attributes['llm.token_count.reasoning']).toBe(15)
    expect(span!.parent_span_id).toBe(anchor!.span_id)
    expect(span!.resource.attributes['test.persona_id']).toBe('p1')
  })

  it('defaults service.name to agent-eval and emits no domain attrs when no opts', () => {
    writeCell(root, 'p1')
    convertTraceStoresToOtlp(root, out)
    const [anchor] = read()
    expect(anchor!.resource.attributes['service.name']).toBe('agent-eval')
    expect(anchor!.resource.attributes['test.persona_id']).toBeUndefined()
  })

  it('preserves captured tool input and marks unavailable arguments', () => {
    writeCell(root, 'p1')
    const dir = join(root, 'p1')
    const tools = [
      {
        spanId: 'tool-captured',
        runId: 'run-1',
        kind: 'tool',
        name: 'search',
        toolName: 'search',
        args: { q: 'x' },
        startedAt: 1_700_000_000_100,
        endedAt: 1_700_000_000_200,
      },
      {
        spanId: 'tool-unknown',
        runId: 'run-1',
        kind: 'tool',
        name: 'search',
        toolName: 'search',
        argsCaptured: false,
        startedAt: 1_700_000_000_300,
        endedAt: 1_700_000_000_400,
      },
    ]
    writeFileSync(
      join(dir, 'spans.ndjson'),
      `${tools.map((span) => JSON.stringify(span)).join('\n')}\n`,
    )

    convertTraceStoresToOtlp(root, out)
    const [, captured, unknown] = read()

    expect(captured!.attributes['tool.args_captured']).toBe(true)
    expect(captured!.attributes['input.value']).toBe('{"q":"x"}')
    expect(unknown!.attributes['tool.args_captured']).toBe(false)
    expect(unknown!.attributes['input.value']).toBeUndefined()
  })

  it('pads ids to OTLP widths (32-hex trace, 16-hex span)', () => {
    writeCell(root, 'p1')
    convertTraceStoresToOtlp(root, out)
    const [anchor] = read()
    expect(anchor!.trace_id).toMatch(/^[0-9a-f]{32}$/)
    expect(anchor!.span_id).toMatch(/^[0-9a-f]{16}$/)
  })

  it('walks multiple cells; an unreadable cell is counted, not fatal', () => {
    writeCell(root, 'p1')
    writeCell(root, 'p2')
    const result = convertTraceStoresToOtlp(root, out)
    expect(result.cellCount).toBe(2)
    expect(result.runCount).toBe(2)
  })

  it('a string source is treated as a celled root', () => {
    writeCell(root, 'p1')
    const result = convertTraceStoresToOtlp(root, out)
    expect(result.spanCount).toBe(1)
  })
})
