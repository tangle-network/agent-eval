import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, readdir, readFile, readlink, realpath } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { hashCanonical } from '../ledger-core/canonical'

const bytesDigest = (bytes: Uint8Array) =>
  `sha256:${createHash('sha256').update(bytes).digest('hex')}`

/** The same context identity serves Harbor import and image rebuilding; never follows links. */
export async function harborDirectoryDigest(directory: string): Promise<string | null> {
  const root = resolve(directory)
  const status = await lstat(root).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  })
  if (!status) return null
  if (!status.isDirectory()) throw new Error(`Harbor asset root must be a directory: ${root}`)
  const names = (await readdir(root, { recursive: true, withFileTypes: true }))
    .map((entry) => relative(root, join(entry.parentPath, entry.name)))
    .sort()
  const entries: unknown[] = []
  for (const name of ['.', ...names]) {
    const path = join(root, name)
    const before = await lstat(path)
    const mode = before.mode & 0o777
    if (before.isDirectory()) entries.push({ path: name, kind: 'directory', mode })
    else if (before.isSymbolicLink()) {
      const target = relative(root, await realpath(path))
      if (target === '..' || target.startsWith(`..${sep}`) || isAbsolute(target))
        throw new Error(`Harbor asset link escapes its declared directory: ${name}`)
      entries.push({ path: name, kind: 'symlink', target: await readlink(path) })
    } else if (before.isFile()) {
      const digest = createHash('sha256')
      for await (const chunk of createReadStream(path)) digest.update(chunk)
      const after = await lstat(path)
      if (
        ['dev', 'ino', 'size', 'mode', 'mtimeMs', 'ctimeMs'].some(
          (key) => before[key as keyof typeof before] !== after[key as keyof typeof after],
        )
      )
        throw new Error(`Harbor asset changed while hashing: ${name}`)
      entries.push({
        path: name,
        kind: 'file',
        mode,
        size: before.size,
        sha256: digest.digest('hex'),
      })
    } else throw new Error(`Unsupported Harbor asset: ${name}`)
  }
  return hashCanonical(entries)
}

export async function harborTaskAssetIdentity(directory: string) {
  const components = {
    configuration: bytesDigest(await readFile(join(directory, 'task.toml'))),
    instruction: bytesDigest(await readFile(join(directory, 'instruction.md'))),
    environment: await harborDirectoryDigest(join(directory, 'environment')),
    tests: await harborDirectoryDigest(join(directory, 'tests')),
    verifier: await harborDirectoryDigest(join(directory, 'verifier')),
  }
  return { version: 1 as const, digest: hashCanonical({ version: 1, components }), components }
}

export async function assertHarborTaskAssets(payload: {
  taskDir: string
  assetIdentity?: Awaited<ReturnType<typeof harborTaskAssetIdentity>>
}) {
  if (
    payload.assetIdentity &&
    (await harborTaskAssetIdentity(payload.taskDir)).digest !== payload.assetIdentity.digest
  )
    throw new Error('Harbor task assets changed since import; reload the task in a fresh campaign')
}
