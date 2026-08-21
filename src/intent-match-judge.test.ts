import { describe, expect, it } from 'vitest'

import { type ChatClient, createChatClient } from './analyst/chat-client'
import { CostLedger } from './cost-ledger'
import { runIntentMatchJudge } from './intent-match-judge'

/** Caller-owned transport: agent-eval issues no provider request itself. */
function answering(answers: Array<object | string | Error>): ChatClient {
  let call = 0
  return createChatClient({
    transport: 'custom',
    defaultModel: 'mock',
    maximumAttempts: 1,
    chat: async () => {
      const spec = answers[Math.min(call, answers.length - 1)]!
      call++
      if (spec instanceof Error) throw spec
      return {
        content: typeof spec === 'string' ? spec : JSON.stringify(spec),
        usage: { promptTokens: 30, completionTokens: 20, totalTokens: 50, captured: true },
        costUsd: 0.004,
        model: 'mock',
        servedModel: 'mock',
        durationMs: 1,
        raw: {},
      }
    },
  })
}

describe('runIntentMatchJudge', () => {
  it('returns available=false when no input artifact', async () => {
    const r = await runIntentMatchJudge(
      { userRequest: 'build a thing', sourceFiles: [] },
      { chat: answering([{}]) },
    )
    expect(r.available).toBe(false)
    expect(r.error).toBe('no input artifact')
    expect(r.score).toBe(0)
  })

  it('returns score and evidence on a happy model call', async () => {
    const costLedger = new CostLedger()
    const r = await runIntentMatchJudge(
      {
        userRequest: 'build an NFT mint page',
        sourceFiles: [
          {
            path: 'src/App.tsx',
            content:
              'import { MintWidget } from "./MintWidget"\nexport default function App() { return <MintWidget /> }',
          },
        ],
      },
      {
        chat: answering([
          {
            score: 0.92,
            evidence: 'src/App.tsx renders <MintWidget /> with mint-1/mint-5 buttons',
          },
        ]),
        costLedger,
      },
    )

    expect(r.available).toBe(true)
    expect(r.score).toBe(0.92)
    expect(r.evidence).toContain('MintWidget')
    expect(costLedger.list()).toEqual([
      expect.objectContaining({ channel: 'judge', actor: 'intent-match' }),
    ])
  })

  it('soft-fails (available=false) when the transport throws', async () => {
    const r = await runIntentMatchJudge(
      { userRequest: 'x', sourceFiles: [{ path: 'a.ts', content: 'x' }] },
      { chat: answering([new Error('500 upstream error')]) },
    )
    expect(r.available).toBe(false)
    expect(r.error).toMatch(/500|upstream/i)
  })

  it('keeps the settled cost when the model answer is not JSON', async () => {
    const costLedger = new CostLedger()
    const r = await runIntentMatchJudge(
      { userRequest: 'x', sourceFiles: [{ path: 'a.ts', content: 'x' }] },
      { chat: answering(['not json at all']), costLedger },
    )
    // The call completed and was billed; only the answer was unusable. Reporting
    // the spend as unknown here would hide money the run actually cost.
    expect(r.available).toBe(false)
    expect(r.costUsd).toBe(0.004)
    expect(costLedger.list()).toEqual([expect.objectContaining({ costUsd: 0.004 })])
  })

  it('clamps score to [0, 1]', async () => {
    const r = await runIntentMatchJudge(
      { userRequest: 'x', sourceFiles: [{ path: 'a.ts', content: 'x' }] },
      { chat: answering([{ score: 1.5, evidence: 'overshoot' }]) },
    )
    expect(r.score).toBe(1)
  })
})
