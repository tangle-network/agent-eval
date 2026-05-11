/**
 * Real-creds end-to-end test for `runPersonaEval`.
 *
 * Gated on `TANGLE_ROUTER_API_KEY`. Runs against the live router using a
 * trivial persona to confirm:
 *
 *   1. raws.jsonl receives at least one redacted provider event
 *   2. traces.jsonl receives the LLM span
 *   3. records.jsonl receives a `RunRecord`
 *   4. manifest.json contains a real commit SHA + paths
 *
 * Skipped when the env var is unset so CI doesn't burn dollars.
 */

import { describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { runPersonaEval } from '../src/persona'
import type { PersonaRunner, PersonaScorer } from '../src/persona'
import { callLlm } from '../src/llm-client'
import { validateRunRecord } from '../src/run-record'

const HAS_CREDS = Boolean(process.env.OPENAI_API_KEY ?? process.env.TANGLE_ROUTER_API_KEY)
const describeMaybe = HAS_CREDS ? describe : describe.skip

describeMaybe('runPersonaEval — real-creds (gated on OPENAI_API_KEY|TANGLE_ROUTER_API_KEY)', () => {
  it('produces a valid artifact with raws + traces + records when calling a live model', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'persona-live-'))
    const useOpenAI = Boolean(process.env.OPENAI_API_KEY)
    const apiKey = (useOpenAI ? process.env.OPENAI_API_KEY : process.env.TANGLE_ROUTER_API_KEY)!
    const baseUrl = useOpenAI ? 'https://api.openai.com/v1' : 'https://router.tangle.tools/v1'
    const model = useOpenAI ? 'gpt-4o-mini-2024-07-18' : 'gpt-4o-mini'
    const recordedModel = 'gpt-4o-mini@2024-07-18'
    const provider = useOpenAI ? 'openai' : 'tangle-router'

    const runner: PersonaRunner<string, string> = async function* (ctx) {
      const result = await callLlm(
        {
          model,
          messages: [
            { role: 'system', content: 'You are terse. One sentence only.' },
            { role: 'user', content: ctx.turn.input as string },
          ],
          maxTokens: 64,
          temperature: 0,
        },
        ctx.capture.llmOpts,
      )
      yield { kind: 'model', model: recordedModel }
      yield { kind: 'text', text: result.content }
      yield { kind: 'output', output: result.content }
      yield {
        kind: 'cost',
        usd: result.costUsd ?? 0,
        tokenUsage: {
          input: result.usage.promptTokens,
          output: result.usage.completionTokens,
        },
      }
    }

    const scorer: PersonaScorer<string> = ({ finalText }) => ({
      pass: finalText.length > 0,
      score: finalText.length > 0 ? 1 : 0,
    })

    const artifact = await runPersonaEval({
      personas: [{
        id: 'tangent-smoke',
        label: 'router-smoke',
        turns: [{ id: 't0', input: 'Say "ok".' }],
      }],
      runner,
      scorer,
      artifactDir: dir,
      llmOpts: { baseUrl, apiKey, provider },
      captureIntegrity: {
        assertLlmRoute: true,
        assertRunCaptured: true,
        rawProviderSinkRequired: false,
      },
      recordDefaults: { model: recordedModel },
    })

    expect(artifact.personas).toHaveLength(1)
    const cell = artifact.personas[0]!
    expect(cell.outcome.pass).toBe(true)
    expect(cell.record.tokenUsage.input).toBeGreaterThan(0)
    expect(cell.record.tokenUsage.output).toBeGreaterThan(0)

    // Verify on-disk shapes.
    const records = await fs.readFile(artifact.manifest.artifactPaths.records, 'utf8')
    expect(records.trim().length).toBeGreaterThan(0)
    const lines = records.trim().split('\n').filter(Boolean)
    for (const line of lines) {
      // Each record must validate at the agent-eval boundary.
      const parsed = JSON.parse(line)
      const rec = validateRunRecord(parsed)
      expect(rec.scenarioId).toBe('tangent-smoke')
    }
    const traces = await fs.readFile(artifact.manifest.artifactPaths.traces, 'utf8')
    expect(traces.length).toBeGreaterThan(0)
    const manifest = JSON.parse(await fs.readFile(artifact.manifest.artifactPaths.manifest, 'utf8'))
    expect(manifest.commitSha.length).toBeGreaterThan(0)
    // Raw provider events must have landed in raws.jsonl.
    const raws = await fs.readFile(artifact.manifest.artifactPaths.raws, 'utf8')
    expect(raws.length).toBeGreaterThan(0)
  }, 60_000)
})
