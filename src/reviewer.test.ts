import { describe, expect, it, vi } from 'vitest'
import { CostLedger } from './cost-ledger'
import { buildReviewerPrompt, createDefaultReviewer } from './reviewer'

const BASE_INPUT = {
  shot: 2,
  userRequest: 'build an NFT mint page with supply counter, mint button',
  traceSummary: 'tool calls: {Write: 3, Edit: 2}, errors: none',
  verification: {
    blendedScore: 0.5,
    allPass: false,
    failCount: 2,
    failingLayers: ['typecheck', 'semantic'],
  },
  memory: [
    {
      shot: 1,
      confidence: 0.85,
      shouldContinue: true,
      observations: 'worker wrote App.tsx',
      diagnosis: 'wagmi imports wrong',
      nextShotInstruction: 'fix imports',
    },
  ],
}

describe('buildReviewerPrompt', () => {
  it('emits system + user with all context blocks present', () => {
    const { system, user } = buildReviewerPrompt(BASE_INPUT)
    expect(system).toMatch(/senior-engineer-grade reviewer/)
    expect(user).toMatch(/shot 2 of the review loop/)
    expect(user).toMatch(/build an NFT mint page/)
    expect(user).toMatch(/tool calls:/)
    expect(user).toMatch(/blendedScore: 0.50/)
    expect(user).toMatch(/failing layers: typecheck, semantic/)
    expect(user).toMatch(/shot 1 — confidence=0.85/)
    expect(user).toMatch(/STRICT JSON/)
  })

  it('injects extraContext block when provided', () => {
    const { user } = buildReviewerPrompt({
      ...BASE_INPUT,
      extraContext: 'workdir: src/App.tsx, src/MintButton.tsx',
    })
    expect(user).toMatch(/EXTRA CONTEXT/)
    expect(user).toMatch(/src\/MintButton\.tsx/)
  })

  it('omits extraContext block entirely when not provided', () => {
    const { user } = buildReviewerPrompt(BASE_INPUT)
    expect(user).not.toMatch(/EXTRA CONTEXT/)
  })

  it('shows "(no prior shots)" when memory is empty', () => {
    const { user } = buildReviewerPrompt({ ...BASE_INPUT, memory: [] })
    expect(user).toMatch(/\(no prior shots\)/)
  })

  it('signals no-failing-layers when verification.failingLayers is empty', () => {
    const { user } = buildReviewerPrompt({
      ...BASE_INPUT,
      verification: { blendedScore: 1, allPass: true, failCount: 0, failingLayers: [] },
    })
    expect(user).toMatch(/no layers failing/)
  })

  it('trailingContext renders at the end when provided', () => {
    const { user } = buildReviewerPrompt({
      ...BASE_INPUT,
      trailingContext: 'leaf_id: nft-mint-page',
    })
    expect(user).toMatch(/TRAILING CONTEXT[\s\S]+leaf_id: nft-mint-page/)
  })
})

describe('createDefaultReviewer', () => {
  function mockFetch(responses: Array<object | { status: number; body: string }>) {
    let i = 0
    return (async () => {
      const r = responses[Math.min(i++, responses.length - 1)]!
      if ('status' in r && 'body' in r) {
        return new Response((r as { body: string }).body, {
          status: (r as { status: number }).status,
        })
      }
      return new Response(
        JSON.stringify({
          model: 'mock',
          choices: [{ message: { content: JSON.stringify(r) } }],
          usage: { total_tokens: 100 },
          _response_cost: 0.001,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }) as unknown as typeof fetch
  }

  it('calls LLM, parses structured output, returns ReviewerOutput', async () => {
    const costLedger = new CostLedger()
    const fetch = mockFetch([
      {
        observations: 'worker wrote 3 files via Edit, no errors logged, build failed on typecheck.',
        diagnosis: 'wagmi v2 API misuse — useAccount from wrong import path, ts will not compile.',
        nextShotInstruction:
          'FIX THESE: 1) change `import { useAccount } from "wagmi/core"` to `from "wagmi"` in src/App.tsx',
        shouldContinue: true,
        confidence: 0.85,
      },
    ])
    const reviewer = createDefaultReviewer({ model: 'mock-model', llm: { fetch }, costLedger })
    const r = await reviewer(BASE_INPUT)
    expect(r.available).toBe(true)
    expect(r.shot).toBe(2)
    expect(r.confidence).toBeCloseTo(0.85)
    expect(r.shouldContinue).toBe(true)
    expect(r.diagnosis).toMatch(/wagmi v2/)
    expect(r.costUsd).toBeCloseTo(0.001)
    expect(costLedger.list()).toEqual([
      expect.objectContaining({ channel: 'analyst', actor: 'default-reviewer', costUsd: 0.001 }),
    ])
  })

  it('clamps confidence to [0, 1]', async () => {
    const fetch = mockFetch([
      {
        observations: 'x'.repeat(30),
        diagnosis: 'y'.repeat(30),
        nextShotInstruction: 'z'.repeat(50),
        shouldContinue: false,
        confidence: 1.5,
      },
    ])
    const r = await createDefaultReviewer({ model: 'm', llm: { fetch } })(BASE_INPUT)
    expect(r.confidence).toBe(1)
  })

  it('soft-fails available=false on LLM error; uses soft-fail defaults', async () => {
    const fetch = mockFetch([{ status: 500, body: 'upstream oops' }])
    const r = await createDefaultReviewer({
      model: 'm',
      llm: { fetch, maxRetries: 1 },
    })(BASE_INPUT)
    expect(r.available).toBe(false)
    expect(r.error).toMatch(/500/)
    expect(r.confidence).toBe(0.3)
    expect(r.shouldContinue).toBe(true)
    expect(r.nextShotInstruction).toMatch(/Inspect the verification findings/)
  })

  it('honors custom soft-fail defaults', async () => {
    const fetch = mockFetch([{ status: 503, body: 'rate-limited' }])
    const r = await createDefaultReviewer({
      model: 'm',
      llm: { fetch, maxRetries: 1 },
      softFailDefaults: { shouldContinue: false, confidence: 0 },
    })(BASE_INPUT)
    expect(r.shouldContinue).toBe(false)
    expect(r.confidence).toBe(0)
  })

  it('custom promptBuilder is used instead of default', async () => {
    const fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content:
                    '{"observations":"' +
                    'o'.repeat(25) +
                    '","diagnosis":"' +
                    'd'.repeat(25) +
                    '","nextShotInstruction":"' +
                    'i'.repeat(50) +
                    '","shouldContinue":false,"confidence":0.5}',
                },
              },
            ],
            usage: {},
          }),
          { status: 200 },
        ),
    ) as unknown as typeof globalThis.fetch
    const custom = vi.fn((_: unknown) => ({ system: 'CUSTOM-SYS', user: 'CUSTOM-USER' }))
    const reviewer = createDefaultReviewer({
      model: 'm',
      llm: { fetch },
      promptBuilder: custom as never,
    })
    await reviewer(BASE_INPUT)
    expect(custom).toHaveBeenCalledOnce()
    const call = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0]! as unknown as [
      string,
      RequestInit,
    ]
    const body = JSON.parse(call[1].body as string)
    expect(body.messages[0].content).toBe('CUSTOM-SYS')
    expect(body.messages[1].content).toBe('CUSTOM-USER')
  })
})
