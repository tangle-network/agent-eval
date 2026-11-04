/**
 * The real product for one grading run: its official image started fresh on Docker with a
 * random admin secret, or a fresh tenant of a vendor's hosted test mode; the grader's admin
 * requests against it; and a recording proxy the app talks to instead of the product.
 *
 * The admin secret stays in the grader. It reaches a container through Docker's own
 * environment (never argv) and never enters an evidence file, a SystemOne state or the app's
 * environment. A hosted app holds only a per-run placeholder key that the proxy swaps for the
 * secret. The proxy records which credential each app request carried by comparing it with the
 * secrets the grader holds, so a submission cannot claim another identity.
 */
import { execFile } from 'node:child_process'
import { createHmac, randomBytes, randomInt } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import {
  createServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type OutgoingHttpHeaders,
  type Server,
} from 'node:http'
import { request as httpsRequest } from 'node:https'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'
import {
  type HostedProductSpec,
  type HttpStep,
  type Json,
  jsonPath,
  type ProbeSpec,
  type ProductSpec,
  type ReadSpec,
  render,
} from './spec'

const run = promisify(execFile)

/** Readiness window for a product whose spec sets none; see startProduct. */
const DEFAULT_READY_TIMEOUT_MS = 600_000

/**
 * Where the product port is published. Docker honours DOCKER_HOST, so a remote daemon runs the
 * product; it must then publish on an address this host can reach, such as that machine's tailnet
 * IP. `docker port` reports the bound address, so the product URL follows it.
 */
const PRODUCT_BIND = process.env.VB_PRODUCT_BIND || '127.0.0.1'
const OWNER_LABEL = 'verticalbench.app-grade.owner'
const RUN_LABEL = 'verticalbench.app-grade.run'
const DOCKER_LIFECYCLE_TIMEOUT_MS = 60_000
const DOCKER_CLEANUP_TIMEOUT_MS = 30_000
const DOCKER_QUERY_TIMEOUT_MS = 10_000
const LATE_CREATE_SWEEPS_MS = [250, 1_000, 3_000] as const
const RUN_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/

async function labeledContainers(label: string, owner: string): Promise<string[]> {
  const { stdout } = await run('docker', ['ps', '-aq', '--filter', `label=${label}=${owner}`], {
    timeout: DOCKER_QUERY_TIMEOUT_MS,
  })
  return stdout.trim().split('\n').filter(Boolean)
}

async function removeLabeledContainers(label: string, owner: string): Promise<void> {
  const ids = await labeledContainers(label, owner)
  if (ids.length === 0) return
  try {
    await run('docker', ['rm', '-f', ...ids], { timeout: DOCKER_CLEANUP_TIMEOUT_MS })
  } catch (error) {
    // Another cleanup may have removed the same container after the list call.
    if ((await labeledContainers(label, owner)).length > 0) throw error
  }
}

/** A killed Docker client can leave a daemon-side create that appears after the first query. */
async function followLateCreation(label: string, owner: string): Promise<void> {
  for (const waitMs of LATE_CREATE_SWEEPS_MS) {
    await delay(waitMs)
    await removeLabeledContainers(label, owner)
  }
}

/** Remove only products started by one App Grade process, including an interrupted startup. */
export async function cleanupAppGradeProducts(
  runId: string,
  followLateCreate = false,
): Promise<void> {
  if (!RUN_ID.test(runId)) throw new Error('invalid App Grade run id')
  await removeLabeledContainers(RUN_LABEL, runId)
  if (followLateCreate) await followLateCreation(RUN_LABEL, runId)
}

export interface ProductContext {
  probe: Record<string, Json>
  vars: Record<string, Json>
}

export interface RunningProduct {
  spec: ProductSpec
  /** Where grader requests go: the container's host URL or the vendor's origin. */
  url: string
  reportedVersion: string
  /** A hosted product's per-run placeholder app key; an image product's key comes from setup. */
  appKey: string | null
  /** App variables the product itself sets: a hosted tenant id and webhook secret. */
  appEnv: Record<string, string>
  /** Admin request against the product. The response body is parsed JSON when it is JSON. */
  admin(method: string, path: string, body?: Json): Promise<{ status: number; body: unknown }>
  /** Values that must never appear in evidence: the admin secret and minted credentials. */
  secrets(): string[]
  addSecret(value: string): void
  credentialOf(
    headers: IncomingHttpHeaders,
    appKey: string | null,
  ): 'admin' | 'app' | 'none' | 'other'
  /** The headers an app request goes upstream with: product host, tenant scope, placeholder swapped. */
  forward(headers: IncomingHttpHeaders): OutgoingHttpHeaders
  stop(): Promise<void>
}

/** `untracked` means startup failed before a caller could retain the product for cleanup retry. */
export class ProductCleanupError extends AggregateError {
  constructor(
    errors: unknown[],
    message: string,
    readonly untracked = false,
  ) {
    super(errors, message)
    this.name = 'ProductCleanupError'
  }
}

const WORDS = [
  'amber',
  'basalt',
  'cobalt',
  'delta',
  'ember',
  'fjord',
  'garnet',
  'harbor',
  'indigo',
  'juniper',
  'kestrel',
  'lumen',
  'marble',
  'nimbus',
  'onyx',
  'pollen',
  'quartz',
  'russet',
  'saffron',
  'tundra',
  'umber',
  'velvet',
  'willow',
  'xenon',
  'yarrow',
  'zephyr',
]

/** Fresh values for one run. A word probe is a pronounceable token no model has seen with this task. */
export function drawProbes(probes: Record<string, ProbeSpec>): Record<string, Json> {
  const out: Record<string, Json> = {}
  for (const [name, probe] of Object.entries(probes)) {
    if (probe.kind === 'word')
      out[name] =
        `${probe.prefix ?? ''}${WORDS[randomInt(WORDS.length)]}${randomBytes(2).toString('hex')}`
    else if (probe.kind === 'int') out[name] = randomInt(probe.min, probe.max + 1)
    else out[name] = probe.from[randomInt(probe.from.length)]!
  }
  return out
}

function authValue(spec: ProductSpec, secret: string): string {
  return `${spec.auth.prefix ?? ''}${secret}`
}

async function fetchJson(
  url: string,
  init: RequestInit,
  signal?: AbortSignal,
): Promise<{ status: number; body: unknown }> {
  const timeout = AbortSignal.timeout(30_000)
  const response = await fetch(url, {
    ...init,
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  })
  const text = await response.text()
  let body: unknown = text
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    // Not JSON; keep the text.
  }
  return { status: response.status, body }
}

/** Stripe's form encoding: nested keys in brackets, arrays by index. */
function formFields(value: Json, key: string, out: URLSearchParams): URLSearchParams {
  if (value !== null && typeof value === 'object')
    for (const [name, inner] of Object.entries(value))
      formFields(inner, key ? `${key}[${name}]` : name, out)
  else out.append(key, value === null ? '' : String(value))
  return out
}

function adminClient(
  spec: ProductSpec,
  url: string,
  secret: string,
  scope: Record<string, string>,
  signal?: AbortSignal,
) {
  const form = spec.hosted?.formBodies === true
  return (method: string, path: string, body?: Json) =>
    fetchJson(
      new URL(path, url).toString(),
      {
        method,
        headers: {
          ...spec.hosted?.headers,
          ...scope,
          [spec.auth.header]: authValue(spec, secret),
          ...(body !== undefined
            ? { 'Content-Type': form ? 'application/x-www-form-urlencoded' : 'application/json' }
            : {}),
        },
        ...(body !== undefined
          ? {
              body: form
                ? formFields(body, '', new URLSearchParams()).toString()
                : JSON.stringify(body),
            }
          : {}),
      },
      signal,
    )
}

/** Check the declared version, then hand out the product. Shared by image and hosted products. */
async function connectProduct(
  spec: ProductSpec,
  on: {
    url: string
    secret: string
    secrets: Set<string>
    stop: () => Promise<void>
    scope?: Record<string, string>
    appKey?: string
    appEnv?: Record<string, string>
  },
  signal?: AbortSignal,
): Promise<RunningProduct> {
  const scope = on.scope ?? {}
  const admin = adminClient(spec, on.url, on.secret, scope, signal)
  const probe = spec.versionProbe
  const versionReply = await admin(probe.method ?? 'GET', probe.path, probe.body)
  signal?.throwIfAborted()
  const reportedVersion = String(
    jsonPath(versionReply.body, spec.versionProbe.jsonPath) ?? `HTTP ${versionReply.status}`,
  )
  if (reportedVersion !== spec.version)
    throw new Error(`${spec.name}: expected version ${spec.version}, got ${reportedVersion}`)
  const header = spec.auth.header.toLowerCase()
  const host = new URL(on.url).host
  return {
    spec,
    url: on.url,
    reportedVersion,
    appKey: on.appKey ?? null,
    appEnv: on.appEnv ?? {},
    admin,
    secrets: () => [...on.secrets],
    addSecret: (value) => {
      if (value) on.secrets.add(value)
    },
    credentialOf(headers, appKey) {
      const raw = headers[header]
      const value = Array.isArray(raw) ? raw[0] : raw
      if (!value) return 'none'
      if (value === authValue(spec, on.secret)) return 'admin'
      if (appKey && value === authValue(spec, appKey)) return 'app'
      return 'other'
    },
    forward(headers) {
      const out: OutgoingHttpHeaders = { ...headers, host, ...scope }
      delete out['accept-encoding']
      if (on.appKey && out[header] === authValue(spec, on.appKey))
        out[header] = authValue(spec, on.secret)
      return out
    },
    stop: on.stop,
  }
}

/**
 * A vendor's hosted test mode. With a tenant, the run creates its own (a Stripe connected
 * account), waits until it can act, scopes every request to it and deletes it on stop.
 */
async function startHostedProduct(
  spec: HostedProductSpec,
  signal?: AbortSignal,
): Promise<RunningProduct> {
  const { hosted } = spec
  const secret = process.env[hosted.secretEnv]
  if (!secret) throw new Error(`${spec.name}: ${hosted.secretEnv} is not set`)
  const platform = adminClient(spec, hosted.origin, secret, {}, signal)
  const appEnv: Record<string, string> = hosted.events
    ? { [hosted.events.secretEnv]: `whsec_${randomBytes(24).toString('base64url')}` }
    : {}
  let scope: Record<string, string> = {}
  let stop = async () => {}
  try {
    if (hosted.tenant) {
      const { create, header, ready } = hosted.tenant
      const created = await platform('POST', create.path, create.body)
      const id = jsonPath(created.body, 'id')
      if (typeof id !== 'string')
        throw new Error(
          `${spec.name}: tenant create returned ${created.status}: ${JSON.stringify(created.body).slice(0, 300)}`,
        )
      stop = async () => {
        const removed = await platform('DELETE', `${create.path}/${id}`).catch(
          (error: unknown) => ({ status: 0, body: String(error) }),
        )
        if (removed.status !== 200 && removed.status !== 404)
          throw new ProductCleanupError(
            [new Error(`HTTP ${removed.status}`)],
            `${spec.name}: failed to delete tenant ${id}`,
          )
      }
      const deadline = Date.now() + (ready.timeoutMs ?? 120_000)
      for (;;) {
        const state = await platform('GET', `${create.path}/${id}`)
        if (JSON.stringify(jsonPath(state.body, ready.jsonPath)) === JSON.stringify(ready.equals))
          break
        if (Date.now() > deadline)
          throw new Error(
            `${spec.name}: tenant ${id} ${ready.jsonPath} never read ${JSON.stringify(ready.equals)}`,
          )
        await delay(2_000, undefined, { signal })
      }
      scope = { [header.toLowerCase()]: id }
      if (hosted.tenant.appEnv) appEnv[hosted.tenant.appEnv] = id
    }
    const appKey = `${hosted.appKeyPrefix}${randomBytes(16).toString('hex')}`
    return await connectProduct(
      spec,
      {
        url: hosted.origin,
        secret,
        secrets: new Set([secret, appKey, ...Object.values(appEnv)]),
        stop,
        scope,
        appKey,
        appEnv,
      },
      signal,
    )
  } catch (error) {
    await stop().catch((cleanup: unknown) => {
      throw new ProductCleanupError(
        [error, cleanup],
        `${spec.name}: start failed and its tenant was not deleted`,
        true,
      )
    })
    throw error
  }
}

/**
 * The vendor cannot reach a grader-local app, so the grader delivers the run's events: it lists
 * them and POSTs each, oldest first, to the app's webhook route until the app answers 2xx (five
 * tries), signed with the run's secret in Stripe's `t=<unix>,v1=<HMAC-SHA256("<t>.<body>")>` scheme.
 */
export function startEventRelay(
  product: RunningProduct,
  appUrl: string,
  logPath: string,
): { stop(): Promise<void> } {
  const events = product.spec.hosted?.events
  if (!events) return { stop: async () => {} }
  const secret = product.appEnv[events.secretEnv]!
  const since = Math.floor(Date.now() / 1000) - 5
  const tries = new Map<string, number>()
  let running = true
  const loop = (async () => {
    while (running) {
      const listed = await product
        .admin('GET', `${events.path}?limit=100&created[gte]=${since}`)
        .catch(() => null)
      for (const event of [
        ...((listed?.body as { data?: { id: string; type: string }[] } | null)?.data ?? []),
      ].reverse()) {
        if ((tries.get(event.id) ?? 0) >= 5) continue
        const body = JSON.stringify(event)
        const t = Math.floor(Date.now() / 1000)
        const signature = `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}`
        const status = await fetch(new URL(events.route, appUrl), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Stripe-Signature': signature },
          body,
          signal: AbortSignal.timeout(10_000),
        })
          .then((reply) => reply.status)
          .catch(() => null)
        tries.set(event.id, status !== null && status < 300 ? 5 : (tries.get(event.id) ?? 0) + 1)
        appendFileSync(
          logPath,
          `${JSON.stringify({ t: Date.now(), event: event.id, type: event.type, status })}\n`,
        )
      }
      await delay(1_000)
    }
  })()
  return {
    stop: async () => {
      running = false
      await loop
    },
  }
}

/** Start the pinned image, or a hosted tenant, and wait until it answers as the declared version. */
export async function startProduct(
  spec: ProductSpec,
  options: { logPath?: string; signal?: AbortSignal } = {},
): Promise<RunningProduct> {
  options.signal?.throwIfAborted()
  if (spec.hosted) return startHostedProduct(spec, options.signal)
  const adminSecret = randomBytes(24).toString('hex')
  const secrets = new Set([adminSecret])
  const env = Object.fromEntries(
    Object.entries(spec.env ?? {}).map(([key, value]) => [key, render(value, { adminSecret })]),
  )
  const owner = randomBytes(16).toString('hex')
  const name = `vb-product-${spec.name}-${owner}`
  const runId = process.env.VB_APP_GRADE_RUN_ID
  if (runId && !RUN_ID.test(runId)) throw new Error('invalid App Grade run id')
  let containerId: string | null = null
  const stop = async () => {
    try {
      if (options.logPath && containerId) {
        const logs = await run('docker', ['logs', containerId], {
          maxBuffer: 16 * 1024 * 1024,
          timeout: DOCKER_QUERY_TIMEOUT_MS,
        }).catch(() => null)
        if (logs)
          appendFileSync(options.logPath, redact(`${logs.stdout}${logs.stderr}`, [...secrets]))
      }
    } finally {
      try {
        await removeLabeledContainers(OWNER_LABEL, owner)
      } catch (error) {
        // biome-ignore lint/correctness/noUnsafeFinally: a container this run cannot remove must fail the run, over any log error
        throw new ProductCleanupError(
          [error],
          `${spec.name}: failed to remove its run-owned container`,
        )
      }
    }
  }
  // `-e NAME` makes Docker read each value from its own environment, so no secret enters argv.
  // No `--rm`: a container that exits at startup keeps its log until `stop` removes it, so the
  // failure below can say why the product did not start.
  try {
    // Complete creation before checking abort. A cancelled Docker client can leave a late
    // daemon-side container; a created container cannot run before this process starts it.
    const { stdout } = await run(
      'docker',
      [
        'create',
        '--name',
        name,
        '--label',
        'verticalbench.app-grade=product',
        '--label',
        `${OWNER_LABEL}=${owner}`,
        ...(runId ? ['--label', `${RUN_LABEL}=${runId}`] : []),
        '-p',
        `${PRODUCT_BIND}::${spec.port}`,
        ...Object.keys(env).flatMap((key) => ['-e', key]),
        spec.image,
        ...(spec.args ?? []),
      ],
      { env: { ...process.env, ...env }, timeout: DOCKER_LIFECYCLE_TIMEOUT_MS },
    )
    containerId = stdout.trim()
    options.signal?.throwIfAborted()
    await run('docker', ['start', containerId], { timeout: DOCKER_LIFECYCLE_TIMEOUT_MS })
    options.signal?.throwIfAborted()
    const port = (
      await run('docker', ['port', containerId, `${spec.port}/tcp`], {
        signal: options.signal,
        timeout: DOCKER_QUERY_TIMEOUT_MS,
      })
    ).stdout
      .trim()
      .split('\n')[0]!
    const url = `http://${port}`
    // A running container gets a long window because first-boot time scales with host load:
    // Directus 12.4.1 ran its migrations for 158 s at load ~290 and failed a 120 s window in 36
    // of 43 define grades. A container that exits fails at once, so a broken spec stays fast.
    const readyTimeoutMs = spec.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS
    const deadline = Date.now() + readyTimeoutMs
    for (let poll = 1; ; poll += 1) {
      options.signal?.throwIfAborted()
      const timeout = AbortSignal.timeout(5_000)
      const status = await fetch(new URL(spec.ready.path, url), {
        method: spec.ready.method ?? 'GET',
        headers: { 'Content-Type': 'application/json' },
        body: spec.ready.body === undefined ? undefined : JSON.stringify(spec.ready.body),
        signal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout,
      })
        .then((response) => response.status)
        .catch(() => null)
      options.signal?.throwIfAborted()
      if (
        status !== null &&
        (spec.ready.status === undefined
          ? status >= 200 && status < 300
          : status === spec.ready.status)
      )
        break
      if (Date.now() > deadline)
        throw new Error(
          `${spec.name}: not ready at ${spec.ready.path} within ${readyTimeoutMs} ms (last status ${status})`,
        )
      if (poll % 10 === 0) {
        const running = await run(
          'docker',
          ['inspect', '--format', '{{.State.Running}}', containerId],
          { signal: options.signal, timeout: DOCKER_QUERY_TIMEOUT_MS },
        )
          .then((inspect) => inspect.stdout.trim())
          .catch(() => 'unknown')
        options.signal?.throwIfAborted()
        if (running === 'false')
          throw new Error(
            `${spec.name}: container stopped before ${spec.ready.path} answered (last status ${status})`,
          )
      }
      await delay(500, undefined, { signal: options.signal })
    }
    return await connectProduct(spec, { url, secret: adminSecret, secrets, stop }, options.signal)
  } catch (error) {
    // The product's own last words (a missing data directory, a bad setting) are the diagnosis;
    // without them a crashed container reads only as an unpublished port.
    const tail =
      containerId && !options.signal?.aborted
        ? await run('docker', ['logs', '--tail', '25', containerId], {
            maxBuffer: 1024 * 1024,
            timeout: DOCKER_QUERY_TIMEOUT_MS,
          }).catch(() => null)
        : null
    const state =
      containerId && !options.signal?.aborted
        ? await run(
            'docker',
            ['inspect', '--format', '{{.State.Status}} exit {{.State.ExitCode}}', containerId],
            { timeout: DOCKER_QUERY_TIMEOUT_MS },
          ).catch(() => null)
        : null
    try {
      await stop()
      if (!containerId && (error as { killed?: boolean }).killed)
        await followLateCreation(OWNER_LABEL, owner)
    } catch (cleanup) {
      if (
        cleanup instanceof ProductCleanupError ||
        (!containerId && (error as { killed?: boolean }).killed)
      ) {
        throw new ProductCleanupError(
          [error, cleanup],
          `${spec.name}: start failed and its container was not removed`,
          true,
        )
      }
      throw new AggregateError(
        [error, cleanup],
        `${spec.name}: start failed and could not retain its log`,
      )
    }
    const log = tail ? redact(`${tail.stdout}${tail.stderr}`, [...secrets]).trim() : ''
    if (error instanceof Error && (log || state)) {
      error.message = `${error.message}\ncontainer ${state?.stdout.trim() ?? 'state unknown'}; last log lines:\n${log.slice(-3_000) || '(none)'}`
    }
    throw error
  }
}

/** Run the setup steps as admin, in order. Returns the captured variables. */
export async function runSetup(
  product: RunningProduct,
  steps: HttpStep[],
  context: ProductContext,
  log: (entry: unknown) => void,
): Promise<void> {
  for (const step of steps) {
    const path = render(step.path, context)
    const body = step.body === undefined ? undefined : render(step.body, context)
    const reply = await product.admin(step.method, path, body)
    const accepted = step.expectStatus
      ? step.expectStatus.includes(reply.status)
      : reply.status >= 200 && reply.status < 300
    log({ step: step.name, method: step.method, path, status: reply.status, accepted })
    if (!accepted)
      throw new Error(
        `setup step ${step.name}: ${step.method} ${path} returned ${reply.status}: ${JSON.stringify(reply.body).slice(0, 300)}`,
      )
    for (const [name, at] of Object.entries(step.capture ?? {})) {
      const value = jsonPath(reply.body, at)
      if (value === undefined)
        throw new Error(`setup step ${step.name}: nothing at ${at} to capture as ${name}`)
      context.vars[name] = value as Json
    }
    if (step.waitFor) {
      const waitPath = render(step.waitFor.path, context)
      const deadline = Date.now() + (step.waitFor.timeoutMs ?? 60_000)
      for (;;) {
        const polled = await product.admin('GET', waitPath)
        const value = jsonPath(polled.body, step.waitFor.jsonPath)
        if (JSON.stringify(value) === JSON.stringify(step.waitFor.equals)) break
        if (Date.now() > deadline)
          throw new Error(
            `setup step ${step.name}: ${waitPath} ${step.waitFor.jsonPath} is ${JSON.stringify(value)}, not ${JSON.stringify(step.waitFor.equals)}`,
          )
        await delay(250)
      }
    }
  }
}

/** Admin reads after the journeys: what the product itself holds or answers. */
export async function runReads(
  product: RunningProduct,
  reads: ReadSpec[],
  context: ProductContext,
): Promise<Record<string, { status: number; body: unknown }>> {
  const out: Record<string, { status: number; body: unknown }> = {}
  for (const read of reads) {
    out[read.name] = await product.admin(
      read.method,
      render(read.path, context),
      read.body === undefined ? undefined : render(read.body, context),
    )
  }
  return out
}

/** One app request the proxy forwarded to the product. */
export interface ProductRequest {
  t: number
  method: string
  path: string
  query: string
  credential: 'admin' | 'app' | 'none' | 'other'
  /** `browser` when the request carried browser fetch metadata (Origin, Sec-Fetch-Site or Sec-Fetch-Dest). */
  from: 'server' | 'browser'
  status: number | null
  body: string
  response: string
}

export interface RecordingProxy {
  url: string
  requests: ProductRequest[]
  close(): Promise<void>
}

const MAX_LOGGED_BODY = 16_384

export function redact(text: string, secrets: string[]): string {
  let out = text
  for (const secret of secrets) if (secret) out = out.split(secret).join('[redacted]')
  return out
}

/**
 * A pass-through proxy on 127.0.0.1 in front of the product. It forwards every request with the
 * product's headers (`RunningProduct.forward`) and records method, path, query, credential
 * identity, origin kind, status and truncated bodies, with the grader's secrets redacted.
 */
export async function startRecordingProxy(
  product: RunningProduct,
  appKey: string | null,
  logPath: string,
): Promise<RecordingProxy> {
  const target = new URL(product.url)
  const requests: ProductRequest[] = []
  const server: Server = createServer((incoming, outgoing) => {
    const chunks: Buffer[] = []
    incoming.on('data', (chunk: Buffer) => chunks.push(chunk))
    incoming.on('end', () => {
      const requestBody = Buffer.concat(chunks)
      const url = new URL(incoming.url ?? '/', 'http://proxy.local')
      const entry: ProductRequest = {
        t: Date.now(),
        method: incoming.method ?? 'GET',
        path: url.pathname,
        query: url.search.replace(/^\?/, ''),
        credential: product.credentialOf(incoming.headers, appKey),
        // Browsers always send Sec-Fetch-Site and Sec-Fetch-Dest, and a page cannot remove them.
        // Node's fetch sends Sec-Fetch-Mode too, so that header alone marks nothing.
        from:
          incoming.headers.origin ||
          incoming.headers['sec-fetch-site'] ||
          incoming.headers['sec-fetch-dest']
            ? 'browser'
            : 'server',
        status: null,
        body: redact(requestBody.toString('utf8').slice(0, MAX_LOGGED_BODY), product.secrets()),
        response: '',
      }
      const send = target.protocol === 'https:' ? httpsRequest : httpRequest
      const upstream = send(
        {
          hostname: target.hostname,
          port: target.port || undefined,
          path: incoming.url,
          method: incoming.method,
          headers: product.forward(incoming.headers),
        },
        (reply) => {
          const replyChunks: Buffer[] = []
          reply.on('data', (chunk: Buffer) => replyChunks.push(chunk))
          reply.on('end', () => {
            const replyBody = Buffer.concat(replyChunks)
            entry.status = reply.statusCode ?? null
            entry.response = redact(
              replyBody.toString('utf8').slice(0, MAX_LOGGED_BODY),
              product.secrets(),
            )
            requests.push(entry)
            appendFileSync(logPath, `${JSON.stringify(entry)}\n`)
            outgoing.writeHead(reply.statusCode ?? 502, reply.headers)
            outgoing.end(replyBody)
          })
        },
      )
      upstream.on('error', (error) => {
        entry.response = `proxy error: ${error.message}`
        requests.push(entry)
        appendFileSync(logPath, `${JSON.stringify(entry)}\n`)
        outgoing.writeHead(502)
        outgoing.end()
      })
      upstream.end(requestBody)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string')
    throw new Error('recording proxy did not bind a port')
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}
