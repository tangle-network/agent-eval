import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { transformSync } from 'esbuild'
import { describe, expect, it } from 'vitest'
import {
  DEAD_PID,
  writeHolderRecord,
  writeRunnableLockModules,
} from '../ledger-core/lock-holder-test-fixtures'
import { acquireSingleRunLock } from './single-run-lock'

const dir = () => mkdtempSync(join(tmpdir(), 'single-run-lock-'))

async function synchronizedContenders(options: {
  readonly count: number
  readonly stale?: boolean
}): Promise<string[]> {
  const root = dir()
  const lockPath = join(root, 'gym.lock')
  const releasePath = join(root, 'release')
  const finishPath = join(root, 'finish')
  const modulePath = join(root, 'single-run-lock.mjs')
  writeRunnableLockModules(root)
  const source = readFileSync(new URL('./single-run-lock.ts', import.meta.url), 'utf8')
  writeFileSync(
    modulePath,
    transformSync(source, { loader: 'ts', format: 'esm', target: 'es2022' }).code.replace(
      /from ['"]\.\.\/ledger-core\/atomic-file-lock['"]/,
      "from './atomic-file-lock.mjs'",
    ),
  )
  if (options.stale) writeHolderRecord(lockPath, { nonce: 'crashed-owner', pid: DEAD_PID })

  const childSource = `
    import { existsSync } from 'node:fs'
    import { acquireSingleRunLock } from ${JSON.stringify(pathToFileURL(modulePath).href)}
    const [lockPath, releasePath, finishPath] = process.argv.slice(1)
    process.stdout.write('READY\\n')
    const wait = new Int32Array(new SharedArrayBuffer(4))
    while (!existsSync(releasePath)) Atomics.wait(wait, 0, 0, 10)
    try {
      const lock = acquireSingleRunLock({ lockPath, releaseOnExit: false })
      process.stdout.write('ACQUIRED\\n')
      while (!existsSync(finishPath)) Atomics.wait(wait, 0, 0, 10)
      lock.release()
    } catch {
      process.stdout.write('REJECTED\\n')
    }
  `
  const children = Array.from({ length: options.count }, () => {
    const child = spawn(
      process.execPath,
      ['--input-type=module', '--eval', childSource, lockPath, releasePath, finishPath],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    )
    let stdout = ''
    let stderr = ''
    let resolveOutcome: (outcome: string) => void
    const outcome = new Promise<string>((resolve) => {
      resolveOutcome = resolve
    })
    const ready = new Promise<void>((resolve) => {
      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8')
        if (stdout.includes('READY\n')) resolve()
        if (stdout.includes('ACQUIRED\n')) resolveOutcome('ACQUIRED')
        if (stdout.includes('REJECTED\n')) resolveOutcome('REJECTED')
      })
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })
    const done = new Promise<void>((resolve, reject) => {
      child.once('error', reject)
      child.once('close', (code) => {
        if (code === 0) resolve()
        else reject(new Error(`single-run contender exited ${String(code)}: ${stderr}`))
      })
    })
    return { child, ready, outcome, done }
  })
  try {
    await Promise.all(children.map((child) => child.ready))
    writeFileSync(releasePath, 'go')
    const outcomes = await Promise.all(children.map((child) => child.outcome))
    writeFileSync(finishPath, 'done')
    await Promise.all(children.map((child) => child.done))
    return outcomes
  } finally {
    for (const child of children) child.child.kill()
    rmSync(root, { recursive: true, force: true })
  }
}

describe('acquireSingleRunLock', () => {
  it('acquires, records the pid, and releases idempotently', () => {
    const lockPath = join(dir(), 'gym.lock')
    const lock = acquireSingleRunLock({ lockPath, releaseOnExit: false })
    const owner = JSON.parse(readFileSync(lockPath, 'utf8')) as Record<string, unknown>
    expect(owner).toMatchObject({ host: hostname(), pid: process.pid })
    expect(owner.nonce).toEqual(expect.any(String))
    lock.release()
    lock.release()
    expect(() => acquireSingleRunLock({ lockPath, releaseOnExit: false }).release()).not.toThrow()
  })

  it('removes its process exit listener when released', () => {
    const lockPath = join(dir(), 'gym.lock')
    const before = process.listenerCount('exit')
    const lock = acquireSingleRunLock({ lockPath })

    expect(process.listenerCount('exit')).toBe(before + 1)
    lock.release()
    expect(process.listenerCount('exit')).toBe(before)
    lock.release()
    expect(process.listenerCount('exit')).toBe(before)
  })

  it('throws naming a live holder', () => {
    const lockPath = join(dir(), 'gym.lock')
    writeHolderRecord(lockPath, { nonce: 'live-holder', pid: process.pid })
    expect(() =>
      acquireSingleRunLock({ lockPath, pid: process.pid + 1, releaseOnExit: false }),
    ).toThrow(/held by live pid/)
  })

  it('rejects a second acquisition by the same process', () => {
    const lockPath = join(dir(), 'gym.lock')
    const lock = acquireSingleRunLock({ lockPath, releaseOnExit: false })
    expect(() => acquireSingleRunLock({ lockPath, releaseOnExit: false })).toThrow(
      /held by live pid/,
    )
    expect(JSON.parse(readFileSync(lockPath, 'utf8'))).toMatchObject({ pid: process.pid })
    lock.release()
  })

  it('reclaims a stale lock whose holder pid is gone', () => {
    const lockPath = join(dir(), 'gym.lock')
    writeHolderRecord(lockPath, { nonce: 'stale-holder', pid: DEAD_PID })
    const lock = acquireSingleRunLock({ lockPath, releaseOnExit: false })
    expect(JSON.parse(readFileSync(lockPath, 'utf8'))).toMatchObject({ pid: process.pid })
    lock.release()
  })

  it('fails closed for an owner on another host', () => {
    const lockPath = join(dir(), 'gym.lock')
    writeHolderRecord(lockPath, {
      host: 'remote-worker.example',
      nonce: 'remote-owner',
      pid: DEAD_PID,
    })
    const owner = readFileSync(lockPath, 'utf8')
    expect(() => acquireSingleRunLock({ lockPath, releaseOnExit: false })).toThrow(
      /held by live pid 999999999/,
    )
    expect(readFileSync(lockPath, 'utf8')).toBe(owner)
  })

  it('respects other runners lockfiles via alsoCheck without writing them', () => {
    const d = dir()
    const mine = join(d, 'mine.lock')
    const theirs = join(d, 'theirs.lock')
    writeHolderRecord(theirs, { nonce: 'other-runner', pid: process.pid })
    const owner = JSON.parse(readFileSync(theirs, 'utf8')) as unknown
    expect(() =>
      acquireSingleRunLock({
        lockPath: mine,
        alsoCheck: [theirs],
        pid: process.pid + 1,
        releaseOnExit: false,
      }),
    ).toThrow(/theirs\.lock/)
    // their lock untouched
    expect(JSON.parse(readFileSync(theirs, 'utf8'))).toEqual(owner)
  })

  it('does not release a lock another process re-acquired', () => {
    const lockPath = join(dir(), 'gym.lock')
    const lock = acquireSingleRunLock({ lockPath, releaseOnExit: false })
    const owner = { host: hostname(), nonce: 'replacement-owner', pid: 999_999_998 }
    writeFileSync(lockPath, JSON.stringify(owner))
    lock.release()
    expect(JSON.parse(readFileSync(lockPath, 'utf8'))).toEqual(owner)
  })

  it('admits exactly one of 32 synchronized processes', async () => {
    const outcomes = await synchronizedContenders({ count: 32 })
    expect(outcomes.filter((outcome) => outcome === 'ACQUIRED')).toHaveLength(1)
    expect(outcomes.filter((outcome) => outcome === 'REJECTED')).toHaveLength(31)
  }, 15_000)

  it('admits exactly one of 32 synchronized stale-lock reclaimers', async () => {
    const outcomes = await synchronizedContenders({ count: 32, stale: true })
    expect(outcomes.filter((outcome) => outcome === 'ACQUIRED')).toHaveLength(1)
    expect(outcomes.filter((outcome) => outcome === 'REJECTED')).toHaveLength(31)
  }, 15_000)

  it('fails closed on an interrupted recovery marker', () => {
    const lockPath = join(dir(), 'gym.lock')
    writeHolderRecord(`${lockPath}.reclaim`, { nonce: 'active-reclaimer', pid: process.pid })
    expect(() => acquireSingleRunLock({ lockPath, releaseOnExit: false })).toThrow(
      /recovery is already in progress/,
    )
  })

  it('fails closed on a malformed lock owner', () => {
    const lockPath = join(dir(), 'gym.lock')
    writeFileSync(lockPath, 'not-a-pid')
    expect(() => acquireSingleRunLock({ lockPath, releaseOnExit: false })).toThrow(/invalid owner/)
    expect(readFileSync(lockPath, 'utf8')).toBe('not-a-pid')
  })

  it('rejects the removed plain-pid owner format', () => {
    const lockPath = join(dir(), 'gym.lock')
    writeFileSync(lockPath, String(process.pid))
    expect(() => acquireSingleRunLock({ lockPath, releaseOnExit: false })).toThrow(/invalid owner/)
  })

  it('rejects invalid owner pids', () => {
    const lockPath = join(dir(), 'gym.lock')
    expect(() => acquireSingleRunLock({ lockPath, pid: 0, releaseOnExit: false })).toThrow(
      /pid must be a positive integer/,
    )
  })
})
