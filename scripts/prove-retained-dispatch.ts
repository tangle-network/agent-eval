/** Real filesystem/child-process persistence proof. No model calls or synthetic storage. */
import assert from 'node:assert/strict'
import { execFileSync, fork } from 'node:child_process'
import { once } from 'node:events'
import { appendFile, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { createRetainedDispatch } from '../src/campaign/index.js'

const output = z.object({ ok: z.boolean(), text: z.string() }).strict()
const limits = { development: 2, audit: 1 }
const scope = { executor: 'proof-v1', purpose: 'retained filesystem/child-process behavior only' }
function open(runDir: string) {
  return createRetainedDispatch({ runDir, scope, limits, parse: (value) => output.parse(value) })
}
function effect(file: string) {
  // A real child process performs a durable external write. No provider/network substitute.
  execFileSync(process.execPath, ['-e', `const fs=require('node:fs'); const f=fs.openSync(process.argv[1],'a'); fs.writeSync(f,'executed\\n'); fs.fsyncSync(f); fs.closeSync(f);`, file])
  return { ok: true, text: 'executed' }
}
async function child(runDir: string, mode: string) {
  const result = await open(runDir).run({ lane: 'development', input: { task: 'one' }, dispatch: async () => {
    const value = effect(path.join(runDir, 'external-effects.txt'))
    if (mode === 'hold') {
      process.send?.({ stage: 'external-completed' })
      await new Promise<void>((resolve) => process.once('message', () => resolve()))
    }
    return value
  } })
  process.send?.({ stage: 'result', result })
  process.disconnect?.()
}
function startChild(runDir: string, mode: string) {
  const processHandle = fork(fileURLToPath(import.meta.url), ['--child', runDir, mode], {
    execArgv: ['--import', 'tsx'], stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  })
  let errors = ''
  processHandle.stderr?.on('data', (chunk) => { errors += String(chunk) })
  const waitMessage = (stage: string) => new Promise<any>((resolve, reject) => {
    const onMessage = (message: any) => { if (message.stage === stage) { clear(); resolve(message) } }
    const onExit = (code: number | null, signal: string | null) => { clear(); reject(new Error(`Child ended before ${stage}: ${code}/${signal} ${errors}`)) }
    const timer = setTimeout(() => { clear(); processHandle.kill(); reject(new Error(`Child timeout at ${stage}: ${errors}`)) }, 15000)
    const clear = () => { clearTimeout(timer); processHandle.off('message', onMessage); processHandle.off('exit', onExit) }
    processHandle.on('message', onMessage); processHandle.on('exit', onExit)
  })
  return { processHandle, waitMessage }
}
async function proof() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'retained-dispatch-'))
  const checks: string[] = []
  try {
    const runDir = path.join(root, 'concurrent')
    open(runDir)
    const owner = startChild(runDir, 'hold')
    await owner.waitMessage('external-completed')
    const contender = startChild(runDir, 'complete')
    const refused = await contender.waitMessage('result')
    assert.equal(refused.result.succeeded, false)
    assert.equal(refused.result.reason, 'outcome_unknown')
    owner.processHandle.send({ continue: true })
    const completed = await owner.waitMessage('result')
    assert.equal(completed.result.succeeded, true)
    assert.equal(await readFile(path.join(runDir, 'external-effects.txt'), 'utf8'), 'executed\n')
    const replay = await open(runDir).run({ lane: 'development', input: { task: 'one' }, dispatch: async () => { throw new Error('must not dispatch replay') } })
    assert.equal(replay.succeeded && replay.replayed, true)
    checks.push('independent-process contention and completed replay execute once')
    const killedDir = path.join(root, 'killed')
    open(killedDir)
    const killed = startChild(killedDir, 'hold')
    await killed.waitMessage('external-completed')
    const exited = once(killed.processHandle, 'exit')
    killed.processHandle.kill('SIGKILL')
    await exited
    const resumed = open(killedDir)
    const unknown = await resumed.run({ lane: 'development', input: { task: 'one' }, dispatch: async () => effect(path.join(killedDir, 'external-effects.txt')) })
    assert.equal(!unknown.succeeded && unknown.reason, 'outcome_unknown')
    assert.equal(await readFile(path.join(killedDir, 'external-effects.txt'), 'utf8'), 'executed\n')
    assert.equal(resumed.committed().get('development'), 1)
    checks.push('SIGKILL after external effect keeps unknown intent and allowance without redispatch')
    const second = await resumed.run({ lane: 'development', input: 'two', dispatch: async () => ({ ok: false, text: 'measured failure' }) })
    assert.equal(second.succeeded && second.value.ok, false)
    const exhausted = await resumed.run({ lane: 'development', input: 'three', dispatch: async () => { throw new Error('reserve was spent') } })
    assert.equal(!exhausted.succeeded && exhausted.reason, 'allowance_exhausted')
    const audit = await resumed.run({ lane: 'audit', input: 'independent', dispatch: async () => ({ ok: true, text: 'audited' }) })
    assert.equal(audit.succeeded, true)
    const failedReplay = await open(killedDir).run({ lane: 'development', input: 'two', dispatch: async () => { throw new Error('failed outcomes are retained') } })
    assert.equal(failedReplay.succeeded && failedReplay.replayed && !failedReplay.value.ok, true)
    checks.push('development exhaustion cannot spend reserved audit; measured failures replay')
    assert.throws(() => createRetainedDispatch({ runDir: killedDir, scope: { ...scope, executor: 'changed' }, limits, parse: output.parse }), /scope or allowances/)
    assert.throws(() => createRetainedDispatch({ runDir: killedDir, scope, limits: { ...limits, development: 10 }, parse: output.parse }), /scope or allowances/)
    const cancelled = new AbortController(); cancelled.abort()
    await assert.rejects(open(path.join(root, 'cancelled')).run({ lane: 'audit', input: 'cancelled', signal: cancelled.signal, dispatch: async () => { throw new Error('must not run') } }))
    assert.equal(open(path.join(root, 'cancelled')).committed().get('audit'), 0)
    checks.push('scope drift, allowance reset and pre-dispatch cancellation refuse work')
    const same = open(path.join(root, 'same-instance'))
    let count = 0
    const dispatch = async () => { count++; await new Promise(resolve => setImmediate(resolve)); return { ok: true, text: 'same' } }
    const duplicates = await Promise.all(Array.from({ length: 20 }, () => same.run({ lane: 'development', input: 'same', dispatch })))
    assert.equal(count, 1)
    assert.ok(duplicates.every(r => r.succeeded))
    checks.push('twenty same-process callers share one in-flight dispatch')
    const canonical = open(path.join(root, 'canonical'))
    await canonical.run({ lane: 'development', input: 'a', dispatch: async () => ({ ok: true, text: 'same JSON' }) })
    await canonical.run({ lane: 'development', input: 'b', dispatch: async () => ({ text: 'same JSON', ok: true }) })
    assert.equal((await readdir(path.join(root, 'canonical', 'dispatch-results'))).filter(f => f.endsWith('.json')).length, 1)
    checks.push('equivalent JSON receipts share canonical storage without collisions')
    const files = await readdir(path.join(runDir, 'dispatch-results'))
    const resultFile = files.find(f => f.endsWith('.json'))!
    await writeFile(path.join(runDir, 'dispatch-results', resultFile), '{"ok":false,"text":"tampered"}')
    await assert.rejects(open(runDir).run({ lane: 'development', input: { task: 'one' }, dispatch: async () => { throw new Error('must not dispatch') } }), /digest mismatch/)
    await appendFile(path.join(killedDir, 'dispatches.jsonl'), '{"torn":')
    assert.throws(() => open(killedDir), /torn/)
    checks.push('altered receipt and torn history refuse reuse rather than create fresh work')
    console.log(JSON.stringify({ passed: true, checks, external: 'real child processes and filesystem, including SIGKILL', modelCalls: 0 }, null, 2))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}
if (process.argv[2] === '--child') await child(process.argv[3]!, process.argv[4]!)
else await proof()
