import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'
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
  const atomicModulePath = join(root, 'atomic-file-lock.mjs')
  const source = readFileSync(new URL('./single-run-lock.ts', import.meta.url), 'utf8')
  const transpile = (input: string): string =>
    ts.transpileModule(input, {
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    }).outputText
  writeFileSync(
    modulePath,
    transpile(source).replace(/from ['"]\.\/atomic-file-lock['"]/, "from './atomic-file-lock.mjs'"),
  )
  writeFileSync(
    atomicModulePath,
    transpile(readFileSync(new URL('./atomic-file-lock.ts', import.meta.url), 'utf8')),
  )
  if (options.stale) {
    writeFileSync(
      lockPath,
      JSON.stringify({ host: hostname(), nonce: 'crashed-owner', pid: 999_999_999 }),
    )
  }

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

  it('throws naming a live holder', () => {
    const lockPath = join(dir(), 'gym.lock')
    writeFileSync(lockPath, String(process.pid)) // this test process IS the live holder
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
    writeFileSync(lockPath, '999999999') // beyond pid_max: never a live process
    const lock = acquireSingleRunLock({ lockPath, releaseOnExit: false })
    expect(JSON.parse(readFileSync(lockPath, 'utf8'))).toMatchObject({ pid: process.pid })
    lock.release()
  })

  it('treats a permission-denied owner probe as live', () => {
    const lockPath = join(dir(), 'gym.lock')
    writeFileSync(lockPath, '12345')
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('denied'), { code: 'EPERM' })
    })
    try {
      expect(() => acquireSingleRunLock({ lockPath, releaseOnExit: false })).toThrow(
        /held by live pid 12345/,
      )
      expect(readFileSync(lockPath, 'utf8')).toBe('12345')
    } finally {
      kill.mockRestore()
    }
  })

  it('fails closed for an owner on another host', () => {
    const lockPath = join(dir(), 'gym.lock')
    const owner = { host: 'remote-worker.example', nonce: 'remote-owner', pid: 999_999_999 }
    writeFileSync(lockPath, JSON.stringify(owner))
    expect(() => acquireSingleRunLock({ lockPath, releaseOnExit: false })).toThrow(
      /held by live pid 999999999/,
    )
    expect(JSON.parse(readFileSync(lockPath, 'utf8'))).toEqual(owner)
  })

  it('respects other runners lockfiles via alsoCheck without writing them', () => {
    const d = dir()
    const mine = join(d, 'mine.lock')
    const theirs = join(d, 'theirs.lock')
    writeFileSync(theirs, String(process.pid))
    expect(() =>
      acquireSingleRunLock({
        lockPath: mine,
        alsoCheck: [theirs],
        pid: process.pid + 1,
        releaseOnExit: false,
      }),
    ).toThrow(/theirs\.lock/)
    // their lock untouched
    expect(readFileSync(theirs, 'utf8')).toBe(String(process.pid))
  })

  it('does not release a lock another process re-acquired', () => {
    const lockPath = join(dir(), 'gym.lock')
    const lock = acquireSingleRunLock({ lockPath, releaseOnExit: false })
    writeFileSync(lockPath, '999999998') // someone else took it over
    lock.release()
    expect(readFileSync(lockPath, 'utf8')).toBe('999999998')
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
    writeFileSync(`${lockPath}.reclaim`, '999999999')
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

  it('rejects invalid owner pids', () => {
    const lockPath = join(dir(), 'gym.lock')
    expect(() => acquireSingleRunLock({ lockPath, pid: 0, releaseOnExit: false })).toThrow(
      /pid must be a positive integer/,
    )
  })
})
