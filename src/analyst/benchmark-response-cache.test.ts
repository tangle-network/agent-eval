import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, win32 } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  isPathInsideDirectory,
  publicBenchmarkCallId,
  readPublicBenchmarkResponseCache,
  writePublicBenchmarkResponseCache,
} from './benchmark-response-cache'

const identity = {
  runIdentitySha256: 'a'.repeat(64),
  caseId: 'codetrace:case-1',
  repetition: 0,
}

describe('public benchmark response cache', () => {
  it('writes and reads one exact successful provider response', () => {
    const directory = mkdtempSync(join(tmpdir(), 'benchmark-response-cache-'))
    const callId = publicBenchmarkCallId(identity)
    const written = writePublicBenchmarkResponseCache(directory, {
      kind: 'agent-eval/public-benchmark-model-response',
      ...identity,
      callId,
      status: 'succeeded',
      response: { report: 'Found one causal step.', findings: [] },
      metadata: {
        providerModel: 'glm-5.2',
        providerDurationMs: 123,
        finishReason: 'stop',
        producedAt: '2026-07-30T00:00:00.000Z',
      },
      receipt: {
        model: 'glm-5.2',
        inputTokens: 100,
        outputTokens: 20,
      },
    })

    expect(written.entrySha256).toMatch(/^[a-f0-9]{64}$/)
    expect(readPublicBenchmarkResponseCache(directory, identity)).toEqual(written)
    expect(
      writePublicBenchmarkResponseCache(directory, {
        kind: 'agent-eval/public-benchmark-model-response',
        ...identity,
        callId,
        status: 'succeeded',
        response: { report: 'Found one causal step.', findings: [] },
        metadata: {
          providerModel: 'glm-5.2',
          providerDurationMs: 123,
          finishReason: 'stop',
          producedAt: '2026-07-30T00:00:00.000Z',
        },
        receipt: {
          model: 'glm-5.2',
          inputTokens: 100,
          outputTokens: 20,
        },
      }),
    ).toEqual(written)
  })

  it('rejects conflicting or modified cache state', () => {
    const directory = mkdtempSync(join(tmpdir(), 'benchmark-response-cache-'))
    const callId = publicBenchmarkCallId(identity)
    writePublicBenchmarkResponseCache(directory, {
      kind: 'agent-eval/public-benchmark-model-response',
      ...identity,
      callId,
      status: 'failed',
      error: { class: 'LlmCallError', message: 'Provider request failed with HTTP 429.' },
      receipt: {
        model: 'glm-5.2',
        inputTokens: 0,
        outputTokens: 0,
        costUnknown: true,
        usageUnknown: true,
      },
    })

    expect(() =>
      writePublicBenchmarkResponseCache(directory, {
        kind: 'agent-eval/public-benchmark-model-response',
        ...identity,
        callId,
        status: 'failed',
        error: { class: 'LlmCallError', message: 'different' },
        receipt: {
          model: 'glm-5.2',
          inputTokens: 0,
          outputTokens: 0,
          costUnknown: true,
          usageUnknown: true,
        },
      }),
    ).toThrow('conflicts with existing file')

    const cached = readPublicBenchmarkResponseCache(directory, identity)
    if (!cached) throw new Error('expected cache entry')
    const [cacheFile] = readdirSync(directory).filter((entry) => entry.endsWith('.json'))
    if (!cacheFile) throw new Error('expected cache file')
    const path = join(directory, cacheFile)
    const value = JSON.parse(readFileSync(path, 'utf8'))
    value.error.message = 'modified'
    writeFileSync(path, `${JSON.stringify(value)}\n`)
    expect(() => readPublicBenchmarkResponseCache(directory, identity)).toThrow(
      'digest does not match',
    )
  })

  it('rejects provider statuses outside the HTTP range', () => {
    const directory = mkdtempSync(join(tmpdir(), 'benchmark-response-cache-'))
    const callId = publicBenchmarkCallId(identity)

    expect(() =>
      writePublicBenchmarkResponseCache(directory, {
        kind: 'agent-eval/public-benchmark-model-response',
        ...identity,
        callId,
        status: 'failed',
        error: {
          class: 'LlmCallError',
          message: 'Provider request failed.',
          status: 99,
        },
        receipt: {
          model: 'glm-5.2',
          inputTokens: 0,
          outputTokens: 0,
          costUnknown: true,
          usageUnknown: true,
        },
      }),
    ).toThrow(/status/)
  })

  it('binds the call id to the run, case, and repetition', () => {
    expect(publicBenchmarkCallId(identity)).toBe(publicBenchmarkCallId(identity))
    expect(publicBenchmarkCallId({ ...identity, repetition: 1 })).not.toBe(
      publicBenchmarkCallId(identity),
    )
    expect(publicBenchmarkCallId({ ...identity, caseId: 'codetrace:case-2' })).not.toBe(
      publicBenchmarkCallId(identity),
    )
  })

  it('checks Windows cache paths with Windows separators', () => {
    expect(
      isPathInsideDirectory('C:\\cache\\benchmark', 'C:\\cache\\benchmark\\response.json', win32),
    ).toBe(true)
    expect(isPathInsideDirectory('C:\\cache\\benchmark', 'C:\\cache\\response.json', win32)).toBe(
      false,
    )
    expect(isPathInsideDirectory('C:\\cache\\benchmark', 'D:\\response.json', win32)).toBe(false)
  })
})
