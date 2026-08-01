import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  analystInstructionsOverrideFromText,
  effectiveAnalystProtocolSha256,
  readAnalystInstructionsOverride,
} from './benchmark-instructions-override'
import { createPublicBenchmarkDirectRunner } from './benchmark-public-model'
import { publicBenchmarkProtocolSha256 } from './benchmark-public-prompt'
import { createPublicBenchmarkRlmRunner } from './benchmark-public-rlm'
import { sha256Digest } from './benchmark-verification-artifacts'

describe('effectiveAnalystProtocolSha256', () => {
  it('is byte-identical to the stock protocol digest when no override is active', () => {
    for (const dataset of ['codetracebench', 'agentrx'] as const) {
      expect(effectiveAnalystProtocolSha256(dataset)).toBe(publicBenchmarkProtocolSha256(dataset))
      expect(effectiveAnalystProtocolSha256(dataset, undefined)).toBe(
        publicBenchmarkProtocolSha256(dataset),
      )
    }
  })

  it('changes the digest deterministically when an override is active', () => {
    const override = analystInstructionsOverrideFromText('Optimized analyst instructions.')
    const digest = effectiveAnalystProtocolSha256('codetracebench', override)
    expect(digest).toMatch(/^[a-f0-9]{64}$/)
    expect(digest).not.toBe(publicBenchmarkProtocolSha256('codetracebench'))
    expect(effectiveAnalystProtocolSha256('codetracebench', override)).toBe(digest)
    expect(digest).toBe(
      sha256Digest(
        JSON.stringify({
          kind: 'analyst-instructions-override-protocol',
          dataset: 'codetracebench',
          stockProtocolSha256: publicBenchmarkProtocolSha256('codetracebench'),
          rlmInstructionsSha256: override.sha256,
        }),
      ),
    )
    const other = analystInstructionsOverrideFromText('Different instructions.')
    expect(effectiveAnalystProtocolSha256('codetracebench', other)).not.toBe(digest)
    expect(effectiveAnalystProtocolSha256('agentrx', override)).not.toBe(digest)
  })
})

describe('analystInstructionsOverrideFromText', () => {
  it('hashes the exact override text', () => {
    const override = analystInstructionsOverrideFromText('candidate text')
    expect(override).toEqual({ text: 'candidate text', sha256: sha256Digest('candidate text') })
  })

  it('rejects blank text', () => {
    expect(() => analystInstructionsOverrideFromText('  \n')).toThrow(/non-empty instruction text/)
  })
})

describe('readAnalystInstructionsOverride', () => {
  it('reads override text and its digest from a file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'analyst-instructions-override-'))
    const path = join(dir, 'candidate.txt')
    await writeFile(path, 'File-backed instructions.\n')
    expect(readAnalystInstructionsOverride(path)).toEqual({
      text: 'File-backed instructions.\n',
      sha256: sha256Digest('File-backed instructions.\n'),
    })
  })

  it('fails loudly on an unreadable file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'analyst-instructions-override-'))
    const missing = join(dir, 'missing.txt')
    expect(() => readAnalystInstructionsOverride(missing)).toThrow(missing)
  })

  it('fails loudly on an empty file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'analyst-instructions-override-'))
    const path = join(dir, 'empty.txt')
    await writeFile(path, '   \n')
    expect(() => readAnalystInstructionsOverride(path)).toThrow(/is empty/)
  })
})

describe('createPublicBenchmarkRlmRunner with an instructions override', () => {
  it('accepts the override while its abstention fallback keeps the stock direct prompt', () => {
    // The direct runner throws on any override, so constructing the recursive
    // runner (which builds its direct fallback internally) proves the fallback
    // receives a config with the override stripped.
    expect(() =>
      createPublicBenchmarkRlmRunner('codetracebench', {
        baseUrl: 'http://127.0.0.1:3355/v1',
        apiKey: 'key',
        model: 'test-model',
        maxOutputTokens: 1024,
        timeoutMs: 1000,
        pricing: { inputUsdPerMillion: 1, outputUsdPerMillion: 2 },
        instructionsOverride: analystInstructionsOverrideFromText('candidate'),
      }),
    ).not.toThrow()
  })
})

describe('createPublicBenchmarkDirectRunner with an instructions override', () => {
  it('refuses the override instead of silently running the stock prompt', () => {
    expect(() =>
      createPublicBenchmarkDirectRunner('codetracebench', {
        baseUrl: 'http://127.0.0.1:3355/v1',
        apiKey: 'key',
        model: 'test-model',
        maxOutputTokens: 1024,
        timeoutMs: 1000,
        instructionsOverride: analystInstructionsOverrideFromText('candidate'),
      }),
    ).toThrow(/requires the dspy-rlm runner/)
  })
})
