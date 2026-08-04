import { describe, expect, it } from 'vitest'
import type { TraceAnalysisToolDescriptor } from '../trace-analyst/tools'
import { startTraceToolCallback } from './trace-tool-callback'

const tool: TraceAnalysisToolDescriptor = {
  namespace: 'traces',
  name: 'echo',
  description: 'Echo input.',
  parameters: { type: 'object' },
  handler: async (args) => ({ echoed: args }),
}

describe('startTraceToolCallback', () => {
  it('requires authentication and forwards exact arguments', async () => {
    const callback = await startTraceToolCallback({ tools: [tool], maxCalls: 2 })
    try {
      const unauthorized = await fetch(callback.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'echo', args: { value: 1 } }),
      })
      expect(unauthorized.status).toBe(401)

      const response = await fetch(callback.url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${callback.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ name: 'echo', args: { value: 1 } }),
      })
      expect(response.status).toBe(200)
      await expect(response.json()).resolves.toEqual({
        result: { echoed: { value: 1 } },
      })
      expect(callback.calls()).toBe(1)
    } finally {
      await callback.close()
    }
  })

  it('rejects calls before executing a tool beyond the declared limit', async () => {
    const callback = await startTraceToolCallback({ tools: [tool], maxCalls: 1 })
    try {
      const call = () =>
        fetch(callback.url, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${callback.token}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({ name: 'echo', args: {} }),
        })
      expect((await call()).status).toBe(200)
      expect((await call()).status).toBe(429)
      expect(callback.calls()).toBe(1)
    } finally {
      await callback.close()
    }
  })

  it('enforces caller-selected response bytes after recording the tool call', async () => {
    const largeTool: TraceAnalysisToolDescriptor = {
      ...tool,
      handler: async () => ({ value: 'x'.repeat(100) }),
    }
    const callback = await startTraceToolCallback({
      tools: [largeTool],
      maxCalls: 1,
      limits: { maxResponseBytes: 30 },
    })
    try {
      const response = await fetch(callback.url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${callback.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ name: 'echo', args: {} }),
      })

      expect(response.status).toBe(413)
      await expect(response.json()).resolves.toEqual({ error: 'trace tool response too large' })
      expect(callback.calls()).toBe(1)
    } finally {
      await callback.close()
    }
  })
})
