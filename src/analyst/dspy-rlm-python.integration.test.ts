import { createServer } from 'node:http'
import { describe, expect, it } from 'vitest'
import { CostLedger } from '../cost-ledger'
import { toTraceJsonSchema, traceStoreInputSchemas } from '../trace-analyst/store-schemas'
import type { TraceAnalysisToolDescriptor } from '../trace-analyst/tools'
import { createDspyRlmTraceEngine } from './dspy-rlm-engine'
import { testModelExecutionOwner } from './model-execution.test-support'

const python = process.env.AGENT_EVAL_DSPY_TEST_PYTHON
const pricing = { inputUsdPerMillion: 1, outputUsdPerMillion: 2 }

describe.skipIf(!python)('official Python DSPy RLM consumer', () => {
  it('executes real sandbox tools and typed submissions through isolated, metered HTTP callbacks', async () => {
    const requests: unknown[] = []
    const authorizations: string[] = []
    const responses: string[] = []
    let batchArrivals = 0
    let batchActive = 0
    let maximumBatchActive = 0
    let releaseBatch: () => void = () => {}
    const batchReady = new Promise<void>((resolve) => { releaseBatch = resolve })
    let code = ''
    const provider = createServer(async (request, response) => {
      let body = ''
      for await (const chunk of request) body += chunk
      requests.push(JSON.parse(body))
      authorizations.push(request.headers.authorization ?? '')
      let batchAnswer: string | undefined
      if (body.includes('subquery-alpha') || body.includes('subquery-beta')) {
        batchAnswer = body.includes('subquery-alpha') ? 'alpha' : 'beta'
        batchArrivals++
        batchActive++
        maximumBatchActive = Math.max(maximumBatchActive, batchActive)
        if (batchArrivals === 2) releaseBatch()
        await batchReady
        batchActive--
      }
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(
        JSON.stringify({
          id: `completion-${requests.length}`,
          object: 'chat.completion',
          model: 'model-a',
          choices: [
            {
              index: 0,
              finish_reason: 'stop',
              message: {
                role: 'assistant',
                content:
                  batchAnswer ?? responses.shift() ??
                  `[[ ## plan ## ]]\nInspect the supplied evidence.\n[[ ## code ## ]]\n${code}\n[[ ## completed ## ]]`,
              },
            },
          ],
          usage: { prompt_tokens: 13, completion_tokens: 7 },
        }),
      )
    })
    await new Promise<void>((resolve) => provider.listen(0, '127.0.0.1', resolve))
    const address = provider.address()
    if (!address || typeof address === 'string') throw new Error('No provider address')
    const observations: unknown[] = []
    const options = {
      ...testModelExecutionOwner({
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        bearer: 'owner-only-secret',
        fetchImpl: fetch,
        pricing,
        onExecution: (record) => observations.push(record),
      }),
      model: 'model-a',
      pricing,
      maxCostUsd: 1,
      maxOutputTokens: 2000,
      maxModelRequests: 1,
      timeoutMs: 240_000,
      runner: { command: python, env: { OPENAI_API_KEY: 'must-not-reach-python' } },
    }
    const engine = createDspyRlmTraceEngine(options)
    let toolCalls = 0
    const tools: TraceAnalysisToolDescriptor[] = [
      {
        namespace: 'traces',
        readOnly: true,
        idempotent: true,
        name: 'getDatasetOverview',
        description: 'Read the retained trace count.',
        parameters: toTraceJsonSchema(traceStoreInputSchemas.getOverview),
        handler: async () => {
          toolCalls++
          return { total_traces: 1 }
        },
      },
    ]
    const limits = { maxIterations: 2, maxLlmCalls: 2, maxToolCalls: 1, maxOutputChars: 8000 }
    try {
      const ledger = new CostLedger()
      code =
        'import os\nassert os.environ.get("OPENAI_API_KEY") is None\n' +
        'assert getDatasetOverview()["total_traces"] == 1\n' +
        'SUBMIT(answer="Inspected one retained trace.", findings_json="[]")'
      const result = await engine.analyze({
        analystId: 'official-rlm',
        question: 'Inspect one trace.',
        instructions: 'Read the count.',
        tools,
        limits,
        costLedger: ledger,
        costPhase: 'compatibility',
      })
      expect(result).toMatchObject({
        answer: 'Inspected one retained trace.',
        findings: [],
        modelCalls: 1,
        toolCalls: 1,
        runtime: {
          format_repair_used: false,
          packages: { dspy: '3.5.0' },
          modelRequestAttempts: 1,
          modelSuccessfulCompletions: 1,
          sandbox: { probeOutput: '2', config: 'none' },
        },
      })
      expect(result.trajectory).toHaveLength(1)
      expect(result.trajectory[0]).toMatchObject({
        code: expect.stringContaining('getDatasetOverview'),
      })
      expect(toolCalls).toBe(1)
      expect(ledger.list()).toEqual([
        expect.objectContaining({
          inputTokens: 13,
          outputTokens: 7,
          usageUnknown: false,
          costUnknown: false,
        }),
      ])
      expect(observations).toHaveLength(1)
      expect(JSON.stringify(result)).not.toContain('must-not-reach-python')
      expect(JSON.stringify(result)).not.toContain('owner-only-secret')
      expect(result.runtime.sandbox).toMatchObject({
        permissions: {
          'allow-read': { scoped: true },
        },
      })
      for (const permission of ['allow-all', 'allow-net', 'allow-env', 'allow-write']) {
        expect(
          (result.runtime.sandbox as { permissions: Record<string, unknown> }).permissions[
            permission
          ],
        ).toBeUndefined()
      }

      code =
        'SUBMIT(answer="Step 2 failed.", repairs=[{"k":2,"failure_claim":"Wrong output path",' +
        '"intervention_kind":"shell","action":"python solve.py --out answer.txt"}])'
      const repaired = await engine.analyze({
        analystId: 'official-rlm-repair',
        question: 'Which step needs repair?',
        instructions: 'TASK tb-repair-typed-v1\nReturn the first broken step and an exact repair.',
        taskInputs: {
          trajectory: [
            { step_id: 1, action: 'ls', observation: 'ok' },
            { step_id: 2, action: 'python solve.py', observation: 'wrong output' },
          ],
          taskStatement: 'Write answer.txt',
        },
        tools: [],
        limits,
        costLedger: new CostLedger(),
        costPhase: 'typed-compatibility',
      })
      expect(repaired).toMatchObject({
        answer: 'Step 2 failed.',
        modelCalls: 1,
        runtime: {
          repair: {
            kept: 1,
            rows: [
              {
                k: 2,
                intervention: {
                  kind: 'shell',
                  action: 'python solve.py --out answer.txt',
                },
              },
            ],
          },
        },
      })

      // The controller exhausts the proxy's one-call ceiling. A subquery is
      // refused before the caller-owned provider runs again.
      code = 'print(llm_query("Attempt a second model call"))'
      await expect(
        engine.analyze({
          analystId: 'bounded-rlm',
          question: 'Test the strict call ceiling.',
          instructions: 'Use only the admitted call.',
          tools: [],
          limits,
          costLedger: new CostLedger(),
          costPhase: 'budget-refusal',
        }),
      ).rejects.toThrow()
      expect(requests).toHaveLength(3)
      expect(observations).toHaveLength(3)
      expect(authorizations).toEqual(Array(3).fill('Bearer owner-only-secret'))

      // A malformed findings field gets exactly one real LM repair call using
      // DSPy's supported string-call API, with both receipts retained.
      code = 'SUBMIT(answer="Failure at trace://run/span/broken.", findings_json="not JSON")'
      responses.push(
        `[[ ## plan ## ]]\nReport the failure.\n[[ ## code ## ]]\n${code}\n[[ ## completed ## ]]`,
        JSON.stringify([
          {
            severity: 'high',
            claim: 'Observed failure.',
            confidence: 0.9,
            evidence: [{ uri: 'trace://run/span/broken' }],
          },
        ]),
      )
      const repairLedger = new CostLedger()
      const recovered = await createDspyRlmTraceEngine({ ...options, maxModelRequests: 2 }).analyze(
        {
          analystId: 'format-repair',
          question: 'Report the failure.',
          instructions: 'Cite only observed facts.',
          tools: [],
          limits,
          costLedger: repairLedger,
          costPhase: 'format-repair',
        },
      )
      expect(recovered).toMatchObject({
        modelCalls: 2,
        findings: [{ claim: 'Observed failure.' }],
        runtime: { format_repair_used: true, modelSuccessfulCompletions: 2 },
      })
      expect(repairLedger.list()).toHaveLength(2)
      expect(requests).toHaveLength(5)
      expect(observations).toHaveLength(5)

      code = 'values = llm_query_batched(["subquery-alpha", "subquery-beta"])\n' +
        'SUBMIT(answer="|".join(values), findings_json="[]")'
      const batchLedger = new CostLedger()
      const batched = await createDspyRlmTraceEngine({ ...options, maxModelRequests: 3,
        modelRequestTimeoutMs: 5000 }).analyze({
        analystId: 'parallel-rlm', question: 'Exercise two bounded parallel subqueries.',
        instructions: 'Return the results in input order.', tools: [], limits,
        costLedger: batchLedger, costPhase: 'parallel-subqueries',
      })
      expect(batched).toMatchObject({ answer: 'alpha|beta', modelCalls: 3,
        runtime: { modelSuccessfulCompletions: 3, format_repair_used: false } })
      expect(maximumBatchActive).toBe(2)
      expect(batchLedger.list()).toHaveLength(3)
      expect(requests).toHaveLength(8)
      expect(observations).toHaveLength(8)
    } finally {
      releaseBatch()
      await new Promise<void>((resolve, reject) =>
        provider.close((error) => (error ? reject(error) : resolve())),
      )
    }
  }, 360_000)
})
