import { appendFile, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createRunCostLedger, fsCampaignStorage } from '../campaign'
import type { CampaignCostMeter, DispatchContext, Scenario } from '../contract'
import { httpDispatch, runDispatchServer } from './http'

interface EchoScenario extends Scenario {
  text: string
}

interface EchoArtifact {
  echoed: string
  aborted: boolean
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

function ctxFor(cellId: string, signal?: AbortSignal): DispatchContext {
  return {
    cellId,
    runAttemptId: `${cellId}-attempt`,
    rep: 0,
    seed: 1,
    signal: signal ?? new AbortController().signal,
  } as DispatchContext
}

describe('runDispatchServer + httpDispatch', () => {
  it('completes a dispatch without aborting when the client stays connected', async () => {
    const handle = await runDispatchServer<EchoScenario, EchoArtifact>({
      dispatch: async (scenario, ctx) => {
        // The dispatch outlives the request-body read; the server must not
        // abort just because the body finished arriving.
        await new Promise((resolve) => setTimeout(resolve, 50))
        return { echoed: scenario.text, aborted: ctx.signal.aborted }
      },
      port: 0,
      auth: 'test-token',
    })
    try {
      const dispatch = httpDispatch<EchoScenario, EchoArtifact>({
        url: `http://127.0.0.1:${handle.port}/dispatch`,
        auth: 'test-token',
        retries: 0,
      })
      const artifact = await dispatch({ id: 's1', kind: 'echo', text: 'hello' }, ctxFor('s1:0'))
      expect(artifact).toEqual({ echoed: 'hello', aborted: false })
    } finally {
      await handle.close()
    }
  })

  it('aborts the dispatch signal when the client disconnects mid-flight', async () => {
    let observedAbort = false
    const dispatchStarted = deferred()
    const abortSeen = deferred()
    const handle = await runDispatchServer<EchoScenario, EchoArtifact>({
      dispatch: async (scenario, ctx) => {
        dispatchStarted.resolve()
        await new Promise<void>((resolve) => {
          ctx.signal.addEventListener('abort', () => resolve(), { once: true })
          setTimeout(resolve, 2_000)
        })
        observedAbort = ctx.signal.aborted
        abortSeen.resolve()
        return { echoed: scenario.text, aborted: ctx.signal.aborted }
      },
      port: 0,
      auth: 'test-token',
    })
    try {
      const clientAbort = new AbortController()
      const dispatch = httpDispatch<EchoScenario, EchoArtifact>({
        url: `http://127.0.0.1:${handle.port}/dispatch`,
        auth: 'test-token',
        retries: 0,
      })
      const inFlight = dispatch(
        { id: 's2', kind: 'echo', text: 'goodbye' },
        ctxFor('s2:0', clientAbort.signal),
      )
      await dispatchStarted.promise
      clientAbort.abort()
      await expect(inFlight).rejects.toThrow()
      await abortSeen.promise
      expect(observedAbort).toBe(true)
    } finally {
      await handle.close()
    }
  })
})

// These cases use real loopback sockets and filesystem effects. Ledger amounts
// are synthetic; this checks transport/accounting, not provider economics.
describe('remote dispatch retries and receipts', () => {
  it('does not retry a terminal authorization refusal', async () => {
    let requests = 0
    const handle = await runDispatchServer({
      port: 0,
      host: '127.0.0.1',
      auth: 'expected-token',
      dispatch: async () => ({ ok: true }),
      onRequest: () => {
        requests++
      },
    })
    try {
      const dispatch = httpDispatch({
        url: `http://127.0.0.1:${handle.port}/dispatch`,
        auth: 'wrong-token',
        retries: 2,
      })
      await expect(dispatch({ id: 's', kind: 'fixture' }, ctxFor('s:0'))).rejects.toThrow('(401)')
      expect(requests).toBe(1)
    } finally {
      await handle.close()
    }
  })

  it('does not redispatch an operation that failed after a filesystem effect by default', async () => {
    const root = await mkdtemp(join(tmpdir(), 'http-dispatch-effect-'))
    const output = join(root, 'effects.txt')
    const handle = await runDispatchServer({
      port: 0,
      host: '127.0.0.1',
      auth: false,
      dispatch: async () => {
        await appendFile(output, 'effect\n')
        throw new Error('Failure after the operation')
      },
    })
    try {
      const dispatch = httpDispatch({ url: `http://127.0.0.1:${handle.port}/dispatch` })
      await expect(dispatch({ id: 's', kind: 'fixture' }, ctxFor('s:0'))).rejects.toThrow('(500)')
      expect(await readFile(output, 'utf8')).toBe('effect\n')
    } finally {
      await handle.close()
      await rm(root, { recursive: true, force: true })
    }
  })

  it.each(['failed', 'cancelled', 'settlement-refused'] as const)(
    'does not repeat completed work when %s',
    async (outcome) => {
      const root = await mkdtemp(join(tmpdir(), 'http-dispatch-paid-'))
      const ledger = (name: string, ceiling: number) =>
        createRunCostLedger({
          runDir: join(root, name),
          storage: fsCampaignStorage(),
          costCeilingUsd: ceiling,
        })
      const worker = ledger('worker', 1)
      const coordinator = ledger('coordinator', outcome === 'settlement-refused' ? 0.01 : 1)
      const meter = (owner: typeof worker): CampaignCostMeter => ({
        runPaidCall: (input) =>
          owner.runPaidCall({
            phase: 'http-fixture',
            ...input,
            channel: input.channel ?? 'agent',
          }),
      })
      let requests = 0
      const handle = await runDispatchServer({
        port: 0,
        host: '127.0.0.1',
        auth: false,
        contextFactory: async (body, signal) => ({
          ...ctxFor(body.cellId, signal),
          ...body,
          cost: meter(worker),
        }),
        dispatch: async (_scenario, context) => {
          const result = await context.cost.runPaidCall({
            actor: 'filesystem-operation',
            model: 'fixture/model',
            maximumCharge: { externallyEnforcedMaximumUsd: 0.05 },
            execute: async () => {
              await appendFile(join(root, 'effect.txt'), 'effect\n')
            },
            receipt: () => ({
              model: 'fixture/model',
              inputTokens: 1,
              outputTokens: 1,
              actualCostUsd: 0.05,
            }),
          })
          if (!result.succeeded) throw result.error
          if (outcome === 'cancelled') throw new DOMException('Worker cancelled', 'AbortError')
          if (outcome === 'failed') throw new Error('Worker failed after charged work')
          return { ok: true }
        },
        onRequest: () => {
          requests++
        },
      })
      try {
        const dispatch = httpDispatch({
          url: `http://127.0.0.1:${handle.port}/dispatch`,
          retries: 2,
        })
        await expect(
          dispatch(
            { id: 's', kind: 'fixture' },
            {
              ...ctxFor('s:0'),
              cost: meter(coordinator),
            },
          ),
        ).rejects.toThrow()
        expect(requests).toBe(1)
        expect(await readFile(join(root, 'effect.txt'), 'utf8')).toBe('effect\n')
        expect(worker.summary().totalCostUsd).toBe(0.05)
        if (outcome !== 'settlement-refused') {
          expect(coordinator.summary().totalCostUsd).toBe(0.05)
          expect(coordinator.list()).toHaveLength(1)
        }
      } finally {
        await handle.close()
        await rm(root, { recursive: true, force: true })
      }
    },
  )
})
