import { describe, expect, it } from 'vitest'
import type { TraceAnalysisStore } from '../trace-analyst/store'
import type { TraceAnalystSpan } from '../trace-analyst/types'
import {
  assertNoBenchmarkLabelsInArtifact,
  assertNoBenchmarkLabelsInTrace,
  resolveAssistantStepEvidence,
  validateCodeTraceFindingEvidence,
} from './benchmark-evidence-validation'
import { makeFinding } from './types'

const TRACE_ID = 'run/1'
const URI = 'trace://run%2F1/span/step-4'

describe('validateCodeTraceFindingEvidence', () => {
  it('accepts an exact action quote from the cited assistant span', async () => {
    await expect(
      validateCodeTraceFindingEvidence({
        trajectoryId: TRACE_ID,
        findings: [finding('qemu-system-i386')],
        store: store(span('qemu-system-i386 -monitor unix:/tmp/qemu.sock')),
      }),
    ).resolves.toBeUndefined()
  })

  it.each([
    [
      'missing quote',
      undefined,
      span('qemu-system-i386 -monitor unix:/tmp/qemu.sock'),
      /must quote/,
    ],
    ['invented quote', 'uses the -k flag', span('qemu-system-i386 --version'), /not present/],
    ['generic short quote', 'qemu', span('qemu-system-i386 --version'), /too short/],
    [
      'non-LLM span',
      'qemu-system-i386',
      span('qemu-system-i386 --version', 'TOOL'),
      /not an assistant LLM/,
    ],
  ])('rejects %s', async (_name, excerpt, citedSpan, error) => {
    await expect(
      validateCodeTraceFindingEvidence({
        trajectoryId: TRACE_ID,
        findings: [finding(excerpt)],
        store: store(citedSpan),
      }),
    ).rejects.toThrow(error)
  })

  it('accepts the complete content when the assistant action is shorter than the normal minimum', async () => {
    await expect(
      validateCodeTraceFindingEvidence({
        trajectoryId: TRACE_ID,
        findings: [finding('ls')],
        store: store(span('ls')),
      }),
    ).resolves.toBeUndefined()
  })

  it('rejects a citation to another trace before reading the store', async () => {
    const traceStore = store(span('qemu-system-i386 --version'))

    await expect(
      validateCodeTraceFindingEvidence({
        trajectoryId: 'another-run',
        findings: [finding('qemu-system-i386')],
        store: traceStore,
      }),
    ).rejects.toThrow(/non-case evidence/)
  })
})

describe('resolveAssistantStepEvidence', () => {
  it('constructs the canonical URI and an exact bounded action preview', async () => {
    const content = `  ${'x'.repeat(600)}  `
    const evidence = await resolveAssistantStepEvidence({
      trajectoryId: TRACE_ID,
      steps: [4, 4],
      store: store(span(content)),
    })

    expect(evidence.size).toBe(1)
    expect(evidence.get(4)).toEqual({
      kind: 'span',
      uri: URI,
      excerpt: 'x'.repeat(512),
    })
  })

  it.each([
    ['missing', store(span('action', 'LLM', 'step-5')), /unavailable assistant steps/],
    ['non-assistant', store(span('action', 'TOOL')), /not an assistant LLM span/],
    ['empty', store(span('   ')), /without action content/],
  ])('rejects a %s selected step', async (_name, traceStore, error) => {
    await expect(
      resolveAssistantStepEvidence({
        trajectoryId: TRACE_ID,
        steps: [4],
        store: traceStore,
      }),
    ).rejects.toThrow(error)
  })
})

describe('assertNoBenchmarkLabelsInTrace', () => {
  it('accepts ordinary trace content and reports the exact byte count', () => {
    const otlpText = `${JSON.stringify({
      trace_id: TRACE_ID,
      span_id: 'step-1',
      attributes: { content: 'The command failed, so inspect the next action.' },
    })}\n`

    expect(assertNoBenchmarkLabelsInTrace({ traceId: TRACE_ID, otlpText })).toEqual({
      passed: true,
      scannedBytes: Buffer.byteLength(otlpText),
      scannedValues: 5,
    })
  })

  it.each([
    [
      'embedded label key',
      { trace_id: TRACE_ID, attributes: { incorrect_step_ids: [4] } },
      /label key 'incorrect_step_ids'/,
    ],
    [
      'annotation path',
      { trace_id: TRACE_ID, attributes: { source: '/tmp/ground_truth/labels.json' } },
      /label path marker/,
    ],
    [
      'serialized label object',
      {
        trace_id: TRACE_ID,
        attributes: { content: JSON.stringify({ incorrect_step_ids: [4] }) },
      },
      /label key 'incorrect_step_ids'.*inside a string/,
    ],
    [
      'recursively serialized label object',
      {
        trace_id: TRACE_ID,
        attributes: {
          content: JSON.stringify({
            payload: JSON.stringify({ root_cause_failure_id: 'failure-4' }),
          }),
        },
      },
      /label key 'root_cause_failure_id'.*inside a string/,
    ],
  ])('rejects %s', (_name, row, error) => {
    expect(() =>
      assertNoBenchmarkLabelsInTrace({
        traceId: TRACE_ID,
        otlpText: `${JSON.stringify(row)}\n`,
      }),
    ).toThrow(error)
  })
})

describe('assertNoBenchmarkLabelsInArtifact', () => {
  it('rejects a result file carrying answer annotations', () => {
    expect(() =>
      assertNoBenchmarkLabelsInArtifact({
        traceId: TRACE_ID,
        relativePath: 'result.json',
        content: JSON.stringify({ resolved: false, incorrect_step_ids: [4] }),
      }),
    ).toThrow(/label key 'incorrect_step_ids'/)
  })
})

function finding(excerpt: string | undefined) {
  return makeFinding({
    analyst_id: 'model',
    area: 'incorrect',
    subject: 'incorrect-step-4',
    claim: 'Step 4 used the wrong command.',
    severity: 'high',
    confidence: 0.9,
    evidence_refs: [{ kind: 'span', uri: URI, ...(excerpt === undefined ? {} : { excerpt }) }],
  })
}

function span(
  content: string,
  kind: TraceAnalystSpan['kind'] = 'LLM',
  spanId = 'step-4',
): TraceAnalystSpan {
  return {
    trace_id: TRACE_ID,
    span_id: spanId,
    parent_span_id: null,
    name: 'message.assistant',
    kind,
    start_time: '2026-01-01T00:00:00.000Z',
    end_time: '2026-01-01T00:00:01.000Z',
    duration_ms: 1_000,
    status: 'OK',
    service_name: 'fixture',
    agent_name: 'assistant',
    model_name: null,
    tool_name: null,
    attributes: { content },
  }
}

function store(citedSpan: TraceAnalystSpan): TraceAnalysisStore {
  return {
    async viewSpans(input: Parameters<TraceAnalysisStore['viewSpans']>[0]) {
      const found =
        input.trace_id === citedSpan.trace_id && input.span_ids.includes(citedSpan.span_id)
      return {
        trace_id: input.trace_id,
        spans: found ? [citedSpan] : [],
        missing_span_ids: found ? [] : [...input.span_ids],
        omitted_span_ids: [],
        has_more: false,
        truncated_attribute_count: 0,
      }
    },
  } as unknown as TraceAnalysisStore
}
