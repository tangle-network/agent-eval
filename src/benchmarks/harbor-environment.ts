/**
 * The docker host lifecycle of a Harbor case: its environment image is built once, before its first
 * grade, and removed with its build cache once the caller is done with the case.
 *
 * `prepareCaseEnvironment` keeps at most `maxLive` case images alive in this process, admitting
 * cases in call order, and pauses (never fails) while the docker host is below its free-space
 * floor, since that space belongs to the host. `gradeHarborPatch` then names the prepared image
 * as the task's `docker_image`, so Harbor builds nothing per trial. A `host` is an ssh target:
 * builds and `docker run` reach it through `DOCKER_HOST`, and Harbor runs there.
 *
 * Each prepared case owns its tag: `harbor-case/<task dir>:<environment digest>-<owner>`, the owner
 * being this machine, this process id and a nonce. Two processes grading the same case on one
 * docker host (two improve passes at once) share the image and its build cache but never a tag, so
 * one pass's release untags only its own name and the other's grades keep their image. Before its
 * space check a preparation removes the case's tags left by dead processes of this machine (a
 * crash or kill leaves them) and shares a live owner's image of the same environment under its own
 * tag; a release removes such dead tags too. Tags of other machines' processes stay, since their
 * liveness is not known here.
 */

import { execFile } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { promisify } from 'node:util'

import type { HarborTaskItem } from './harbor'
import { assertHarborTaskAssets, harborDirectoryDigest } from './harbor-assets'

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

const live = new Map<
  string,
  { host?: string; image: Promise<string>; environment?: string | null }
>()
const waiters: (() => void)[] = []
const wake = () => {
  for (const resume of waiters.splice(0)) resume()
}

const MACHINE = createHash('sha256').update(hostname()).digest('hex').slice(0, 6)
const OWNED = new RegExp(`^[0-9a-f]{16}-${MACHINE}-(\\d+)-[0-9a-f]{4}$`, 'u')
const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** `harbor-case/<task dir>` and the digest of every file under `environment/`. */
async function caseImage(item: HarborTaskItem): Promise<{ repository: string; digest: string }> {
  const dir = join(item.payload.taskDir, 'environment')
  const digest = await harborDirectoryDigest(dir)
  if (!digest) throw new Error('Harbor task has no environment directory')
  return {
    repository: `harbor-case/${item.payload.dir.toLowerCase()}`,
    digest: digest.slice('sha256:'.length, 'sha256:'.length + 16),
  }
}

/**
 * Remove the case's tags whose owner is a dead process of this machine, and return the tags left.
 * Tags of other machines' processes stay, since their liveness is not known here.
 */
async function reclaimDead(repository: string, env: NodeJS.ProcessEnv): Promise<string[]> {
  const listed = await execute('docker', ['images', repository, '--format', '{{.Tag}}'], { env })
  const tags = listed.stdout.split('\n').filter(Boolean)
  const dead = (tag: string) => {
    const pid = Number(OWNED.exec(tag)?.[1] ?? process.pid)
    return pid !== process.pid && !alive(pid)
  }
  for (const tag of tags.filter(dead))
    await execute('docker', ['image', 'rm', `${repository}:${tag}`], { env }).catch(() => undefined)
  return tags.filter((tag) => !dead(tag))
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
  const { repository, digest } = await caseImage(item)
  const owner = `${MACHINE}-${process.pid}-${randomBytes(2).toString('hex')}`
  const image = `${repository}:${digest}-${owner}`
  // A dead pass's image is reclaimed before the space check; a live owner's image of the same
  // environment is shared under a new tag, since sharing it takes no space.
  for (const tag of (await reclaimDead(repository, env)).filter((t) => t.startsWith(`${digest}-`)))
    if (
      await execute('docker', ['tag', `${repository}:${tag}`, image], { env }).then(
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
  // An image another owner built from the same environment comes back from the build cache.
  await execute('docker', ['build', '-q', '-t', image, context], { env, maxBuffer: 1 << 26 })
  return image
}

/** Build the case's environment image once and return its tag; waits for a live slot first. */
export async function prepareCaseEnvironment(
  item: HarborTaskItem,
  options: CaseEnvironmentOptions = {},
): Promise<string> {
  await assertHarborTaskAssets(item.payload)
  const key = item.payload.taskDir
  while (!live.has(key) && live.size >= (options.maxLive ?? 2)) {
    options.signal?.throwIfAborted()
    await new Promise<void>((resume) => {
      waiters.push(resume)
      options.signal?.addEventListener('abort', () => resume(), { once: true })
    })
  }
  let entry = live.get(key)
  if (entry && entry.environment !== item.payload.assetIdentity?.components.environment)
    throw new Error('Harbor environment changed while prepared; release it before preparing again')
  if (!entry) {
    entry = {
      host: options.host,
      image: build(item, options),
      environment: item.payload.assetIdentity?.components.environment,
    }
    live.set(key, entry)
    entry.image.catch(() => {
      live.delete(key)
      wake()
    })
  }
  const image = await entry.image
  await assertHarborTaskAssets(item.payload)
  return image
}

/**
 * Remove the case's tag and its build cache: the records whose step is the Dockerfile's first
 * `RUN` line, and every record built on them. Frees the case's live slot. Another owner's tag of
 * the same image keeps that image, and pruning build cache never removes an image.
 *
 * The prune names the case's records and passes `--all`: without it BuildKit skips every record it
 * reports as shared with an image, and on a busy docker host it reported this case's records shared
 * after the case's last tag was gone, leaving them behind.
 */
export async function releaseCaseEnvironment(
  item: HarborTaskItem,
  options: { host?: string } = {},
) {
  const entry = live.get(item.payload.taskDir)
  live.delete(item.payload.taskDir)
  wake()
  const env = dockerHostEnv(entry?.host ?? options.host)
  const image = await entry?.image.catch(() => undefined)
  if (image) await execute('docker', ['image', 'rm', image], { env }).catch(() => undefined)
  await reclaimDead((await caseImage(item)).repository, env)
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
      ['buildx', 'prune', '-f', '--all', '--filter', `id~=^(${[...ids].join('|')})$`],
      {
        env,
      },
    )
}
