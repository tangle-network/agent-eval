/**
 * Start the submission's production build and attest what is served.
 *
 * The app process gets a clean environment: PATH, HOME, NODE_ENV, PORT and the
 * task's declared app variables (for a product task: the product URL and the app's
 * own scoped key). Grader credentials never reach it.
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { createWriteStream, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export interface ServeAttestation {
  command: string[]
  pid: number | null
  portOwnerPid: number | null
  portOwnerCommand: string | null
  /** The listener belongs to the process group this call spawned, not to a server left on the port. */
  portOwnerIsChild: boolean
  readyAfterMs: number | null
  lastStatus: number | null
  isScaffoldPreview: boolean
}

export interface ServedApp {
  url: string
  attestation: ServeAttestation
  stop: () => Promise<void>
}

function startCommand(workdir: string): string[] {
  const pkg = JSON.parse(readFileSync(join(workdir, 'package.json'), 'utf8')) as { scripts?: Record<string, string> }
  const next = join(workdir, 'node_modules', '.bin', 'next')
  // The Next.js family's production server. A contestant `start` script that is not
  // `next start` is recorded but not trusted; the attestation below shows what ran.
  if (existsSync(next)) return [next, 'start']
  if (pkg.scripts?.start) return ['npm', 'run', 'start', '--']
  throw new Error('no production start command: node_modules/.bin/next is missing and package.json has no start script')
}

/**
 * The pid listening on `port`, or null. Linux asks `ss`: lsof 4.95 there lists no process whose
 * name holds '(', and `next start` renames its server `next-server (v16.3.6)`, so every Next.js
 * submission read as unserved on drew-gtr-pro (2026-09-27). macOS asks lsof.
 */
function listeningPid(port: number): number | null {
  if (process.platform === 'linux') {
    const out = execFileSync('ss', ['-Hltnp', `sport = :${port}`], { encoding: 'utf8' })
    const match = /pid=(\d+)/.exec(out)
    return match ? Number(match[1]) : null
  }
  // lsof exits 1 when nothing listens; the caller reads that as no owner.
  const pid = Number(execFileSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], { encoding: 'utf8' }).trim().split('\n')[0])
  return Number.isFinite(pid) && pid > 0 ? pid : null
}

/** The process listening on `port`, or all nulls when none does or the lookup fails. */
export function portOwner(port: number): { pid: number | null; pgid: number | null; command: string | null } {
  try {
    const pid = listeningPid(port)
    if (pid === null) return { pid: null, pgid: null, command: null }
    const command = execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' }).trim()
    const pgid = Number(execFileSync('ps', ['-o', 'pgid=', '-p', String(pid)], { encoding: 'utf8' }).trim())
    return { pid, pgid: Number.isFinite(pgid) ? pgid : null, command }
  } catch {
    return { pid: null, pgid: null, command: null }
  }
}

/**
 * Ports the Fetch standard blocks (https://fetch.spec.whatwg.org/#bad-port). Chromium refuses
 * to load them and `next start` refuses to bind them, so a run on one would fail the
 * submission for the grader's own choice of port.
 */
const BAD_PORTS = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123,
  135, 137, 139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995,
  1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080,
])

/**
 * Process groups of apps this process served and has not stopped. A grader that dies on a signal
 * never calls `stop`, and its detached app would keep the port: on 2026-09-27 a board grading died
 * with its ssh session and left four `next-server` processes on ports 4611-4622 for 11 hours, and
 * two held-out climb cells then failed all three attempts on "port 4611 is already served".
 */
const liveGroups = new Set<number>()
let reaperInstalled = false

function reapGroups(): void {
  for (const pgid of liveGroups) {
    try {
      process.kill(-pgid, 'SIGKILL')
    } catch {
      // Already gone.
    }
  }
  liveGroups.clear()
}

function installReaper(): void {
  if (reaperInstalled) return
  reaperInstalled = true
  process.once('exit', reapGroups)
  for (const signal of ['SIGHUP', 'SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      reapGroups()
      // This listener replaced the signal's default action; restore it unless the host handles the signal.
      if (process.listenerCount(signal) === 0) process.kill(process.pid, signal)
    })
  }
}

export async function serveApp(input: { workdir: string; port: number; logPath: string; readyTimeoutMs?: number; env?: Record<string, string> }): Promise<ServedApp> {
  if (BAD_PORTS.has(input.port)) throw new Error(`port ${input.port} is a blocked port (Fetch standard); browsers and next start refuse it`)
  // A server already on the port would answer the readiness probe and be graded in place of this submission.
  const occupant = portOwner(input.port)
  if (occupant.pid !== null) throw new Error(`port ${input.port} is already served by pid ${occupant.pid}: ${occupant.command ?? ''}`)
  const command = [...startCommand(input.workdir), '-p', String(input.port)]
  const log = createWriteStream(input.logPath)
  const child: ChildProcess = spawn(command[0]!, command.slice(1), {
    cwd: input.workdir,
    env: { ...input.env, PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', NODE_ENV: 'production', PORT: String(input.port) },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  })
  if (child.pid) {
    liveGroups.add(child.pid)
    installReaper()
  }
  child.stdout?.pipe(log)
  child.stderr?.pipe(log)
  const url = `http://127.0.0.1:${input.port}/`
  const started = Date.now()
  let lastStatus: number | null = null
  let readyAfterMs: number | null = null
  while (Date.now() - started < (input.readyTimeoutMs ?? 60_000)) {
    if (child.exitCode !== null) break
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(5_000) })
      lastStatus = response.status
      if (response.ok) {
        readyAfterMs = Date.now() - started
        break
      }
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  const owner = portOwner(input.port)
  const attestation: ServeAttestation = {
    command,
    pid: child.pid ?? null,
    portOwnerPid: owner.pid,
    portOwnerCommand: owner.command,
    // Detached, so the child leads its own process group; `next start` forks the listener into it.
    portOwnerIsChild: child.pid !== undefined && owner.pgid === child.pid,
    readyAfterMs,
    lastStatus,
    isScaffoldPreview: /preview-server\.mjs|preview:instant/.test(`${command.join(' ')} ${owner.command ?? ''}`),
  }
  return {
    url,
    attestation,
    stop: async () => {
      if (child.pid && child.exitCode === null && child.signalCode === null) {
        const exited = new Promise((resolve) => child.once('exit', resolve))
        try {
          process.kill(-child.pid, 'SIGTERM')
        } catch {
          // Already gone.
        }
        // The port must be free before the next run binds it; SIGKILL the group if SIGTERM is ignored.
        const timer = setTimeout(() => {
          try {
            process.kill(-child.pid!, 'SIGKILL')
          } catch {
            // Already gone.
          }
        }, 5_000)
        await exited
        clearTimeout(timer)
      }
      if (child.pid) liveGroups.delete(child.pid)
      log.end()
    },
  }
}
