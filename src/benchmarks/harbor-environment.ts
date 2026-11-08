/**
 * The docker host lifecycle of a Harbor case: its environment image is built once, before its first
 * grade, and removed with its build cache once the caller is done with the case.
 *
 * `prepareCaseEnvironment` keeps at most `maxLive` case images alive in this process, admitting
 * cases in call order, and pauses (never fails) while the docker host is below its free-space
 * floor, since that space belongs to the host. `gradeHarborPatch` then names the prepared image
 * as the task's `docker_image`, so Harbor builds nothing per trial. A `host` is an ssh target:
 * builds and `docker run` reach it through `DOCKER_HOST`, and Harbor runs there.
 */

import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { promisify } from 'node:util'

import type { HarborTaskItem } from './harbor'

const execute = promisify(execFile)

export interface CaseEnvironmentOptions {
  /** ssh target of the docker host; the local docker host when absent. */
  host?: string
  /** Builds wait while the docker host's data root has fewer free bytes. Default 25 GiB. */
  freeFloorBytes?: number
  /** Case images alive at once in this process. Default 2. */
  maxLive?: number
  /** How long a paused build waits before reading free space again. Default 60 s. */
  recheckMs?: number
  /** Where pause lines go. Default `console.error`. */
  log?: (line: string) => void
  signal?: AbortSignal
}

/** The environment for docker commands on `host`. */
export const dockerHostEnv = (host?: string): NodeJS.ProcessEnv =>
  host ? { ...process.env, DOCKER_HOST: `ssh://${host}` } : process.env

const live = new Map<string, { host?: string; image: Promise<string> }>()
const waiters: (() => void)[] = []
const wake = () => {
  for (const resume of waiters.splice(0)) resume()
}

/** `harbor-case/<task dir>:<digest of every file under environment/>`. */
async function imageTag(item: HarborTaskItem): Promise<string> {
  const dir = join(item.payload.taskDir, 'environment')
  const digest = createHash('sha256')
  for (const file of (await readdir(dir, { recursive: true, withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name))
    .sort())
    digest.update(`${file.slice(dir.length)}\0`).update(await readFile(file))
  return `harbor-case/${item.payload.dir.toLowerCase()}:${digest.digest('hex').slice(0, 16)}`
}

/** The image `gradeHarborPatch` names for a case prepared in this process. */
export const preparedImage = (item: HarborTaskItem) => live.get(item.payload.taskDir)

async function freeBytes(host?: string): Promise<number> {
  const info = await execute('docker', ['info', '-f', '{{.DockerRootDir}}'], {
    env: dockerHostEnv(host),
  })
  const df = ['df', '-B1', '--output=avail', info.stdout.trim()]
  const { stdout } = await (host ? execute('ssh', [host, ...df]) : execute('df', df.slice(1)))
  return Number(stdout.trim().split('\n').pop())
}

async function build(item: HarborTaskItem, options: CaseEnvironmentOptions): Promise<string> {
  const { host, freeFloorBytes = 25 * 2 ** 30, recheckMs = 60_000, signal } = options
  const log = options.log ?? ((line: string) => console.error(line))
  const env = dockerHostEnv(host)
  const image = await imageTag(item)
  if (
    await execute('docker', ['image', 'inspect', image], { env }).then(
      () => true,
      () => false,
    )
  )
    return image
  for (let free = await freeBytes(host); free < freeFloorBytes; free = await freeBytes(host)) {
    const gib = (bytes: number) => (bytes / 2 ** 30).toFixed(1)
    log(
      `PAUSE host-owned: ${host ?? 'the local docker host'} has ${gib(free)} GiB free, below the ${gib(freeFloorBytes)} GiB floor; ${item.id} builds after ${recheckMs / 1000} s`,
    )
    await sleep(recheckMs, undefined, { signal })
  }
  const context = join(item.payload.taskDir, 'environment')
  await execute('docker', ['build', '-q', '-t', image, context], { env, maxBuffer: 1 << 26 })
  return image
}

/** Build the case's environment image once and return its tag; waits for a live slot first. */
export async function prepareCaseEnvironment(
  item: HarborTaskItem,
  options: CaseEnvironmentOptions = {},
): Promise<string> {
  const key = item.payload.taskDir
  while (!live.has(key) && live.size >= (options.maxLive ?? 2)) {
    options.signal?.throwIfAborted()
    await new Promise<void>((resume) => {
      waiters.push(resume)
      options.signal?.addEventListener('abort', () => resume(), { once: true })
    })
  }
  let entry = live.get(key)
  if (!entry) {
    entry = { host: options.host, image: build(item, options) }
    live.set(key, entry)
    entry.image.catch(() => {
      live.delete(key)
      wake()
    })
  }
  return entry.image
}

/**
 * Remove the case's image and its build cache: the records whose step is the Dockerfile's first
 * `RUN` line, and every record built on them. Frees the case's live slot.
 */
export async function releaseCaseEnvironment(
  item: HarborTaskItem,
  options: { host?: string } = {},
) {
  const host = live.get(item.payload.taskDir)?.host ?? options.host
  live.delete(item.payload.taskDir)
  wake()
  const env = dockerHostEnv(host)
  await execute('docker', ['image', 'rm', await imageTag(item)], { env }).catch(() => undefined)
  const dockerfile = await readFile(join(item.payload.taskDir, 'environment/Dockerfile'), 'utf8')
  const marker = /^RUN\s+(.*?)\s*\\?$/mu.exec(dockerfile)?.[1]
  if (!marker) return
  const { stdout } = await execute('docker', ['buildx', 'du', '--format', 'json'], {
    env,
    maxBuffer: 1 << 26,
  })
  const records = stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { ID: string; Description?: string; Parents?: string[] })
  const ids = new Set(records.filter((r) => r.Description?.includes(marker)).map((r) => r.ID))
  for (let size = -1; size !== ids.size; ) {
    size = ids.size
    for (const r of records) if (r.Parents?.some((id) => ids.has(id))) ids.add(r.ID)
  }
  if (ids.size)
    await execute(
      'docker',
      ['buildx', 'prune', '-f', '--filter', `id~=^(${[...ids].join('|')})$`],
      {
        env,
      },
    )
}
