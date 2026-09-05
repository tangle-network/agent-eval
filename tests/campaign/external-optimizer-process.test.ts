import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  runExternalOptimizerProcess,
  runWithCleanup,
  startExternalOptimizerCallback,
  startExternalOptimizerModelProxy as startRuntimeOwnedModelProxy,
} from '../../src/campaign/external-optimizer-process'
import {
  CostLedger,
  type CostLedgerHandle,
  type CostReceiptInput,
  type CustomTokenPricing,
  costForTokenPricing,
} from '../../src/cost-ledger'

const openCallbacks: Array<{ close: () => Promise<void> }> = []

interface FakeOwnerProxyArgs {
  ownerCall?: typeof fetch
  model: string
  budget: {
    maxCostUsd?: number
    maxRequests: number
    maxRequestBytes: number
    maxResponseBytes: number
    maxOutputTokensPerRequest: number
    maxReasoningTokensPerRequest?: number
    pricing?: CustomTokenPricing
    requestTimeoutMs?: number
  }
  costLedger: CostLedgerHandle
  phase: string
  actor: string
  channel?: string
  tags?: Record<string, string>
  initialUsage?: { requests: number; costUsd?: number }
  signal?: AbortSignal
}

/** Fake execution owner used by proxy tests; production has no HTTP transport arm. */
function startExternalOptimizerModelProxy(args: FakeOwnerProxyArgs) {
  const {
    ownerCall = async () => {
      throw new Error('test execution owner was not configured')
    },
    ...proxy
  } = args
  const executionRecords: unknown[] = []
  return startRuntimeOwnedModelProxy({
    ...proxy,
    callRef: 'test-owner:fake-runtime',
    call: async (request) => {
      const started = performance.now()
      try {
        const response = await ownerCall('https://test-owner.invalid/v1/chat/completions', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            model: request.request.model,
            messages: request.request.messages,
            max_tokens: request.request.maxTokens,
            ...(request.request.temperature === undefined
              ? {}
              : { temperature: request.request.temperature }),
          }),
          signal: request.signal,
          redirect: 'error',
        })
        const receipt = await fakeOwnerReceipt(
          response.clone(),
          request.request.model,
          args.budget.pricing,
        )
        const canonical = await fakeOwnerResponse(response.clone(), receipt, started)
        if (!response.ok) {
          return {
            succeeded: false as const,
            error: `test execution owner returned HTTP ${response.status}`,
            receipt,
            execution: {
              kind: 'test-owner-call',
              model: request.request.model,
              status: response.status,
              durationMs: performance.now() - started,
            },
          }
        }
        return {
          succeeded: true as const,
          response: canonical,
          receipt,
          execution: {
            kind: 'test-owner-call',
            model: request.request.model,
            status: response.status,
            durationMs: performance.now() - started,
          },
        }
      } catch (error) {
        return {
          succeeded: false as const,
          error: error instanceof Error ? error.message : String(error),
          receipt: unknownReceipt(request.request.model),
          execution: {
            kind: 'test-owner-call',
            model: request.request.model,
            error: error instanceof Error ? error.name : 'Error',
            durationMs: performance.now() - started,
          },
        }
      }
    },
    recordExecution: (observation) => {
      executionRecords.push(structuredClone(observation))
    },
  })
}

async function fakeOwnerReceipt(
  response: Response,
  model: string,
  pricing?: CustomTokenPricing,
): Promise<CostReceiptInput> {
  let value: unknown
  try {
    value = await response.json()
  } catch {
    return unknownReceipt(model)
  }
  if (!value || typeof value !== 'object' || !('usage' in value)) return unknownReceipt(model)
  const usage = (value as { usage?: Record<string, unknown> }).usage
  if (!usage) return unknownReceipt(model)
  const totalInput = usage.prompt_tokens ?? usage.input_tokens
  const output = usage.completion_tokens ?? usage.output_tokens
  if (
    !Number.isSafeInteger(totalInput) ||
    (totalInput as number) < 0 ||
    !Number.isSafeInteger(output) ||
    (output as number) < 0
  ) {
    return unknownReceipt(model)
  }
  const inputDetails = (usage.prompt_tokens_details ?? usage.input_tokens_details) as
    | Record<string, unknown>
    | undefined
  const outputDetails = (usage.completion_tokens_details ?? usage.output_tokens_details) as
    | Record<string, unknown>
    | undefined
  const nestedCachedTokens = Number(inputDetails?.cached_tokens ?? 0)
  const separateCachedTokens = Number(usage.cache_read_input_tokens ?? 0)
  const cachedTokens = nestedCachedTokens || separateCachedTokens
  const nestedCacheWriteTokens = Number(
    inputDetails?.cache_creation_tokens ?? inputDetails?.cache_write_tokens ?? 0,
  )
  const separateCacheWriteTokens = Number(usage.cache_creation_input_tokens ?? 0)
  const cacheWriteTokens = nestedCacheWriteTokens || separateCacheWriteTokens
  const reasoningTokens = Number(outputDetails?.reasoning_tokens ?? 0)
  if (
    ![cachedTokens, cacheWriteTokens, reasoningTokens].every(
      (entry) => Number.isSafeInteger(entry) && entry >= 0,
    ) ||
    nestedCachedTokens + nestedCacheWriteTokens > (totalInput as number) ||
    reasoningTokens > (output as number)
  ) {
    return unknownReceipt(model)
  }
  const actualCost = usage.cost
  return {
    model,
    inputTokens: (totalInput as number) - nestedCachedTokens,
    outputTokens: output as number,
    ...(cachedTokens > 0 ? { cachedTokens } : {}),
    ...(cacheWriteTokens > 0 ? { cacheWriteTokens } : {}),
    ...(reasoningTokens > 0 ? { reasoningTokens } : {}),
    ...(typeof actualCost === 'number' && Number.isFinite(actualCost) && actualCost >= 0
      ? { actualCostUsd: actualCost }
      : pricing
        ? { customTokenPricing: pricing }
        : { costUnknown: true }),
  }
}

async function fakeOwnerResponse(response: Response, receipt: CostReceiptInput, startedAt: number) {
  const text = await response.text()
  let raw: Record<string, unknown> = { body: text }
  try {
    const parsed = JSON.parse(text) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      raw = JSON.parse(JSON.stringify(parsed)) as Record<string, unknown>
    }
  } catch {
    // The canonical owner can retain an unstructured provider body as evidence.
  }
  const choices = Array.isArray(raw.choices) ? raw.choices : []
  const first = choices[0]
  const firstRecord = first && typeof first === 'object' ? (first as Record<string, unknown>) : {}
  const message =
    firstRecord.message && typeof firstRecord.message === 'object'
      ? (firstRecord.message as Record<string, unknown>)
      : {}
  const output = Array.isArray(raw.output) ? raw.output : []
  const outputText = output
    .flatMap((item) =>
      item && typeof item === 'object' && Array.isArray((item as Record<string, unknown>).content)
        ? ((item as Record<string, unknown>).content as unknown[])
        : [],
    )
    .find(
      (part) =>
        part &&
        typeof part === 'object' &&
        (part as Record<string, unknown>).type === 'output_text' &&
        typeof (part as Record<string, unknown>).text === 'string',
    ) as Record<string, unknown> | undefined
  const content =
    typeof message.content === 'string'
      ? message.content
      : typeof raw.output_text === 'string'
        ? raw.output_text
        : typeof outputText?.text === 'string'
          ? outputText.text
          : text
  const usageKnown = receipt.usageUnknown !== true
  const promptTokens = usageKnown ? receipt.inputTokens + (receipt.cachedTokens ?? 0) : 0
  const completionTokens = usageKnown ? receipt.outputTokens : 0
  return {
    content,
    usage: {
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens,
      ...(usageKnown ? {} : { captured: false }),
      ...(receipt.cachedTokens === undefined ? {} : { cachedPromptTokens: receipt.cachedTokens }),
      ...(receipt.reasoningTokens === undefined
        ? {}
        : { reasoningTokens: receipt.reasoningTokens }),
    },
    costUsd:
      receipt.actualCostUsd ??
      receipt.estimatedCostUsd ??
      (receipt.customTokenPricing && receipt.usageUnknown !== true
        ? costForTokenPricing(receipt.customTokenPricing, receipt)
        : null),
    model: receipt.model,
    durationMs: performance.now() - startedAt,
    finishReason: typeof firstRecord.finish_reason === 'string' ? firstRecord.finish_reason : null,
    contentEmpty: content.trim().length === 0,
    raw,
  }
}

function unknownReceipt(model: string): CostReceiptInput {
  return {
    model,
    inputTokens: 0,
    outputTokens: 0,
    usageUnknown: true,
    costUnknown: true,
  }
}

afterEach(async () => {
  await Promise.all(openCallbacks.splice(0).map((callback) => callback.close()))
})

describe('external optimizer callback', () => {
  it('records malformed JSON and invalid bodies as explicit refusals', async () => {
    const observations: unknown[] = []
    const callback = await startExternalOptimizerCallback({
      token: 'secret',
      maxEvaluations: 1,
      evaluate: async () => ({ score: 1 }),
      observe: (observation) => {
        observations.push(structuredClone(observation))
      },
    })
    openCallbacks.push(callback)

    const malformed = await fetch(callback.url, {
      method: 'POST',
      headers: {
        authorization: 'Bearer secret',
        'content-type': 'application/json',
      },
      body: '{',
    })
    const invalid = await fetch(callback.url, {
      method: 'POST',
      headers: {
        authorization: 'Bearer secret',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ candidate: '', exampleId: 3 }),
    })

    expect([malformed.status, invalid.status]).toEqual([400, 400])
    expect(callback.evaluations()).toBe(0)
    expect(observations).toEqual([
      { kind: 'refusal', reason: 'invalid-request', sequence: 1 },
      { kind: 'refusal', reason: 'invalid-request', sequence: 2 },
    ])
  })

  it('records only callback-submitted candidates, per-case scores, and refusals', async () => {
    const observations: unknown[] = []
    const callback = await startExternalOptimizerCallback({
      token: 'secret',
      maxEvaluations: 1,
      evaluate: async ({ exampleId }) => ({ score: exampleId === 'case-a' ? 1 : 0 }),
      observe: (observation) => {
        observations.push(structuredClone(observation))
      },
    })
    openCallbacks.push(callback)

    expect((await post(callback.url, 'secret', 'candidate', 'case-a')).status).toBe(200)
    expect((await post(callback.url, 'secret', 'candidate', 'case-b')).status).toBe(429)

    expect(observations).toMatchObject([
      { kind: 'proposal', sequence: 1, candidate: 'candidate' },
      { kind: 'evaluation', sequence: 2, exampleId: 'case-a', evaluationNumber: 1 },
      { kind: 'refusal', sequence: 3, reason: 'evaluation-limit', exampleId: 'case-b' },
    ])
    expect(
      observations.filter((row) => (row as { kind?: string }).kind === 'proposal'),
    ).toHaveLength(1)
  })

  it('authenticates requests and enforces the limit under concurrency', async () => {
    let accepted = 0
    const callback = await startExternalOptimizerCallback({
      token: 'secret',
      maxEvaluations: 2,
      evaluate: async () => {
        accepted += 1
        await new Promise((resolve) => setTimeout(resolve, 20))
        return { score: 1 }
      },
    })
    openCallbacks.push(callback)

    const unauthorized = await post(callback.url, 'wrong')
    expect(unauthorized.status).toBe(401)
    expect(callback.evaluations()).toBe(0)

    const responses = await Promise.all([
      post(callback.url, 'secret'),
      post(callback.url, 'secret'),
      post(callback.url, 'secret'),
      post(callback.url, 'secret'),
    ])

    expect(responses.map((response) => response.status).sort()).toEqual([200, 200, 429, 429])
    expect(accepted).toBe(2)
    expect(callback.evaluations()).toBe(2)
  })

  it('lets callers raise the former one-megabyte request limit', async () => {
    const candidate = 'x'.repeat(1_000_100)
    const callback = await startExternalOptimizerCallback({
      token: 'secret',
      maxEvaluations: 1,
      limits: { maxRequestBytes: 1_100_000 },
      evaluate: async ({ candidate: received }) => ({ matches: received === candidate }),
    })
    openCallbacks.push(callback)

    const response = await post(callback.url, 'secret', candidate, 'large-case')

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ matches: true })
  })

  it('enforces a caller-selected callback response limit', async () => {
    const callback = await startExternalOptimizerCallback({
      token: 'secret',
      maxEvaluations: 1,
      limits: { maxResponseBytes: 20 },
      evaluate: async () => ({ result: 'x'.repeat(100) }),
    })
    openCallbacks.push(callback)

    const response = await post(callback.url, 'secret')

    expect(response.status).toBe(413)
    await expect(response.json()).resolves.toEqual({ error: 'evaluation response too large' })
  })

  it('aborts active evaluation work before close resolves', async () => {
    let started = false
    let aborted = false
    const callback = await startExternalOptimizerCallback({
      token: 'secret',
      maxEvaluations: 1,
      evaluate: (_request, signal) =>
        new Promise<never>((_resolve, reject) => {
          started = true
          signal.addEventListener(
            'abort',
            () => {
              aborted = true
              reject(signal.reason)
            },
            { once: true },
          )
        }),
    })
    openCallbacks.push(callback)

    const pendingRequest = post(callback.url, 'secret')
    await waitFor(() => started)
    await callback.close()
    await Promise.allSettled([pendingRequest])

    expect(aborted).toBe(true)
  })
})

describe('external optimizer process', () => {
  it('preserves operation and cleanup failures together', async () => {
    const error = await runWithCleanup({
      label: 'optimizer resources',
      run: async () => {
        throw new Error('primary failure')
      },
      cleanup: async () => {
        throw new Error('cleanup failure')
      },
    }).catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(AggregateError)
    expect(error).toMatchObject({
      message: 'primary failure; optimizer resources cleanup failed: cleanup failure',
      errors: [{ message: 'primary failure' }, { message: 'cleanup failure' }],
    })
  })

  it('passes only safe inherited variables plus explicit runner environment', async () => {
    process.env.AGENT_EVAL_TEST_SECRET = 'must-not-leak'
    const script = [
      "const { writeFileSync } = require('node:fs')",
      "const output = process.argv[process.argv.indexOf('--output') + 1]",
      'writeFileSync(output, JSON.stringify({ inherited: process.env.AGENT_EVAL_TEST_SECRET ?? null, explicit: process.env.EXPLICIT_VALUE }))',
    ].join(';')

    try {
      const result = await runExternalOptimizerProcess<{
        inherited: string | null
        explicit: string
      }>({
        label: 'isolated optimizer',
        tempPrefix: 'agent-eval-isolated-env-',
        module: 'unused',
        input: {},
        runner: {
          command: process.execPath,
          args: ['-e', script, '--'],
          env: { EXPLICIT_VALUE: 'present' },
        },
        timeoutMs: 5_000,
      })
      expect(result).toEqual({ inherited: null, explicit: 'present' })
    } finally {
      delete process.env.AGENT_EVAL_TEST_SECRET
    }
  })

  it('resolves a path-like runner command before entering the private working directory', async () => {
    const script = [
      "const { writeFileSync } = require('node:fs')",
      "const output = process.argv[process.argv.indexOf('--output') + 1]",
      "writeFileSync(output, JSON.stringify({ status: 'complete' }))",
    ].join(';')

    await expect(
      runExternalOptimizerProcess({
        label: 'relative-runner optimizer',
        tempPrefix: 'agent-eval-relative-runner-',
        module: 'unused',
        input: {},
        runner: {
          command: relative(process.cwd(), process.execPath),
          args: ['-e', script, '--'],
        },
        timeoutMs: 5_000,
      }),
    ).resolves.toEqual({ status: 'complete' })
  })

  it('retains the final exception after large process output', async () => {
    const script = [
      "process.stderr.write('HEAD_MARKER\\n')",
      "process.stderr.write('x'.repeat(70_000))",
      "process.stderr.write('\\nTAIL_MARKER\\n')",
      'process.exitCode = 9',
    ].join(';')

    await expect(
      runExternalOptimizerProcess({
        label: 'large-output optimizer',
        tempPrefix: 'agent-eval-large-output-',
        module: 'unused',
        input: {},
        runner: {
          command: process.execPath,
          args: ['-e', script, '--'],
        },
        timeoutMs: 5_000,
      }),
    ).rejects.toThrow(
      expect.objectContaining({
        message: expect.stringMatching(/HEAD_MARKER.*TAIL_MARKER/),
      }),
    )
  })

  it('reports process failure and cleanup failure together', async () => {
    const denied = Object.assign(new Error('cleanup denied'), { code: 'EPERM' })
    const processKill = vi.spyOn(process, 'kill').mockImplementation(((pid: number) => {
      if (pid < 0) throw denied
      return true
    }) as typeof process.kill)
    const script = "process.stderr.write('primary failure'); process.exit(9)"

    try {
      const error = await runExternalOptimizerProcess({
        label: 'cleanup-failure optimizer',
        tempPrefix: 'agent-eval-cleanup-failure-',
        module: 'unused',
        input: {},
        runner: {
          command: process.execPath,
          args: ['-e', script, '--'],
        },
        timeoutMs: 5_000,
      }).catch((caught: unknown) => caught)

      expect(error).toBeInstanceOf(AggregateError)
      expect(error).toMatchObject({
        message: expect.stringMatching(/exited 9.*process cleanup failed.*cleanup denied/),
      })
      expect((error as AggregateError).errors).toHaveLength(2)
    } finally {
      processKill.mockRestore()
    }
  })

  it('rejects an oversized result file before reading it', async () => {
    const script = [
      "const { writeFileSync } = require('node:fs')",
      "const output = process.argv[process.argv.indexOf('--output') + 1]",
      "writeFileSync(output, 'x'.repeat(4 * 1024 * 1024 + 1))",
    ].join(';')

    await expect(
      runExternalOptimizerProcess({
        label: 'oversized optimizer',
        tempPrefix: 'agent-eval-oversized-result-',
        module: 'unused',
        input: {},
        runner: {
          command: process.execPath,
          args: ['-e', script, '--'],
        },
        timeoutMs: 5_000,
      }),
    ).rejects.toThrow('output exceeds 4194304 bytes')
  })

  it('enforces caller-selected process input and result limits', async () => {
    await expect(
      runExternalOptimizerProcess({
        label: 'small-input optimizer',
        tempPrefix: 'agent-eval-small-input-',
        module: 'unused',
        input: { value: 'x'.repeat(100) },
        runner: { command: process.execPath, limits: { maxInputBytes: 20 } },
        timeoutMs: 5_000,
      }),
    ).rejects.toThrow('input exceeds 20 bytes')

    const script = [
      "const { writeFileSync } = require('node:fs')",
      "const output = process.argv[process.argv.indexOf('--output') + 1]",
      "writeFileSync(output, JSON.stringify({ value: 'x'.repeat(100) }))",
    ].join(';')
    await expect(
      runExternalOptimizerProcess({
        label: 'small-result optimizer',
        tempPrefix: 'agent-eval-small-result-',
        module: 'unused',
        input: {},
        runner: {
          command: process.execPath,
          args: ['-e', script, '--'],
          limits: { maxResultBytes: 20 },
        },
        timeoutMs: 5_000,
      }),
    ).rejects.toThrow('output exceeds 20 bytes')
  })

  it('terminates optimizer descendants when the process times out', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-eval-descendant-'))
    const marker = join(dir, 'descendant-survived.txt')
    const descendant = [
      "const { writeFileSync } = require('node:fs')",
      `setTimeout(() => writeFileSync(${JSON.stringify(marker)}, 'survived'), 1_000)`,
      'setTimeout(() => process.exit(0), 2_000)',
    ].join(';')
    const parent = [
      "const { spawn } = require('node:child_process')",
      `spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], { stdio: 'ignore' })`,
      'setInterval(() => {}, 1_000)',
    ].join(';')

    try {
      await expect(
        runExternalOptimizerProcess({
          label: 'timed optimizer',
          tempPrefix: 'agent-eval-timeout-',
          module: 'unused',
          input: {},
          runner: {
            command: process.execPath,
            args: ['-e', parent, '--'],
          },
          timeoutMs: 100,
        }),
      ).rejects.toThrow('timed optimizer exceeded 100ms')
      await new Promise((resolve) => setTimeout(resolve, 1_100))
      await expect(readFile(marker, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }, 10_000)

  it('terminates the detached process group promptly when the caller aborts', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-eval-abort-descendant-'))
    const ready = join(dir, 'ready.txt')
    const marker = join(dir, 'descendant-survived.txt')
    const descendant = [
      "const { writeFileSync } = require('node:fs')",
      `setTimeout(() => writeFileSync(${JSON.stringify(marker)}, 'survived'), 1_000)`,
      'setInterval(() => {}, 1_000)',
    ].join(';')
    const parent = [
      "const { spawn } = require('node:child_process')",
      "const { writeFileSync } = require('node:fs')",
      `spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], { stdio: 'ignore' })`,
      `writeFileSync(${JSON.stringify(ready)}, 'ready')`,
      'setInterval(() => {}, 1_000)',
    ].join(';')
    const owner = new AbortController()

    try {
      const running = runExternalOptimizerProcess({
        label: 'aborted optimizer',
        tempPrefix: 'agent-eval-aborted-',
        module: 'unused',
        input: {},
        runner: {
          command: process.execPath,
          args: ['-e', parent, '--'],
        },
        timeoutMs: 10_000,
        signal: owner.signal,
      })
      await waitFor(() => existsSync(ready))
      const abortedAt = performance.now()
      owner.abort(new Error('owner cancelled optimizer'))

      await expect(running).rejects.toThrow('owner cancelled optimizer')
      expect(performance.now() - abortedAt).toBeLessThan(1_000)
      await new Promise((resolve) => setTimeout(resolve, 1_100))
      expect(existsSync(marker)).toBe(false)
    } finally {
      owner.abort(new Error('test cleanup'))
      await rm(dir, { recursive: true, force: true })
    }
  }, 10_000)

  it('terminates optimizer descendants after a successful parent exit', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-eval-success-descendant-'))
    const marker = join(dir, 'descendant-survived.txt')
    const descendant = [
      "const { writeFileSync } = require('node:fs')",
      `setTimeout(() => writeFileSync(${JSON.stringify(marker)}, 'survived'), 1_000)`,
      'setTimeout(() => process.exit(0), 2_000)',
    ].join(';')
    const parent = [
      "const { spawn } = require('node:child_process')",
      "const { writeFileSync } = require('node:fs')",
      "const output = process.argv[process.argv.indexOf('--output') + 1]",
      `spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], { stdio: 'ignore' })`,
      "writeFileSync(output, JSON.stringify({ status: 'complete' }))",
      'process.exit(0)',
    ].join(';')

    try {
      await expect(
        runExternalOptimizerProcess({
          label: 'successful optimizer',
          tempPrefix: 'agent-eval-successful-',
          module: 'unused',
          input: {},
          runner: {
            command: process.execPath,
            args: ['-e', parent, '--'],
          },
          timeoutMs: 5_000,
        }),
      ).resolves.toEqual({ status: 'complete' })
      await new Promise((resolve) => setTimeout(resolve, 1_100))
      await expect(readFile(marker, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }, 10_000)

  it('terminates optimizer descendants after a nonzero parent exit', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-eval-failed-descendant-'))
    const marker = join(dir, 'descendant-survived.txt')
    const descendant = [
      "const { writeFileSync } = require('node:fs')",
      `setTimeout(() => writeFileSync(${JSON.stringify(marker)}, 'survived'), 1_000)`,
      'setTimeout(() => process.exit(0), 2_000)',
    ].join(';')
    const parent = [
      "const { spawn } = require('node:child_process')",
      `spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], { stdio: 'ignore' })`,
      "process.stderr.write('PARENT_FAILURE_MARKER\\n')",
      'process.exit(9)',
    ].join(';')

    try {
      await expect(
        runExternalOptimizerProcess({
          label: 'failed optimizer',
          tempPrefix: 'agent-eval-failed-',
          module: 'unused',
          input: {},
          runner: {
            command: process.execPath,
            args: ['-e', parent, '--'],
          },
          timeoutMs: 5_000,
        }),
      ).rejects.toThrow(
        expect.objectContaining({
          message: expect.stringMatching(/exited 9.*PARENT_FAILURE_MARKER/),
        }),
      )
      await new Promise((resolve) => setTimeout(resolve, 1_100))
      await expect(readFile(marker, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }, 10_000)
})

describe('external optimizer model proxy', () => {
  it('rejects reasoning-token allowances that could understate the reservation', async () => {
    for (const maxReasoningTokensPerRequest of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      await expect(
        startRuntimeOwnedModelProxy({
          callRef: 'test-runtime:invalid-reasoning-budget',
          call: async () => {
            throw new Error('must not execute')
          },
          recordExecution: () => undefined,
          model: 'model-a',
          budget: modelBudget({ maxReasoningTokensPerRequest }),
          costLedger: new CostLedger(),
          phase: 'optimizer',
          actor: 'official-library',
        }),
      ).rejects.toThrow('maxReasoningTokensPerRequest must be a non-negative safe integer')
    }
  })

  it('converts an official-optimizer request into one deeply frozen canonical call', async () => {
    const fixture = JSON.parse(
      await readFile(
        new URL('../fixtures/official-optimizer-chat-request.json', import.meta.url),
        'utf8',
      ),
    ) as Record<string, unknown>
    const records: Array<Record<string, unknown>> = []
    let seenCallId = ''
    const proxy = await startRuntimeOwnedModelProxy({
      callRef: 'runtime-profile:official-optimizer',
      call: async (request) => {
        seenCallId = request.callId
        expect(Object.isFrozen(request.request)).toBe(true)
        expect(Object.isFrozen(request.request.messages)).toBe(true)
        expect(Object.isFrozen(request.request.messages[0])).toBe(true)
        expect(request.request).toEqual({
          model: 'model-a',
          messages: fixture.messages,
          maxTokens: 256,
          temperature: 0.2,
        })
        expect(request.endpointFormat).toBe('chat-completions')
        return {
          succeeded: true,
          response: {
            content: '{"edits":[]}',
            usage: {
              promptTokens: 12,
              completionTokens: 5,
              totalTokens: 17,
            },
            costUsd: 0.000022,
            model: request.request.model,
            durationMs: 12,
            finishReason: 'stop',
            raw: { runtime: 'profile' },
          },
          receipt: {
            model: request.request.model,
            inputTokens: 12,
            outputTokens: 5,
            customTokenPricing: {
              inputUsdPerMillion: 1,
              outputUsdPerMillion: 2,
            },
          },
          execution: { kind: 'runtime-profile-call' },
        }
      },
      recordExecution: (record) => records.push(structuredClone(record) as Record<string, unknown>),
      model: 'model-a',
      budget: modelBudget({ maxRequests: 1, maxOutputTokensPerRequest: 256 }),
      costLedger: new CostLedger(),
      phase: 'optimizer',
      actor: 'official-library',
    })

    try {
      const response = await postModel(proxy, fixture)
      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({
        model: 'model-a',
        choices: [{ message: { role: 'assistant', content: '{"edits":[]}' } }],
      })
      expect(seenCallId).toMatch(/\S/)
      expect(records).toMatchObject([{ callId: seenCallId, succeeded: true }])
    } finally {
      await proxy.close()
    }
  })

  it('accepts and preserves a provider-qualified snapshot of the requested model', async () => {
    const servedModel = 'deepseek/deepseek-v4-flash@fp_a18b46594c_prod0820_fp8_kvcache_20260402'
    const ledger = new CostLedger()
    const proxy = await startRuntimeOwnedModelProxy({
      callRef: 'runtime-profile:qualified-snapshot',
      call: async () => ({
        succeeded: true,
        response: {
          content: 'revised',
          usage: { promptTokens: 7, completionTokens: 3, totalTokens: 10 },
          costUsd: null,
          model: servedModel,
          durationMs: 1,
          finishReason: 'stop',
          raw: { owner: 'runtime-profile' },
        },
        receipt: {
          model: servedModel,
          inputTokens: 7,
          outputTokens: 3,
          costUnknown: true,
        },
        execution: { kind: 'runtime-profile-call', model: servedModel },
      }),
      recordExecution: () => {},
      model: 'deepseek-v4-flash',
      budget: modelBudget({ maxRequests: 1, maxOutputTokensPerRequest: 3 }),
      costLedger: ledger,
      phase: 'optimizer',
      actor: 'official-library',
    })

    try {
      const response = await postModel(proxy, {
        model: 'deepseek-v4-flash',
        messages: [],
        max_tokens: 3,
      })
      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({ model: servedModel })
      expect(ledger.list()).toEqual([
        expect.objectContaining({ model: servedModel, inputTokens: 7, outputTokens: 3 }),
      ])
      proxy.assertExecutionComplete()
    } finally {
      await proxy.close()
    }
  })

  it('rejects a provider-qualified snapshot of a different model', async () => {
    const servedModel = 'deepseek/deepseek-v3@fp_other'
    const proxy = await startRuntimeOwnedModelProxy({
      callRef: 'runtime-profile:substituted-snapshot',
      call: async () => ({
        succeeded: true,
        response: {
          content: 'wrong model',
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          costUsd: null,
          model: servedModel,
          durationMs: 1,
          finishReason: 'stop',
          raw: { owner: 'runtime-profile' },
        },
        receipt: {
          model: servedModel,
          inputTokens: 1,
          outputTokens: 1,
          costUnknown: true,
        },
        execution: { kind: 'runtime-profile-call', model: servedModel },
      }),
      recordExecution: () => {},
      model: 'deepseek-v4-flash',
      budget: modelBudget({ maxRequests: 1, maxOutputTokensPerRequest: 1 }),
      costLedger: new CostLedger(),
      phase: 'optimizer',
      actor: 'official-library',
    })

    try {
      const response = await postModel(proxy, {
        model: 'deepseek-v4-flash',
        messages: [],
        max_tokens: 1,
      })
      expect(response.status).toBe(502)
      expect(await response.text()).toContain('model substitution')
      expect(proxy.successfulCompletions()).toBe(0)
    } finally {
      await proxy.close()
    }
  })

  it("rejects a within-family substitute under an explicit 'exact' policy", async () => {
    const servedModel = 'deepseek/deepseek-v3'
    const proxy = await startRuntimeOwnedModelProxy({
      callRef: 'runtime-profile:exact-policy',
      call: async () => ({
        succeeded: true,
        response: {
          content: 'wrong model',
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          costUsd: null,
          model: servedModel,
          durationMs: 1,
          finishReason: 'stop',
          raw: { owner: 'runtime-profile' },
        },
        receipt: {
          model: servedModel,
          inputTokens: 1,
          outputTokens: 1,
          costUnknown: true,
        },
        execution: { kind: 'runtime-profile-call', model: servedModel },
      }),
      recordExecution: () => {},
      model: 'deepseek-v4-flash',
      servedModelPolicy: 'exact',
      budget: modelBudget({ maxRequests: 1, maxOutputTokensPerRequest: 1 }),
      costLedger: new CostLedger(),
      phase: 'optimizer',
      actor: 'official-library',
    })

    try {
      const response = await postModel(proxy, {
        model: 'deepseek-v4-flash',
        messages: [],
        max_tokens: 1,
      })
      expect(response.status).toBe(502)
      expect(await response.text()).toContain('model substitution')
      expect(proxy.successfulCompletions()).toBe(0)
    } finally {
      await proxy.close()
    }
  })

  it("accepts a within-family substitute under 'allow-within-family'", async () => {
    const servedModel = 'deepseek/deepseek-v3'
    const ledger = new CostLedger()
    const proxy = await startRuntimeOwnedModelProxy({
      callRef: 'runtime-profile:within-family-policy',
      call: async () => ({
        succeeded: true,
        response: {
          content: 'substituted answer',
          usage: { promptTokens: 7, completionTokens: 3, totalTokens: 10 },
          costUsd: null,
          model: servedModel,
          durationMs: 1,
          finishReason: 'stop',
          raw: { owner: 'runtime-profile' },
        },
        receipt: {
          model: servedModel,
          inputTokens: 7,
          outputTokens: 3,
          costUnknown: true,
        },
        execution: { kind: 'runtime-profile-call', model: servedModel },
      }),
      recordExecution: () => {},
      model: 'deepseek-v4-flash',
      servedModelPolicy: 'allow-within-family',
      budget: modelBudget({ maxRequests: 1, maxOutputTokensPerRequest: 3 }),
      costLedger: ledger,
      phase: 'optimizer',
      actor: 'official-library',
    })

    try {
      const response = await postModel(proxy, {
        model: 'deepseek-v4-flash',
        messages: [],
        max_tokens: 3,
      })
      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({ model: servedModel })
      expect(proxy.successfulCompletions()).toBe(1)
      expect(ledger.list()).toEqual([
        expect.objectContaining({ model: servedModel, inputTokens: 7, outputTokens: 3 }),
      ])
      proxy.assertExecutionComplete()
    } finally {
      await proxy.close()
    }
  })

  it("rejects a cross-family substitute even under 'allow-within-family'", async () => {
    const servedModel = 'gpt-4.1-mini'
    const proxy = await startRuntimeOwnedModelProxy({
      callRef: 'runtime-profile:within-family-cross-reject',
      call: async () => ({
        succeeded: true,
        response: {
          content: 'wrong provider',
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          costUsd: null,
          model: servedModel,
          durationMs: 1,
          finishReason: 'stop',
          raw: { owner: 'runtime-profile' },
        },
        receipt: {
          model: servedModel,
          inputTokens: 1,
          outputTokens: 1,
          costUnknown: true,
        },
        execution: { kind: 'runtime-profile-call', model: servedModel },
      }),
      recordExecution: () => {},
      model: 'deepseek-v4-flash',
      servedModelPolicy: 'allow-within-family',
      budget: modelBudget({ maxRequests: 1, maxOutputTokensPerRequest: 1 }),
      costLedger: new CostLedger(),
      phase: 'optimizer',
      actor: 'official-library',
    })

    try {
      const response = await postModel(proxy, {
        model: 'deepseek-v4-flash',
        messages: [],
        max_tokens: 1,
      })
      expect(response.status).toBe(502)
      expect(await response.text()).toContain('model substitution')
      expect(proxy.successfulCompletions()).toBe(0)
    } finally {
      await proxy.close()
    }
  })

  it('rejects an unknown servedModelPolicy value', async () => {
    await expect(
      startRuntimeOwnedModelProxy({
        callRef: 'runtime-profile:invalid-policy',
        call: async () => {
          throw new Error('never called')
        },
        recordExecution: () => {},
        model: 'deepseek-v4-flash',
        servedModelPolicy: 'within-family' as never,
        budget: modelBudget({ maxRequests: 1 }),
        costLedger: new CostLedger(),
        phase: 'optimizer',
        actor: 'official-library',
      }),
    ).rejects.toThrow("servedModelPolicy must be 'exact' or 'allow-within-family'")
  })

  it('rejects different served snapshots in the response and receipt', async () => {
    const responseModel = 'deepseek/deepseek-v4-flash@fp_response'
    const receiptModel = 'deepseek/deepseek-v4-flash@fp_receipt'
    const proxy = await startRuntimeOwnedModelProxy({
      callRef: 'runtime-profile:conflicting-snapshots',
      call: async () => ({
        succeeded: true,
        response: {
          content: 'conflicting evidence',
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          costUsd: null,
          model: responseModel,
          durationMs: 1,
          finishReason: 'stop',
          raw: { owner: 'runtime-profile' },
        },
        receipt: {
          model: receiptModel,
          inputTokens: 1,
          outputTokens: 1,
          costUnknown: true,
        },
        execution: { kind: 'runtime-profile-call', model: responseModel },
      }),
      recordExecution: () => {},
      model: 'deepseek-v4-flash',
      budget: modelBudget({ maxRequests: 1, maxOutputTokensPerRequest: 1 }),
      costLedger: new CostLedger(),
      phase: 'optimizer',
      actor: 'official-library',
    })

    try {
      const response = await postModel(proxy, {
        model: 'deepseek-v4-flash',
        messages: [],
        max_tokens: 1,
      })
      expect(response.status).toBe(502)
      expect(await response.text()).toContain(
        'optimizer model response and execution receipt disagree about the served model',
      )
      expect(proxy.successfulCompletions()).toBe(0)
    } finally {
      await proxy.close()
    }
  })

  it('fails loud when the execution owner rejects without evidence', async () => {
    const records: unknown[] = []
    const proxy = await startRuntimeOwnedModelProxy({
      callRef: 'test-runtime:rejects',
      call: async () => {
        throw new Error('owner escaped its typed outcome')
      },
      recordExecution: (record) => records.push(structuredClone(record)),
      model: 'model-a',
      budget: modelBudget({ maxRequests: 1 }),
      costLedger: new CostLedger(),
      phase: 'optimizer',
      actor: 'official-library',
    })

    const response = await postModel(proxy, {
      model: 'model-a',
      messages: [],
      max_tokens: 1,
    })
    expect(response.status).toBe(502)
    expect(await response.text()).toContain('rejected without execution evidence')
    expect(records).toEqual([])
    expect(() => proxy.assertExecutionComplete()).toThrow(
      'returned 0 execution records for 1 invoked calls',
    )
    await expect(proxy.close()).rejects.toThrow('returned 0 execution records for 1 invoked calls')
  })

  it('passes a typed failed outcome to the recorder and keeps unknown USD unknown', async () => {
    const records: Array<Record<string, unknown>> = []
    const ledger = new CostLedger()
    const execution = { kind: 'runtime-profile-call', profileDigest: 'sha256:abc' }
    const proxy = await startRuntimeOwnedModelProxy({
      callRef: 'runtime-profile:sha256:abc',
      call: async (request) => ({
        succeeded: false,
        error: 'runtime execution failed',
        receipt: {
          model: request.request.model,
          inputTokens: 7,
          outputTokens: 0,
          costUnknown: true,
        },
        execution,
      }),
      recordExecution: (record) => records.push(structuredClone(record) as Record<string, unknown>),
      model: 'model-a',
      budget: {
        maxRequests: 1,
        maxRequestBytes: 10_000,
        maxResponseBytes: 10_000,
        maxOutputTokensPerRequest: 10,
      },
      costLedger: ledger,
      phase: 'optimizer',
      actor: 'official-library',
    })

    try {
      const response = await postModel(proxy, {
        model: 'model-a',
        messages: [],
        max_tokens: 1,
      })
      execution.profileDigest = 'mutated-after-call'
      expect(response.status).toBe(502)
      expect(records).toMatchObject([
        {
          sequence: 1,
          callRef: 'runtime-profile:sha256:abc',
          succeeded: false,
          error: 'runtime execution failed',
          execution: { profileDigest: 'sha256:abc' },
        },
      ])
      expect(ledger.list()).toEqual([
        expect.objectContaining({
          inputTokens: 7,
          outputTokens: 0,
          costUnknown: true,
        }),
      ])
      expect(ledger.summary().accountingComplete).toBe(false)
      proxy.assertExecutionComplete()
    } finally {
      await proxy.close()
    }
  })

  it('forwards a successful execution when billed USD is unknown and no dollar cap was guessed', async () => {
    const ledger = new CostLedger()
    const proxy = await startRuntimeOwnedModelProxy({
      callRef: 'runtime-profile:unknown-billing',
      call: async (request) => ({
        succeeded: true,
        response: {
          content: 'revised',
          usage: {
            promptTokens: 7,
            completionTokens: 3,
            totalTokens: 10,
          },
          costUsd: null,
          model: request.request.model,
          durationMs: 0,
          finishReason: 'stop',
          raw: { owner: 'runtime-profile' },
        },
        receipt: {
          model: request.request.model,
          inputTokens: 7,
          outputTokens: 3,
          costUnknown: true,
        },
        execution: { kind: 'runtime-profile-call', billedUsd: null },
      }),
      recordExecution: () => {},
      model: 'model-a',
      budget: {
        maxRequests: 1,
        maxRequestBytes: 10_000,
        maxResponseBytes: 10_000,
        maxOutputTokensPerRequest: 10,
      },
      costLedger: ledger,
      phase: 'optimizer',
      actor: 'official-library',
    })

    try {
      const response = await postModel(proxy, {
        model: 'model-a',
        messages: [],
        max_tokens: 3,
      })
      expect(response.status).toBe(200)
      expect(ledger.summary().costProvenance).toEqual({ kind: 'uncaptured', usd: null })
      expect(ledger.summary().totalCostUsd).toBe(0)
      proxy.assertExecutionComplete()
    } finally {
      await proxy.close()
    }
  })

  it('rejects a dollar cap without exact pricing', async () => {
    await expect(
      startRuntimeOwnedModelProxy({
        callRef: 'runtime-profile:invalid-dollar-cap',
        call: async () => {
          throw new Error('must not execute')
        },
        recordExecution: () => {},
        model: 'model-a',
        budget: {
          maxCostUsd: 1,
          maxRequests: 1,
          maxRequestBytes: 10_000,
          maxResponseBytes: 10_000,
          maxOutputTokensPerRequest: 10,
        },
        costLedger: new CostLedger(),
        phase: 'optimizer',
        actor: 'official-library',
      }),
    ).rejects.toThrow('pricing is required when maxCostUsd is supplied')
  })

  it('meters one typed execution-owner result', async () => {
    const ledger = new CostLedger({ costCeilingUsd: 1 })
    const proxy = await startExternalOptimizerModelProxy({
      model: 'model-a',
      budget: modelBudget({ maxRequests: 2 }),
      costLedger: ledger,
      phase: 'skillopt.optimizer',
      actor: 'skillopt',
      ownerCall: async () => {
        return new Response(
          JSON.stringify({
            id: 'completion-1',
            choices: [{ message: { role: 'assistant', content: 'revised' } }],
            usage: {
              prompt_tokens: 10,
              completion_tokens: 5,
              total_tokens: 15,
            },
          }),
          { headers: { 'content-type': 'application/json' } },
        )
      },
    })

    try {
      const response = await postModel(proxy, {
        model: 'model-a',
        messages: [{ role: 'user', content: 'improve this' }],
        max_tokens: 20,
      })
      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({
        choices: [{ message: { content: 'revised' } }],
      })
      expect(proxy.requestAttempts()).toBe(1)
      expect(ledger.list()).toEqual([
        expect.objectContaining({
          channel: 'optimizer',
          phase: 'skillopt.optimizer',
          actor: 'skillopt',
          model: 'model-a',
          inputTokens: 10,
          outputTokens: 5,
          costUsd: 0.00002,
          costUnknown: false,
          usageUnknown: false,
        }),
      ])
      expect(ledger.list()[0]?.actualCostUsd).toBeUndefined()
      expect(ledger.list()[0]?.pricing).toEqual({
        inputUsdPerThousand: 0.001,
        outputUsdPerThousand: 0.002,
      })
    } finally {
      await proxy.close()
    }
  })

  it('uses a finite nonnegative provider cost without also attaching estimated pricing', async () => {
    const ledger = new CostLedger()
    const providerCosts = [0, 0.000017]
    let providerCalls = 0
    const proxy = await startExternalOptimizerModelProxy({
      model: 'model-a',
      budget: modelBudget({ maxRequests: 2 }),
      costLedger: ledger,
      phase: 'optimizer',
      actor: 'official-library',
      ownerCall: async () => {
        const cost = providerCosts[providerCalls]
        providerCalls += 1
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: 'ok' } }],
            usage: {
              prompt_tokens: 10,
              completion_tokens: 5,
              cost,
            },
          }),
          { headers: { 'content-type': 'application/json' } },
        )
      },
    })

    try {
      for (const expectedCost of providerCosts) {
        const response = await postModel(proxy, {
          model: 'model-a',
          messages: [{ role: 'user', content: 'improve this' }],
          max_tokens: 20,
        })
        expect(response.status).toBe(200)
        const receipt = ledger.list().at(-1)
        expect(receipt).toEqual(
          expect.objectContaining({
            inputTokens: 10,
            outputTokens: 5,
            costUsd: expectedCost,
            actualCostUsd: expectedCost,
            costUnknown: false,
          }),
        )
        expect(receipt?.pricing).toBeUndefined()
      }
    } finally {
      await proxy.close()
    }
  })

  it('uses configured rates when provider cost is negative or non-finite', async () => {
    const ledger = new CostLedger()
    let providerCalls = 0
    const proxy = await startExternalOptimizerModelProxy({
      model: 'model-a',
      budget: modelBudget({ maxRequests: 2 }),
      costLedger: ledger,
      phase: 'optimizer',
      actor: 'official-library',
      ownerCall: async () => {
        providerCalls += 1
        const cost = providerCalls === 1 ? '-1' : '1e999'
        return new Response(
          `{"choices":[{"message":{"content":"ok"}}],"usage":{"prompt_tokens":10,"completion_tokens":5,"cost":${cost}}}`,
          { headers: { 'content-type': 'application/json' } },
        )
      },
    })

    try {
      for (let request = 0; request < 2; request += 1) {
        const response = await postModel(proxy, {
          model: 'model-a',
          messages: [{ role: 'user', content: 'improve this' }],
          max_tokens: 20,
        })
        expect(response.status).toBe(200)
      }
      expect(ledger.list()).toHaveLength(2)
      for (const receipt of ledger.list()) {
        expect(receipt.actualCostUsd).toBeUndefined()
        expect(receipt.costUsd).toBe(0.00002)
        expect(receipt.pricing).toEqual({
          inputUsdPerThousand: 0.001,
          outputUsdPerThousand: 0.002,
        })
      }
    } finally {
      await proxy.close()
    }
  })

  it('keeps non-cached input, cache reads, and cache writes as distinct billed classes', async () => {
    const ledger = new CostLedger()
    const proxy = await startExternalOptimizerModelProxy({
      model: 'model-a',
      budget: modelBudget({
        maxRequests: 1,
        pricing: {
          inputUsdPerMillion: 2,
          cachedInputUsdPerMillion: 0.5,
          cacheWriteUsdPerMillion: 3,
          outputUsdPerMillion: 4,
        },
      }),
      costLedger: ledger,
      phase: 'optimizer',
      actor: 'official-library',
      ownerCall: async () =>
        new Response(
          JSON.stringify({
            choices: [{ message: { content: 'ok' } }],
            usage: {
              prompt_tokens: 100,
              completion_tokens: 10,
              prompt_tokens_details: {
                cached_tokens: 20,
                cache_creation_tokens: 30,
              },
              completion_tokens_details: { reasoning_tokens: 4 },
            },
          }),
          { headers: { 'content-type': 'application/json' } },
        ),
    })

    try {
      const response = await postModel(proxy, {
        model: 'model-a',
        messages: [{ role: 'user', content: 'x'.repeat(200) }],
        max_tokens: 10,
      })
      expect(response.status).toBe(200)
      expect(ledger.list()).toEqual([
        expect.objectContaining({
          inputTokens: 80,
          cachedTokens: 20,
          cacheWriteTokens: 30,
          outputTokens: 10,
          reasoningTokens: 4,
          costUnknown: false,
        }),
      ])
      expect(ledger.list()[0]?.costUsd).toBeCloseTo(0.0003, 12)
      expect(ledger.list()[0]?.actualCostUsd).toBeUndefined()
    } finally {
      await proxy.close()
    }
  })

  it('preserves separate cache-read and cache-write usage from the execution owner', async () => {
    const ledger = new CostLedger()
    const proxy = await startExternalOptimizerModelProxy({
      model: 'model-a',
      budget: modelBudget({
        maxRequests: 1,
        pricing: {
          inputUsdPerMillion: 2,
          cachedInputUsdPerMillion: 0.5,
          cacheWriteUsdPerMillion: 3,
          outputUsdPerMillion: 4,
        },
      }),
      costLedger: ledger,
      phase: 'optimizer',
      actor: 'official-library',
      ownerCall: async () =>
        new Response(
          JSON.stringify({
            choices: [{ message: { content: 'ok' } }],
            usage: {
              prompt_tokens: 50,
              completion_tokens: 10,
              cache_read_input_tokens: 20,
              cache_creation_input_tokens: 30,
              completion_tokens_details: { reasoning_tokens: 4 },
            },
          }),
          { headers: { 'content-type': 'application/json' } },
        ),
    })

    try {
      const response = await postModel(proxy, {
        model: 'model-a',
        messages: [{ role: 'user', content: 'use the cached prefix' }],
        max_tokens: 10,
      })
      expect(response.status).toBe(200)
      expect(ledger.list()).toEqual([
        expect.objectContaining({
          inputTokens: 50,
          cachedTokens: 20,
          cacheWriteTokens: 30,
          outputTokens: 10,
          reasoningTokens: 4,
          costUnknown: false,
        }),
      ])
      expect(ledger.list()[0]?.costUsd).toBeCloseTo(0.00024, 12)
    } finally {
      await proxy.close()
    }
  })

  it('forwards a completion whose usage is internally contradictory, with cost flagged', async () => {
    const ledger = new CostLedger()
    const proxy = await startExternalOptimizerModelProxy({
      model: 'model-a',
      budget: modelBudget({ maxRequests: 1 }),
      costLedger: ledger,
      phase: 'optimizer',
      actor: 'official-library',
      ownerCall: async () =>
        new Response(
          JSON.stringify({
            choices: [{ message: { content: 'ok' } }],
            usage: {
              prompt_tokens: 10,
              completion_tokens: 5,
              prompt_tokens_details: {
                cached_tokens: 8,
                cache_creation_tokens: 3,
              },
            },
          }),
          { headers: { 'content-type': 'application/json' } },
        ),
    })

    try {
      const response = await postModel(proxy, {
        model: 'model-a',
        messages: [],
        max_tokens: 5,
      })
      // The usage is unusable (cached + created input exceeds the total), but
      // the completion is not, so it is forwarded with its cost flagged.
      expect(response.status).toBe(200)
      expect(await response.text()).toContain('ok')
      expect(ledger.list()).toEqual([
        expect.objectContaining({
          costUnknown: true,
          usageUnknown: true,
        }),
      ])
    } finally {
      await proxy.close()
    }
  })

  it('parses Responses API input and output token details', async () => {
    const ledger = new CostLedger()
    const proxy = await startExternalOptimizerModelProxy({
      model: 'model-a',
      budget: modelBudget({
        maxRequests: 1,
        pricing: {
          inputUsdPerMillion: 2,
          cachedInputUsdPerMillion: 0.5,
          cacheWriteUsdPerMillion: 3,
          outputUsdPerMillion: 4,
        },
      }),
      costLedger: ledger,
      phase: 'optimizer',
      actor: 'official-library',
      ownerCall: async () =>
        new Response(
          JSON.stringify({
            id: 'response-1',
            output: [],
            usage: {
              input_tokens: 120,
              output_tokens: 20,
              input_tokens_details: {
                cached_tokens: 50,
                cache_write_tokens: 20,
              },
              output_tokens_details: { reasoning_tokens: 5 },
            },
          }),
          { headers: { 'content-type': 'application/json' } },
        ),
    })

    try {
      const response = await postResponses(proxy, {
        model: 'model-a',
        input: 'improve this',
        max_output_tokens: 20,
      })
      expect(response.status).toBe(200)
      expect(ledger.list()).toEqual([
        expect.objectContaining({
          inputTokens: 70,
          cachedTokens: 50,
          cacheWriteTokens: 20,
          outputTokens: 20,
          reasoningTokens: 5,
          costUnknown: false,
        }),
      ])
      expect(ledger.list()[0]?.costUsd).toBeCloseTo(0.000305, 12)
    } finally {
      await proxy.close()
    }
  })

  it('rejects disallowed requests before any provider call', async () => {
    const ledger = new CostLedger()
    let providerCalls = 0
    const proxy = await startExternalOptimizerModelProxy({
      model: 'model-a',
      budget: modelBudget({ maxRequests: 1, maxOutputTokensPerRequest: 10 }),
      costLedger: ledger,
      phase: 'optimizer',
      actor: 'official-library',
      ownerCall: async () => {
        providerCalls += 1
        return new Response('{}')
      },
    })

    try {
      const wrongModel = await postModel(proxy, {
        model: 'other',
        messages: [],
        max_tokens: 1,
      })
      const tooManyTokens = await postModel(proxy, {
        model: 'model-a',
        messages: [],
        max_tokens: 11,
      })
      const streaming = await postModel(proxy, {
        model: 'model-a',
        messages: [],
        max_tokens: 1,
        stream: true,
      })
      const multipleCompletions = await postModel(proxy, {
        model: 'model-a',
        messages: [],
        max_tokens: 1,
        n: 2,
      })
      const hiddenLargerLimit = await postModel(proxy, {
        model: 'model-a',
        messages: [],
        max_output_tokens: 1,
        max_tokens: 11,
      })
      const reasoningOverride = await postModel(proxy, {
        model: 'model-a',
        messages: [],
        max_tokens: 1,
        reasoning_effort: 'high',
      })
      expect([
        wrongModel.status,
        tooManyTokens.status,
        streaming.status,
        multipleCompletions.status,
        hiddenLargerLimit.status,
        reasoningOverride.status,
      ]).toEqual([400, 400, 400, 400, 400, 400])
      expect(providerCalls).toBe(0)
      expect(ledger.list()).toEqual([])
    } finally {
      await proxy.close()
    }
  })

  it('stops before a request would exceed the optimizer model budget', async () => {
    const ledger = new CostLedger()
    let providerCalls = 0
    const proxy = await startExternalOptimizerModelProxy({
      model: 'model-a',
      budget: modelBudget({
        maxCostUsd: 0.000001,
        maxRequests: 1,
        pricing: {
          inputUsdPerMillion: 10,
          outputUsdPerMillion: 10,
        },
      }),
      costLedger: ledger,
      phase: 'optimizer',
      actor: 'official-library',
      ownerCall: async () => {
        providerCalls += 1
        return new Response('{}')
      },
    })

    try {
      const response = await postModel(proxy, {
        model: 'model-a',
        messages: [{ role: 'user', content: 'x' }],
        max_tokens: 1,
      })
      expect(response.status).toBe(429)
      expect(await response.json()).toEqual({ error: 'optimizer model cost limit reached' })
      expect(providerCalls).toBe(0)
      expect(proxy.requestAttempts()).toBe(0)
    } finally {
      await proxy.close()
    }
  })

  it('applies prior request and cost use to a resumed model budget', async () => {
    const ledger = new CostLedger()
    let providerCalls = 0
    const proxy = await startExternalOptimizerModelProxy({
      model: 'model-a',
      budget: modelBudget({ maxRequests: 2 }),
      costLedger: ledger,
      phase: 'optimizer',
      actor: 'official-library',
      tags: { optimizerRun: 'run', optimizerAttempt: 'attempt-b' },
      initialUsage: { requests: 1, costUsd: 0 },
      ownerCall: async () => {
        providerCalls += 1
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: 'ok' } }],
            usage: { prompt_tokens: 1, completion_tokens: 1 },
          }),
          { headers: { 'content-type': 'application/json' } },
        )
      },
    })

    try {
      const first = await postModel(proxy, {
        model: 'model-a',
        messages: [],
        max_tokens: 1,
      })
      const second = await postModel(proxy, {
        model: 'model-a',
        messages: [],
        max_tokens: 1,
      })
      expect(first.status).toBe(200)
      expect(second.status).toBe(429)
      expect(await second.json()).toEqual({ error: 'optimizer model request limit reached' })
      expect(providerCalls).toBe(1)
      expect(proxy.requestAttempts()).toBe(1)
      expect(ledger.list()[0]?.tags).toEqual({
        optimizerRun: 'run',
        optimizerAttempt: 'attempt-b',
      })
    } finally {
      await proxy.close()
    }
  })

  it('rejects resumed model use that already exceeds the configured limit', async () => {
    await expect(
      startExternalOptimizerModelProxy({
        model: 'model-a',
        budget: modelBudget({ maxRequests: 1 }),
        costLedger: new CostLedger(),
        phase: 'optimizer',
        actor: 'official-library',
        initialUsage: { requests: 2, costUsd: 0 },
      }),
    ).rejects.toThrow('initialUsage exceeds the configured budget')
  })

  it('reserves input at the most expensive configured cache class', async () => {
    const ledger = new CostLedger()
    let providerCalls = 0
    const requestBody = {
      model: 'model-a',
      messages: [{ role: 'user', content: 'x' }],
      max_tokens: 1,
    }
    const requestBytes = Buffer.byteLength(JSON.stringify(requestBody))
    const normalInputMaximum = (requestBytes + 1) / 1_000_000
    const cacheWriteMaximum = (requestBytes * 50 + 1) / 1_000_000
    const proxy = await startExternalOptimizerModelProxy({
      model: 'model-a',
      budget: modelBudget({
        maxCostUsd: (normalInputMaximum + cacheWriteMaximum) / 2,
        maxRequests: 1,
        pricing: {
          inputUsdPerMillion: 1,
          cachedInputUsdPerMillion: 0.1,
          cacheWriteUsdPerMillion: 50,
          outputUsdPerMillion: 1,
        },
      }),
      costLedger: ledger,
      phase: 'optimizer',
      actor: 'official-library',
      ownerCall: async () => {
        providerCalls += 1
        return new Response('{}')
      },
    })

    try {
      const response = await postModel(proxy, requestBody)
      expect(response.status).toBe(429)
      expect(await response.json()).toEqual({ error: 'optimizer model cost limit reached' })
      expect(providerCalls).toBe(0)
      expect(proxy.requestAttempts()).toBe(0)
      expect(ledger.list()).toEqual([])
    } finally {
      await proxy.close()
    }
  })

  it('keeps concurrent reservations within the optimizer model budget', async () => {
    const ledger = new CostLedger()
    const requestBody = {
      model: 'model-a',
      messages: [{ role: 'user', content: 'x' }],
      max_tokens: 1,
    }
    const requestBytes = Buffer.byteLength(JSON.stringify(requestBody))
    const maximumPerRequest = (requestBytes * 2 + 1) / 1_000_000
    let releaseProvider: (() => void) | undefined
    const providerPending = new Promise<void>((resolve) => {
      releaseProvider = resolve
    })
    let providerCalls = 0
    const proxy = await startExternalOptimizerModelProxy({
      model: 'model-a',
      budget: modelBudget({
        maxCostUsd: maximumPerRequest * 1.5,
        maxRequests: 2,
        pricing: {
          inputUsdPerMillion: 1,
          outputUsdPerMillion: 1,
        },
      }),
      costLedger: ledger,
      phase: 'optimizer',
      actor: 'official-library',
      ownerCall: async () => {
        providerCalls += 1
        await providerPending
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: 'ok' } }],
            usage: { prompt_tokens: 1, completion_tokens: 1 },
          }),
          { headers: { 'content-type': 'application/json' } },
        )
      },
    })

    try {
      const first = postModel(proxy, requestBody)
      await waitFor(() => providerCalls === 1)
      const second = await postModel(proxy, requestBody)
      expect(second.status).toBe(429)
      expect(await second.json()).toEqual({ error: 'optimizer model cost limit reached' })
      expect(providerCalls).toBe(1)
      releaseProvider?.()
      expect((await first).status).toBe(200)
      expect(proxy.requestAttempts()).toBe(1)
      expect(ledger.summary().totalCostUsd).toBe(0.000002)
    } finally {
      releaseProvider?.()
      await proxy.close()
    }
  })

  it('forwards a completion whose usage the provider omitted, with cost flagged', async () => {
    const ledger = new CostLedger()
    const proxy = await startExternalOptimizerModelProxy({
      model: 'model-a',
      budget: modelBudget({ maxRequests: 1 }),
      costLedger: ledger,
      phase: 'optimizer',
      actor: 'official-library',
      ownerCall: async () =>
        new Response(JSON.stringify({ choices: [{ message: { content: 'no usage' } }] }), {
          headers: { 'content-type': 'application/json' },
        }),
    })

    try {
      const response = await postModel(proxy, {
        model: 'model-a',
        messages: [],
        max_tokens: 1,
      })
      // The completion is usable, so it reaches the caller; only its cost is
      // unknown, and that is flagged rather than fabricated.
      expect(response.status).toBe(200)
      expect(await response.text()).toContain('no usage')
      expect(proxy.successfulCompletions()).toBe(1)
      expect(ledger.summary().accountingComplete).toBe(false)
      expect(ledger.list()).toEqual([
        expect.objectContaining({ costUnknown: true, usageUnknown: true }),
      ])
      expect(ledger.list()[0]?.actualCostUsd).toBeUndefined()
    } finally {
      await proxy.close()
    }
  })

  it('retains an execution owner receipt that explicitly reports zero usage', async () => {
    const ledger = new CostLedger()
    const proxy = await startExternalOptimizerModelProxy({
      model: 'model-a',
      budget: modelBudget({ maxRequests: 1 }),
      costLedger: ledger,
      phase: 'optimizer',
      actor: 'official-library',
      ownerCall: async () =>
        new Response(
          JSON.stringify({
            choices: [{ message: { content: 'unmetered result' } }],
            usage: { prompt_tokens: 0, completion_tokens: 0 },
          }),
          { headers: { 'content-type': 'application/json' } },
        ),
    })

    try {
      const response = await postModel(proxy, {
        model: 'model-a',
        messages: [],
        max_tokens: 1,
      })
      expect(response.status).toBe(200)
      expect(await response.text()).toContain('unmetered result')
      expect(proxy.successfulCompletions()).toBe(1)
      expect(ledger.summary().accountingComplete).toBe(true)
      expect(ledger.list()).toEqual([
        expect.objectContaining({
          inputTokens: 0,
          outputTokens: 0,
          costUsd: 0,
          costUnknown: false,
          usageUnknown: false,
        }),
      ])
    } finally {
      await proxy.close()
    }
  })

  it('admits a reasoning model whose completion fits the requested limit', async () => {
    const ledger = new CostLedger()
    const proxy = await startExternalOptimizerModelProxy({
      model: 'model-a',
      budget: modelBudget({ maxRequests: 1, maxReasoningTokensPerRequest: 600 }),
      costLedger: ledger,
      phase: 'optimizer',
      actor: 'official-library',
      ownerCall: async () =>
        new Response(
          JSON.stringify({
            choices: [{ message: { content: 'thought hard, answered briefly' } }],
            usage: {
              prompt_tokens: 10,
              completion_tokens: 500,
              completion_tokens_details: { reasoning_tokens: 490 },
            },
          }),
          { headers: { 'content-type': 'application/json' } },
        ),
    })

    try {
      // 500 output tokens of which 490 are reasoning: the completion this cap
      // governs is 10, so the response is admitted rather than rejected.
      const response = await postModel(proxy, {
        model: 'model-a',
        messages: [],
        max_tokens: 20,
      })
      expect(response.status).toBe(200)
      expect(proxy.successfulCompletions()).toBe(1)
    } finally {
      await proxy.close()
    }
  })

  it('rejects output beyond the requested limit after recording actual usage', async () => {
    const ledger = new CostLedger()
    const proxy = await startExternalOptimizerModelProxy({
      model: 'model-a',
      budget: modelBudget({ maxRequests: 1 }),
      costLedger: ledger,
      phase: 'optimizer',
      actor: 'official-library',
      ownerCall: async () =>
        new Response(
          JSON.stringify({
            choices: [{ message: { content: 'too much output' } }],
            usage: { prompt_tokens: 10, completion_tokens: 21 },
          }),
          { headers: { 'content-type': 'application/json' } },
        ),
    })

    try {
      const response = await postModel(proxy, {
        model: 'model-a',
        messages: [],
        max_tokens: 20,
      })
      expect(response.status).toBe(502)
      expect(await response.json()).toEqual({
        error:
          'optimizer model execution reported 21 completion tokens, exceeding requested limit 20',
      })
      expect(proxy.successfulCompletions()).toBe(0)
      const receipts = ledger.list()
      expect(receipts).toEqual([
        expect.objectContaining({
          inputTokens: 10,
          outputTokens: 21,
          costUnknown: false,
          usageUnknown: false,
        }),
      ])
      expect(receipts[0]?.costUsd).toBeCloseTo(0.000052, 12)
    } finally {
      await proxy.close()
    }
  })

  it('returns an owner 429 after exactly one callback invocation', async () => {
    const ledger = new CostLedger()
    let ownerCalls = 0
    const proxy = await startExternalOptimizerModelProxy({
      model: 'model-a',
      budget: modelBudget({ maxRequests: 5 }),
      costLedger: ledger,
      phase: 'optimizer',
      actor: 'official-library',
      ownerCall: async () => {
        ownerCalls += 1
        return new Response(JSON.stringify({ error: { message: 'still rate limited' } }), {
          status: 429,
          headers: { 'content-type': 'application/json' },
        })
      },
    })

    try {
      const response = await postModel(proxy, {
        model: 'model-a',
        messages: [{ role: 'user', content: 'improve this' }],
        max_tokens: 20,
      })
      expect(response.status).toBe(502)
      expect(await response.text()).toContain('test execution owner returned HTTP 429')
      expect(ownerCalls).toBe(1)
      expect(proxy.requestAttempts()).toBe(1)
      expect(proxy.successfulCompletions()).toBe(0)
      proxy.assertExecutionComplete()
    } finally {
      await proxy.close()
    }
  })

  it('returns an owner failure after exactly one callback invocation', async () => {
    const ledger = new CostLedger()
    let ownerCalls = 0
    const proxy = await startExternalOptimizerModelProxy({
      model: 'model-a',
      budget: modelBudget({ maxRequests: 5 }),
      costLedger: ledger,
      phase: 'optimizer',
      actor: 'official-library',
      ownerCall: async () => {
        ownerCalls += 1
        return new Response(JSON.stringify({ error: { message: 'provider exploded' } }), {
          status: 500,
          headers: { 'content-type': 'application/json' },
        })
      },
    })

    try {
      const response = await postModel(proxy, {
        model: 'model-a',
        messages: [{ role: 'user', content: 'improve this' }],
        max_tokens: 20,
      })
      expect(response.status).toBe(502)
      expect(await response.text()).toContain('test execution owner returned HTTP 500')
      expect(ownerCalls).toBe(1)
      expect(proxy.requestAttempts()).toBe(1)
      proxy.assertExecutionComplete()
    } finally {
      await proxy.close()
    }
  })

  it('bounds provider responses before buffering them', async () => {
    const ledger = new CostLedger()
    const proxy = await startExternalOptimizerModelProxy({
      model: 'model-a',
      budget: modelBudget({ maxRequests: 1, maxResponseBytes: 16 }),
      costLedger: ledger,
      phase: 'optimizer',
      actor: 'official-library',
      ownerCall: async () =>
        new Response('x'.repeat(17), {
          headers: { 'content-type': 'application/json' },
        }),
    })

    try {
      const response = await postModel(proxy, {
        model: 'model-a',
        messages: [],
        max_tokens: 1,
      })
      expect(response.status).toBe(502)
      expect(await response.json()).toEqual({
        error: 'optimizer model response exceeds maxResponseBytes',
      })
      expect(ledger.summary().accountingComplete).toBe(false)
    } finally {
      await proxy.close()
    }
  })
})

function post(
  url: string,
  token: string,
  candidate = 'candidate',
  exampleId = 'case',
): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ candidate, exampleId }),
  })
}

function postModel(
  proxy: { baseUrl: string; apiKey: string },
  body: Record<string, unknown>,
): Promise<Response> {
  return fetch(`${proxy.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${proxy.apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  })
}

function postResponses(
  proxy: { baseUrl: string; apiKey: string },
  body: Record<string, unknown>,
): Promise<Response> {
  return fetch(`${proxy.baseUrl}/responses`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${proxy.apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  })
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('condition was not met')
}

function modelBudget(
  overrides: Partial<{
    maxCostUsd: number
    maxRequests: number
    maxRequestBytes: number
    maxResponseBytes: number
    maxOutputTokensPerRequest: number
    maxReasoningTokensPerRequest: number
    pricing: {
      inputUsdPerMillion: number
      cachedInputUsdPerMillion?: number
      cacheWriteUsdPerMillion?: number
      outputUsdPerMillion: number
    }
  }> = {},
) {
  return {
    maxCostUsd: 0.1,
    maxRequests: 2,
    maxRequestBytes: 10_000,
    maxResponseBytes: 10_000,
    maxOutputTokensPerRequest: 100,
    pricing: {
      inputUsdPerMillion: 1,
      outputUsdPerMillion: 2,
    },
    ...overrides,
  }
}
