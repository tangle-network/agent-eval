/** Lock-holder records and runnable lock modules for tests that cross a process boundary. */

import { closeSync, fstatSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { transformSync } from 'esbuild'
import { lockIdentity, readLockHolderIdentity } from './lock-holder'

/** Above Linux's largest `pid_max` (2^22), so no process ever holds it. */
export const DEAD_PID = 999_999_999

/**
 * Write a lock file the way a holder with `pid` would: this host's identity and
 * the file's own inode identity, so a dead `pid` is provably dead.
 */
export function writeHolderRecord(
  path: string,
  holder: { readonly pid: number; readonly nonce: string; readonly host?: string },
): void {
  const descriptor = openSync(path, 'w', 0o600)
  try {
    const lock = lockIdentity(fstatSync(descriptor, { bigint: true }))
    const identity = { ...readLockHolderIdentity(process.pid), pid: holder.pid }
    const record = {
      ...identity,
      ...(holder.host ? { host: holder.host } : {}),
      nonce: holder.nonce,
      lock,
    }
    writeFileSync(descriptor, `${JSON.stringify(record)}\n`, 'utf8')
  } finally {
    closeSync(descriptor)
  }
}

/**
 * Transpile the lock modules into `directory` so a plain `node` child can import
 * them. Returns the file URL path of the atomic file lock module.
 */
export function writeRunnableLockModules(directory: string): string {
  const transpile = (name: string): string =>
    transformSync(readFileSync(new URL(`./${name}.ts`, import.meta.url), 'utf8'), {
      loader: 'ts',
      format: 'esm',
      target: 'es2022',
    }).code
  writeFileSync(join(directory, 'lock-holder.mjs'), transpile('lock-holder'))
  const atomicModulePath = join(directory, 'atomic-file-lock.mjs')
  writeFileSync(
    atomicModulePath,
    transpile('atomic-file-lock').replace(
      /from ['"]\.\/lock-holder['"]/u,
      "from './lock-holder.mjs'",
    ),
  )
  return atomicModulePath
}
