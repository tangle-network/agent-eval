import { describe, expect, it, vi } from 'vitest'
import { createSemanticConceptJudgeAdapter } from './adapters'
import { AnalystRegistry } from './registry'

describe('createSemanticConceptJudgeAdapter', () => {
  it('records one provider receipt instead of copying one cost onto every finding', async () => {
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({
          model: 'gpt-4o',
          choices: [
            {
              message: {
                content: JSON.stringify({
                  summary: 'all three concepts are absent',
                  concepts: ['one', 'two', 'three'].map((concept) => ({
                    concept,
                    present: false,
                    score: 0,
                    evidence: `${concept} is absent from src/App.tsx`,
                    severity: 'major',
                  })),
                }),
              },
            },
          ],
          usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
          _response_cost: 0.25,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )) as unknown as typeof globalThis.fetch
    const registry = new AnalystRegistry()
    registry.register(
      createSemanticConceptJudgeAdapter({
        options: { model: 'gpt-4o', llm: { fetch: fetchImpl } },
      }),
    )

    const result = await registry.run('semantic-cost', {
      custom: {
        'semantic-concept-judge': {
          userRequest: 'Implement one, two, and three.',
          sourceFiles: [{ path: 'src/App.tsx', content: 'export default function App() {}' }],
          expectedConcepts: [{ name: 'one' }, { name: 'two' }, { name: 'three' }],
        },
      },
    })

    expect(result.findings).toHaveLength(3)
    expect(result.findings.every((finding) => finding.metadata?.cost_usd === undefined)).toBe(true)
    expect(result.per_analyst[0]).toMatchObject({
      status: 'ok',
      findings_count: 3,
      cost_usd: 0.25,
      usage: {
        calls: 1,
        tokens: { input: 100, output: 50 },
        cost: { kind: 'observed', usd: 0.25 },
      },
    })
    expect(result.total_cost_usd).toBe(0.25)
  })

  it('waits for a cancelled provider to return its bill before completing the run', async () => {
    const controller = new AbortController()
    let markStarted!: () => void
    const started = new Promise<void>((resolve) => {
      markStarted = resolve
    })
    let finishProvider!: (response: Response) => void
    const provider = new Promise<Response>((resolve) => {
      finishProvider = resolve
    })
    const registry = new AnalystRegistry()
    registry.register(
      createSemanticConceptJudgeAdapter({
        settlementTimeoutMs: 1_000,
        options: {
          model: 'gpt-4o',
          maxTokens: 64,
          llm: {
            baseUrl: 'https://provider.invalid/v1',
            maxRetries: 1,
            fetch: async () => {
              markStarted()
              return provider
            },
          },
        },
      }),
    )

    let completed = false
    const run = registry
      .run('semantic-cancel', semanticInput(), {
        signal: controller.signal,
        budget: { totalUsd: 1 },
      })
      .then((result) => {
        completed = true
        return result
      })
    await started
    controller.abort(new DOMException('cancelled', 'AbortError'))
    await Promise.resolve()
    expect(completed).toBe(false)

    finishProvider(providerResponse(0.25))
    const result = await run

    expect(result.per_analyst[0]?.usage).toEqual({
      calls: 1,
      tokens: { input: 100, output: 50 },
      cost: { kind: 'observed', usd: 0.25 },
    })
    expect(result.total_cost_usd).toBe(0.25)
  })

  it('bounds settlement when a cancelled provider never returns', async () => {
    const controller = new AbortController()
    const log = vi.fn()
    let markStarted!: () => void
    const started = new Promise<void>((resolve) => {
      markStarted = resolve
    })
    const registry = new AnalystRegistry({ log })
    registry.register(
      createSemanticConceptJudgeAdapter({
        settlementTimeoutMs: 1,
        options: {
          model: 'gpt-4o',
          maxTokens: 64,
          llm: {
            baseUrl: 'https://provider.invalid/v1',
            maxRetries: 1,
            fetch: async () => {
              markStarted()
              return new Promise<Response>(() => {})
            },
          },
        },
      }),
    )

    const run = registry.run('semantic-stuck-cancel', semanticInput(), {
      signal: controller.signal,
      budget: { totalUsd: 1 },
    })
    await started
    controller.abort(new DOMException('cancelled', 'AbortError'))
    const result = await run

    expect(result.per_analyst[0]?.usage).toEqual({
      calls: 1,
      tokens: null,
      cost: { kind: 'uncaptured', usd: null },
      knownCostUsd: 0,
    })
    expect(log).toHaveBeenCalledWith(
      '[semantic-concept-judge] semantic-concept judge provider settlement timed out',
      expect.objectContaining({ pending_calls: 1, timeout_ms: 1 }),
    )
  })
})

function semanticInput() {
  return {
    custom: {
      'semantic-concept-judge': {
        userRequest: 'Implement one.',
        sourceFiles: [{ path: 'src/App.tsx', content: 'export default function App() {}' }],
        expectedConcepts: [{ name: 'one' }],
      },
    },
  }
}

function providerResponse(costUsd: number): Response {
  return new Response(
    JSON.stringify({
      model: 'gpt-4o',
      choices: [
        {
          message: {
            content: JSON.stringify({
              summary: 'the requested concept is absent',
              concepts: [
                {
                  concept: 'one',
                  present: false,
                  score: 0,
                  evidence: 'one is absent from src/App.tsx',
                  severity: 'major',
                },
              ],
            }),
          },
        },
      ],
      usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
      _response_cost: costUsd,
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )
}
