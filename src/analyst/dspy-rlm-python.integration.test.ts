import { createServer } from 'node:http'
import { describe, expect, it } from 'vitest'
import { CostLedger } from '../cost-ledger'
import { createDspyRlmTraceEngine } from './dspy-rlm-engine'
import { testModelExecutionOwner } from './model-execution.test-support'

const python = process.env.AGENT_EVAL_DSPY_TEST_PYTHON
const pricing = { inputUsdPerMillion: 1, outputUsdPerMillion: 2 }

describe.skipIf(!python)('official Python DSPy RLM consumer', () => {
  it('executes real sandbox tools and typed submissions through isolated, metered HTTP callbacks', async () => {
    const requests: unknown[] = []
    const authorizations: string[] = []
    let code = ''
    const provider = createServer(async (request, response) => {
      let body = ''
      for await (const chunk of request) body += chunk
      requests.push(JSON.parse(body))
      authorizations.push(request.headers.authorization ?? '')
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({
        id: `completion-${requests.length}`,
        object: 'chat.completion',
        model: 'model-a',
        choices: [{ index: 0, finish_reason: 'stop', message: {
          role: 'assistant',
          content: `[[ ## plan ## ]]\nInspect the supplied evidence.\n[[ ## code ## ]]\n${code}\n[[ ## completed ## ]]`,
        } }],
        usage: { prompt_tokens: 13, completion_tokens: 7 },
      }))
    })
    await new Promise<void>((resolve) => provider.listen(0, '127.0.0.1', resolve))
    const address = provider.address()
    if (!address || typeof address === 'string') throw new Error('No provider address')
    const observations: unknown[] = []
    const engine = createDspyRlmTraceEngine({
      ...testModelExecutionOwner({
        baseUrl: `http://127.0.0.1:${address.port}/v1`, bearer: 'owner-only-secret',
        fetchImpl: fetch, pricing, onExecution: (record) => observations.push(record),
      }),
      model: 'model-a', pricing, maxCostUsd: 1, maxOutputTokens: 2000,
      maxModelRequests: 1, timeoutMs: 240_000,
      runner: { command: python, env: { OPENAI_API_KEY: 'must-not-reach-python' } },
    })
    let toolCalls = 0
    const tools = [{
      namespace: 'traces', readOnly: true, idempotent: true,
      name: 'getDatasetOverview', description: 'Read the retained trace count.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      handler: async () => { toolCalls++; return { total_traces: 1 } },
    }]
    const limits = { maxIterations: 2, maxLlmCalls: 2, maxToolCalls: 1, maxOutputChars: 8000 }
    try {
      const ledger = new CostLedger()
      code = 'import os\nassert os.environ.get("OPENAI_API_KEY") is None\n' +
        'assert getDatasetOverview()["total_traces"] == 1\n' +
        'SUBMIT(answer="Inspected one retained trace.", findings_json="[]")'
      const result = await engine.analyze({
        analystId: 'official-rlm', question: 'Inspect one trace.', instructions: 'Read the count.',
        tools, limits, costLedger: ledger, costPhase: 'compatibility',
      })
      expect(result).toMatchObject({ answer: 'Inspected one retained trace.', findings: [], modelCalls: 1, toolCalls: 1,
        runtime: { packages: { dspy: '3.5.0' }, modelRequestAttempts: 1, modelSuccessfulCompletions: 1,
          sandbox: { probeOutput: '2', config: 'none' } } })
      expect(result.trajectory).toHaveLength(1)
      expect(result.trajectory[0]).toMatchObject({ code: expect.stringContaining('getDatasetOverview') })
      expect(toolCalls).toBe(1)
      expect(ledger.list()).toEqual([expect.objectContaining({ inputTokens: 13, outputTokens: 7,
        usageUnknown: false, costUnknown: false })])
      expect(observations).toHaveLength(1)
      expect(JSON.stringify(result)).not.toContain('must-not-reach-python')
      expect(JSON.stringify(result)).not.toContain('owner-only-secret')

      code = 'SUBMIT(answer="Step 2 failed.", repairs=[{"k":2,"failure_claim":"Wrong output path",' +
        '"intervention_kind":"shell","action":"python solve.py --out answer.txt"}])'
      const repaired = await engine.analyze({
        analystId: 'official-rlm-repair', question: 'Which step needs repair?',
        instructions: 'TASK tb-repair-typed-v1\nReturn the first broken step and an exact repair.',
        taskInputs: { trajectory: [{ step_id: 1, action: 'ls', observation: 'ok' },
          { step_id: 2, action: 'python solve.py', observation: 'wrong output' }], taskStatement: 'Write answer.txt' },
        tools: [], limits, costLedger: new CostLedger(), costPhase: 'typed-compatibility',
      })
      expect(repaired).toMatchObject({ answer: 'Step 2 failed.', modelCalls: 1,
        runtime: { repair: { kept: 1, rows: [{ k: 2, intervention: {
          kind: 'shell', action: 'python solve.py --out answer.txt' } }] } } })

      // The controller exhausts the proxy's one-call ceiling. A subquery is
      // refused before the caller-owned provider runs again.
      code = 'print(llm_query("Attempt a second model call"))'
      await expect(engine.analyze({ analystId: 'bounded-rlm', question: 'Test the strict call ceiling.',
        instructions: 'Use only the admitted call.', tools: [], limits,
        costLedger: new CostLedger(), costPhase: 'budget-refusal' })).rejects.toThrow()
      expect(requests).toHaveLength(3)
      expect(observations).toHaveLength(3)
      expect(authorizations).toEqual(Array(3).fill('Bearer owner-only-secret'))
    } finally {
      await new Promise<void>((resolve, reject) => provider.close((error) => error ? reject(error) : resolve()))
    }
  }, 360_000)
})
