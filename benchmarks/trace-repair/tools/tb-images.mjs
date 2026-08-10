#!/usr/bin/env node
// Pinned task-image store for TB-Repair replay.
//
// A replay is only valid against the exact image bytes the recorded trajectory ran on,
// and a campaign must not depend on a third-party registry staying reachable mid-run.
// This tool gives both properties:
//
//   1. Correctness. Every task image is pinned by registry manifest digest, recorded in
//      tb-images.lock.json together with the terminal-bench-2 commit the reference came
//      from. A republished tag then fails `verify` loudly instead of silently swapping
//      the bits underneath a recorded trajectory.
//   2. Throughput. Campaign-time resolution is local-only: `docker image inspect` against
//      the pinned identity, zero network calls, so an exhausted Docker Hub quota or an
//      unreachable registry cannot throttle a run that is already under way. Network work
//      happens once, in `warm`, under an explicit quota budget.
//
// Two distinct identities are recorded per image, because they survive different things:
//
//   digest  — the registry manifest digest. What we pull by. Immune to tag movement.
//             Lost by `docker save` -> `docker load` (measured: RepoDigests comes back []).
//   imageId — the local image config digest. What we verify by. Survives save/load, so it
//             is the identity a restored-from-archive image can still be checked against.
//
// Measured Docker Hub anonymous limits that shape the budget logic (2026-08-09, one IP):
// 100 manifest GETs per 3600 s; a manifest HEAD costs 0. Digest resolution is therefore
// free and only a cold layer fetch spends quota.
//
// Usage:
//   node tb-images.mjs lock    [--tasks a,b | --tasks-file F | --tasks all]
//   node tb-images.mjs warm    [--tasks ...] [--reserve N] [--archive]
//   node tb-images.mjs archive [--tasks ...]
//   node tb-images.mjs verify  [--tasks ...]        # zero network; run this at campaign start
//   node tb-images.mjs status  [--tasks ...] [--quota]
//
// Prerequisites, each verified rather than assumed:
//   - docker CLI on PATH
//   - a terminal-bench-2 clone at --tb2 (default ~/bench-cache/terminal-bench-2), pinned;
//     task definitions move under the same names, so the lockfile records its commit

import { execFileSync } from 'node:child_process'
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  statfsSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const DEFAULT_LOCK = resolve(HERE, '..', 'tb-images.lock.json')
const DEFAULT_TB2 = join(homedir(), 'bench-cache', 'terminal-bench-2')
const DEFAULT_STORE = join(homedir(), 'bench-cache', 'tb-images')
const LOCK_VERSION = 1

// Docker Hub reports the anonymous pull budget on every manifest response. A HEAD carries
// the headers without spending from the budget, so quota can be read for free.
const HUB_REGISTRY = 'registry-1.docker.io'
const HUB_QUOTA_REPOSITORY = 'ratelimitpreview/test'
const HUB_QUOTA_TAG = 'latest'

const MANIFEST_ACCEPT = [
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.docker.distribution.manifest.v2+json',
].join(',')

export function expandHome(p) {
  if (!p) return p
  return p.startsWith('~') ? join(homedir(), p.slice(1)) : p
}

// docker.io/<namespace>/<name>:<tag>, with the docker.io and library/ defaults the
// daemon applies. A digest reference is rejected: this tool assigns the pin, it does
// not accept one that was written by hand somewhere else.
export function parseImageRef(reference) {
  if (typeof reference !== 'string' || reference.trim() === '') {
    throw new Error('image reference must be a non-empty string')
  }
  const ref = reference.trim()
  if (ref.includes('@')) {
    throw new Error(`image reference must be tag-form, not digest-form: ${ref}`)
  }
  const slash = ref.indexOf('/')
  const head = slash === -1 ? '' : ref.slice(0, slash)
  const hasRegistry = head.includes('.') || head.includes(':') || head === 'localhost'
  const registry = hasRegistry ? head : 'docker.io'
  const remainder = hasRegistry ? ref.slice(slash + 1) : ref
  const colon = remainder.lastIndexOf(':')
  if (colon === -1) throw new Error(`image reference must carry an explicit tag: ${ref}`)
  const path = remainder.slice(0, colon)
  const tag = remainder.slice(colon + 1)
  if (path === '' || tag === '') throw new Error(`malformed image reference: ${ref}`)
  const repository = registry === 'docker.io' && !path.includes('/') ? `library/${path}` : path
  return { registry, repository, tag }
}

export function parseQuotaHeader(value) {
  if (typeof value !== 'string') return null
  const match = /^\s*(\d+)\s*;\s*w\s*=\s*(\d+)/.exec(value)
  if (!match) return null
  return { count: Number(match[1]), windowSeconds: Number(match[2]) }
}

export function readQuotaHeaders(headers) {
  const limit = parseQuotaHeader(headers.get('ratelimit-limit'))
  const remaining = parseQuotaHeader(headers.get('ratelimit-remaining'))
  if (!limit || !remaining) return null
  return {
    limit: limit.count,
    remaining: remaining.count,
    windowSeconds: limit.windowSeconds,
    source: headers.get('docker-ratelimit-source') ?? null,
  }
}

export function isDigest(value) {
  return typeof value === 'string' && /^sha256:[0-9a-f]{64}$/.test(value)
}

export function digestHex(digest) {
  if (!isDigest(digest)) throw new Error(`not a sha256 digest: ${digest}`)
  return digest.slice('sha256:'.length)
}

// `docker_image` lives under [environment] in a terminal-bench-2 task.toml and is the
// only declaration of what the recorded trajectory ran on.
export function parseTaskImage(toml, task) {
  const matches = [...toml.matchAll(/^\s*docker_image\s*=\s*["']([^"']+)["']\s*$/gm)]
  if (matches.length === 0) throw new Error(`${task}: task.toml declares no docker_image`)
  if (matches.length > 1) throw new Error(`${task}: task.toml declares ${matches.length} docker_image values`)
  return matches[0][1]
}

// A cold pull spends one unit of the manifest budget. The reserve keeps headroom for the
// other work sharing this IP, so a warm phase cannot strand a concurrent run at zero.
export function planPulls(missing, quota, reserve) {
  if (missing <= 0) return { allowed: 0, deferred: 0, reason: 'nothing to pull' }
  if (!quota) {
    return { allowed: 0, deferred: missing, reason: 'quota unreadable; refusing to pull blind' }
  }
  const spendable = Math.max(0, quota.remaining - reserve)
  const allowed = Math.min(missing, spendable)
  return {
    allowed,
    deferred: missing - allowed,
    reason:
      allowed === missing
        ? `budget allows all ${missing} pulls (remaining ${quota.remaining}, reserve ${reserve})`
        : `budget allows ${allowed} of ${missing} pulls (remaining ${quota.remaining}, reserve ${reserve}); window ${quota.windowSeconds}s`,
  }
}

function docker(args, options = {}) {
  return execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options })
}

// null means the daemon answered and does not hold this reference. Any other docker
// failure — daemon down, permission denied — is raised, so a broken environment never
// reads as "image absent" and never sends a campaign back to the registry for nothing.
function localImage(reference) {
  let raw
  try {
    raw = docker(['image', 'inspect', reference, '--format', '{{json .}}'])
  } catch (error) {
    const stderr = String(error.stderr ?? '')
    if (/no such (image|object)/i.test(stderr)) return null
    throw new Error(`docker image inspect ${reference} failed: ${stderr.trim() || error.message}`)
  }
  const info = JSON.parse(raw)
  return {
    id: info.Id,
    size: info.Size,
    repoDigests: info.RepoDigests ?? [],
    repoTags: info.RepoTags ?? [],
  }
}

async function registryToken(registry, repository) {
  const probe = await fetch(`https://${registryHost(registry)}/v2/`, { method: 'GET' })
  if (probe.status !== 401) return null
  const challenge = probe.headers.get('www-authenticate')
  if (!challenge || !/^bearer /i.test(challenge)) {
    throw new Error(`${registry}: unsupported auth challenge: ${challenge ?? '(none)'}`)
  }
  const params = new Map()
  for (const part of challenge.slice('bearer '.length).matchAll(/([a-z_]+)="([^"]*)"/gi)) {
    params.set(part[1].toLowerCase(), part[2])
  }
  const realm = params.get('realm')
  if (!realm) throw new Error(`${registry}: auth challenge carries no realm`)
  const url = new URL(realm)
  if (params.get('service')) url.searchParams.set('service', params.get('service'))
  url.searchParams.set('scope', `repository:${repository}:pull`)
  const response = await fetch(url, { headers: registryAuthHeaders(registry) })
  if (!response.ok) throw new Error(`${registry}: token request failed with ${response.status}`)
  const body = await response.json()
  const token = body.token ?? body.access_token
  if (!token) throw new Error(`${registry}: token response carried no token`)
  return token
}

// Only credentials already present in the environment are used. This tool never writes,
// prompts for, or persists a registry credential.
function registryAuthHeaders(registry) {
  const basic = registry === 'docker.io' ? process.env.DOCKERHUB_BASIC_AUTH : undefined
  return basic ? { authorization: `Basic ${basic}` } : {}
}

function registryHost(registry) {
  return registry === 'docker.io' ? HUB_REGISTRY : registry
}

async function headManifest(registry, repository, reference) {
  const token = await registryToken(registry, repository)
  const headers = { accept: MANIFEST_ACCEPT }
  if (token) headers.authorization = `Bearer ${token}`
  const url = `https://${registryHost(registry)}/v2/${repository}/manifests/${reference}`
  const response = await fetch(url, { method: 'HEAD', headers })
  const quota = readQuotaHeaders(response.headers)
  if (!response.ok) {
    const detail = response.status === 429 ? ' (rate limited)' : ''
    return { ok: false, status: response.status, quota, error: `HEAD ${repository}:${reference} -> ${response.status}${detail}` }
  }
  const digest = response.headers.get('docker-content-digest')
  if (!isDigest(digest)) {
    return { ok: false, status: response.status, quota, error: `${repository}:${reference} returned no usable content digest` }
  }
  return {
    ok: true,
    status: response.status,
    quota,
    digest,
    mediaType: response.headers.get('content-type'),
    bytes: Number(response.headers.get('content-length') ?? 0),
  }
}

export async function readHubQuota() {
  const result = await headManifest('docker.io', HUB_QUOTA_REPOSITORY, HUB_QUOTA_TAG)
  return result.quota
}

function readLock(lockPath) {
  if (!existsSync(lockPath)) {
    return { version: LOCK_VERSION, generator: 'tb-images.mjs', tb2Commit: null, images: {} }
  }
  const lock = JSON.parse(readFileSync(lockPath, 'utf8'))
  if (lock.version !== LOCK_VERSION) {
    throw new Error(`${lockPath}: lock version ${lock.version} is not supported (expected ${LOCK_VERSION})`)
  }
  return lock
}

function writeJsonAtomic(path, value) {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  renameSync(tmp, path)
}

function tb2Commit(tb2Dir) {
  try {
    return execFileSync('git', ['-C', tb2Dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  } catch (error) {
    throw new Error(`${tb2Dir}: not a readable git clone of terminal-bench-2 (${error.message})`)
  }
}

function taskList(args, tb2Dir, lock) {
  if (args.tasksFile) {
    return readFileSync(args.tasksFile, 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '' && !line.startsWith('#'))
  }
  if (args.tasks === 'all') {
    return readdirSync(tb2Dir)
      .filter((name) => existsSync(join(tb2Dir, name, 'task.toml')))
      .sort()
  }
  if (args.tasks) return args.tasks.split(',').map((t) => t.trim()).filter(Boolean)
  const locked = Object.keys(lock.images)
  if (locked.length === 0) {
    throw new Error('no tasks given and the lockfile is empty; pass --tasks, --tasks-file, or --tasks all')
  }
  return locked.sort()
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code === 'EPERM'
  }
}

// Every writer shares one docker daemon and one Docker Hub budget, and this box runs
// several agents at once. Two concurrent warms would double-spend the budget and can
// leave the lockfile holding whichever write landed last, so writers serialize here.
function acquireStoreLock(storeDir) {
  mkdirSync(storeDir, { recursive: true })
  const path = join(storeDir, 'writer.lock')
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, 'wx')
      writeSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }))
      closeSync(fd)
      return () => {
        try {
          unlinkSync(path)
        } catch {
          // another writer already reclaimed a lock this process had lost
        }
      }
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      let holder = null
      try {
        holder = JSON.parse(readFileSync(path, 'utf8'))
      } catch {
        holder = null
      }
      if (holder && processAlive(holder.pid)) {
        throw new Error(`another tb-images writer holds ${path} (pid ${holder.pid}, since ${holder.at}); wait for it or pass a different --store`)
      }
      unlinkSync(path)
    }
  }
  throw new Error(`could not acquire ${path}`)
}

function storePaths(storeDir, imageId) {
  const hex = digestHex(imageId)
  return {
    blob: join(storeDir, 'blobs', `${hex}.tar`),
    tmp: join(storeDir, 'blobs', `${hex}.tar.${process.pid}.tmp`),
  }
}

function freeBytes(path) {
  const stats = statfsSync(path)
  return stats.bavail * stats.bsize
}

async function cmdLock(args) {
  const lock = readLock(args.lock)
  const commit = tb2Commit(args.tb2)
  const tasks = taskList(args, args.tb2, lock)
  const rows = []
  let quota = null
  let headCount = 0
  const before = await readHubQuota()

  for (const task of tasks) {
    const tomlPath = join(args.tb2, task, 'task.toml')
    if (!existsSync(tomlPath)) throw new Error(`${task}: no task.toml at ${tomlPath}`)
    const reference = parseTaskImage(readFileSync(tomlPath, 'utf8'), task)
    const { registry, repository, tag } = parseImageRef(reference)
    const local = localImage(reference)
    const localPin = local?.repoDigests.find((entry) => entry.startsWith(`${repository}@`))

    let digest = null
    let mediaType = null
    let manifestBytes = null
    let resolvedFrom = null
    if (localPin) {
      digest = localPin.slice(localPin.indexOf('@') + 1)
      resolvedFrom = 'local-store'
    } else {
      const head = await headManifest(registry, repository, tag)
      headCount += 1
      if (head.quota) quota = head.quota
      if (!head.ok) throw new Error(`${task}: ${head.error}`)
      digest = head.digest
      mediaType = head.mediaType
      manifestBytes = head.bytes
      resolvedFrom = 'registry-head'
    }
    if (!isDigest(digest)) throw new Error(`${task}: resolved a malformed digest: ${digest}`)

    const previous = lock.images[task]
    if (previous && previous.digest !== digest) {
      if (!args.acceptMoved) {
        throw new Error(
          `${task}: tag ${reference} moved. locked ${previous.digest}, registry now serves ${digest}. ` +
            'Every replay recorded against the locked digest is invalidated by accepting this. ' +
            'Re-run with --accept-moved only after deciding to re-certify.',
        )
      }
      previous.previousDigest = previous.digest
      previous.movedAt = new Date().toISOString()
    }

    // The local image id is only recorded when the local copy proves it carries the pinned
    // digest. A local tag can be stale, and `docker load` drops RepoDigests, so anything
    // weaker would pair a registry digest with content nobody checked. Leaving it null
    // makes `verify` demand a warm rather than accept an unproven local copy.
    const provenLocally = local?.repoDigests.includes(`${repository}@${digest}`) ?? false
    lock.images[task] = {
      ...(previous ?? {}),
      reference,
      registry,
      repository,
      tag,
      digest,
      manifestMediaType: mediaType ?? previous?.manifestMediaType ?? null,
      manifestBytes: manifestBytes ?? previous?.manifestBytes ?? null,
      imageId: provenLocally ? local.id : (previous?.imageId ?? null),
      imageBytes: provenLocally ? local.size : (previous?.imageBytes ?? null),
      resolvedFrom,
      resolvedAt: new Date().toISOString(),
    }
    rows.push({ task, digest, resolvedFrom })
  }

  lock.tb2Commit = commit
  lock.lockedAt = new Date().toISOString()
  writeJsonAtomic(args.lock, lock)

  const after = await readHubQuota()
  for (const row of rows) console.log(`${row.task}\t${row.digest}\t${row.resolvedFrom}`)
  console.log(`locked ${rows.length} images -> ${args.lock} (tb2 ${commit.slice(0, 7)})`)
  console.log(
    `manifest HEADs issued: ${headCount}; hub quota remaining ${before?.remaining ?? 'unreadable'} -> ${after?.remaining ?? 'unreadable'}` +
      `${quota ? ` (limit ${quota.limit}/${quota.windowSeconds}s)` : ''}`,
  )
}

function ensureTag(imageId, repository, tag) {
  docker(['tag', imageId, `${repository}:${tag}`])
}

function loadFromStore(entry, storeDir) {
  if (!entry.imageId) return false
  const { blob } = storePaths(storeDir, entry.imageId)
  if (!existsSync(blob)) return false
  docker(['load', '-i', blob], { stdio: ['ignore', 'pipe', 'pipe'] })
  const loaded = localImage(entry.imageId)
  if (!loaded) throw new Error(`${entry.repository}: archive ${blob} did not restore image ${entry.imageId}`)
  ensureTag(entry.imageId, entry.repository, entry.tag)
  return true
}

async function cmdWarm(args) {
  const lock = readLock(args.lock)
  const tasks = taskList(args, args.tb2, lock)
  const quotaBefore = await readHubQuota()

  const present = []
  const restored = []
  const needPull = []
  for (const task of tasks) {
    const entry = lock.images[task]
    if (!entry) throw new Error(`${task}: not in ${args.lock}; run \`tb-images.mjs lock\` first`)
    const byId = entry.imageId ? localImage(entry.imageId) : null
    const info = byId ?? localImage(`${entry.repository}@${entry.digest}`)
    if (info) {
      entry.imageId = info.id
      entry.imageBytes = info.size
      if (!info.repoTags.includes(`${entry.repository}:${entry.tag}`)) ensureTag(info.id, entry.repository, entry.tag)
      present.push(task)
      continue
    }
    if (loadFromStore(entry, args.store)) {
      restored.push(task)
      continue
    }
    needPull.push(task)
  }

  const plan = planPulls(needPull.length, quotaBefore, args.reserve)
  const pulled = []
  for (const task of needPull.slice(0, plan.allowed)) {
    const entry = lock.images[task]
    const pinned = `${entry.repository}@${entry.digest}`
    const started = Date.now()
    docker(['pull', pinned], { stdio: ['ignore', 'pipe', 'pipe'] })
    const info = localImage(pinned)
    if (!info) throw new Error(`${task}: pull of ${pinned} reported success but the image is absent`)
    ensureTag(info.id, entry.repository, entry.tag)
    entry.imageId = info.id
    entry.imageBytes = info.size
    entry.pulledAt = new Date().toISOString()
    pulled.push({ task, seconds: (Date.now() - started) / 1000 })
  }

  const archived = []
  if (args.archive) {
    for (const task of tasks) {
      if (archiveOne(lock.images[task], args.store)) archived.push(task)
    }
  }

  writeJsonAtomic(args.lock, lock)
  const quotaAfter = await readHubQuota()

  console.log(`present ${present.length}\trestored ${restored.length}\tpulled ${pulled.length}\tdeferred ${plan.deferred}`)
  for (const row of pulled) console.log(`pulled\t${row.task}\t${row.seconds.toFixed(1)}s`)
  if (archived.length > 0) console.log(`archived ${archived.length} -> ${join(args.store, 'blobs')}`)
  console.log(`hub quota remaining ${quotaBefore?.remaining ?? 'unreadable'} -> ${quotaAfter?.remaining ?? 'unreadable'}`)
  if (plan.deferred > 0) {
    console.error(`deferred ${plan.deferred} pulls: ${plan.reason}`)
    process.exitCode = 3
  }
}

function archiveOne(entry, storeDir) {
  if (!entry?.imageId) return false
  const { blob, tmp } = storePaths(storeDir, entry.imageId)
  if (existsSync(blob)) return false
  const info = localImage(entry.imageId)
  if (!info) return false
  const headroom = info.size * 1.5 + 5 * 1024 ** 3
  mkdirSync(dirname(blob), { recursive: true })
  const free = freeBytes(dirname(blob))
  if (free < headroom) {
    throw new Error(
      `refusing to archive ${entry.repository}: ${(free / 1024 ** 3).toFixed(1)} GB free, ` +
        `${(headroom / 1024 ** 3).toFixed(1)} GB required for a ${(info.size / 1024 ** 3).toFixed(1)} GB image`,
    )
  }
  try {
    docker(['save', entry.imageId, '-o', tmp])
    renameSync(tmp, blob)
  } catch (error) {
    if (existsSync(tmp)) unlinkSync(tmp)
    throw error
  }
  return true
}

async function cmdArchive(args) {
  const lock = readLock(args.lock)
  const tasks = taskList(args, args.tb2, lock)
  let bytes = 0
  const written = []
  for (const task of tasks) {
    const entry = lock.images[task]
    if (!entry) throw new Error(`${task}: not in ${args.lock}`)
    if (archiveOne(entry, args.store)) {
      const { blob } = storePaths(args.store, entry.imageId)
      bytes += statSync(blob).size
      written.push(task)
    }
  }
  writeJsonAtomic(args.lock, lock)
  console.log(`archived ${written.length} of ${tasks.length} (${(bytes / 1024 ** 3).toFixed(2)} GB) -> ${join(args.store, 'blobs')}`)
}

// The campaign gate. Reads nothing over the network, so it states the truth about the
// machine the campaign is about to run on even when Docker Hub is refusing traffic.
export function verifyPins(lock, tasks, storeDir) {
  const rows = []
  for (const task of tasks) {
    const entry = lock.images[task]
    if (!entry) {
      rows.push({ task, ok: false, detail: 'not locked' })
      continue
    }
    if (!entry.imageId) {
      rows.push({ task, ok: false, detail: 'locked but never warmed (no imageId)' })
      continue
    }
    const byId = localImage(entry.imageId)
    if (!byId) {
      const { blob } = storePaths(storeDir, entry.imageId)
      rows.push({
        task,
        ok: false,
        detail: existsSync(blob) ? 'absent from the daemon; archived, run warm' : 'absent from the daemon and from the archive',
      })
      continue
    }
    const tagged = localImage(`${entry.repository}:${entry.tag}`)
    if (!tagged) {
      rows.push({ task, ok: false, detail: `image present but tag ${entry.repository}:${entry.tag} is missing` })
      continue
    }
    if (tagged.id !== entry.imageId) {
      rows.push({
        task,
        ok: false,
        detail: `tag ${entry.repository}:${entry.tag} points at ${tagged.id.slice(0, 19)}, pin expects ${entry.imageId.slice(0, 19)}`,
      })
      continue
    }
    const pinnedDigest = byId.repoDigests.find((d) => d === `${entry.repository}@${entry.digest}`)
    const otherDigest = byId.repoDigests.find((d) => d.startsWith(`${entry.repository}@`) && d !== `${entry.repository}@${entry.digest}`)
    if (otherDigest) {
      rows.push({ task, ok: false, detail: `local copy carries ${otherDigest}, pin is ${entry.digest}` })
      continue
    }
    rows.push({
      task,
      ok: true,
      detail: pinnedDigest ? 'digest-provenance: registry' : 'digest-provenance: archive (RepoDigests dropped by docker load)',
    })
  }
  return rows
}

async function cmdVerify(args) {
  const lock = readLock(args.lock)
  const tasks = taskList(args, args.tb2, lock)
  const started = Date.now()
  const rows = verifyPins(lock, tasks, args.store)
  const failed = rows.filter((row) => !row.ok)
  for (const row of rows) console.log(`${row.ok ? 'ok  ' : 'FAIL'}\t${row.task}\t${row.detail}`)
  console.log(`${rows.length - failed.length}/${rows.length} pins verified in ${Date.now() - started} ms, zero network calls`)
  if (failed.length > 0) process.exitCode = 1
}

async function cmdStatus(args) {
  const lock = readLock(args.lock)
  const tasks = taskList(args, args.tb2, lock)
  console.log('task\tdigest\timageId\tlocal\tarchived\tbytes')
  for (const task of tasks) {
    const entry = lock.images[task]
    if (!entry) {
      console.log(`${task}\t-\t-\tno\tno\t-`)
      continue
    }
    const local = entry.imageId ? localImage(entry.imageId) : null
    const archived = entry.imageId && existsSync(storePaths(args.store, entry.imageId).blob)
    console.log(
      `${task}\t${entry.digest.slice(7, 19)}\t${entry.imageId ? entry.imageId.slice(7, 19) : '-'}\t` +
        `${local ? 'yes' : 'no'}\t${archived ? 'yes' : 'no'}\t${entry.imageBytes ?? '-'}`,
    )
  }
  console.log(`tb2 commit: ${lock.tb2Commit ?? 'unlocked'}`)
  if (args.quota) {
    const quota = await readHubQuota()
    console.log(
      quota
        ? `hub quota: ${quota.remaining}/${quota.limit} per ${quota.windowSeconds}s (source ${quota.source ?? 'unknown'})`
        : 'hub quota: unreadable',
    )
  }
}

// Resolution the replay batch calls per row. Local only, and it refuses to hand back a
// reference whose local bytes do not match the pin.
export function resolvePinnedImage(lockPath, task, storeDir = DEFAULT_STORE) {
  const lock = readLock(lockPath)
  const [row] = verifyPins(lock, [task], storeDir)
  if (!row.ok) throw new Error(`${task}: pinned image unusable (${row.detail})`)
  const entry = lock.images[task]
  return {
    reference: `${entry.repository}:${entry.tag}`,
    digest: entry.digest,
    imageId: entry.imageId,
    tb2Commit: lock.tb2Commit,
  }
}

function parseArgs(argv) {
  const out = {
    command: argv[0],
    lock: DEFAULT_LOCK,
    tb2: DEFAULT_TB2,
    store: DEFAULT_STORE,
    tasks: null,
    tasksFile: null,
    reserve: 10,
    archive: false,
    acceptMoved: false,
    quota: false,
  }
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--lock') out.lock = resolve(expandHome(argv[++i]))
    else if (a === '--tb2') out.tb2 = resolve(expandHome(argv[++i]))
    else if (a === '--store') out.store = resolve(expandHome(argv[++i]))
    else if (a === '--tasks') out.tasks = argv[++i]
    else if (a === '--tasks-file') out.tasksFile = resolve(expandHome(argv[++i]))
    else if (a === '--reserve') out.reserve = Number(argv[++i])
    else if (a === '--archive') out.archive = true
    else if (a === '--accept-moved') out.acceptMoved = true
    else if (a === '--quota') out.quota = true
    else throw new Error(`unknown argument: ${a}`)
  }
  if (!Number.isInteger(out.reserve) || out.reserve < 0) throw new Error(`--reserve must be a non-negative integer`)
  return out
}

const COMMANDS = { lock: cmdLock, warm: cmdWarm, archive: cmdArchive, verify: cmdVerify, status: cmdStatus }
const WRITERS = new Set(['lock', 'warm', 'archive'])

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const run = COMMANDS[args.command]
  if (!run) {
    console.error(`usage: tb-images.mjs <${Object.keys(COMMANDS).join('|')}> [options]`)
    process.exit(2)
  }
  const release = WRITERS.has(args.command) ? acquireStoreLock(args.store) : null
  try {
    await run(args)
  } finally {
    release?.()
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message)
    process.exit(1)
  })
}
