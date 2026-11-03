/**
 * Declarative App Grade tasks.
 *
 * A company suite is data: the real product a task runs against (`ProductSpec`, on the
 * seed) and, per task, the grader-side setup, browser journeys, product reads,
 * deterministic checks and SystemOne reviews (`AppGradeSpec`, on the leaf). `spec-leaf.ts`
 * interprets a spec with the same browser session, target picker, SystemOne reviews and tier
 * ladder as the hand-written leaves in `leaves/`. `vb define` authors these specs.
 *
 * Evidence a spec can check comes from outside the submission's reach: the product's own
 * replies to the grader's admin reads, and the grader's recording proxy between the app and
 * the product. Page text is evidence of what the user saw, never of what the product did.
 *
 * This module and `verdict.ts` import nothing outside App Grade, so the repository's
 * admission gate can read them without App Grade's dependencies.
 */
import type { Tier, TierRole } from './verdict'

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json }

/** The real product: its official image run fresh for every grading run, or a vendor's hosted test mode. */
export type ProductSpec = ImageProductSpec | HostedProductSpec

export interface ImageProductSpec extends ProductBase {
  /** Official image pinned by digest: `<repository>:<tag>@sha256:<64 hex>`. */
  image: string
  /** Container port the product listens on. */
  port: number
  /** Container environment. `{{adminSecret}}` is the grader's per-run admin secret. */
  env?: Record<string, string>
  /** Arguments after the image entrypoint. They must not carry the admin secret. */
  args?: string[]
  /** Unauthenticated readiness probe. */
  ready: { path: string; status?: number }
  readyTimeoutMs?: number
  hosted?: undefined
}

/**
 * A vendor's hosted test environment (Stripe test mode) that no image can stand up. The grader
 * reaches `origin` with the secret in `secretEnv`; the app reaches it only through the recording
 * proxy, which swaps the app's per-run placeholder key for that secret, so the secret never
 * enters the app, its logs or the evidence.
 */
export interface HostedProductSpec extends ProductBase {
  hosted: {
    origin: string
    secretEnv: string
    /** Prefix of the app's per-run placeholder key, e.g. `sk_test_vb_`. */
    appKeyPrefix: string
    /** Headers the grader's admin requests carry, e.g. a pinned `Stripe-Version`; app requests keep their own. */
    headers?: Record<string, string>
    /** Admin request bodies are form-encoded with bracketed keys (Stripe) instead of JSON. */
    formBodies?: boolean
    /**
     * A fresh tenant per run (a Stripe connected account), so concurrent runs share nothing: created
     * by `create`, ready when GET `<create.path>/<id>` reads `ready.equals` at `ready.jsonPath`, deleted
     * on stop. Every admin and app request carries its id in `header`; app variable `appEnv` holds it.
     */
    tenant?: {
      create: { path: string; body: Json }
      header: string
      ready: { jsonPath: string; equals: Json; timeoutMs?: number }
      appEnv?: string
    }
    /** The grader relays the run's events from `path` to the app's `route`, signed with the per-run secret in app variable `secretEnv`. */
    events?: { path: string; route: string; secretEnv: string }
  }
  image?: undefined
}

interface ProductBase {
  /** Product name, lowercase, e.g. `meilisearch`. */
  name: string
  /** The version the running product must report through `versionProbe`. */
  version: string
  /**
   * Admin-authenticated GET whose JSON value at `jsonPath` is the running version. A hosted
   * product states its test mode here: Stripe's `/v1/balance` `livemode` must read `false`.
   */
  versionProbe: { path: string; jsonPath: string }
  /** How admin requests authenticate: `<header>: <prefix><adminSecret>`. */
  auth: { header: string; prefix?: string }
  /**
   * Environment names the app receives at runtime: `url` holds the product URL (the grader's
   * recording proxy in front of the product), `key` holds `appKey` when set.
   */
  appEnv: { url: string; key?: string }
  /**
   * The credential the app receives in `appEnv.key`, a template over the setup context,
   * for example `{{vars.appKey}}` captured by a setup step. Omit when the app needs none, and
   * for a hosted product, whose app key is its per-run placeholder.
   */
  appKey?: string
}

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

/** One admin request the grader makes against the product before the app starts. */
export interface HttpStep {
  name: string
  method: HttpMethod
  /** Path and query, templated. */
  path: string
  /** JSON body, templated. */
  body?: Json
  /** Accepted statuses. Default: any 2xx. */
  expectStatus?: number[]
  /** Values to keep for later templates: `vars.<name>` = the response JSON at the path. */
  capture?: Record<string, string>
  /** Poll a GET until the JSON value at `jsonPath` equals `equals` (asynchronous writes). */
  waitFor?: { path: string; jsonPath: string; equals: Json; timeoutMs?: number }
}

/** A value drawn fresh for every grading run, so a submission cannot hard-code it. */
export type ProbeSpec =
  | { kind: 'word'; prefix?: string }
  | { kind: 'int'; min: number; max: number }
  | { kind: 'pick'; from: Json[] }

export type JourneyStep =
  | { open: string }
  | { fill: { goal: string; value: string } }
  | { select: { goal: string; value: string } }
  | { click: { goal: string } }
  | { press: string }
  | { wait: number }
  | { waitForText: { text: string; timeoutMs?: number } }
  | { capture: string }

/** A user path through the running app. `fill`, `select` and `click` goals are resolved by the target picker. */
export interface JourneySpec {
  id: string
  steps: JourneyStep[]
}

/** An admin read of the product after the journeys: what the product itself holds or answers. */
export interface ReadSpec {
  name: string
  method: 'GET' | 'POST'
  path: string
  body?: Json
}

/** Which proxied app-to-product requests a check counts. Strings are templates. */
export interface RequestMatch {
  method?: HttpMethod
  /** Regular expression over the request path (without query). */
  path?: string
  credential?: 'app' | 'admin' | 'none' | 'other'
  from?: 'server' | 'browser'
  /** Every value must appear in the request body text. */
  bodyIncludes?: string[]
  /** Every value must appear in the query string. */
  queryIncludes?: string[]
  status?: number[]
}

export type CheckKind =
  | { kind: 'journeyCompleted'; journey: string }
  | { kind: 'pageContains'; capture: string; values: string[]; mode?: 'all' | 'any' }
  | { kind: 'pageLacks'; capture: string; values: string[] }
  | { kind: 'productRequests'; match: RequestMatch; min?: number; max?: number }
  | {
      kind: 'readMatches'
      read: string
      jsonPath: string
      equals?: Json
      includes?: Json
      length?: { min?: number; max?: number }
    }
  /**
   * The strings at `jsonPath` (an array; `field` picks a property of each element) in a read,
   * first `limit` of them: `shown` requires each on the page, `ordered` also in that order,
   * `absent` requires none on the page.
   */
  | {
      kind: 'pageRead'
      capture: string
      read: string
      jsonPath: string
      field?: string
      limit?: number
      expect: 'shown' | 'ordered' | 'absent'
    }

/** `floor` failures give F; `journey` failures give C. See verdict.ts. */
export type CheckSpec = { id: string; gate: 'floor' | 'journey'; why: string } & CheckKind

export type SystemOneQuestionSpec =
  | { type: 'noul'; instructions: string }
  | { type: 'score'; instructions: string; criteria: string[] }
  | { type: 'choice'; instructions: string; criteria: Record<string, string> }

/** One bounded SystemOne question with how its answer moves the tier. */
export interface ReviewQuestionSpec {
  question: SystemOneQuestionSpec
  claim: string
  area: string
  severity: 'info' | 'low' | 'medium' | 'high' | 'critical'
  /** Native answers that support the claim (`true`/`false`, score levels, or choice keys). */
  supports: string[]
  refutes: string[]
  role: TierRole
}

/** A SystemOne review over named evidence. */
export interface ReviewSpecData {
  id: string
  evidence: { captures?: string[]; reads?: string[]; productLog?: boolean; code?: boolean }
  questions: Record<string, ReviewQuestionSpec>
}

/** The grader side of one task. Contestants never see it. */
export interface AppGradeSpec {
  /** The task as the reviewer should understand it (not the contestant prompt). */
  task: string
  probes: Record<string, ProbeSpec>
  /** Admin requests before the app starts: seed data, settings, the app's credential. */
  setup: HttpStep[]
  journeys: JourneySpec[]
  reads: ReadSpec[]
  checks: CheckSpec[]
  reviews: ReviewSpecData[]
  /** Flows this grader cannot operate; any entry caps the tier below S. */
  unmeasured: string[]
  /** The lowest tier a correct submission earns; admission requires the reference to reach it. */
  passTier: Exclude<Tier, 'F' | 'C'>
  /**
   * The floor or journey check that encodes the current-product fact a from-memory build gets
   * wrong. Calibration requires the reference to pass it and the stale build to fail it every run.
   */
  factCheck?: string
}

// ─── Templates ─────────────────────────────────────────────────────────────

const TEMPLATE = /\{\{\s*([A-Za-z_][\w.-]*)\s*\}\}/g
const WHOLE_TEMPLATE = /^\{\{\s*([A-Za-z_][\w.-]*)\s*\}\}$/

/** Value at a dotted path (`hits.0.title`); undefined when any segment is missing. */
export function jsonPath(value: unknown, path: string): unknown {
  if (path === '' || path === '.') return value
  let current = value
  for (const segment of path.split('.')) {
    if (current === null || typeof current !== 'object') return undefined
    current = Array.isArray(current)
      ? current[Number(segment)]
      : (current as Record<string, unknown>)[segment]
  }
  return current
}

/**
 * Render `{{a.b}}` references against `context`. A string that is exactly one reference
 * takes the referenced value itself, so numbers and arrays survive. A missing reference
 * throws: a template that renders to nothing would grade against the wrong value.
 */
export function render<T extends Json | undefined>(template: T, context: object): T {
  if (template === undefined || template === null) return template
  if (typeof template === 'string') {
    const whole = WHOLE_TEMPLATE.exec(template)
    if (whole) return lookup(context, whole[1]!) as T
    return template.replace(TEMPLATE, (_, path: string) => {
      const value = lookup(context, path)
      return typeof value === 'string' ? value : JSON.stringify(value)
    }) as T
  }
  if (Array.isArray(template)) return template.map((item) => render(item, context)) as T
  if (typeof template === 'object') {
    return Object.fromEntries(
      Object.entries(template).map(([key, item]) => [key, render(item, context)]),
    ) as T
  }
  return template
}

function lookup(context: object, path: string): Json {
  const value = jsonPath(context, path)
  if (value === undefined) throw new Error(`template reference {{${path}}} is not defined`)
  return value as Json
}

/** Every `{{…}}` reference in a value, for linting. */
export function references(value: unknown): string[] {
  if (typeof value === 'string') return [...value.matchAll(TEMPLATE)].map((match) => match[1]!)
  if (Array.isArray(value)) return value.flatMap(references)
  if (value && typeof value === 'object') return Object.values(value).flatMap(references)
  return []
}

// ─── Lint ──────────────────────────────────────────────────────────────────

const ID = /^[a-z0-9][a-z0-9-]{0,62}$/
const DIGEST_IMAGE = /^[a-z0-9][a-z0-9._/-]*(:[\w.-]+)?@sha256:[a-f0-9]{64}$/
const ENV_NAME = /^[A-Z][A-Z0-9_]*$/
const PRODUCT_EVIDENCE: ReadonlySet<CheckSpec['kind']> = new Set([
  'productRequests',
  'readMatches',
  'pageRead',
])

/** What calibration binds: the digest-pinned image, or the hosted origin with its pinned headers. */
export function productIdentity(product: ProductSpec): string {
  return product.hosted
    ? `${product.hosted.origin} ${JSON.stringify(product.hosted.headers ?? {})}`
    : product.image
}

/** The image digest a provenance record freezes; a hosted product has none. */
export function productImageDigest(product: ProductSpec | undefined): string | undefined {
  return /@sha256:([a-f0-9]{64})$/.exec(product?.image ?? '')?.[1]
}

export function lintProductSpec(product: ProductSpec): string[] {
  const problems: string[] = []
  if (!ID.test(product.name ?? '')) problems.push('product.name must be a lowercase id')
  const { hosted } = product
  if (hosted) {
    if (!/^https:\/\/[a-z0-9.-]+$/.test(hosted.origin ?? ''))
      problems.push('product.hosted.origin must be an https origin')
    if (!/^[a-z]+_test_[a-z_]*$/.test(hosted.appKeyPrefix ?? ''))
      problems.push('product.hosted.appKeyPrefix must name a test key')
    if (product.appKey !== undefined || product.appEnv?.key === undefined)
      problems.push(
        'a hosted product gives the app its placeholder key in appEnv.key; product.appKey must be omitted',
      )
    if (
      hosted.tenant &&
      (!hosted.tenant.create?.path?.startsWith('/') ||
        !/^[A-Za-z-]+$/.test(hosted.tenant.header ?? '') ||
        !hosted.tenant.ready?.jsonPath)
    )
      problems.push('product.hosted.tenant is incomplete')
    if (
      hosted.events &&
      (!hosted.events.path?.startsWith('/') || !hosted.events.route?.startsWith('/'))
    )
      problems.push('product.hosted.events paths must start with /')
    for (const name of [
      hosted.secretEnv,
      ...(hosted.tenant?.appEnv ? [hosted.tenant.appEnv] : []),
      ...(hosted.events ? [hosted.events.secretEnv] : []),
    ]) {
      if (!ENV_NAME.test(name ?? ''))
        problems.push(`product.hosted: ${name} must be an environment variable name`)
    }
  } else {
    if (!DIGEST_IMAGE.test(product.image ?? ''))
      problems.push('product.image must be pinned by sha256 digest')
    if (!Number.isInteger(product.port) || product.port < 1 || product.port > 65_535)
      problems.push('product.port is invalid')
    if (!product.ready?.path?.startsWith('/')) problems.push('product.ready.path must start with /')
    if (references(product.args ?? []).some((path) => path === 'adminSecret'))
      problems.push('product.args must not carry the admin secret; use env')
    for (const path of references(product.env ?? {}))
      if (path !== 'adminSecret')
        problems.push(`product.env references {{${path}}}; only {{adminSecret}} exists at start`)
  }
  if (typeof product.version !== 'string' || !product.version.trim())
    problems.push('product.version is required')
  if (!product.versionProbe?.path?.startsWith('/') || !product.versionProbe.jsonPath)
    problems.push('product.versionProbe is incomplete')
  if (!product.auth?.header) problems.push('product.auth.header is required')
  if (!ENV_NAME.test(product.appEnv?.url ?? ''))
    problems.push('product.appEnv.url must be an environment variable name')
  if (product.appEnv?.key !== undefined && !ENV_NAME.test(product.appEnv.key))
    problems.push('product.appEnv.key must be an environment variable name')
  if (!hosted && (product.appEnv?.key === undefined) !== (product.appKey === undefined))
    problems.push('product.appEnv.key and product.appKey go together')
  return problems
}

/**
 * Structural problems in a task spec. A spec that passes can still be wrong; calibration
 * decides that. This only refuses specs whose checks cannot discriminate by construction.
 */
export function lintAppGradeSpec(spec: AppGradeSpec, product: ProductSpec | undefined): string[] {
  const problems: string[] = []
  if (!product) problems.push('an App Grade task needs the seed product')
  if (!spec.task || spec.task.trim().length < 40)
    problems.push('task must describe the job in at least 40 characters')
  if (!['B', 'A', 'S'].includes(spec.passTier)) problems.push('passTier must be B, A or S')
  const probes = new Set(Object.keys(spec.probes ?? {}))
  for (const [name, probe] of Object.entries(spec.probes ?? {})) {
    if (!/^[a-z][a-zA-Z0-9]*$/.test(name)) problems.push(`probe ${name}: name must be camelCase`)
    if (
      probe.kind === 'int' &&
      !(Number.isInteger(probe.min) && Number.isInteger(probe.max) && probe.min < probe.max)
    )
      problems.push(`probe ${name}: int range is invalid`)
    if (probe.kind === 'pick' && (!Array.isArray(probe.from) || probe.from.length < 2))
      problems.push(`probe ${name}: pick needs at least two values`)
  }
  const vars = new Set<string>()
  const known = (path: string, where: string, allowed: { reads?: Set<string> } = {}) => {
    const [root, name] = path.split('.')
    if (root === 'probe' && name && probes.has(name)) return
    if (root === 'vars' && name && vars.has(name)) return
    if (root === 'read' && name && allowed.reads?.has(name)) return
    problems.push(`${where}: unknown reference {{${path}}}`)
  }
  const stepNames = new Set<string>()
  for (const step of spec.setup ?? []) {
    if (!ID.test(step.name)) problems.push(`setup step ${step.name}: invalid name`)
    if (stepNames.has(step.name)) problems.push(`setup step ${step.name}: duplicate name`)
    stepNames.add(step.name)
    if (!step.path?.startsWith('/'))
      problems.push(`setup step ${step.name}: path must start with /`)
    for (const path of references([step.path, step.body ?? null]))
      known(path, `setup step ${step.name}`)
    for (const name of Object.keys(step.capture ?? {})) vars.add(name)
    // `runSetup` captures before it polls, so a step's wait may name its own captures.
    for (const path of references([step.waitFor?.path ?? '', step.waitFor?.equals ?? null]))
      known(path, `setup step ${step.name}`)
  }
  if (product?.appKey) for (const path of references(product.appKey)) known(path, 'product.appKey')
  const journeys = new Set<string>()
  const captures = new Set<string>()
  for (const journey of spec.journeys ?? []) {
    if (!ID.test(journey.id)) problems.push(`journey ${journey.id}: invalid id`)
    if (journeys.has(journey.id)) problems.push(`journey ${journey.id}: duplicate id`)
    journeys.add(journey.id)
    if (!journey.steps?.length) problems.push(`journey ${journey.id}: no steps`)
    if (!journey.steps?.some((step) => 'open' in step))
      problems.push(`journey ${journey.id}: must open the app`)
    for (const step of journey.steps ?? []) {
      if ('capture' in step) {
        if (!ID.test(step.capture))
          problems.push(`journey ${journey.id}: capture ${step.capture} has an invalid name`)
        if (captures.has(step.capture)) problems.push(`capture ${step.capture}: duplicate name`)
        captures.add(step.capture)
      }
      for (const path of references(step)) known(path, `journey ${journey.id}`)
    }
  }
  if (journeys.size === 0) problems.push('at least one journey is required')
  const reads = new Set<string>()
  for (const read of spec.reads ?? []) {
    if (!ID.test(read.name)) problems.push(`read ${read.name}: invalid name`)
    if (reads.has(read.name)) problems.push(`read ${read.name}: duplicate name`)
    reads.add(read.name)
    if (!read.path?.startsWith('/')) problems.push(`read ${read.name}: path must start with /`)
    for (const path of references([read.path, read.body ?? null])) known(path, `read ${read.name}`)
  }
  const checkIds = new Set<string>()
  for (const check of spec.checks ?? []) {
    if (!/^[a-z][a-zA-Z0-9.-]*$/.test(check.id)) problems.push(`check ${check.id}: invalid id`)
    if (checkIds.has(check.id)) problems.push(`check ${check.id}: duplicate id`)
    checkIds.add(check.id)
    if (check.gate !== 'floor' && check.gate !== 'journey')
      problems.push(`check ${check.id}: gate must be floor or journey`)
    if (!check.why || check.why.trim().length < 10)
      problems.push(`check ${check.id}: say why it matters`)
    if ('capture' in check && !captures.has(check.capture))
      problems.push(`check ${check.id}: unknown capture ${check.capture}`)
    if ('journey' in check && !journeys.has(check.journey))
      problems.push(`check ${check.id}: unknown journey ${check.journey}`)
    if ('read' in check && !reads.has(check.read))
      problems.push(`check ${check.id}: unknown read ${check.read}`)
    if (check.kind === 'productRequests') {
      if (check.match.path !== undefined) {
        try {
          new RegExp(check.match.path)
        } catch {
          problems.push(`check ${check.id}: match.path is not a regular expression`)
        }
      }
      if (check.min === undefined && check.max === undefined)
        problems.push(`check ${check.id}: productRequests needs min or max`)
    }
    for (const path of references(check)) known(path, `check ${check.id}`)
  }
  // Something the product itself holds or answered must gate the floor, or a page that only
  // prints the right words passes.
  if (
    !(spec.checks ?? []).some((check) => check.gate === 'floor' && PRODUCT_EVIDENCE.has(check.kind))
  ) {
    problems.push(
      'at least one floor check must read product evidence (productRequests, readMatches or pageRead)',
    )
  }
  const reviewIds = new Set<string>()
  for (const review of spec.reviews ?? []) {
    if (!ID.test(review.id)) problems.push(`review ${review.id}: invalid id`)
    if (reviewIds.has(review.id)) problems.push(`review ${review.id}: duplicate id`)
    reviewIds.add(review.id)
    for (const name of review.evidence?.captures ?? [])
      if (!captures.has(name)) problems.push(`review ${review.id}: unknown capture ${name}`)
    for (const name of review.evidence?.reads ?? [])
      if (!reads.has(name)) problems.push(`review ${review.id}: unknown read ${name}`)
    const questions = Object.entries(review.questions ?? {})
    if (questions.length === 0) problems.push(`review ${review.id}: no questions`)
    for (const [name, question] of questions) {
      const labels =
        question.question.type === 'noul'
          ? ['true', 'false']
          : question.question.type === 'score'
            ? question.question.criteria.map((_, index) => String(index))
            : Object.keys(question.question.criteria)
      if (question.question.type === 'score' && question.question.criteria.length < 2)
        problems.push(`review ${review.id}.${name}: score needs two or more levels`)
      for (const answer of [...question.supports, ...question.refutes]) {
        if (!labels.includes(answer))
          problems.push(`review ${review.id}.${name}: ${answer} is not an answer`)
      }
      if (question.supports.length === 0 || question.refutes.length === 0)
        problems.push(`review ${review.id}.${name}: needs supporting and refuting answers`)
      if (question.supports.some((answer) => question.refutes.includes(answer)))
        problems.push(`review ${review.id}.${name}: an answer both supports and refutes`)
      if (!['core', 'senior', 'engineering', 'integrity'].includes(question.role))
        problems.push(`review ${review.id}.${name}: invalid role`)
    }
  }
  if (!Array.isArray(spec.unmeasured)) problems.push('unmeasured must be a list')
  if (
    spec.factCheck !== undefined &&
    !(spec.checks ?? []).some((check) => check.id === spec.factCheck)
  )
    problems.push(`factCheck ${spec.factCheck} names no check`)
  return problems
}
