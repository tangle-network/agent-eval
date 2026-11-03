/**
 * Browser evidence for one grading run: accessibility snapshots, screenshots,
 * every response with the app's own payloads, console lines, page errors, a
 * Playwright trace per journey, and the wallet channel.
 *
 * Trust boundary. The app under test runs arbitrary JavaScript in its own
 * realm, so nothing the grader decides on is recorded there:
 *
 * - The wallet channel is recorded inside the wallet window's realm
 *   (`keys.coinbase.com`), which the app cannot script. A passive init script
 *   there reports each `message` event (the browser sets `origin` and
 *   `isTrusted`), each request the wallet decrypts with WebCrypto, and each
 *   response it encrypts. Records reach Node through a binding that accepts a
 *   call only from the main frame of a wallet-origin page. A call from any other
 *   frame is page code writing to the grader's channel; it is kept as a forgery
 *   attempt and never as evidence.
 * - DOM reads (controls, visibility, order totals, control state) run in a CDP
 *   isolated world. The page shares the DOM but not the JavaScript globals, so
 *   patched prototypes or getters in the page cannot change what the grader reads.
 */
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Browser, BrowserContext, CDPSession, Page } from 'playwright'

export const WALLET_CHANNEL_BINDING = '__appGradeWalletChannel'
const GRADER_WORLD = 'app-grade-grader'
/** Longest request or response body kept per network entry. */
const PAYLOAD_CHARS = 20_000

/** One observation made inside a wallet window's own realm. */
export interface WalletRecord {
  kind: 'message' | 'decrypt' | 'encrypt'
  /** `message`: the sender origin as the browser reported it. */
  from?: string
  /** `message`: `event.isTrusted`; a page cannot dispatch a trusted message. */
  trusted?: boolean
  data?: unknown
  /** `decrypt`: a request the wallet decrypted. `encrypt`: a response it encrypted. */
  plaintext?: string
  t: number
}

/** Page code that called the grader's wallet channel from outside a wallet window. */
export interface ForgeryAttempt {
  journey: string
  frameUrl: string
  payload: string
  t: number
}

export interface WalletWindow {
  opener: Page
  page: Page
  url: string
  records: WalletRecord[]
}

/**
 * Runs in every document; does nothing outside the wallet origin. A string, not
 * a function: tsx wraps named functions in a `__name` helper the page lacks.
 */
function walletTap(walletOrigin: string): string {
  return `(() => {
  if (location.origin !== ${JSON.stringify(walletOrigin)} || window.top !== window) return
  const pending = []
  const send = (record) => {
    pending.push(JSON.stringify({ ...record, t: Date.now() }))
    const channel = window[${JSON.stringify(WALLET_CHANNEL_BINDING)}]
    if (typeof channel !== 'function') return
    while (pending.length > 0) void channel(pending.shift())
  }
  const text = (data) => {
    try {
      const view = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
      return new TextDecoder().decode(view).slice(0, ${PAYLOAD_CHARS})
    } catch {
      return null
    }
  }
  window.addEventListener('message', (event) => {
    let data
    try { data = JSON.parse(JSON.stringify(event.data)) } catch { data = String(event.data) }
    send({ kind: 'message', from: event.origin, trusted: event.isTrusted, data })
  }, true)
  const subtle = crypto.subtle
  const decrypt = subtle.decrypt.bind(subtle)
  const encrypt = subtle.encrypt.bind(subtle)
  subtle.decrypt = (algorithm, key, data) => decrypt(algorithm, key, data).then((out) => {
    const plaintext = text(out)
    if (plaintext !== null) send({ kind: 'decrypt', plaintext })
    return out
  })
  subtle.encrypt = (algorithm, key, data) => {
    const plaintext = text(data)
    if (plaintext !== null) send({ kind: 'encrypt', plaintext })
    return encrypt(algorithm, key, data)
  }
})()`
}

/**
 * Page-side rule for what a sighted buyer can see, evaluated in the grader's
 * isolated world. The expression yields `painted(node)` for a text node or an
 * element (a string: tsx wraps named functions in a `__name` helper the page lacks).
 *
 * Excluded: hidden, transparent, faded (cumulative opacity under 0.1), tiny, and
 * clipped or off-page boxes. A text node also needs a readable colour and size.
 * An element needs a box of at least 8 x 8 px and something drawn in it: painted
 * text, an image, a native form widget, or its own background or border. A
 * control a buyer cannot see is never offered to the picker or read as the order.
 */
export const PAINTED = `(() => {
  const alpha = (color) => {
    const match = /rgba?\\(([^)]+)\\)/.exec(color || '')
    if (!match) return color === 'transparent' ? 0 : 1
    const parts = match[1].split(/[ ,\\/]+/).filter(Boolean)
    return parts.length >= 4 ? Number.parseFloat(parts[3]) : 1
  }
  const docWidth = () => Math.max(document.documentElement.scrollWidth, innerWidth)
  const docHeight = () => Math.max(document.documentElement.scrollHeight, innerHeight)
  const readable = (element) => {
    const style = getComputedStyle(element)
    return Number.parseFloat(style.fontSize) >= 6 && alpha(style.color) >= 0.1 && alpha(style.webkitTextFillColor) >= 0.1
  }
  /** Painted area of \`rects\` inside \`element\`'s clipping ancestors and the page; 0 when hidden or faded. */
  const area = (element, rects, minWidth, minHeight) => {
    if (!element.checkVisibility({ opacityProperty: true, visibilityProperty: true, contentVisibilityAuto: true })) return 0
    let opacity = 1
    for (let at = element; at; at = at.parentElement) opacity *= Number.parseFloat(getComputedStyle(at).opacity)
    if (opacity < 0.1) return 0
    let total = 0
    for (const rect of rects) {
      let left = rect.left + scrollX, top = rect.top + scrollY, right = rect.right + scrollX, bottom = rect.bottom + scrollY
      for (let at = element; at && at !== document.documentElement; at = at.parentElement) {
        const s = getComputedStyle(at)
        const clipsOverflow = ['hidden', 'clip'].includes(s.overflowX) || ['hidden', 'clip'].includes(s.overflowY)
        const clipRect = s.clip && s.clip !== 'auto'
        const clipPath = s.clipPath && s.clipPath !== 'none'
        if (clipRect && /rect\\(\\s*0(px)?[ ,]+0(px)?[ ,]+0(px)?[ ,]+0(px)?\\s*\\)/.test(s.clip)) return 0
        if (clipPath && /inset\\(\\s*(50|[5-9]\\d|100)%/.test(s.clipPath)) return 0
        if (clipsOverflow || clipRect || clipPath) {
          const box = at.getBoundingClientRect()
          left = Math.max(left, box.left + scrollX)
          top = Math.max(top, box.top + scrollY)
          right = Math.min(right, box.right + scrollX)
          bottom = Math.min(bottom, box.bottom + scrollY)
        }
      }
      left = Math.max(left, 0)
      top = Math.max(top, 0)
      right = Math.min(right, docWidth())
      bottom = Math.min(bottom, docHeight())
      if (right - left >= minWidth && bottom - top >= minHeight) total += (right - left) * (bottom - top)
    }
    return total
  }
  const cache = new Map()
  const text = (node) => {
    const parent = node.parentElement
    if (!parent || !readable(parent)) return false
    const range = document.createRange()
    range.selectNodeContents(node)
    return area(parent, [...range.getClientRects()], 2, 4) >= 16
  }
  const drawsSomething = (element) => {
    const tag = element.tagName
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
      return ['checkbox', 'radio'].includes(element.type) || readable(element)
    }
    const style = getComputedStyle(element)
    if (alpha(style.backgroundColor) >= 0.1 || style.backgroundImage !== 'none') return true
    if (Number.parseFloat(style.borderTopWidth) + Number.parseFloat(style.borderBottomWidth) > 0 && alpha(style.borderTopColor) >= 0.1) return true
    for (const media of element.querySelectorAll('img, svg, canvas, video')) {
      if (area(media, [...media.getClientRects()], 4, 4) >= 16) return true
    }
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
    while (walker.nextNode()) {
      if ((walker.currentNode.nodeValue || '').trim() && painted(walker.currentNode)) return true
    }
    return false
  }
  const painted = (node) => {
    if (!cache.has(node)) {
      cache.set(node, node.nodeType === Node.TEXT_NODE ? text(node) : area(node, [...node.getClientRects()], 8, 8) >= 64 && drawsSomething(node))
    }
    return cache.get(node)
  }
  return painted
})()`

function originOf(url: string): string {
  try {
    return new URL(url).origin
  } catch {
    return ''
  }
}

function append(dir: string, file: string, value: unknown) {
  mkdirSync(dirname(join(dir, file)), { recursive: true })
  appendFileSync(join(dir, file), `${JSON.stringify(value)}\n`)
}

export class EvidenceBrowser {
  private constructor(
    private readonly browser: Browser,
    /** What this browser reports as its user agent; vendor SDKs send it in the app's traffic. */
    readonly userAgent: string,
  ) {}

  static async launch(input: { headless?: boolean } = {}): Promise<EvidenceBrowser> {
    // Loaded here so the rest of App Grade (specs, verdicts, products) runs without Playwright installed.
    const { chromium } = await import('playwright')
    const browser = await chromium.launch({ headless: input.headless ?? true })
    const cdp = await browser.newBrowserCDPSession()
    const { userAgent } = await cdp.send('Browser.getVersion')
    await cdp.detach()
    return new EvidenceBrowser(browser, userAgent)
  }

  /** A fresh browser context per journey: its own storage, as a new buyer has. Without a wallet origin, no page records wallet evidence. */
  async journey(input: { id: string; dir: string; appUrl: string; walletOrigin?: string }): Promise<JourneySession> {
    return JourneySession.open(this.browser, input)
  }

  async close(): Promise<void> {
    await this.browser.close().catch(() => {})
  }
}

export class JourneySession {
  readonly walletWindows: WalletWindow[] = []
  readonly forgeryAttempts: ForgeryAttempt[] = []
  private readonly pendingBodies = new Set<Promise<void>>()
  /** Wallet-origin records that arrived before the opener's popup event; claimed when it fires. */
  private readonly unclaimed = new Map<Page, WalletRecord[]>()
  private readonly cdp = new WeakMap<Page, Promise<CDPSession>>()

  private constructor(
    readonly id: string,
    readonly dir: string,
    readonly context: BrowserContext,
    readonly appOrigin: string,
    readonly walletOrigin: string | null,
  ) {}

  static async open(browser: Browser, input: { id: string; dir: string; appUrl: string; walletOrigin?: string }): Promise<JourneySession> {
    mkdirSync(input.dir, { recursive: true })
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
    const session = new JourneySession(input.id, input.dir, context, originOf(input.appUrl), input.walletOrigin ?? null)
    await context.tracing.start({ screenshots: true, snapshots: true, sources: false })
    await context.exposeBinding(WALLET_CHANNEL_BINDING, (source, payload: unknown) => session.receive(source.page, source.frame, payload))
    // The binding stays exposed without a wallet: any call to it is then page code, kept as a forgery attempt.
    if (input.walletOrigin) await context.addInitScript({ content: walletTap(input.walletOrigin) })
    context.on('page', (page) => session.watch(page))
    context.on('response', (response) => {
      const request = response.request()
      const entry: Record<string, unknown> = {
        t: Date.now(),
        journey: session.id,
        method: request.method(),
        url: request.url().slice(0, 500),
        status: response.status(),
        type: request.resourceType(),
        appOrigin: originOf(request.url()) === session.appOrigin,
      }
      // Payloads the app itself controls: its own responses, and what its pages send anywhere.
      let fromApp = false
      try {
        fromApp = originOf(request.frame().url()) === session.appOrigin
      } catch {
        // Service-worker requests have no frame.
      }
      const payloadType = ['fetch', 'xhr', 'document', 'eventsource'].includes(request.resourceType())
      if (!payloadType || !(entry.appOrigin || fromApp)) {
        session.append('network.jsonl', entry)
        return
      }
      const body = (async () => {
        entry.requestBody = request.postData()?.slice(0, PAYLOAD_CHARS) ?? null
        if (entry.appOrigin) entry.responseBody = (await response.text().catch(() => null))?.slice(0, PAYLOAD_CHARS) ?? null
        session.append('network.jsonl', entry)
      })()
      session.pendingBodies.add(body)
      void body.finally(() => session.pendingBodies.delete(body))
    })
    context.on('requestfailed', (request) => {
      session.append('network.jsonl', {
        t: Date.now(),
        journey: session.id,
        method: request.method(),
        url: request.url().slice(0, 500),
        failure: request.failure()?.errorText ?? 'failed',
        type: request.resourceType(),
        requestBody: request.postData()?.slice(0, PAYLOAD_CHARS) ?? null,
      })
    })
    return session
  }

  private receive(page: Page, frame: { url(): string }, payload: unknown) {
    const text = typeof payload === 'string' ? payload : JSON.stringify(payload ?? null)
    // Only a wallet-origin top frame runs the wallet tap; any other caller is page code.
    if (originOf(frame.url()) !== this.walletOrigin || frame !== page.mainFrame()) {
      this.forgeryAttempts.push({ journey: this.id, frameUrl: frame.url().slice(0, 300), payload: text.slice(0, 2_000), t: Date.now() })
      this.append('forgery-attempts.jsonl', this.forgeryAttempts.at(-1))
      return
    }
    let record: WalletRecord
    try {
      record = JSON.parse(text) as WalletRecord
    } catch {
      return
    }
    // Arkose and other embedded services also post to the wallet window; only the app's messages matter.
    if (record.kind === 'message' && record.from !== this.appOrigin) return
    const window = this.walletWindows.find((candidate) => candidate.page === page)
    if (window) window.records.push(record)
    else this.unclaimed.set(page, [...(this.unclaimed.get(page) ?? []), record])
  }

  private watch(page: Page) {
    page.on('console', (message) => {
      this.append('console.jsonl', { t: Date.now(), journey: this.id, page: page.url().slice(0, 160), type: message.type(), text: message.text().slice(0, 2_000) })
    })
    page.on('pageerror', (error) => {
      this.append('console.jsonl', { t: Date.now(), journey: this.id, page: page.url().slice(0, 160), type: 'pageerror', text: String(error).slice(0, 2_000) })
    })
    // A wallet window is a page some app page opened: the grader never opens one itself.
    page.on('popup', (popup) => {
      const window: WalletWindow = { opener: page, page: popup, url: popup.url(), records: this.unclaimed.get(popup) ?? [] }
      this.unclaimed.delete(popup)
      this.walletWindows.push(window)
      popup.on('framenavigated', (frame) => {
        if (frame === popup.mainFrame()) window.url = frame.url()
      })
    })
  }

  append(file: string, value: unknown) {
    append(this.dir, file, value)
  }

  write(file: string, value: string | Buffer) {
    mkdirSync(dirname(join(this.dir, file)), { recursive: true })
    writeFileSync(join(this.dir, file), value)
  }

  async newPage(): Promise<Page> {
    return this.context.newPage()
  }

  /** Windows at the wallet origin that `opener` opened, in open order, skipping the first `since` of them. */
  walletWindowsOf(opener: Page, since = 0): WalletWindow[] {
    return this.walletWindows.filter((window) => window.opener === opener && originOf(window.url) === this.walletOrigin).slice(since)
  }

  /**
   * Evaluate `expression` in the grader's isolated world of the page's main frame.
   * The world persists for the life of the document, so it can hold element references.
   */
  async graderEval<T>(page: Page, expression: string): Promise<T> {
    let session = this.cdp.get(page)
    if (!session) {
      session = this.context.newCDPSession(page)
      this.cdp.set(page, session)
    }
    const cdp = await session
    const { frameTree } = await cdp.send('Page.getFrameTree')
    const { executionContextId } = await cdp.send('Page.createIsolatedWorld', { frameId: frameTree.frame.id, worldName: GRADER_WORLD })
    const result = await cdp.send('Runtime.evaluate', { expression, contextId: executionContextId, returnByValue: true, awaitPromise: true })
    if (result.exceptionDetails) {
      throw new Error(`grader world: ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`)
    }
    return result.result.value as T
  }

  /** Accessibility snapshot and screenshot of one moment, saved under this journey's directory. */
  async capture(page: Page, label: string): Promise<{ aria: string; ariaPath: string; screenshotPath: string; url: string }> {
    const base = join('journeys', this.id, label)
    const aria = await page.locator('body').ariaSnapshot({ timeout: 5_000 }).catch((error) => `ARIA_UNAVAILABLE: ${String(error).slice(0, 200)}`)
    this.write(`${base}.aria.yml`, aria)
    await page.screenshot({ path: join(this.dir, `${base}.png`), fullPage: true, timeout: 10_000 }).catch(() => {})
    return { aria, ariaPath: `${base}.aria.yml`, screenshotPath: `${base}.png`, url: page.url() }
  }

  async close(): Promise<void> {
    await Promise.allSettled([...this.pendingBodies])
    await this.context.tracing.stop({ path: join(this.dir, 'journeys', this.id, 'trace.zip') }).catch(() => {})
    await this.context.close().catch(() => {})
  }
}
