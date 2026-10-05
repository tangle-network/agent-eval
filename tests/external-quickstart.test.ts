import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { type DeploymentOutcome, InMemoryOutcomeStore } from '../src/rl/index'

const repoRoot = fileURLToPath(new URL('../', import.meta.url))

function quickstartProgram(): string {
  const doc = readFileSync(join(repoRoot, 'docs/quickstart-external.md'), 'utf8')
  const program = doc.match(/<!-- external-quickstart:program -->\s*```ts\n([\s\S]*?)\n```/)?.[1]
  if (!program) throw new Error('The external quickstart must contain its runnable program')
  return program
}

// CI tests before build. Resolve the documented package specifiers to the
// same public source barrels; do not substitute implementations or mock runners.
function sourceImports(program: string): string {
  const barrels: Record<string, string> = {
    '@tangle-network/agent-eval': 'src/index.ts',
    '@tangle-network/agent-eval/contract': 'src/contract/index.ts',
    '@tangle-network/agent-eval/campaign': 'src/campaign/index.ts',
    '@tangle-network/agent-eval/rl': 'src/rl/index.ts',
  }
  return program.replace(/'(@tangle-network\/agent-eval(?:\/[^']+)?)'/g, (_, name: string) => {
    const path = barrels[name]
    if (!path) throw new Error(`Undocumented public import in quickstart: ${name}`)
    return JSON.stringify(pathToFileURL(join(repoRoot, path)).href)
  })
}

function runQuickstart(mode: 'offline' | 'openai', omitUsage = false): string {
  const program = quickstartProgram()
  // Keep tsx's dependency resolution inside this checkout, not the OS temp dir.
  const dir = mkdtempSync(join(repoRoot, '.tmp-external-quickstart-'))
  try {
    const prelude = `
      import assert from 'node:assert/strict'
      let quickstartFetchCalls = 0
      globalThis.fetch = async (input, init) => {
        assert.equal(${JSON.stringify(mode)}, 'openai', 'offline quickstart made a network request')
        const request = new Request(input, init)
        assert.equal(request.url, 'https://api.openai.com/v1/chat/completions')
        assert.equal(request.method, 'POST')
        assert.equal(request.headers.get('authorization'), 'Bearer fixture-key')
        const body = await request.json()
        assert.equal(body.model, 'fixture-model-2026-01-01')
        const ticket = body.messages[1].content.match(/ticket (\\w+)\\./)?.[1]
        assert.ok(ticket, 'the adapter must send the scenario input')
        const text = body.messages[0].content.includes('cite the ticket id')
          ? 'Ticket ' + ticket + ': on it.' : 'On it.'
        quickstartFetchCalls += 1
        return new Response(JSON.stringify({
          id: 'fixture-' + quickstartFetchCalls,
          object: 'chat.completion',
          created: 1,
          model: body.model,
          choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
          ...(${omitUsage} ? {} : {
            usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 },
          }),
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
    `
    const proof = `
      assert.equal(baseline.cells.length, 2)
      assert.equal(improvement.baselineOnHoldout.cells.length, 2)
      assert.equal(improvement.winnerOnHoldout.cells.length, 2)
      for (const campaign of [baseline, improvement.baselineOnHoldout, improvement.winnerOnHoldout]) {
        assert.equal(campaign.cells.filter(cell => cell.error).length, 0)
      }
      assert.equal(baseline.aggregates.byJudge['ticket-id'].mean, 0)
      assert.equal(improvement.winnerOnHoldout.aggregates.byJudge['ticket-id'].mean, 1)
      assert.equal(improvement.gateResult.decision, 'hold', 'two cases must not establish a release')
      assert.equal((await outcomes.forRun(observation.runId)).length, 1)
      if (${JSON.stringify(mode)} === 'openai') {
        assert.ok(quickstartFetchCalls > 0)
        assert.ok(baseline.aggregates.cost.totalCostUsd > 0, 'paid dispatch must record cost')
        assert.ok(improvement.winnerOnHoldout.aggregates.cost.totalCostUsd > 0)
      } else {
        assert.equal(quickstartFetchCalls, 0)
      }
      console.log('external-quickstart-proof:ok')
    `
    const entry = join(dir, 'eval.mts')
    writeFileSync(entry, `${prelude}\n${sourceImports(program)}\n${proof}`)
    return execFileSync(
      process.execPath,
      ['--import', 'tsx', entry, ...(mode === 'openai' ? ['--openai'] : [])],
      {
        cwd: dir,
        encoding: 'utf8',
        timeout: 60_000,
        stdio: 'pipe',
        env: {
          ...process.env,
          LLM_BASE_URL: 'https://api.openai.com/v1',
          LLM_API_KEY: 'fixture-key',
          LLM_MODEL: 'fixture-model-2026-01-01',
          LLM_INPUT_USD_PER_MILLION: '1',
          LLM_OUTPUT_USD_PER_MILLION: '2',
        },
      },
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('external quickstart public contract', () => {
  it('imports both outcome contracts from the public /rl barrel and round-trips an observation', async () => {
    const observation: DeploymentOutcome = {
      runId: 'foreign-agent-run',
      capturedAt: 1,
      metrics: { resolved: 1 },
      source: 'test-fixture',
    }
    const outcomes = new InMemoryOutcomeStore()
    await outcomes.append(observation)
    expect(await outcomes.forRun(observation.runId)).toEqual([observation])
    expect(await outcomes.forRun('unmeasured')).toEqual([])
  })

  it.each(['offline', 'openai'] as const)(
    'runs the documented %s program through the real campaign and improvement APIs',
    (mode) => {
      expect(runQuickstart(mode)).toContain('external-quickstart-proof:ok')
    },
    90_000,
  )

  it('refuses missing usage instead of silently falling back to the offline agent', () => {
    expect(() => runQuickstart('openai', true)).toThrow()
  }, 90_000)
})
