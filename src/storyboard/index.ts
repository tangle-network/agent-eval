/**
 * Storyboard — compile a raw agent trace into a small set of meaningful scenes,
 * then render them as a shareable, watchable replay.
 *
 *   Span[] → SemanticEvent[] → Storyboard{scenes} → { markdown | html }
 *
 * The trace is the source of truth; the storyboard is the IR; markdown/html
 * (and, in a consumer package, Remotion/MP4) are compiled targets. Everything
 * here is PURE — same spans in, same bytes out (no clock/random) — so a run's
 * replay is deterministic and diffable.
 *
 * Crucially, every scene carries a modality-typed VISUAL extracted from the
 * span — a browser/computer screenshot, a code diff, a terminal command +
 * output, file content, an API request/response, or reasoning prose — so no
 * matter what the agent did, the replay SHOWS it, not just narrates it. The
 * reducer is rules-based; an LLM pass can refine titles/summaries later, but
 * the structure + visuals do not depend on one. Renderers that need a browser
 * (Remotion, React) live in consumers; this module only emits strings.
 */

import type { Span } from '../trace/schema'

/** What the agent meaningfully did — the compressed vocabulary. */
export type SemanticKind =
  | 'understood_task'
  | 'reasoned'
  | 'ran_command'
  | 'read_file'
  | 'edited_code'
  | 'searched'
  | 'used_browser'
  | 'used_computer'
  | 'called_api'
  | 'called_tool'
  | 'evaluated'
  | 'observed_failure'
  | 'completed'

/** The modality-typed payload a scene shows. This is what makes any agent
 *  action — screen, browser, shell, code, API — actually viewable. */
export type SceneVisual =
  | { type: 'screenshot'; src: string; caption?: string }
  | { type: 'browser'; url?: string; action?: string; screenshot?: string }
  | { type: 'diff'; path: string; patch: string }
  | { type: 'code'; path: string; content: string }
  | { type: 'terminal'; command: string; output?: string }
  | {
      type: 'api'
      method?: string
      url: string
      status?: number
      request?: string
      response?: string
    }
  | { type: 'prose'; text: string }
  | { type: 'none' }

export interface SemanticEvent {
  kind: SemanticKind
  /** One-line headline (the ticket/scene title). */
  title: string
  /** Short human summary. */
  summary: string
  /** The modality payload to show for this moment. */
  visual: SceneVisual
  /** Span ids backing this moment — the evidence trail. */
  evidenceSpanIds: string[]
  /** 1 (noise) … 5 (pivotal: failures, edits). Drives selection + duration. */
  importance: 1 | 2 | 3 | 4 | 5
  startTs: number
  endTs: number
}

export interface ReduceOptions {
  /** Collapse adjacent same-kind moments into one. Default true. */
  collapseAdjacent?: boolean
}

// ── Modality extraction ─────────────────────────────────────────────────────

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' ? v : undefined
}

function attr(span: Span, ...keys: string[]): unknown {
  const a = span.attributes as Record<string, unknown> | undefined
  if (!a) return undefined
  for (const k of keys) if (a[k] != null) return a[k]
  return undefined
}

function asObj(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined
}

function safeJson(v: unknown): string | undefined {
  if (v == null) return undefined
  if (typeof v === 'string') return v
  try {
    return JSON.stringify(v, null, 2)
  } catch {
    return String(v)
  }
}

/** Is this string an embeddable image (data URI or http URL)? */
function isImageSrc(s: string | undefined): s is string {
  return !!s && (s.startsWith('data:image') || /^https?:\/\//.test(s))
}

/** Pull the modality-appropriate visual out of whatever the span carries.
 *  Conventions (checked in priority order): an image rides on
 *  `attributes.screenshot|image|frame|videoFrame` or `result.screenshot`; a
 *  diff on `attributes.diff|patch` or `args.diff`; a command on `args` /
 *  `args.command`; an API call on a `url`/`method` in args; file content on
 *  `result`. Unknown tools degrade to an args/result inspector. */
function extractVisual(span: Span): SceneVisual {
  const shot =
    str(attr(span, 'screenshot', 'screenshotUrl', 'image', 'frame', 'videoFrame')) ??
    (span.kind === 'tool'
      ? (str(asObj(span.result)?.screenshot) ?? str(asObj(span.result)?.image))
      : undefined)

  if (span.kind === 'tool') {
    const tn = span.toolName.toLowerCase()
    const a = asObj(span.args)
    // computer use (GUI / desktop control)
    if (/computer|cua|desktop|\bgui\b|xdotool|mouse|keyboard|screen_|pyautogui/.test(tn)) {
      return {
        type: 'browser',
        action: str(a?.action) ?? span.toolName,
        url: str(a?.target),
        screenshot: shot,
      }
    }
    // browser use
    if (
      /browser|playwright|puppeteer|\bpage\b|navigate|goto|\bclick\b|\btype\b|screenshot|dom/.test(
        tn,
      )
    ) {
      return {
        type: 'browser',
        url: str(a?.url) ?? str(attr(span, 'url')),
        action: str(a?.action) ?? str(a?.selector) ?? span.toolName,
        screenshot: shot,
      }
    }
    // code edit → diff
    const diff = str(attr(span, 'diff', 'patch')) ?? str(a?.diff) ?? str(a?.patch)
    if (diff && /edit|write|patch|apply|str_replace|create|save|file/.test(tn)) {
      return {
        type: 'diff',
        path: str(a?.path) ?? str(a?.file) ?? str(attr(span, 'path')) ?? '',
        patch: truncate(diff, 2000),
      }
    }
    if (/edit|write|patch|apply|str_replace/.test(tn)) {
      const newText = str(a?.new_str) ?? str(a?.content) ?? str(a?.text)
      return {
        type: 'diff',
        path: str(a?.path) ?? str(a?.file) ?? '',
        patch: newText ? `+ ${truncate(newText, 1600)}` : '(no diff captured)',
      }
    }
    // file read → code
    if (/read|\bcat\b|open|view|get_file|load|fetch_file/.test(tn)) {
      const content =
        str(asObj(span.result)?.content) ??
        (typeof span.result === 'string' ? span.result : undefined) ??
        str(attr(span, 'content'))
      return {
        type: 'code',
        path: str(a?.path) ?? str(a?.file) ?? '',
        content: truncate(content ?? '', 1400),
      }
    }
    // search
    if (/search|grep|find|glob|query/.test(tn)) {
      return {
        type: 'terminal',
        command: `search ${str(a?.query) ?? str(a?.pattern) ?? ''}`.trim(),
        output: truncate(safeJson(span.result) ?? '', 1000),
      }
    }
    // api / http / network
    const url = str(a?.url) ?? str(attr(span, 'url'))
    if (url || /http|\bapi\b|fetch|request|webhook|rest|graphql|endpoint/.test(tn)) {
      return {
        type: 'api',
        method: str(a?.method) ?? str(attr(span, 'method')),
        url: url ?? span.toolName,
        status: num(attr(span, 'status', 'statusCode')) ?? num(asObj(span.result)?.status),
        request: truncate(str(a?.body) ?? safeJson(span.args) ?? '', 900),
        response: truncate(str(attr(span, 'response')) ?? safeJson(span.result) ?? '', 900),
      }
    }
    // shell / sandbox exec
    if (/shell|exec|bash|\brun\b|terminal|command|sandbox|process/.test(tn)) {
      const command =
        typeof span.args === 'string'
          ? span.args
          : (str(a?.command) ?? str(a?.cmd) ?? span.toolName)
      const output =
        str(attr(span, 'output', 'stdout')) ??
        (typeof span.result === 'string' ? span.result : safeJson(span.result))
      return {
        type: 'terminal',
        command: truncate(command, 240),
        output: truncate(output ?? '', 1400),
      }
    }
    // generic tool — show the call
    return {
      type: 'api',
      url: span.toolName,
      request: truncate(safeJson(span.args) ?? '', 900),
      response: truncate(safeJson(span.result) ?? '', 900),
    }
  }

  if (isImageSrc(shot)) return { type: 'screenshot', src: shot }
  if (span.kind === 'llm') {
    const text = str(span.output) ?? str(span.messages?.[span.messages.length - 1]?.content)
    return text ? { type: 'prose', text: truncate(text, 900) } : { type: 'none' }
  }
  if (span.kind === 'sandbox')
    return { type: 'terminal', command: span.name, output: str(attr(span, 'output')) }
  return { type: 'none' }
}

// ── Classification ──────────────────────────────────────────────────────────

interface Classified {
  kind: SemanticKind
  importance: 1 | 2 | 3 | 4 | 5
  label: string
}

function toolLabel(span: Span): string {
  if (span.kind === 'tool') {
    const a = asObj(span.args)
    const arg =
      typeof span.args === 'string'
        ? span.args
        : a
          ? (str(a.path) ??
            str(a.url) ??
            str(a.command) ??
            str(a.query) ??
            Object.values(a).find((v) => typeof v === 'string'))
          : undefined
    return typeof arg === 'string' && arg.length > 0
      ? `${span.toolName}: ${truncate(arg, 60)}`
      : span.toolName
  }
  return span.name
}

function classify(span: Span): Classified {
  if (span.status === 'error' || span.error) {
    return { kind: 'observed_failure', importance: 5, label: span.error ?? span.name }
  }
  if (span.kind === 'llm' || span.kind === 'agent')
    return { kind: 'reasoned', importance: 2, label: span.name }
  if (span.kind === 'judge') return { kind: 'evaluated', importance: 2, label: span.name }
  if (span.kind === 'retrieval') return { kind: 'searched', importance: 2, label: span.name }
  if (span.kind === 'sandbox') return { kind: 'ran_command', importance: 3, label: span.name }
  if (span.kind === 'tool') {
    const tn = span.toolName.toLowerCase()
    const label = toolLabel(span)
    if (/computer|cua|desktop|\bgui\b|xdotool|pyautogui/.test(tn))
      return { kind: 'used_computer', importance: 3, label }
    if (/browser|playwright|puppeteer|\bpage\b|navigate|goto|\bclick\b|screenshot|dom/.test(tn))
      return { kind: 'used_browser', importance: 3, label }
    if (/edit|write|patch|apply|str_replace|create.*file|save/.test(tn))
      return { kind: 'edited_code', importance: 4, label }
    if (/read|\bcat\b|open|view|get.*file|load/.test(tn))
      return { kind: 'read_file', importance: 2, label }
    if (/search|grep|find|glob|query/.test(tn)) return { kind: 'searched', importance: 2, label }
    if (
      /http|\bapi\b|fetch|request|webhook|rest|graphql|endpoint/.test(tn) ||
      str(asObj(span.args)?.url)
    ) {
      return { kind: 'called_api', importance: 3, label }
    }
    if (/shell|exec|bash|\brun\b|terminal|command|process/.test(tn))
      return { kind: 'ran_command', importance: 3, label }
    return { kind: 'called_tool', importance: 3, label }
  }
  return { kind: 'called_tool', importance: 2, label: span.name }
}

const KIND_VERB: Record<SemanticKind, string> = {
  understood_task: 'Received the task',
  reasoned: 'Reasoned',
  ran_command: 'Ran a command',
  read_file: 'Read files',
  edited_code: 'Edited code',
  searched: 'Searched',
  used_browser: 'Used the browser',
  used_computer: 'Controlled the computer',
  called_api: 'Called an API',
  called_tool: 'Used a tool',
  evaluated: 'Evaluated the result',
  observed_failure: 'Hit a failure',
  completed: 'Finished',
}

/**
 * Reduce a span tree into the meaningful moments a viewer cares about. Each
 * span is classified + has its modality visual extracted; adjacent same-kind
 * moments collapse (the compression step), carrying the latest visual so the
 * scene shows the most recent state. A failure always stands alone.
 */
export function reduceToSemanticEvents(
  spans: readonly Span[],
  opts: ReduceOptions = {},
): SemanticEvent[] {
  const collapse = opts.collapseAdjacent ?? true
  const ordered = [...spans].sort((a, b) => a.startedAt - b.startedAt)
  const raw: SemanticEvent[] = ordered.map((s) => {
    const c = classify(s)
    return {
      kind: c.kind,
      title: c.label,
      summary: `${KIND_VERB[c.kind]} — ${c.label}`,
      visual: extractVisual(s),
      evidenceSpanIds: [s.spanId],
      importance: c.importance,
      startTs: s.startedAt,
      endTs: s.endedAt ?? s.startedAt,
    }
  })
  if (!collapse) return raw

  const merged: SemanticEvent[] = []
  for (const ev of raw) {
    const prev = merged[merged.length - 1]
    if (prev && prev.kind === ev.kind && ev.kind !== 'observed_failure') {
      prev.evidenceSpanIds.push(...ev.evidenceSpanIds)
      prev.endTs = Math.max(prev.endTs, ev.endTs)
      if (ev.visual.type !== 'none') prev.visual = ev.visual // keep the latest state
      const n = prev.evidenceSpanIds.length
      prev.title = `${KIND_VERB[ev.kind]} (${n}×)`
      prev.summary = `${KIND_VERB[ev.kind]} ${n} time${n === 1 ? '' : 's'} — latest: ${ev.title}`
    } else {
      merged.push({ ...ev, evidenceSpanIds: [...ev.evidenceSpanIds] })
    }
  }
  return merged
}

// ── Storyboard ────────────────────────────────────────────────────────────

export type SceneType =
  | 'title_card'
  | 'reasoning'
  | 'terminal'
  | 'file'
  | 'diff'
  | 'search'
  | 'browser'
  | 'computer'
  | 'api'
  | 'tool'
  | 'eval'
  | 'error'
  | 'summary'

export interface Scene {
  sceneType: SceneType
  title: string
  narration: string
  /** The modality payload the renderer shows. */
  visual: SceneVisual
  durationMs: number
  evidenceSpanIds: string[]
}

export interface Storyboard {
  title: string
  totalMs: number
  scenes: Scene[]
}

export interface CompileOptions {
  /** Headline for the title card. Default "Agent run". */
  title?: string
  /** Max action scenes between the title + summary cards. Default 16. */
  maxScenes?: number
}

const KIND_TO_SCENE: Record<SemanticKind, SceneType> = {
  understood_task: 'title_card',
  reasoned: 'reasoning',
  ran_command: 'terminal',
  read_file: 'file',
  edited_code: 'diff',
  searched: 'search',
  used_browser: 'browser',
  used_computer: 'computer',
  called_api: 'api',
  called_tool: 'tool',
  evaluated: 'eval',
  observed_failure: 'error',
  completed: 'summary',
}

const DURATION_BY_IMPORTANCE: Record<1 | 2 | 3 | 4 | 5, number> = {
  1: 2500,
  2: 3000,
  3: 4000,
  4: 5000,
  5: 6000,
}

/**
 * Select the moments worth showing and lay them out as scenes. Every failure
 * (importance 5) and edit (4) is always kept; the rest fill the budget by
 * importance, then re-sort chronological. A title card opens, a summary closes.
 */
export function compileStoryboard(
  events: readonly SemanticEvent[],
  opts: CompileOptions = {},
): Storyboard {
  const title = opts.title ?? 'Agent run'
  const maxScenes = opts.maxScenes ?? 16

  const indexed = events.map((ev, i) => ({ ev, i }))
  const mustKeep = indexed.filter(({ ev }) => ev.importance >= 4)
  const rest = indexed
    .filter(({ ev }) => ev.importance < 4)
    .sort((a, b) => b.ev.importance - a.ev.importance || a.i - b.i)
  const budget = Math.max(0, maxScenes - mustKeep.length)
  const selected = [...mustKeep, ...rest.slice(0, budget)].sort((a, b) => a.i - b.i)

  const actionScenes: Scene[] = selected.map(({ ev }) => ({
    sceneType: KIND_TO_SCENE[ev.kind],
    title: ev.title,
    narration: ev.summary,
    visual: ev.visual,
    durationMs: DURATION_BY_IMPORTANCE[ev.importance],
    evidenceSpanIds: ev.evidenceSpanIds,
  }))

  const failures = events.filter((e) => e.kind === 'observed_failure').length
  const edits = events.filter((e) => e.kind === 'edited_code').length
  const commands = events.filter((e) => e.kind === 'ran_command').length
  const summaryNarration =
    `${events.length} moments · ${commands} command${commands === 1 ? '' : 's'} · ` +
    `${edits} edit${edits === 1 ? '' : 's'} · ${failures} failure${failures === 1 ? '' : 's'}`

  const scenes: Scene[] = [
    {
      sceneType: 'title_card',
      title,
      narration: 'The agent receives its task.',
      visual: { type: 'none' },
      durationMs: 3000,
      evidenceSpanIds: [],
    },
    ...actionScenes,
    {
      sceneType: 'summary',
      title: failures > 0 ? 'Finished — with failures' : 'Finished',
      narration: summaryNarration,
      visual: { type: 'none' },
      durationMs: 4000,
      evidenceSpanIds: [],
    },
  ]
  return { title, totalMs: scenes.reduce((s, sc) => s + sc.durationMs, 0), scenes }
}

// ── Renderers (pure string out) ─────────────────────────────────────────────

const SCENE_ICON: Record<SceneType, string> = {
  title_card: '🎬',
  reasoning: '🧠',
  terminal: '⌨️',
  file: '📄',
  diff: '✏️',
  search: '🔎',
  browser: '🌐',
  computer: '🖥️',
  api: '🔌',
  tool: '🔧',
  eval: '⚖️',
  error: '❌',
  summary: '🏁',
}

function mmss(ms: number): string {
  const s = Math.round(ms / 1000)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, Math.max(0, max - 1))}…`
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** A short modality tag for the markdown shot list. */
function visualMarkdown(v: SceneVisual): string {
  switch (v.type) {
    case 'screenshot':
      return `🖼 screenshot (${truncate(v.src, 60)})`
    case 'browser':
      return `🌐 ${v.action ?? 'browser'}${v.url ? ` → ${v.url}` : ''}${v.screenshot ? ' [screenshot]' : ''}`
    case 'diff':
      return `\n\n\`\`\`diff\n${truncate(v.patch, 600)}\n\`\`\`${v.path ? `\n_${v.path}_` : ''}`
    case 'code':
      return `\n\n\`\`\`\n${truncate(v.content, 500)}\n\`\`\`${v.path ? `\n_${v.path}_` : ''}`
    case 'terminal':
      return `\n\n\`\`\`sh\n$ ${v.command}${v.output ? `\n${truncate(v.output, 500)}` : ''}\n\`\`\``
    case 'api':
      return `🔌 ${v.method ?? 'CALL'} ${v.url}${v.status != null ? ` → ${v.status}` : ''}`
    case 'prose':
      return `\n\n> ${truncate(v.text, 400).replace(/\n/g, '\n> ')}`
    default:
      return ''
  }
}

/** Build the (escaped, structured) HTML for a scene's visual. We never inject
 *  raw agent markup — every text part is escaped; only image `src` (data/http)
 *  is passed through as an attribute. */
function visualHtml(v: SceneVisual): string {
  switch (v.type) {
    case 'screenshot':
      return `<img class="shot" src="${escapeHtml(v.src)}" alt="screenshot" loading="lazy"/>`
    case 'browser': {
      const bar = `<div class="urlbar">${escapeHtml(v.url ?? v.action ?? 'browser')}</div>`
      const body = isImageSrc(v.screenshot)
        ? `<img class="shot" src="${escapeHtml(v.screenshot)}" alt="page" loading="lazy"/>`
        : `<div class="browser-action">${escapeHtml(v.action ?? 'navigated')}</div>`
      return `<div class="browser">${bar}${body}</div>`
    }
    case 'diff': {
      const lines = v.patch.split('\n').map((l) => {
        const cls = l.startsWith('+') ? 'add' : l.startsWith('-') ? 'del' : ''
        return `<span class="${cls}">${escapeHtml(l)}</span>`
      })
      return `${v.path ? `<div class="pathhdr">${escapeHtml(v.path)}</div>` : ''}<pre class="diff">${lines.join('\n')}</pre>`
    }
    case 'code':
      return `${v.path ? `<div class="pathhdr">${escapeHtml(v.path)}</div>` : ''}<pre class="code">${escapeHtml(v.content)}</pre>`
    case 'terminal':
      return `<pre class="term"><span class="cmd">$ ${escapeHtml(v.command)}</span>${v.output ? `\n${escapeHtml(v.output)}` : ''}</pre>`
    case 'api': {
      const badge = `<span class="method">${escapeHtml(v.method ?? 'CALL')}</span> <span class="url">${escapeHtml(v.url)}</span>${v.status != null ? ` <span class="status s${Math.floor(v.status / 100)}">${v.status}</span>` : ''}`
      const req = v.request
        ? `<div class="kv"><b>req</b><pre>${escapeHtml(v.request)}</pre></div>`
        : ''
      const res = v.response
        ? `<div class="kv"><b>res</b><pre>${escapeHtml(v.response)}</pre></div>`
        : ''
      return `<div class="api"><div class="apihdr">${badge}</div>${req}${res}</div>`
    }
    case 'prose':
      return `<div class="prose">${escapeHtml(v.text)}</div>`
    default:
      return ''
  }
}

/** Render the storyboard as a Markdown timeline — the human-readable shot list. */
export function renderStoryboardMarkdown(storyboard: Storyboard): string {
  const out: string[] = [
    `# 🎬 ${storyboard.title}`,
    '',
    `_${storyboard.scenes.length} scenes · ${mmss(storyboard.totalMs)} replay_`,
    '',
  ]
  let elapsed = 0
  for (const sc of storyboard.scenes) {
    out.push(`### [${mmss(elapsed)}] ${SCENE_ICON[sc.sceneType]} ${sc.title}`)
    out.push('')
    out.push(sc.narration)
    const vm = visualMarkdown(sc.visual)
    if (vm) out.push(vm)
    if (sc.evidenceSpanIds.length > 0) {
      out.push('')
      out.push(`_evidence: ${sc.evidenceSpanIds.length} span(s)_`)
    }
    out.push('')
    elapsed += sc.durationMs
  }
  return out.join('\n')
}

export interface HtmlRenderOptions {
  /** Document title + on-page heading. Defaults to the storyboard title. */
  title?: string
}

/**
 * Render the storyboard as a self-contained, auto-playing HTML replay — one
 * shareable file, no build step, no external assets. Each scene animates in
 * for its duration and SHOWS its modality (screenshot / diff / terminal / API
 * / browser / prose); controls let a viewer scrub. This is the "free clip" a
 * run produces; an MP4 is the same storyboard fed to Remotion in a consumer.
 */
export function renderStoryboardHtml(storyboard: Storyboard, opts: HtmlRenderOptions = {}): string {
  const docTitle = opts.title ?? storyboard.title
  // Pre-render each scene's visual to safe HTML here (testable, escaped); the
  // player just sets innerHTML. `<` is escaped in the JSON so a payload can't
  // break out of the <script> tag.
  const scenesJson = JSON.stringify(
    storyboard.scenes.map((s) => ({
      icon: SCENE_ICON[s.sceneType],
      type: s.sceneType,
      title: s.title,
      narration: s.narration,
      durationMs: s.durationMs,
      evidence: s.evidenceSpanIds.length,
      visual: visualHtml(s.visual),
    })),
  ).replace(/</g, '\\u003c')

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(docTitle)}</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 16px/1.5 ui-sans-serif, system-ui, -apple-system, sans-serif;
    background: #0b0f17; color: #e6edf3; display: flex; min-height: 100vh; align-items: center; justify-content: center; }
  .stage { width: min(900px, 95vw); }
  h1 { font-size: 1.1rem; font-weight: 600; color: #9aa7b5; margin: 0 0 14px; letter-spacing: .02em; }
  .card { background: #111824; border: 1px solid #1e2a3a; border-radius: 14px; padding: 24px 28px;
    min-height: 300px; box-shadow: 0 12px 40px rgba(0,0,0,.45); position: relative; overflow: hidden; }
  .card::before { content: ""; position: absolute; inset: 0 0 auto 0; height: 3px; background: var(--accent, #3b82f6); }
  .head { display: flex; align-items: center; gap: 12px; margin-bottom: 6px; }
  .icon { font-size: 2rem; line-height: 1; }
  .title { font-size: 1.3rem; font-weight: 650; }
  .narration { color: #9fb0c0; font-size: .95rem; margin-bottom: 14px; }
  .visual { margin-top: 6px; }
  .visual img.shot { max-width: 100%; max-height: 360px; border-radius: 8px; border: 1px solid #1e2a3a; display: block; }
  .visual pre { background: #0a0e15; border: 1px solid #1e2a3a; border-radius: 8px; padding: 12px 14px;
    overflow: auto; max-height: 340px; font: 13px/1.5 ui-monospace, "SF Mono", Menlo, monospace; white-space: pre-wrap; word-break: break-word; }
  .pathhdr { font: 12px ui-monospace, monospace; color: #7d8da0; margin-bottom: 4px; }
  .diff .add { color: #56d364; } .diff .del { color: #f85149; }
  .term .cmd { color: #eab308; }
  .browser { border: 1px solid #1e2a3a; border-radius: 8px; overflow: hidden; }
  .urlbar { background: #0a0e15; padding: 7px 12px; font: 12px ui-monospace, monospace; color: #8b98a6; border-bottom: 1px solid #1e2a3a; }
  .browser-action { padding: 28px; color: #9fb0c0; text-align: center; }
  .api .apihdr { font: 13px ui-monospace, monospace; margin-bottom: 8px; }
  .method { background: #1b2636; padding: 2px 8px; border-radius: 5px; color: #79c0ff; }
  .status.s2 { color: #56d364; } .status.s4, .status.s5 { color: #f85149; }
  .kv { margin-top: 6px; } .kv b { color: #7d8da0; font-weight: 600; font-size: 12px; }
  .prose { color: #c9d4e0; font-size: 1rem; white-space: pre-wrap; max-height: 340px; overflow: auto; }
  .type-error { --accent: #ef4444; } .type-diff { --accent: #22c55e; } .type-terminal { --accent: #eab308; }
  .type-browser { --accent: #06b6d4; } .type-computer { --accent: #14b8a6; } .type-api { --accent: #79c0ff; }
  .type-summary { --accent: #a855f7; } .type-title_card { --accent: #3b82f6; }
  .scene-enter { animation: pop .45s cubic-bezier(.2,.7,.3,1.2); }
  @keyframes pop { from { opacity: 0; transform: translateY(10px) scale(.985); } to { opacity: 1; transform: none; } }
  .bar { height: 4px; background: #1e2a3a; border-radius: 4px; margin-top: 14px; overflow: hidden; }
  .bar > i { display: block; height: 100%; width: 0; background: var(--accent, #3b82f6); transition: width .1s linear; }
  .controls { display: flex; gap: 10px; align-items: center; margin-top: 14px; color: #8b98a6; font-size: .85rem; }
  button { background: #1b2636; color: #e6edf3; border: 1px solid #2a3a4f; border-radius: 8px; padding: 6px 12px; cursor: pointer; font: inherit; }
  button:hover { background: #243349; }
  .dots { display: flex; gap: 5px; margin-left: auto; flex-wrap: wrap; }
  .dot { width: 7px; height: 7px; border-radius: 50%; background: #2a3a4f; cursor: pointer; }
  .dot.on { background: var(--accent, #3b82f6); }
</style>
</head>
<body>
<div class="stage">
  <h1>🎬 ${escapeHtml(docTitle)}</h1>
  <div class="card" id="card">
    <div class="head"><span class="icon" id="icon"></span><span class="title" id="title"></span></div>
    <div class="narration" id="narration"></div>
    <div class="visual" id="visual"></div>
    <div class="bar"><i id="fill"></i></div>
  </div>
  <div class="controls">
    <button id="playPause">⏸ Pause</button>
    <button id="prev">◀ Prev</button>
    <button id="next">Next ▶</button>
    <span id="counter"></span>
    <span class="dots" id="dots"></span>
  </div>
</div>
<script>
  const SCENES = ${scenesJson};
  let i = 0, playing = true, raf = 0, start = 0;
  const card = document.getElementById('card'), counter = document.getElementById('counter'), dotsEl = document.getElementById('dots');
  SCENES.forEach((_, k) => { const d = document.createElement('span'); d.className = 'dot'; d.onclick = () => go(k); dotsEl.appendChild(d); });
  function paint() {
    const s = SCENES[i];
    card.className = 'card scene-enter type-' + s.type;
    document.getElementById('icon').textContent = s.icon;
    document.getElementById('title').textContent = s.title;
    document.getElementById('narration').textContent = s.narration;
    document.getElementById('visual').innerHTML = s.visual || '';
    counter.textContent = (i + 1) + ' / ' + SCENES.length;
    [...dotsEl.children].forEach((d, k) => d.className = 'dot' + (k === i ? ' on' : ''));
    void card.offsetWidth;
  }
  function tick(t) {
    if (!start) start = t;
    const s = SCENES[i], p = Math.min(1, (t - start) / s.durationMs);
    document.getElementById('fill').style.width = (p * 100) + '%';
    if (p >= 1) { if (i < SCENES.length - 1) { go(i + 1); } else { playing = false; updateBtn(); return; } }
    if (playing) raf = requestAnimationFrame(tick);
  }
  function go(n) { i = Math.max(0, Math.min(SCENES.length - 1, n)); start = 0; cancelAnimationFrame(raf); paint(); if (playing) raf = requestAnimationFrame(tick); }
  function updateBtn() { document.getElementById('playPause').textContent = playing ? '⏸ Pause' : '▶ Play'; }
  document.getElementById('playPause').onclick = () => { playing = !playing; updateBtn(); start = 0; if (playing) raf = requestAnimationFrame(tick); else cancelAnimationFrame(raf); };
  document.getElementById('next').onclick = () => go(i + 1);
  document.getElementById('prev').onclick = () => go(i - 1);
  paint(); raf = requestAnimationFrame(tick);
</script>
</body>
</html>
`
}

// The "watch the agent write code" keystroke animation + the CodeEdit IR a
// Remotion consumer reads. Composes with this pipeline: a 'diff' scene shows an
// inline card here; renderCodeAnimationHtml types the whole file out there.
export * from './code-edit'
