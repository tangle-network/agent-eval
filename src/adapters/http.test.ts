import { describe, expect, it } from 'vitest'
import type { DispatchContext, Scenario } from '../contract'
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
