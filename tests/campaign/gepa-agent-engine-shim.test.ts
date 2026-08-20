import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { testModelExecutionOwner } from '../../src/analyst/model-execution.test-support'
import {
  compareOptimizationMethods,
  gepaOptimizationMethod,
  type JudgeConfig,
  type OpenAICompatibleOptimizerModel,
  type Scenario,
} from '../../src/campaign'
import { startExternalOptimizerModelProxy } from '../../src/campaign/external-optimizer-process'
import { CostLedger } from '../../src/cost-ledger'

interface TestScenario extends Scenario {
  kind: string
  prompt: string
  privateNote: string
}

interface TestArtifact {
  text: string
}

let runDir: string
const openServers: Server[] = []
const openProxies: Array<{ close: () => Promise<void> }> = []

const MODEL_BUDGET = {
  maxCostUsd: 0.1,
  maxRequests: 2,
  maxRequestBytes: 100_000,
  maxResponseBytes: 100_000,
  maxOutputTokensPerRequest: 100,
  pricing: {
    inputUsdPerMillion: 1,
    outputUsdPerMillion: 2,
  },
}

const RUNTIME_IDENTITY = {
  python: {
    implementation: 'CPython',
    version: '3.12.0',
  },
  bridge: {
    package: 'agent-eval-rpc',
    version: 'test-bridge',
    sourceUrl: 'https://github.com/tangle-network/agent-eval',
    revision: 'test-bridge-revision',
    sourceSha256: 'a'.repeat(64),
  },
  optimizer: {
    package: 'gepa',
    version: 'test',
    sourceUrl: 'https://github.com/gepa-ai/gepa',
    revision: 'test-revision',
    sourceSha256: 'b'.repeat(64),
  },
  engineModules: [],
} as const

beforeEach(() => {
  runDir = mkdtempSync(join(tmpdir(), 'gepa-agent-shim-'))
})

afterEach(async () => {
  await Promise.all(openProxies.splice(0).map((proxy) => proxy.close()))
  await Promise.all(
    openServers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.closeAllConnections?.()
          server.close((error) => (error ? reject(error) : resolve()))
        }),
    ),
  )
  rmSync(runDir, { recursive: true, force: true })
})

describe('anthropic endpoint on the optimizer model proxy', () => {
  async function startAnthropicProxy(options: { anthropicEndpoint?: boolean } = {}) {
    const upstreamBaseUrl = await startModelServer()
    const ledger = new CostLedger()
    const executions: unknown[] = []
    const owner = testModelExecutionOwner({
      baseUrl: upstreamBaseUrl,
      bearer: 'provider-secret',
      fetchImpl: fetch,
      pricing: MODEL_BUDGET.pricing,
    })
    const proxy = await startExternalOptimizerModelProxy({
      call: owner.call,
      callRef: owner.callRef,
      recordExecution: (observation) => {
        executions.push(structuredClone(observation))
      },
      model: 'model',
      budget: MODEL_BUDGET,
      costLedger: ledger,
      phase: 'test.optimizer-model',
      actor: 'anthropic-endpoint-test',
      tags: { attempt: 'a-1' },
      ...(options.anthropicEndpoint === undefined
        ? {}
        : { anthropicEndpoint: options.anthropicEndpoint }),
    })
    openProxies.push(proxy)
    return { proxy, ledger, executions }
  }

  function messagesRequest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      model: 'model',
      max_tokens: 20,
      messages: [{ role: 'user', content: 'improve' }],
      ...overrides,
    }
  }

  it('synthesizes SSE from one counted owner call and receipts it', async () => {
    const { proxy, ledger, executions } = await startAnthropicProxy({ anthropicEndpoint: true })
    const origin = new URL(proxy.baseUrl).origin
    const response = await fetch(`${origin}/v1/messages`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${proxy.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(messagesRequest({ stream: true, system: 'You improve candidates.' })),
    })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/event-stream')
    const sse = await response.text()
    const events = [...sse.matchAll(/^event: (.+)$/gm)].map((match) => match[1])
    expect(events).toEqual([
      'message_start',
      'content_block_start',
      'content_block_delta',
      'content_block_stop',
      'message_delta',
      'message_stop',
    ])
    expect(sse).toContain('"type":"text_delta","text":"better"')

    expect(proxy.requestAttempts()).toBe(1)
    expect(proxy.successfulCompletions()).toBe(1)
    expect(proxy.wireUsage()).toEqual({
      openai: { requestAttempts: 0, successfulCompletions: 0 },
      anthropic: { requestAttempts: 1, successfulCompletions: 1 },
    })
    proxy.assertExecutionComplete()
    expect(executions).toHaveLength(1)
    expect(executions[0]).toMatchObject({ path: '/v1/messages', succeeded: true })
    const receipts = ledger.list({ tags: { attempt: 'a-1', wire: 'anthropic' } })
    expect(receipts).toHaveLength(1)
    expect(receipts[0]).toMatchObject({ model: 'model', inputTokens: 10, outputTokens: 5 })
  })

  it('accepts the ephemeral token as x-api-key and answers plain JSON', async () => {
    const { proxy } = await startAnthropicProxy({ anthropicEndpoint: true })
    const origin = new URL(proxy.baseUrl).origin
    const response = await fetch(`${origin}/v1/messages`, {
      method: 'POST',
      headers: { 'x-api-key': proxy.apiKey, 'content-type': 'application/json' },
      body: JSON.stringify(messagesRequest()),
    })
    expect(response.status).toBe(200)
    const message = (await response.json()) as Record<string, unknown>
    expect(message).toMatchObject({
      type: 'message',
      role: 'assistant',
      model: 'model',
      content: [{ type: 'text', text: 'better' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 10, output_tokens: 5 },
    })
    const wrongToken = await fetch(`${origin}/v1/messages`, {
      method: 'POST',
      headers: { 'x-api-key': 'wrong', 'content-type': 'application/json' },
      body: JSON.stringify(messagesRequest()),
    })
    expect(wrongToken.status).toBe(401)
    expect(await wrongToken.json()).toEqual({
      type: 'error',
      error: { type: 'authentication_error', message: 'unauthorized' },
    })
  })

  it('returns 402 with the Anthropic envelope when the budget is exhausted', async () => {
    const { proxy } = await startAnthropicProxy({ anthropicEndpoint: true })
    const origin = new URL(proxy.baseUrl).origin
    const headers = {
      authorization: `Bearer ${proxy.apiKey}`,
      'content-type': 'application/json',
    }
    const body = JSON.stringify(messagesRequest())
    for (let call = 0; call < MODEL_BUDGET.maxRequests; call += 1) {
      const admitted = await fetch(`${origin}/v1/messages`, { method: 'POST', headers, body })
      expect(admitted.status).toBe(200)
      await admitted.arrayBuffer()
    }
    const refused = await fetch(`${origin}/v1/messages`, { method: 'POST', headers, body })
    expect(refused.status).toBe(402)
    expect(await refused.json()).toEqual({
      type: 'error',
      error: {
        type: 'invalid_request_error',
        message: 'optimizer model request limit reached',
      },
    })
    expect(proxy.wireUsage().anthropic).toEqual({ requestAttempts: 2, successfulCompletions: 2 })
  })

  it('serves a real CLI tool-call request end to end and discloses stripped fields', async () => {
    const { proxy, ledger, executions } = await startAnthropicProxy({ anthropicEndpoint: true })
    const origin = new URL(proxy.baseUrl).origin
    const response = await fetch(`${origin}/v1/messages`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${proxy.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(
        messagesRequest({
          stream: true,
          tools: [
            {
              name: 'run_eval',
              description: 'Run one eval case',
              input_schema: { type: 'object', properties: { case: { type: 'string' } } },
            },
          ],
          tool_choice: { type: 'auto' },
          thinking: { type: 'adaptive', display: 'omitted' },
          output_config: { effort: 'xhigh' },
        }),
      ),
    })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/event-stream')
    const sse = await response.text()
    expect(sse).toContain(
      '"content_block":{"type":"tool_use","id":"call_1","name":"run_eval","input":{}}',
    )
    expect(sse).toContain(
      '"delta":{"type":"input_json_delta","partial_json":"{\\"case\\":\\"a\\"}"}',
    )
    expect(sse).toContain('"stop_reason":"tool_use"')

    expect(proxy.wireUsage().anthropic).toEqual({ requestAttempts: 1, successfulCompletions: 1 })
    proxy.assertExecutionComplete()
    expect(executions).toHaveLength(1)
    expect(executions[0]).toMatchObject({ path: '/v1/messages', succeeded: true })
    const receipts = ledger.list({
      tags: { wire: 'anthropic', strippedFields: 'output_config,thinking' },
    })
    expect(receipts).toHaveLength(1)
  })

  it('keeps /v1/messages closed unless the endpoint is enabled', async () => {
    const { proxy } = await startAnthropicProxy()
    const origin = new URL(proxy.baseUrl).origin
    const response = await fetch(`${origin}/v1/messages`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${proxy.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(messagesRequest()),
    })
    expect(response.status).toBe(404)
  })

  it('still refuses streaming on the OpenAI wire', async () => {
    const { proxy } = await startAnthropicProxy({ anthropicEndpoint: true })
    const response = await fetch(`${proxy.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${proxy.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'model',
        messages: [{ role: 'user', content: 'improve' }],
        max_tokens: 20,
        stream: true,
      }),
    })
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({
      error: 'streaming optimizer model requests are not supported',
    })
  })
})

describe('gepaOptimizationMethod with agent CLI engines', () => {
  it('rejects agent engines unless optimizer.anthropicEndpoint is enabled', () => {
    expect(() =>
      gepaOptimizationMethod({
        recipe: {
          kind: 'engine',
          run: {
            engine: 'autoresearch',
            maxEvaluations: 1,
            engineConfig: { model: 'model' },
          },
        },
        objective: 'Return a better policy.',
        evaluationId: 'test',
        optimizer: optimizerModel(),
      }),
    ).toThrow('requires optimizer.anthropicEndpoint: true')
  })

  it('requires engineConfig.model to equal the proxied optimizer model', () => {
    expect(() =>
      gepaOptimizationMethod({
        recipe: {
          kind: 'engine',
          run: { engine: 'meta_harness', maxEvaluations: 1 },
        },
        objective: 'Return a better policy.',
        evaluationId: 'test',
        optimizer: { ...optimizerModel(), anthropicEndpoint: true },
      }),
    ).toThrow("must set engineConfig.model to the optimizer model 'model'")
  })

  it('rejects a fixed thinking budget through the Anthropic endpoint', () => {
    expect(() =>
      gepaOptimizationMethod({
        recipe: {
          kind: 'engine',
          run: {
            engine: 'autoresearch',
            maxEvaluations: 1,
            engineConfig: { model: 'model', max_thinking_tokens: 2048 },
          },
        },
        objective: 'Return a better policy.',
        evaluationId: 'test',
        optimizer: { ...optimizerModel(), anthropicEndpoint: true },
      }),
    ).toThrow('cannot set engineConfig.max_thinking_tokens')
  })

  it('keeps refusing non-agent engines even with the endpoint enabled', () => {
    expect(() =>
      gepaOptimizationMethod({
        recipe: {
          kind: 'engine',
          run: { engine: 'best_of_n', maxEvaluations: 1 },
        },
        objective: 'Return a better policy.',
        evaluationId: 'test',
        optimizer: { ...optimizerModel(), anthropicEndpoint: true },
      }),
    ).toThrow("optimizer requires GEPA's 'gepa' engine")
  })

  it('meters one agent-engine claude session end to end', async () => {
    const upstreamBaseUrl = await startModelServer()
    const claudeStubDir = writeClaudeStub(new URL(upstreamBaseUrl).origin)
    const method = gepaOptimizationMethod<TestScenario, TestArtifact>({
      recipe: {
        kind: 'engine',
        run: {
          engine: 'autoresearch',
          maxEvaluations: 1,
          engineConfig: { model: 'model' },
        },
      },
      objective: 'Return the better policy.',
      evaluationId: 'agent-shim',
      optimizer: { ...optimizerModel(upstreamBaseUrl), anthropicEndpoint: true },
      runner: fakeAgentBridgeRunner(upstreamBaseUrl, claudeStubDir),
    })

    const result = await compareOptimizationMethods<TestScenario, TestArtifact>({
      methods: [method],
      baselineSurface: 'baseline',
      trainScenarios: [{ id: 'train', kind: 'qa', prompt: 'visible train', privateNote: '' }],
      selectionScenarios: [
        { id: 'selection', kind: 'qa', prompt: 'visible selection', privateNote: '' },
      ],
      testScenarios: [
        { id: 'final', kind: 'qa', prompt: 'final', privateNote: '' },
        { id: 'final-2', kind: 'qa', prompt: 'final 2', privateNote: '' },
      ],
      dispatchWithSurface: async (surface) => ({ text: String(surface) }),
      judges: [betterJudge],
      runDir,
      seed: 11,
      resamples: 40,
      expectUsage: 'off',
    })

    expect(result.scores[0]!.optimizationCost).toEqual({
      totalCostUsd: 0.00004,
      costProvenance: { kind: 'estimated', usd: 0.00004 },
      accountingComplete: true,
      incompleteReasons: [],
    })
    expect(result.scores[0]!.provenance).toMatchObject({
      optimizerModel: 'model',
      anthropicEndpoint: { requestAttempts: 2, successfulCompletions: 2 },
      tokenUsage: {
        inputTokens: 20,
        outputTokens: 10,
        totalTokens: 30,
        calls: 2,
      },
      modelExecutions: {
        calls: 2,
        succeeded: 2,
        failed: 0,
      },
    })
  })
})

const betterJudge: JudgeConfig<TestArtifact, TestScenario> = {
  name: 'better',
  dimensions: [{ key: 'better', description: 'candidate is the known better surface' }],
  score: ({ artifact }) => {
    const score = artifact.text === 'better' ? 1 : 0
    return { dimensions: { better: score }, composite: score, notes: '' }
  },
}

function optimizerModel(baseUrl = 'http://127.0.0.1:1/v1'): OpenAICompatibleOptimizerModel {
  const owner = testModelExecutionOwner({
    baseUrl,
    bearer: 'provider-secret',
    fetchImpl: fetch,
    pricing: MODEL_BUDGET.pricing,
    callRef: `test-model-server:${baseUrl}`,
  })
  return {
    model: 'model',
    callRef: owner.callRef,
    call: owner.call,
    budget: MODEL_BUDGET,
  }
}

/**
 * Executable `claude` stub resolved from PATH by the fake bridge, the same
 * way the pinned engines resolve the real CLI. It reads the injected
 * ANTHROPIC_* environment, makes one streamed and one plain /v1/messages
 * call against the shim, verifies both, and prints a claude-style JSON
 * result. Any mismatch exits non-zero, which fails the bridge loudly.
 */
function writeClaudeStub(upstreamOrigin: string): string {
  const stubDir = mkdtempSync(join(tmpdir(), 'claude-stub-'))
  const source = [
    `#!${process.execPath}`,
    'const assert = (condition, message) => {',
    "  if (!condition) { console.error('claude stub: ' + message); process.exit(1) }",
    '}',
    'const base = process.env.ANTHROPIC_BASE_URL',
    'const token = process.env.ANTHROPIC_AUTH_TOKEN',
    'const model = process.env.ANTHROPIC_MODEL',
    "assert(base && base.startsWith('http://127.0.0.1:'), 'ANTHROPIC_BASE_URL must be the loopback shim, got ' + base)",
    `assert(base !== ${JSON.stringify(upstreamOrigin)}, 'ANTHROPIC_BASE_URL must not be the upstream provider')`,
    "assert(token && token !== 'provider-secret' && token !== 'user-supplied-should-strip', 'ephemeral proxy token expected')",
    "assert(model === 'model', 'ANTHROPIC_MODEL must carry the proxied model, got ' + model)",
    "assert(process.env.ANTHROPIC_SMALL_FAST_MODEL === 'model', 'ANTHROPIC_SMALL_FAST_MODEL must carry the proxied model')",
    "assert(process.env.CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING === '1', 'adaptive thinking must be disabled')",
    "assert(process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS === '100', 'CLAUDE_CODE_MAX_OUTPUT_TOKENS must match the per-request cap')",
    "assert(process.env.API_TIMEOUT_MS === '360000', 'API_TIMEOUT_MS must exceed the request deadline')",
    "assert(!process.env.OPENAI_API_KEY && !process.env.CUSTOM_AUTH_TOKEN && !process.env.AWS_SECRET_ACCESS_KEY, 'stripped secrets must not reach the CLI')",
    ';(async () => {',
    "  const streamed = await fetch(base + '/v1/messages', {",
    "    method: 'POST',",
    "    headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },",
    '    body: JSON.stringify({',
    '      model,',
    '      max_tokens: 20,',
    '      stream: true,',
    "      system: 'You improve candidates.',",
    "      messages: [{ role: 'user', content: 'improve' }],",
    '    }),',
    '  })',
    "  assert(streamed.status === 200, 'stream status ' + streamed.status)",
    "  assert((streamed.headers.get('content-type') || '').startsWith('text/event-stream'), 'stream content type')",
    '  const sse = await streamed.text()',
    '  for (const marker of [',
    "    'event: message_start',",
    "    'event: content_block_delta',",
    '    \'"type":"text_delta","text":"better"\',',
    "    'event: message_delta',",
    '    \'"output_tokens":5\',',
    "    'event: message_stop',",
    "  ]) assert(sse.includes(marker), 'missing SSE marker ' + marker)",
    "  const plain = await fetch(base + '/v1/messages', {",
    "    method: 'POST',",
    "    headers: { 'x-api-key': token, 'content-type': 'application/json' },",
    '    body: JSON.stringify({',
    '      model,',
    '      max_tokens: 20,',
    "      messages: [{ role: 'user', content: 'improve again' }],",
    '    }),',
    '  })',
    "  assert(plain.status === 200, 'plain status ' + plain.status)",
    '  const message = await plain.json()',
    "  assert(message.type === 'message' && message.role === 'assistant', 'message shape')",
    "  assert(message.content[0].text === 'better', 'message text')",
    "  assert(message.stop_reason === 'end_turn', 'stop reason')",
    "  process.stdout.write(JSON.stringify({ type: 'result', total_cost_usd: 0.00004, result: message.content[0].text }))",
    "})().catch((error) => { console.error('claude stub: ' + error.message); process.exit(1) })",
  ].join('\n')
  const stubPath = join(stubDir, 'claude')
  writeFileSync(stubPath, source)
  chmodSync(stubPath, 0o755)
  return stubDir
}

/**
 * Fake GEPA bridge for an agent-engine recipe. It spawns the `claude` stub
 * with its own environment — the exact propagation the pinned engines use —
 * and reports zeroed reflection token usage: agent CLI traffic is counted by
 * the shim, not by the bridge.
 */
function fakeAgentBridgeRunner(upstreamBaseUrl: string, claudeStubDir: string) {
  const source = [
    "const fs = require('node:fs')",
    "const { spawnSync } = require('node:child_process')",
    "const inputPath = process.argv[process.argv.indexOf('--input') + 1]",
    "const outputPath = process.argv[process.argv.indexOf('--output') + 1]",
    'const input = JSON.parse(fs.readFileSync(inputPath, "utf8"))',
    `const runtime = ${JSON.stringify(RUNTIME_IDENTITY)}`,
    'if (process.env.OPENAI_API_KEY) throw new Error("upstream secret reached child")',
    'if (process.env.AWS_SECRET_ACCESS_KEY) throw new Error("AWS secret reached child")',
    'if (process.env.CUSTOM_AUTH_TOKEN) throw new Error("custom token reached child")',
    'if (input.operation === "inspect") {',
    '  fs.writeFileSync(outputPath, JSON.stringify({ runtime }))',
    '  process.exit(0)',
    '}',
    'if (input.modelProxy.anthropicEndpoint !== true) throw new Error("anthropicEndpoint missing from bridge input")',
    `if (input.modelProxy.baseUrl === ${JSON.stringify(upstreamBaseUrl)}) throw new Error("upstream URL reached child")`,
    'if (!process.env.ANTHROPIC_BASE_URL) throw new Error("ANTHROPIC_BASE_URL missing from bridge env")',
    'if (process.env.ANTHROPIC_AUTH_TOKEN !== input.modelProxy.apiKey) throw new Error("bridge env token must be the ephemeral proxy token")',
    'const cli = spawnSync("claude", [], { env: process.env, encoding: "utf8" })',
    'if (cli.status !== 0) throw new Error("claude stub failed: " + cli.stderr + cli.stdout)',
    'const cliResult = JSON.parse(cli.stdout)',
    'if (typeof cliResult.total_cost_usd !== "number") throw new Error("claude stub result missing cost")',
    ';(async () => {',
    '  const response = await fetch(input.callbackUrl, {',
    '    method: "POST",',
    '    headers: { authorization: "Bearer " + input.callbackToken, "content-type": "application/json" },',
    '    body: JSON.stringify({ candidate: cliResult.result, exampleId: input.trainSet[0].id }),',
    '  })',
    '  if (!response.ok) throw new Error("callback failed: " + response.status)',
    '  const scored = await response.json()',
    '  fs.writeFileSync(outputPath, JSON.stringify({',
    '    bestCandidate: cliResult.result,',
    '    bestScore: scored.score,',
    '    totalEvaluations: 1,',
    '    recipeKind: input.recipe.kind,',
    '    proposerCostAccounting: "metered",',
    '    proposerCostUsd: 0,',
    '    tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, calls: 0, requestAttempts: 0 },',
    '    seedApplied: input.recipe.run.engine === "gepa",',
    '    upstream: runtime.optimizer,',
    '    runId: input.runId,',
    '    resumed: false,',
    '  }))',
    '})().catch((error) => { console.error(error); process.exit(1) })',
  ].join('\n')
  return {
    command: process.execPath,
    args: ['-e', source, '--'],
    env: {
      PATH: `${claudeStubDir}:${process.env.PATH ?? ''}`,
      OPENAI_API_KEY: 'unrelated-provider-secret',
      AWS_SECRET_ACCESS_KEY: 'aws-secret',
      CUSTOM_AUTH_TOKEN: 'custom-secret',
      ANTHROPIC_AUTH_TOKEN: 'user-supplied-should-strip',
    },
  }
}

async function startModelServer(): Promise<string> {
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) {
      chunks.push(chunk as Buffer)
    }
    if (request.headers.authorization !== 'Bearer provider-secret') {
      response.writeHead(401)
      response.end()
      return
    }
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
      tools?: unknown[]
    }
    // A tool-carrying request answers with an OpenAI function call so the
    // shim's full translate → execute → synthesize path is exercised.
    const choice = Array.isArray(body.tools)
      ? {
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'call_1',
                type: 'function',
                function: { name: 'run_eval', arguments: '{"case":"a"}' },
              },
            ],
          },
          finish_reason: 'tool_calls',
        }
      : { message: { role: 'assistant', content: 'better' }, finish_reason: 'stop' }
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(
      JSON.stringify({
        id: 'completion-1',
        choices: [choice],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }),
    )
  })
  openServers.push(server)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('model server failed to bind')
  return `http://127.0.0.1:${address.port}/v1`
}
