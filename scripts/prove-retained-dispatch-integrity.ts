/** Real filesystem and process boundaries. No provider calls or mocked storage. */
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { createRetainedDispatch } from '../src/campaign/index.js'

const self = fileURLToPath(import.meta.url)
const resultSchema = z.object({ ok: z.boolean(), text: z.string() }).strict()
const scope = { executor: 'retained-integrity-proof-v1' }
const limits = { development: 2, audit: 1 }
const input = { task: 'same-external-operation' }
function open(root: string, requireExisting = false) {
  return createRetainedDispatch({
    runDir: path.join(root, 'journal'), scope, limits, parse: resultSchema.parse, requireExisting,
  })
}
function effect(root: string) {
  execFileSync(process.execPath, ['-e', `
    const fs = require('node:fs');
    const fd = fs.openSync(process.argv[1], 'a');
    fs.writeSync(fd, 'executed\\n'); fs.fsyncSync(fd); fs.closeSync(fd);
  `, path.join(root, 'effects.txt')])
  return { ok: true, text: 'external operation completed' }
}
function child(root: string, requireExisting = false) {
  return spawnSync(process.execPath, [
    '--import', 'tsx', self, '--child', root, ...(requireExisting ? ['--resume'] : []),
  ], { encoding: 'utf8', timeout: 15000, maxBuffer: 1024 * 1024 })
}
async function proof() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'retained-integrity-'))
  const checks: string[] = []
  const start = (name: string) => {
    const directory = path.join(root, name)
    const first = child(directory)
    assert.equal(first.status, 0, first.stderr)
    return directory
  }
  const once = async (directory: string) => {
    assert.equal(await readFile(path.join(directory, 'effects.txt'), 'utf8'), 'executed\n')
  }
  try {
    const healthy = start('healthy')
    assert.equal(child(healthy, true).status, 0)
    await once(healthy)
    checks.push('independent process replay preserves one external effect')

    const erased = start('erased')
    await unlink(path.join(erased, 'journal', 'dispatches.jsonl'))
    const reset = child(erased)
    assert.notEqual(reset.status, 0)
    assert.match(reset.stderr, /history is missing/)
    await once(erased)
    checks.push('restart after journal deletion cannot issue a fresh allowance')

    const empty = start('empty')
    await writeFile(path.join(empty, 'journal', 'dispatches.jsonl'), '')
    assert.notEqual(child(empty).status, 0)
    await once(empty)
    checks.push('empty history cannot restart an existing scope')

    const truncated = start('truncated')
    const journalPath = path.join(truncated, 'journal', 'dispatches.jsonl')
    const scopePath = path.join(truncated, 'journal', 'dispatch-scope.json')
    const scopeTextBefore = await readFile(scopePath, 'utf8')
    const history = await readFile(journalPath, 'utf8')
    // Keep the valid header line only: every started and settled event is erased.
    await writeFile(journalPath, `${history.split('\n')[0]}\n`)
    const restarted = child(truncated, true)
    assert.notEqual(restarted.status, 0)
    assert.match(restarted.stderr, /truncated below its durable anchor/)
    assert.equal(restarted.stdout, '')
    assert.equal(await readFile(scopePath, 'utf8'), scopeTextBefore)
    await once(truncated)
    // The committed high-water mark still exceeds the truncated history, so the
    // started events cannot be forgotten and no allowance was reset for reuse.
    const anchor = await readFile(path.join(truncated, 'journal', 'dispatch-anchor.jsonl'), 'utf8')
    const highWater = JSON.parse(anchor.trimEnd().split('\n').at(-1)!) as { bytes: number }
    assert.ok(highWater.bytes > Buffer.byteLength(`${history.split('\n')[0]}\n`))
    checks.push('header-only truncation fails closed without redispatch or allowance reset')

    const absent = path.join(root, 'absent')
    assert.throws(() => open(absent, true), /required retained history/)
    const lostAll = start('lost-all')
    await rm(path.join(lostAll, 'journal'), { recursive: true })
    assert.notEqual(child(lostAll, true).status, 0)
    await once(lostAll)
    checks.push('a durable owner refuses entirely missing retained state')

    const liveRoot = start('live')
    const live = open(liveRoot)
    await unlink(path.join(liveRoot, 'journal', 'dispatches.jsonl'))
    await assert.rejects(live.run({ lane: 'development', input, dispatch: async () => effect(liveRoot) }), /truncated/)
    await once(liveRoot)
    checks.push('cached in-process replay still checks durable history')

    const anchorRoot = start('anchor')
    const anchored = open(anchorRoot)
    await unlink(path.join(anchorRoot, 'journal', 'dispatch-scope.json'))
    assert.throws(() => open(anchorRoot), /legacy history/)
    await assert.rejects(anchored.run({ lane: 'development', input, dispatch: async () => effect(anchorRoot) }), /scope anchor/)
    await once(anchorRoot)
    checks.push('missing scope anchor refuses both reopening and live replay')

    const decoded = start('decoder')
    const changed = createRetainedDispatch({
      runDir: path.join(decoded, 'journal'), scope, limits,
      parse: value => ({ ...resultSchema.parse(value), text: 'different meaning' }),
    })
    await assert.rejects(changed.run({ lane: 'development', input, dispatch: async () => effect(decoded) }), /decoder changed/)
    await once(decoded)
    checks.push('replay cannot reinterpret a receipt under a changed decoder')

    console.log(JSON.stringify({ passed: true, checks, modelCalls: 0 }, null, 2))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}
if (process.argv[2] === '--child') {
  try {
    const root = process.argv[3]!
    const result = await open(root, process.argv.includes('--resume')).run({
      lane: 'development', input, dispatch: async () => effect(root),
    })
    assert.ok(result.succeeded)
    console.log(JSON.stringify(result))
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
} else await proof()
