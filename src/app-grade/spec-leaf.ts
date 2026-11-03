/**
 * Interpret a declarative `AppGradeSpec` as an App Grade leaf: run its journeys in the
 * evidence browser, read the product as admin, evaluate its deterministic checks and build
 * its SystemOne reviews. The same target picker, capture format, review runner and tier ladder
 * grade hand-written and spec-driven leaves.
 *
 * Journeys run in declaration order, since a later one may read product state an earlier
 * one wrote, and each runs in its own browser context, as a new visitor's would.
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import type { Page } from 'playwright'
import type { EvidenceBrowser, JourneySession } from './browser'
import { controlLocator, type Picker } from './drive'
import type { GradeLeaf } from './grade'
import { type ProductContext, type ProductRequest, type RunningProduct, runReads } from './product'
import type { ReviewSpec } from './review'
import {
  type AppGradeSpec,
  type CheckSpec,
  type JourneySpec,
  type Json,
  jsonPath,
  type RequestMatch,
  render,
} from './spec'
import type { VerdictCheck } from './verdict'

export interface CaptureRecord {
  journey: string
  ariaPath: string
  textPath: string
  screenshotPath: string
  url: string
}

export interface SpecEvidence {
  journeys: Record<string, { completed: boolean; problems: string[] }>
  captures: Record<string, CaptureRecord>
  reads: Record<string, { status: number; body: unknown }>
  productRequests: ProductRequest[]
  probes: Record<string, Json>
  journeyMs: Record<string, number>
}

const ACTION_SETTLE_MS = 5_000

async function settle(page: Page) {
  await page.waitForLoadState('networkidle', { timeout: ACTION_SETTLE_MS }).catch(() => {})
}

async function runJourney(input: {
  session: JourneySession
  url: string
  pick: Picker
  journey: JourneySpec
  context: ProductContext
  captures: Record<string, CaptureRecord>
}): Promise<{ completed: boolean; problems: string[] }> {
  const { session, journey, context, pick } = input
  const page = await session.newPage()
  const dir = `journeys/${journey.id}`
  const problems: string[] = []
  const record = (entry: Record<string, unknown>) =>
    session.append(`${dir}/steps.jsonl`, { t: Date.now(), ...entry })
  try {
    for (const [index, step] of journey.steps.entries()) {
      const n = index + 1
      // After a failed action only captures run, so reviewers see where the journey stopped.
      if (problems.length > 0 && !('capture' in step)) {
        record({ n, skipped: step })
        continue
      }
      if ('open' in step) {
        const target = new URL(render(step.open, context), input.url).toString()
        const response = await page
          .goto(target, { waitUntil: 'networkidle', timeout: 30_000 })
          .catch(async () => {
            await page.waitForLoadState('load').catch(() => {})
            return null
          })
        record({ n, action: 'open', target, result: `status ${response?.status() ?? 'unknown'}` })
        if (response && response.status() >= 400)
          problems.push(`step ${n}: open ${target} returned ${response.status()}`)
      } else if ('fill' in step || 'select' in step || 'click' in step) {
        const kind = 'fill' in step ? 'fill' : 'select' in step ? 'select' : 'click'
        const goal =
          'fill' in step ? step.fill.goal : 'select' in step ? step.select.goal : step.click.goal
        const picked = await pick(
          session,
          page,
          goal,
          `Journey "${journey.id}", step ${n}: ${kind}.`,
        )
        const control = picked.control
        if (!control || control.disabled) {
          problems.push(`step ${n}: no ${control ? 'enabled ' : ''}control for "${goal}"`)
          record({
            n,
            action: kind,
            goal,
            result: control ? 'control disabled' : 'no control',
            reason: picked.reason,
          })
          continue
        }
        const locator = controlLocator(page, control)
        try {
          if ('fill' in step) {
            if (!['input', 'textarea'].includes(control.tag))
              throw new Error(`picked a ${control.tag}, not a text field`)
            const value = String(render(step.fill.value, context))
            await locator.fill(value, { timeout: 5_000 })
            record({ n, action: 'fill', goal, target: control.name, value, reason: picked.reason })
          } else if ('select' in step) {
            if (control.tag !== 'select') throw new Error(`picked a ${control.tag}, not a select`)
            const value = String(render(step.select.value, context))
            await locator
              .selectOption({ label: value }, { timeout: 5_000 })
              .catch(() => locator.selectOption(value, { timeout: 5_000 }))
            record({
              n,
              action: 'select',
              goal,
              target: control.name,
              value,
              reason: picked.reason,
            })
          } else {
            await locator.click({ timeout: 5_000 })
            record({ n, action: 'click', goal, target: control.name, reason: picked.reason })
          }
        } catch (error) {
          problems.push(`step ${n}: ${kind} "${goal}" failed: ${String(error).slice(0, 200)}`)
          record({
            n,
            action: kind,
            goal,
            target: control.name,
            result: 'failed',
            error: String(error).slice(0, 300),
          })
          continue
        }
      } else if ('press' in step) {
        await page.keyboard.press(step.press)
        record({ n, action: 'press', key: step.press })
      } else if ('wait' in step) {
        await page.waitForTimeout(Math.min(step.wait, 30_000))
        record({ n, action: 'wait', ms: step.wait })
      } else if ('waitForText' in step) {
        const text = String(render(step.waitForText.text, context))
        const found = await page
          .getByText(text, { exact: false })
          .first()
          .waitFor({ timeout: step.waitForText.timeoutMs ?? 10_000 })
          .then(
            () => true,
            () => false,
          )
        record({ n, action: 'waitForText', text, result: found ? 'shown' : 'not shown' })
        if (!found) problems.push(`step ${n}: "${text}" never appeared`)
      } else if ('capture' in step) {
        const shot = await session.capture(page, step.capture)
        const text = await page
          .locator('body')
          // biome-ignore lint/performance/useDomNodeTextContent: a Playwright locator; innerText is the rendered text a buyer reads
          .innerText({ timeout: 5_000 })
          .catch((error) => `TEXT_UNAVAILABLE: ${String(error).slice(0, 200)}`)
        const textPath = `${dir}/${step.capture}.txt`
        session.write(textPath, text)
        input.captures[step.capture] = {
          journey: journey.id,
          ariaPath: shot.ariaPath,
          textPath,
          screenshotPath: shot.screenshotPath,
          url: shot.url,
        }
        record({ n, action: 'capture', name: step.capture, url: shot.url })
        continue
      }
      await settle(page)
    }
  } finally {
    await page.close().catch(() => {})
  }
  return { completed: problems.length === 0, problems }
}

/** Case- and whitespace-insensitive text for matching: CSS may transform case on screen. */
function normal(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim()
}

function stringsAt(body: unknown, path: string, field: string | undefined): string[] | null {
  const value = jsonPath(body, path)
  if (!Array.isArray(value)) return null
  return value
    .map((item) => (field ? jsonPath(item, field) : item))
    .filter((item) => item !== undefined && item !== null)
    .map((item) => String(item))
}

function matches(request: ProductRequest, match: RequestMatch, context: ProductContext): boolean {
  if (match.method && request.method !== match.method) return false
  if (match.path && !new RegExp(match.path).test(request.path)) return false
  if (match.credential && request.credential !== match.credential) return false
  if (match.from && request.from !== match.from) return false
  if (match.status && (request.status === null || !match.status.includes(request.status)))
    return false
  if (match.bodyIncludes?.some((value) => !request.body.includes(String(render(value, context)))))
    return false
  const query = decodeURIComponent(request.query.replace(/\+/g, ' '))
  if (match.queryIncludes?.some((value) => !query.includes(String(render(value, context)))))
    return false
  return true
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

export function evaluateChecks(
  spec: AppGradeSpec,
  evidence: SpecEvidence,
  readText: (path: string) => string,
  context: ProductContext,
): VerdictCheck[] {
  const text = (capture: string) => {
    const record = evidence.captures[capture]
    return record ? normal(`${readText(record.textPath)}\n${readText(record.ariaPath)}`) : null
  }
  const result = (check: CheckSpec, ok: boolean, detail: string): VerdictCheck => ({
    id: check.id,
    gate: check.gate,
    status: ok ? 'pass' : 'fail',
    detail: detail.slice(0, 600),
  })
  return spec.checks.map((check) => {
    try {
      switch (check.kind) {
        case 'journeyCompleted': {
          const journey = evidence.journeys[check.journey]
          return result(
            check,
            journey?.completed === true,
            journey ? journey.problems.join('; ') || 'every step ran' : 'journey did not run',
          )
        }
        case 'pageContains':
        case 'pageLacks': {
          const page = text(check.capture)
          if (page === null) return result(check, false, `capture ${check.capture} was never taken`)
          const values = check.values.map((value) => String(render(value, context)))
          const present = values.filter((value) => page.includes(normal(value)))
          if (check.kind === 'pageLacks')
            return result(
              check,
              present.length === 0,
              present.length ? `shown: ${present.join(', ')}` : `none of ${values.length} shown`,
            )
          const ok = check.mode === 'any' ? present.length > 0 : present.length === values.length
          return result(
            check,
            ok,
            `${present.length}/${values.length} shown; missing: ${values.filter((value) => !present.includes(value)).join(', ') || 'none'}`,
          )
        }
        case 'productRequests': {
          const hits = evidence.productRequests.filter((request) =>
            matches(request, check.match, context),
          )
          const ok =
            (check.min === undefined || hits.length >= check.min) &&
            (check.max === undefined || hits.length <= check.max)
          const sample = hits
            .slice(0, 3)
            .map(
              (request) =>
                `${request.method} ${request.path}${request.query ? `?${request.query}` : ''} [${request.credential}, ${request.from}, ${request.status}]`,
            )
          return result(
            check,
            ok,
            `${hits.length} matching request(s) of ${evidence.productRequests.length}; ${sample.join('; ') || 'none'}`,
          )
        }
        case 'readMatches': {
          const read = evidence.reads[check.read]
          if (!read) return result(check, false, `read ${check.read} did not run`)
          const value = jsonPath(read.body, check.jsonPath)
          const problems: string[] = []
          if (check.equals !== undefined && !deepEqual(value, render(check.equals, context)))
            problems.push(
              `is ${JSON.stringify(value)?.slice(0, 200)}, expected ${JSON.stringify(render(check.equals, context))}`,
            )
          if (check.includes !== undefined) {
            const wanted = render(check.includes, context)
            const ok = Array.isArray(value)
              ? value.some((item) => deepEqual(item, wanted))
              : typeof value === 'string' && value.includes(String(wanted))
            if (!ok) problems.push(`does not include ${JSON.stringify(wanted)}`)
          }
          if (check.length) {
            const length = Array.isArray(value) || typeof value === 'string' ? value.length : null
            if (
              length === null ||
              (check.length.min !== undefined && length < check.length.min) ||
              (check.length.max !== undefined && length > check.length.max)
            )
              problems.push(`length ${length}`)
          }
          return result(
            check,
            problems.length === 0,
            `${check.read} ${check.jsonPath}: ${problems.join('; ') || 'matches'} (HTTP ${read.status})`,
          )
        }
        case 'pageRead': {
          const page = text(check.capture)
          if (page === null) return result(check, false, `capture ${check.capture} was never taken`)
          const read = evidence.reads[check.read]
          if (!read) return result(check, false, `read ${check.read} did not run`)
          const values = stringsAt(read.body, check.jsonPath, check.field)?.slice(
            0,
            check.limit ?? Infinity,
          )
          // A check the product answered with nothing cannot discriminate; it fails rather than passing vacuously.
          if (!values || values.length === 0)
            return result(
              check,
              false,
              `vacuous: ${check.read} ${check.jsonPath} holds no values (HTTP ${read.status})`,
            )
          const positions = values.map((value) => page.indexOf(normal(value)))
          if (check.expect === 'absent') {
            const shown = values.filter((_, index) => positions[index]! >= 0)
            return result(
              check,
              shown.length === 0,
              shown.length
                ? `shown but should be absent: ${shown.join(', ')}`
                : `none of ${values.length} shown`,
            )
          }
          const missing = values.filter((_, index) => positions[index]! < 0)
          if (missing.length)
            return result(
              check,
              false,
              `${values.length - missing.length}/${values.length} shown; missing: ${missing.join(', ')}`,
            )
          if (check.expect === 'ordered') {
            const ordered = positions.every(
              (position, index) => index === 0 || position > positions[index - 1]!,
            )
            return result(
              check,
              ordered,
              ordered
                ? `${values.length} shown in the product's order`
                : `shown out of order: ${values.join(' > ')}`,
            )
          }
          return result(check, true, `${values.length}/${values.length} shown`)
        }
      }
      return result(check, false, `unknown check kind ${(check as { kind: string }).kind}`)
    } catch (error) {
      return result(
        check,
        false,
        `check could not be evaluated: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  })
}

/** App-originated text enters SystemOne state as quoted, untrusted data with its provenance. */
function untrusted(source: string, text: string, max = 7_000) {
  return {
    untrusted: true,
    source,
    text:
      text.length > max ? `${text.slice(0, max)}\n[truncated ${text.length - max} chars]` : text,
  }
}

function truncateJson(value: unknown, max = 6_000): unknown {
  const text = JSON.stringify(value)
  if (text === undefined || text.length <= max) return value
  return { truncated: true, preview: text.slice(0, max) }
}

const SKIP_DIRS = new Set(['node_modules', '.next', '.git', '.starter-foundry', 'preview'])

/** Source files, those that touch the product or tests first, within a character budget. */
function codeEvidence(workdir: string, relevant: RegExp, budget = 45_000) {
  const files: Array<{ path: string; content: string }> = []
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (SKIP_DIRS.has(name)) continue
      const full = join(dir, name)
      if (statSync(full).isDirectory()) walk(full)
      else if (
        /\.(ts|tsx|js|jsx|mjs)$/.test(name) &&
        !/^(next\.config|validate-types|preview-server|postcss\.config)/.test(name)
      ) {
        files.push({ path: relative(workdir, full), content: readFileSync(full, 'utf8') })
      }
    }
  }
  walk(workdir)
  const isRelevant = (file: { path: string; content: string }) =>
    relevant.test(file.content) || /test|spec/.test(file.path)
  const ordered = [...files.filter(isRelevant), ...files.filter((file) => !isRelevant(file))]
  const chosen: Array<{ path: string; lines: string; content: string }> = []
  let used = 0
  for (const file of ordered) {
    if (used + file.content.length > budget) continue
    chosen.push({
      path: file.path,
      lines: `1-${file.content.split('\n').length}`,
      content: file.content,
    })
    used += file.content.length
  }
  return { files: chosen, relevantCount: files.filter(isRelevant).length }
}

/**
 * SystemOne reviews over the evidence itself. The deterministic checks' statuses and the build
 * gates stay out of the reviewer's state: a reviewer that reads the grader's own verdicts
 * grades the grader, not the app.
 */
export function specReviews(input: {
  spec: AppGradeSpec
  product: RunningProduct['spec']
  evidence: SpecEvidence
  readText: (path: string) => string
  workdir: string
}): ReviewSpec[] {
  const { spec, evidence } = input
  const productTerms = new RegExp(
    [input.product.name, input.product.appEnv.url, input.product.appEnv.key]
      .filter(Boolean)
      .map((term) => term!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('|'),
    'i',
  )
  const code = spec.reviews.some((review) => review.evidence.code)
    ? codeEvidence(input.workdir, productTerms)
    : null
  return spec.reviews.map((review) => {
    const wantedCaptures = review.evidence.captures ?? []
    const wantedReads = review.evidence.reads ?? []
    const present = [
      ...wantedCaptures.map((name) => evidence.captures[name] !== undefined),
      ...wantedReads.map((name) => evidence.reads[name] !== undefined),
      ...(review.evidence.code ? [code !== null && code.relevantCount > 0] : []),
      ...(review.evidence.productLog ? [true] : []),
    ]
    const coverage =
      present.length === 0 || present.every(Boolean)
        ? 'complete'
        : present.some(Boolean)
          ? 'partial'
          : 'missing'
    const evidenceRefs = [
      ...wantedCaptures
        .filter((name) => evidence.captures[name])
        .map((name) => ({
          kind: 'artifact' as const,
          uri: evidence.captures[name]!.ariaPath,
          excerpt: `screen "${name}"`,
        })),
      ...wantedReads
        .filter((name) => evidence.reads[name])
        .map((name) => ({
          kind: 'artifact' as const,
          uri: `reads.json#${name}`,
          excerpt: `product read "${name}"`,
        })),
      ...(review.evidence.productLog
        ? [
            {
              kind: 'artifact' as const,
              uri: 'product-requests.jsonl',
              excerpt: `${evidence.productRequests.length} app request(s) to the product`,
            },
          ]
        : []),
      ...(code
        ? code.files.slice(0, 8).map((file) => ({
            kind: 'artifact' as const,
            uri: `workdir/${file.path}#L${file.lines}`,
            excerpt: file.path,
          }))
        : []),
    ]
    const state = {
      task: spec.task,
      screens: Object.fromEntries(
        wantedCaptures
          .filter((name) => evidence.captures[name])
          .map((name) => [
            name,
            untrusted(`app screen "${name}"`, input.readText(evidence.captures[name]!.textPath)),
          ]),
      ),
      productReads: Object.fromEntries(
        wantedReads
          .filter((name) => evidence.reads[name])
          .map((name) => [name, truncateJson(evidence.reads[name])]),
      ),
      ...(review.evidence.productLog
        ? {
            appRequestsToProduct: evidence.productRequests.slice(0, 40).map((request) => ({
              method: request.method,
              path: request.path,
              query: request.query.slice(0, 300),
              credential: request.credential,
              from: request.from,
              status: request.status,
              body: untrusted('app request body', request.body, 800),
            })),
          }
        : {}),
      ...(code
        ? {
            files: code.files.map((file) => ({
              ...file,
              content: untrusted(`source file ${file.path}`, file.content, 15_000),
            })),
          }
        : {}),
    }
    const reviewChecks = Object.fromEntries(
      Object.entries(review.questions).map(([name, question]) => [
        name,
        {
          claim: question.claim,
          area: question.area,
          subject: review.id,
          severity: question.severity,
          supports: question.supports,
          refutes: question.refutes,
          ...(question.role === 'integrity'
            ? { supportAtLeast: 0.6, refuteAtLeast: 0.6 }
            : { supportAtLeast: 0.8, refuteAtLeast: 0.7 }),
          coverage,
          evidence: evidenceRefs,
        },
      ]),
    )
    return {
      id: review.id,
      questions: Object.fromEntries(
        Object.entries(review.questions).map(([name, question]) => [name, question.question]),
      ),
      state,
      checks: reviewChecks,
      tierRole: Object.fromEntries(
        Object.entries(review.questions).map(([name, question]) => [name, question.role]),
      ),
    } as ReviewSpec
  })
}

/** Build the grade leaf for one spec-driven task against a started product and proxy. */
export function specLeaf(input: {
  id: string
  /** Digest of the task material; part of every review digest, so a changed spec never reuses a review. */
  specDigest: string
  spec: AppGradeSpec
  product: RunningProduct
  context: ProductContext
  requests: () => ProductRequest[]
  readText: (path: string) => string
}): GradeLeaf<SpecEvidence> {
  const { spec, product, context } = input
  return {
    id: input.id,
    reviewVersion: `app-grade/task/${input.id}@${input.specDigest.slice(0, 16)}`,
    unmeasured: spec.unmeasured,
    async runJourneys(browser: EvidenceBrowser, dir, url, pick) {
      const captures: Record<string, CaptureRecord> = {}
      const journeys: SpecEvidence['journeys'] = {}
      const journeyMs: Record<string, number> = {}
      for (const journey of spec.journeys) {
        const started = Date.now()
        const session = await browser.journey({ id: journey.id, dir, appUrl: url })
        try {
          journeys[journey.id] = await runJourney({
            session,
            url,
            pick,
            journey,
            context,
            captures,
          })
        } finally {
          await session.close()
        }
        journeyMs[journey.id] = Date.now() - started
      }
      const reads = await runReads(product, spec.reads, context)
      writeFileSync(join(dir, 'reads.json'), JSON.stringify(reads, null, 1))
      return {
        journeys,
        captures,
        reads,
        productRequests: [...input.requests()],
        probes: context.probe,
        journeyMs,
      }
    },
    landing(evidence) {
      return Object.values(evidence.captures)[0]?.ariaPath
    },
    deterministicChecks(evidence) {
      return evaluateChecks(spec, evidence, input.readText, context)
    },
    reviewSpecs({ evidence, workdir }) {
      return specReviews({
        spec,
        product: product.spec,
        evidence,
        readText: input.readText,
        workdir,
      })
    },
  }
}
