import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { isProposedCandidate, type ProposeContext, type ProposedCandidate } from '../types'
import { haloDriver } from './halo'

function asCandidate(v: unknown): ProposedCandidate {
  if (!isProposedCandidate(v as never)) throw new Error('expected a ProposedCandidate')
  return v as ProposedCandidate
}

// A fake `halo` binary: ignores args, prints canned findings to stdout — so we
// test the WRAPPING (CLI invocation + findings → surface application) without
// the real engine or any network/LLM spend.
function fakeHalo(stdout: string, exitCode = 0): string {
  const dir = mkdtempSync(join(tmpdir(), 'fakehalo-'))
  const bin = join(dir, 'halo')
  writeFileSync(bin, `#!/bin/sh\ncat <<'EOF'\n${stdout}\nEOF\nexit ${exitCode}\n`)
  chmodSync(bin, 0o755)
  return bin
}

// Stub fetch → an OpenAI-compatible chat-completion returning a revised prompt.
function stubFetch(revisedPrompt: string): typeof fetch {
  return (async () =>
    new Response(JSON.stringify({ choices: [{ message: { content: revisedPrompt } }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch
}

const ctx = (currentSurface: string): ProposeContext =>
  ({
    currentSurface,
    history: [],
    findings: [],
    populationSize: 1,
    generation: 1,
    signal: new AbortController().signal,
  }) as unknown as ProposeContext

describe('haloDriver — wraps the real halo-engine CLI as an ImprovementDriver', () => {
  it('runs halo on the resolved traces and applies its findings to the prompt surface', async () => {
    const driver = haloDriver({
      baseUrl: 'https://router.example/v1',
      apiKey: 'sk-test',
      haloBin: fakeHalo(
        'FINDING: api_predictor under-fetched the spotify APIs; widen the whitelist.',
      ),
      resolveTraces: () =>
        '{"name":"agent.Assistant","trace_id":"t1"}\n{"name":"function.spotify__login"}',
      fetchImpl: stubFetch('IMPROVED PROMPT: always fetch spotify APIs before planning.'),
    })
    const out = await driver.propose(ctx('BASE PROMPT: do the task.'))
    expect(out).toHaveLength(1)
    const c = asCandidate(out[0])
    expect(c.surface).toBe('IMPROVED PROMPT: always fetch spotify APIs before planning.')
    expect(c.label).toBe('halo')
    // HALO's real findings are preserved verbatim in the rationale (attribution).
    expect(c.rationale).toContain('api_predictor under-fetched')
  })

  it('is an ImprovementDriver of kind "halo" (drops into compareDrivers)', () => {
    const d = haloDriver({ baseUrl: 'https://x/v1', resolveTraces: () => 'x' })
    expect(d.kind).toBe('halo')
    expect(typeof d.propose).toBe('function')
  })

  it('FAILS LOUD when there are no traces (never fabricates a candidate)', async () => {
    const driver = haloDriver({
      baseUrl: 'https://x/v1',
      haloBin: fakeHalo('unused'),
      resolveTraces: () => '   ',
      fetchImpl: stubFetch('x'),
    })
    await expect(driver.propose(ctx('p'))).rejects.toThrow(/no OTLP traces/)
  })

  it('FAILS LOUD when the halo engine errors (no silent swallow)', async () => {
    const driver = haloDriver({
      baseUrl: 'https://x/v1',
      haloBin: fakeHalo('boom', 3),
      resolveTraces: () => '{"name":"x"}',
      fetchImpl: stubFetch('x'),
    })
    await expect(driver.propose(ctx('p'))).rejects.toThrow(/halo-engine/)
  })

  it('returns no candidate when the applied surface is unchanged (no fake lift)', async () => {
    const driver = haloDriver({
      baseUrl: 'https://x/v1',
      haloBin: fakeHalo('FINDING: nothing actionable.'),
      resolveTraces: () => '{"name":"x"}',
      fetchImpl: stubFetch('BASE PROMPT: do the task.'), // identical to parent
    })
    const out = await driver.propose(ctx('BASE PROMPT: do the task.'))
    expect(out).toHaveLength(0)
  })
})
