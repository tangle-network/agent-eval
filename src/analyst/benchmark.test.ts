import { describe, expect, it } from 'vitest'
import type { TraceAnalysisStore } from '../trace-analyst/store'
import {
  traceStoreEvidenceResolver,
} from './benchmark'






describe('traceStoreEvidenceResolver', () => {
  it('resolves encoded canonical span URIs and rejects unsupported locations', async () => {
    const requests: Array<{ trace_id: string; span_ids: readonly string[] }> = []
    let receivedSignal: AbortSignal | undefined
    const traceStore = {
      async viewSpans(
        input: { trace_id: string; span_ids: readonly string[] },
        options?: { signal?: AbortSignal },
      ) {
        requests.push(input)
        receivedSignal = options?.signal
        const found = input.trace_id === 'run/a' && input.span_ids[0] === 'span/b'
        return {
          trace_id: input.trace_id,
          spans: found ? [{ trace_id: input.trace_id, span_id: input.span_ids[0] }] : [],
          missing_span_ids: found ? [] : [...input.span_ids],
          truncated_attribute_count: 0,
        }
      },
    } as unknown as TraceAnalysisStore
    const resolve = traceStoreEvidenceResolver<{ traceStore: TraceAnalysisStore }>(
      (input) => input.traceStore,
    )
    const context = {
      caseId: 'case',
      caseInput: { traceStore },
    }
    const controller = new AbortController()

    await expect(
      resolve({
        ...context,
        evidence: { kind: 'span', uri: 'trace://run%2Fa/span/span%2Fb' },
        signal: controller.signal,
      }),
    ).resolves.toBe(true)
    await expect(
      resolve({
        ...context,
        evidence: { kind: 'artifact', uri: 'artifact://report' },
      }),
    ).resolves.toBe(false)
    await expect(
      resolve({
        ...context,
        evidence: { kind: 'span', uri: 'trace://bad/span/%E0%A4%A' },
      }),
    ).resolves.toBe(false)
    expect(requests).toEqual([{ trace_id: 'run/a', span_ids: ['span/b'] }])
    expect(receivedSignal).toBe(controller.signal)
  })
})
