import { createServer } from 'node:http'
import { describe, expect, it, vi } from 'vitest'
import { CostLedger } from '../cost-ledger'
import type { TraceAnalysisToolDescriptor } from '../trace-analyst/tools'
import { createDspyRlmTraceEngine } from './dspy-rlm-engine'

const CHILD_SCRIPT = `
const fs = require('node:fs')
const inputPath = process.argv[process.argv.indexOf('--input') + 1]
const outputPath = process.argv[process.argv.indexOf('--output') + 1]
const input = JSON.parse(fs.readFileSync(inputPath, 'utf8'))
async function main() {
  const model = await fetch(input.modelProxy.baseUrl + '/chat/completions', {
    method: 'POST',
    headers: {
      authorization: 'Bearer ' + input.modelProxy.apiKey,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: input.modelProxy.model,
      messages: [{ role: 'user', content: input.question }],
      max_tokens: input.modelProxy.maxOutputTokens,
    }),
  })
  if (!model.ok) throw new Error('model proxy failed: ' + await model.text())
  await model.json()
  const tool = await fetch(input.toolCallback.url, {
    method: 'POST',
    headers: {
      authorization: 'Bearer ' + input.toolCallback.token,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ name: 'getDatasetOverview', args: {} }),
  })
  if (!tool.ok) throw new Error('trace callback failed: ' + await tool.text())
  const toolResult = await tool.json()
  fs.writeFileSync(outputPath, JSON.stringify({
    answer: 'The run failed after one inspected trace.',
    findings: __FINDINGS__,
    trajectory: [{ tool: 'getDatasetOverview', result: toolResult.result }],
    modelCalls: 1,
    runtime: { engine: 'test-bridge' },
  }))
}
main().catch((error) => {
  console.error(error)
  process.exit(1)
})
`

function childScript(findingsJson: string): string {
  return CHILD_SCRIPT.replace('__FINDINGS__', findingsJson)
}

describe('createDspyRlmTraceEngine', () => {
  it('runs a child through authenticated model and trace callbacks', async () => {
    let providerAuthorization = ''
    const provider = createServer((request, response) => {
      providerAuthorization = request.headers.authorization ?? ''
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(
        JSON.stringify({
          choices: [{ message: { role: 'assistant', content: 'investigate' } }],
          usage: { prompt_tokens: 3, completion_tokens: 2 },
        }),
      )
    })
    await new Promise<void>((resolve, reject) => {
      provider.once('error', reject)
      provider.listen(0, '127.0.0.1', () => {
        provider.off('error', reject)
        resolve()
      })
    })
    const address = provider.address()
    if (!address || typeof address === 'string') throw new Error('provider did not bind')

    const ledger = new CostLedger()
    let toolExecutions = 0
    const tool: TraceAnalysisToolDescriptor = {
      namespace: 'traces',
      name: 'getDatasetOverview',
      description: 'Return a summary.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      handler: async () => {
        toolExecutions += 1
        return { total_traces: 1 }
      },
    }
    const engine = createDspyRlmTraceEngine({
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      apiKey: 'provider-secret',
      model: 'model-a',
      pricing: {
        inputUsdPerMillion: 1,
        outputUsdPerMillion: 2,
      },
      maxCostUsd: 0.1,
      maxOutputTokens: 64,
      runner: {
        command: process.execPath,
        args: ['-e', childScript('[]'), '--'],
      },
      timeoutMs: 5_000,
    })

    try {
      const result = await engine.analyze({
        analystId: 'failure-mode',
        question: 'What failed?',
        instructions: 'Inspect the trace.',
        tools: [tool],
        limits: {
          maxIterations: 2,
          maxLlmCalls: 1,
          maxToolCalls: 1,
          maxOutputChars: 1_000,
        },
        costLedger: ledger,
        costPhase: 'analyst.test',
      })

      expect(result).toMatchObject({
        answer: 'The run failed after one inspected trace.',
        findings: [],
        modelCalls: 1,
        toolCalls: 1,
        runtime: {
          engine: 'test-bridge',
          modelRequestAttempts: 1,
          modelSuccessfulCompletions: 1,
        },
      })
      expect(toolExecutions).toBe(1)
      expect(providerAuthorization).toBe('Bearer provider-secret')
      expect(ledger.list()).toEqual([
        expect.objectContaining({
          channel: 'analyst',
          phase: 'analyst.test',
          actor: 'failure-mode',
          model: 'model-a',
          inputTokens: 3,
          outputTokens: 2,
          costUnknown: false,
          usageUnknown: false,
        }),
      ])
    } finally {
      await new Promise<void>((resolve, reject) => {
        provider.close((error) => (error ? reject(error) : resolve()))
      })
    }
  })

  it('drops invalid finding rows, keeps valid ones, and counts the rejections', async () => {
    const provider = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(
        JSON.stringify({
          choices: [{ message: { role: 'assistant', content: 'investigate' } }],
          usage: { prompt_tokens: 3, completion_tokens: 2 },
        }),
      )
    })
    await new Promise<void>((resolve, reject) => {
      provider.once('error', reject)
      provider.listen(0, '127.0.0.1', () => {
        provider.off('error', reject)
        resolve()
      })
    })
    const address = provider.address()
    if (!address || typeof address === 'string') throw new Error('provider did not bind')

    const tool: TraceAnalysisToolDescriptor = {
      namespace: 'traces',
      name: 'getDatasetOverview',
      description: 'Return a summary.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      handler: async () => ({ total_traces: 1 }),
    }
    const validFinding = {
      severity: 'high',
      claim: 'Step 2 failed before recovery.',
      subject: 'incorrect-step-2',
      confidence: 0.9,
      evidence: [{ uri: 'trace://run-1/span/step-2' }],
    }
    const invalidFinding = { ...validFinding, subject: 'step:2' }
    const engine = createDspyRlmTraceEngine({
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      apiKey: 'provider-secret',
      model: 'model-a',
      pricing: { inputUsdPerMillion: 1, outputUsdPerMillion: 2 },
      maxCostUsd: 0.1,
      maxOutputTokens: 64,
      runner: {
        command: process.execPath,
        args: ['-e', childScript(JSON.stringify([validFinding, invalidFinding])), '--'],
      },
      timeoutMs: 5_000,
    })

    const log = vi.fn()
    try {
      const result = await engine.analyze({
        analystId: 'failure-mode',
        question: 'What failed?',
        instructions: 'Inspect the trace.',
        tools: [tool],
        limits: {
          maxIterations: 2,
          maxLlmCalls: 1,
          maxToolCalls: 1,
          maxOutputChars: 1_000,
        },
        costLedger: new CostLedger(),
        costPhase: 'analyst.test',
        log,
      })

      expect(result.findings).toEqual([expect.objectContaining({ claim: validFinding.claim })])
      expect(result.runtime.rejectedFindings).toBe(1)
      expect(log).toHaveBeenCalledWith('finding rejected: bridge row failed schema validation', {
        engine: 'dspy-rlm',
        index: 1,
        reason: expect.stringContaining('finding-subject grammar'),
      })
    } finally {
      await new Promise<void>((resolve, reject) => {
        provider.close((error) => (error ? reject(error) : resolve()))
      })
    }
  })

  it('requires explicit pricing for an unknown model', () => {
    expect(() =>
      createDspyRlmTraceEngine({
        baseUrl: 'https://provider.example/v1',
        apiKey: 'secret',
        model: 'unknown-model-with-no-pricing',
      }),
    ).toThrow("no pricing is configured for 'unknown-model-with-no-pricing'")
  })
})
