import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer, type RequestListener, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { runCampaign } from '../../src/campaign/index'

const roots: string[] = []
const peers: Server[] = []
afterEach(async () => {
  await Promise.all(
    peers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections()
          server.close(() => resolve())
        }),
    ),
  )
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function root() {
  const path = mkdtempSync(join(tmpdir(), 'campaign-adapter-'))
  roots.push(path)
  return path
}

async function peer(handler: RequestListener) {
  const server = createServer(handler)
  peers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('missing peer socket')
  return `http://127.0.0.1:${address.port}`
}

interface Artifact {
  pass: boolean
  skipped?: boolean
}
const scenario = (id: string) => ({ id, kind: 'http-probe' })

it('retains failed HTTP artifacts across retries and streams each final persisted cell once, including cache hits', async () => {
  const requests = new Map<string, number>()
  let releaseRetry: (() => void) | undefined
  const skipSettled = new Promise<void>((resolve) => {
    releaseRetry = resolve
  })
  const url = await peer((request, response) => {
    const id = request.url!.slice(1)
    const attempt = (requests.get(id) ?? 0) + 1
    requests.set(id, attempt)
    response.setHeader('Content-Type', 'application/json')
    const answer = () =>
      response.end(
        JSON.stringify(
          id === 'skip'
            ? { pass: false, skipped: true }
            : { pass: attempt > (id === 'recover' ? 2 : 1) },
        ),
      )
    if (id === 'retry' && attempt > 1) void skipSettled.then(answer)
    else answer()
  })
  const runDir = root()
  const observed: string[] = []
  const options = {
    scenarios: [scenario('retry'), scenario('skip'), scenario('recover')],
    runDir,
    dispatchRef: 'measured-http-v1',
    expectUsage: 'off' as const,
    tracing: 'off' as const,
    dispatch: async (entry: { id: string }, context: { signal: AbortSignal }) =>
      (await (await fetch(`${url}/${entry.id}`, { signal: context.signal })).json()) as Artifact,
    dispatchTimeoutMs: 5000,
    cellRetry: {
      attempts: 2,
      retryable: () => false,
      retryResult: (value: Artifact) => !value.pass && !value.skipped,
    },
    onCellSettled: (cell: {
      cellId: string
      scenarioId: string
      artifact: Artifact
      cached: boolean
    }) => {
      const latest = JSON.parse(
        readFileSync(
          join(runDir, cell.cellId.replace(/[^a-zA-Z0-9_-]/g, '_'), 'latest-attempt.json'),
          'utf8',
        ),
      )
      const persisted = JSON.parse(
        readFileSync(
          join(
            runDir,
            cell.cellId.replace(/[^a-zA-Z0-9_-]/g, '_'),
            'attempts',
            latest.runAttemptId,
            `attempt-${latest.number}`,
            'result.json',
          ),
          'utf8',
        ),
      )
      expect(persisted.artifact).toEqual(cell.artifact)
      observed.push(cell.scenarioId)
      if (cell.scenarioId === 'skip') releaseRetry!()
    },
  }
  const first = await runCampaign(options)
  expect(requests.get('retry')).toBe(2)
  expect(requests.get('skip')).toBe(1)
  expect(observed.indexOf('skip')).toBeLessThan(observed.indexOf('retry'))
  expect([...observed].sort()).toEqual(['recover', 'retry', 'skip'])
  const retried = first.cells.find((cell) => cell.scenarioId === 'retry')!
  expect(retried.retryAttempts).toBe(1)
  const cellDir = join(runDir, retried.cellId.replace(/[^a-zA-Z0-9_-]/g, '_'))
  const firstAttempt = join(
    cellDir,
    'attempts',
    retried.attempt!.runAttemptId,
    'attempt-1',
    'result.json',
  )
  expect(JSON.parse(readFileSync(firstAttempt, 'utf8')).artifact).toEqual({ pass: false })
  const exhausted = first.cells.find((cell) => cell.scenarioId === 'recover')!
  expect(exhausted.artifact).toEqual({ pass: false })
  expect(exhausted.retryAttempts).toBe(1)
  const exhaustedPath = join(
    runDir,
    exhausted.cellId.replace(/[^a-zA-Z0-9_-]/g, '_'),
    'attempts',
    exhausted.attempt!.runAttemptId,
    'attempt-2',
    'result.json',
  )
  expect(JSON.parse(readFileSync(exhaustedPath, 'utf8')).artifact).toEqual({ pass: false })
  observed.length = 0
  const resumed = await runCampaign(options)
  expect(resumed.cells.find((cell) => cell.scenarioId === 'recover')).toMatchObject({
    cached: false,
    artifact: { pass: true },
  })
  expect(observed.sort()).toEqual(['recover', 'retry', 'skip'])
  expect(Object.fromEntries(requests)).toEqual({ retry: 2, skip: 1, recover: 3 })
  const cached = await runCampaign(options)
  expect(cached.cells.every((cell) => cell.cached)).toBe(true)
  expect(Object.fromEntries(requests)).toEqual({ retry: 2, skip: 1, recover: 3 })
  await expect(
    runCampaign({ ...options, cellRetry: { ...options.cellRetry, retryResult: true as never } }),
  ).rejects.toThrow('retryResult must be a function')
  const rejectedDir = root()
  const predicateError = new Error('caller rejected measured result')
  await expect(
    runCampaign({
      ...options,
      runDir: rejectedDir,
      scenarios: [scenario('predicate-error')],
      cellRetry: {
        ...options.cellRetry,
        retryResult: () => {
          throw predicateError
        },
      },
    }),
  ).rejects.toBe(predicateError)
  const rejectedCell = join(rejectedDir, 'predicate-error_0')
  const rejectedAttempt = JSON.parse(
    readFileSync(join(rejectedCell, 'latest-attempt.json'), 'utf8'),
  )
  const retained = JSON.parse(
    readFileSync(
      join(rejectedCell, 'attempts', rejectedAttempt.runAttemptId, 'attempt-1', 'result.json'),
      'utf8',
    ),
  )
  expect(retained.artifact).toEqual({ pass: false })
})

it('persists the failing cell and drains a cancelled sibling before rejecting with the original error', async () => {
  let admitted: (() => void) | undefined
  const active = new Promise<void>((resolve) => {
    admitted = resolve
  })
  let retiring: (() => void) | undefined
  const retirement = new Promise<void>((resolve) => {
    retiring = resolve
  })
  let releaseRetirement: (() => void) | undefined
  const url = await peer((request, response) => {
    if (request.url === '/active') admitted!()
    else if (request.url === '/fail') void active.then(() => response.writeHead(503).end())
    else if (request.url === '/retire') {
      releaseRetirement = () => response.end('retired')
      retiring!()
    } else response.writeHead(404).end()
  })
  const failure = new Error('peer rejected scenario')
  let settled = false
  const running = runCampaign({
    scenarios: [scenario('active'), scenario('fail')],
    runDir: root(),
    maxConcurrency: 2,
    abortOnCellError: true,
    dispatchShutdownTimeoutMs: 5000,
    expectUsage: 'off',
    tracing: 'off',
    dispatch: async (entry, context) => {
      if (entry.id === 'fail') {
        await fetch(`${url}/fail`, { signal: context.signal })
        throw failure
      }
      try {
        await fetch(`${url}/active`, { signal: context.signal })
        return 'finished'
      } finally {
        await fetch(`${url}/retire`)
      }
    },
  })
  void running.then(
    () => {
      settled = true
    },
    () => {
      settled = true
    },
  )
  await retirement
  expect(settled).toBe(false)
  releaseRetirement!()
  await expect(running).rejects.toBe(failure)
})

it('keeps pre-aborted and cooperatively drained mid-queue cancellations as partial campaign results', async () => {
  let calls = 0
  let admit: (() => void) | undefined
  const admitted = new Promise<void>((resolve) => {
    admit = resolve
  })
  const url = await peer((_request, _response) => {
    calls++
    admit!()
  })
  const options = {
    scenarios: [scenario('active'), scenario('queued')],
    runDir: root(),
    maxConcurrency: 1,
    expectUsage: 'off' as const,
    tracing: 'off' as const,
    dispatch: async (entry: { id: string }, context: { signal: AbortSignal }) =>
      await (await fetch(`${url}/${entry.id}`, { signal: context.signal })).text(),
  }
  const before = new AbortController()
  before.abort(new Error('pre-aborted owner'))
  expect((await runCampaign({ ...options, signal: before.signal })).cells).toEqual([])
  expect(calls).toBe(0)
  const during = new AbortController()
  const running = runCampaign({ ...options, signal: during.signal })
  await admitted
  during.abort(new Error('owner stopped'))
  const result = await running
  expect(calls).toBe(1)
  expect(result.cells.map((cell) => cell.scenarioId)).toEqual(['active'])
  expect(result.cells[0]!.error).toContain('owner stopped')
})
