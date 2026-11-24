/**
 * A graph that stops itself settles `no-winner` / `stopped` with no error. The
 * run report reads the stop from the last node in `result.tree.nodes` and the
 * `reason` of that node's output blob, so the cause is on the RUN-REPORT line
 * instead of `failure=none recorded`. An agent node's output is the settled
 * object; a command node's output is the command envelope, its settled value
 * under `json`.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { hashCanonical } from '../ledger-core/canonical'
import { analyzeSupervisorRunSources } from './analyze'
import { renderSupervisorRunHeadline } from './render'
import { readRuntimeSupervisorRun } from './runtime-reader'

const ROOT = 'delivery-graph-stop'
const AT = '2026-11-24T10:00:00.000Z'
const HEAD = 'a'.repeat(40)
const STOP_OUTPUT = { unchanged: true, head: HEAD, prior: HEAD, reason: 'verify pass=false' }
const BUILD_OUTPUT = { built: true, head: HEAD }
const STOP_REF = hashCanonical(STOP_OUTPUT)
const BUILD_REF = hashCanonical(BUILD_OUTPUT)
const STOP_BLOB = `sha256-${STOP_REF.slice('sha256:'.length)}.json`
const COMMAND_STOP_OUTPUT = {
  pass: false,
  exitCode: 1,
  output: 'verify pass=false\n',
  json: { unchanged: true, head: HEAD, prior: HEAD, reason: 'verify pass=false', note: '' },
}

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'graph-stop-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const node = (n: number, label: string, outRef: string) => ({
  id: `${ROOT}:s${n}`,
  parent: ROOT,
  label,
  outRef,
  status: 'done',
  settledAt: Date.parse(AT) + n,
  spent: { iterations: 1, ms: 1, tokens: { input: 0, output: 0 }, usd: 0 },
})

async function writeRun(stopOutput: Record<string, unknown> = STOP_OUTPUT): Promise<void> {
  const stopRef = hashCanonical(stopOutput)
  const event = (seq: number, body: Record<string, unknown>) =>
    JSON.stringify({ kind: 'event', root: ROOT, event: { ...body, seq, at: AT } })
  const journal = [
    JSON.stringify({ kind: 'begin', root: ROOT, at: AT }),
    event(0, { kind: 'spawned', id: ROOT, label: 'root', runtime: 'cli' }),
    event(1, { kind: 'spawned', id: `${ROOT}:s0`, parent: ROOT, label: 'build', runtime: 'cli' }),
    event(2, { kind: 'settled', id: `${ROOT}:s0`, status: 'done', outRef: BUILD_REF }),
    event(3, { kind: 'spawned', id: `${ROOT}:s1`, parent: ROOT, label: 'repair-head' }),
    event(4, { kind: 'settled', id: `${ROOT}:s1`, status: 'done', outRef: stopRef }),
  ]
  await writeFile(join(dir, 'spawn-journal.jsonl'), `${journal.join('\n')}\n`)
  await writeFile(
    join(dir, 'result.json'),
    JSON.stringify({
      kind: 'no-winner',
      reason: 'stopped',
      tree: {
        root: ROOT,
        inFlight: 0,
        nodes: [node(0, 'build', BUILD_REF), node(1, 'repair-head', stopRef)],
      },
    }),
  )
  await mkdir(join(dir, 'blobs'))
  await writeFile(
    join(dir, 'blobs', `sha256-${BUILD_REF.slice('sha256:'.length)}.json`),
    JSON.stringify(BUILD_OUTPUT),
  )
  await writeFile(
    join(dir, 'blobs', `sha256-${stopRef.slice('sha256:'.length)}.json`),
    JSON.stringify(stopOutput),
  )
}

async function headline(): Promise<{ text: string; gaps: readonly string[] }> {
  const report = analyzeSupervisorRunSources(await readRuntimeSupervisorRun(dir), () =>
    Date.parse(AT),
  )
  return { text: renderSupervisorRunHeadline(report), gaps: report.gaps }
}

it('reports the stopping node and its reason as the graph-stop failure', async () => {
  await writeRun()
  const { text, gaps } = await headline()
  expect(text).toContain(
    '  status=no-winner source=runtime-result reason=stopped failure=graph-stop repair-head: verify pass=false\n',
  )
  expect(gaps.some((gap) => gap.startsWith('failure:'))).toBe(false)
})

it('reads the reason under json when a command node stops the graph', async () => {
  await writeRun(COMMAND_STOP_OUTPUT)
  const { text, gaps } = await headline()
  expect(text).toContain(
    '  status=no-winner source=runtime-result reason=stopped failure=graph-stop repair-head: verify pass=false\n',
  )
  expect(gaps.some((gap) => gap.startsWith('failure:'))).toBe(false)
})

it('keeps failure=none recorded and names the missing blob when it is removed', async () => {
  await writeRun()
  await rm(join(dir, 'blobs', STOP_BLOB))
  const { text, gaps } = await headline()
  expect(text).toContain(
    '  status=no-winner source=runtime-result reason=stopped failure=none recorded\n',
  )
  expect(gaps).toContain(
    `failure: graph stop: repair-head: output blob blobs/${STOP_BLOB} is missing`,
  )
})

it('lets an error record outrank the stop', async () => {
  await writeRun()
  await writeFile(
    join(dir, 'failure.json'),
    JSON.stringify({ runId: ROOT, at: AT, error: { name: 'Error', message: 'first attempt' } }),
  )
  const { text } = await headline()
  expect(text).toContain(
    `reason=stopped failure=Error: first attempt [runtime-failure at ${AT}, earlier attempt]\n`,
  )
})
