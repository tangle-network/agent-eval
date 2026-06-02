/**
 * Storyboard — compile a raw agent trace into a small set of meaningful scenes,
 * then render them as a shareable replay.
 *
 *   Span[] → SemanticEvent[] → Storyboard{scenes} → { markdown | html }
 *
 * The trace is the source of truth; the storyboard is the IR; markdown/html
 * (and, in a consumer package, Remotion/MP4) are compiled targets. Everything
 * here is PURE — same spans in, same bytes out (no clock/random) — so a run's
 * replay is deterministic and diffable. The semantic reducer is rules-based:
 * an LLM pass can refine titles later, but the structure does not depend on
 * one. Renderers that need a browser (Remotion, React) live in consumers; this
 * module only emits strings.
 */

import type { Span } from '../trace/schema'

/** What the agent meaningfully did — the compressed vocabulary the storyboard
 *  is built from (the spec's semantic layer). */
export type SemanticKind =
  | 'understood_task'
  | 'reasoned'
  | 'ran_command'
  | 'read_file'
  | 'edited_code'
  | 'searched'
  | 'used_browser'
  | 'called_tool'
  | 'evaluated'
  | 'observed_failure'
  | 'completed'

export interface SemanticEvent {
  kind: SemanticKind
  /** One-line headline (the ticket/scene title). */
  title: string
  /** Short human summary. */
  summary: string
  /** Span ids backing this moment — the evidence trail. */
  evidenceSpanIds: string[]
  /** 1 (noise) … 5 (pivotal: failures, edits). Drives selection + duration. */
  importance: 1 | 2 | 3 | 4 | 5
  startTs: number
  endTs: number
}

export interface ReduceOptions {
  /** Collapse adjacent same-kind moments into one (e.g. 6 file reads → one
   *  "explored N files"). Default true — this is the compression that takes a
   *  4000-event run down to dozens of moments. */
  collapseAdjacent?: boolean
}

interface Classified {
  kind: SemanticKind
  importance: 1 | 2 | 3 | 4 | 5
  /** A short label for the span's action (e.g. the command, the file). */
  label: string
}

function toolLabel(span: Span): string {
  if (span.kind === 'tool') {
    const tn = span.toolName
    const arg =
      typeof span.args === 'string'
        ? span.args
        : span.args && typeof span.args === 'object'
          ? Object.values(span.args as Record<string, unknown>).find((v) => typeof v === 'string')
          : undefined
    return typeof arg === 'string' && arg.length > 0 ? `${tn}: ${truncate(arg, 60)}` : tn
  }
  return span.name
}

function classify(span: Span): Classified {
  // A failed span is pivotal regardless of what it was doing.
  if (span.status === 'error' || span.error) {
    return { kind: 'observed_failure', importance: 5, label: span.error ?? span.name }
  }
  if (span.kind === 'llm' || span.kind === 'agent') {
    return { kind: 'reasoned', importance: 2, label: span.name }
  }
  if (span.kind === 'judge') {
    return { kind: 'evaluated', importance: 2, label: span.name }
  }
  if (span.kind === 'retrieval') {
    return { kind: 'searched', importance: 2, label: span.name }
  }
  if (span.kind === 'sandbox') {
    return { kind: 'ran_command', importance: 3, label: span.name }
  }
  if (span.kind === 'tool') {
    const tn = span.toolName.toLowerCase()
    const label = toolLabel(span)
    if (/shell|exec|bash|\brun\b|terminal|command/.test(tn)) {
      return { kind: 'ran_command', importance: 3, label }
    }
    if (/edit|write|patch|apply|str_replace|create.*file|save/.test(tn)) {
      return { kind: 'edited_code', importance: 4, label }
    }
    if (/read|\bcat\b|open|view|get.*file|load/.test(tn)) {
      return { kind: 'read_file', importance: 2, label }
    }
    if (/search|grep|find|glob|query/.test(tn)) {
      return { kind: 'searched', importance: 2, label }
    }
    if (/browser|playwright|click|navigate|goto|screenshot|page/.test(tn)) {
      return { kind: 'used_browser', importance: 3, label }
    }
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
  used_browser: 'Drove the browser',
  called_tool: 'Used a tool',
  evaluated: 'Evaluated the result',
  observed_failure: 'Hit a failure',
  completed: 'Finished',
}

/**
 * Reduce a span tree into the meaningful moments a viewer cares about. Spans
 * are sorted by start time; each is classified, then adjacent same-kind
 * moments collapse into one (the compression step). A failure always stands
 * alone (importance 5) so it never gets folded into the noise around it.
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
    // Never fold a failure, and never fold across kinds.
    if (prev && prev.kind === ev.kind && ev.kind !== 'observed_failure') {
      prev.evidenceSpanIds.push(...ev.evidenceSpanIds)
      prev.endTs = Math.max(prev.endTs, ev.endTs)
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
  | 'tool'
  | 'eval'
  | 'error'
  | 'summary'

export interface Scene {
  sceneType: SceneType
  title: string
  narration: string
  durationMs: number
  /** Span ids behind the scene — the click-through evidence. */
  evidenceSpanIds: string[]
}

export interface Storyboard {
  title: string
  /** Sum of scene durations — the replay length. */
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
  called_tool: 'tool',
  evaluated: 'eval',
  observed_failure: 'error',
  completed: 'summary',
}

// Pivotal moments earn longer screen time.
const DURATION_BY_IMPORTANCE: Record<1 | 2 | 3 | 4 | 5, number> = {
  1: 2500,
  2: 3000,
  3: 4000,
  4: 5000,
  5: 6000,
}

/**
 * Select the moments worth showing and lay them out as scenes. Every failure
 * (importance 5) and edit (4) is always kept — those are the story; the rest
 * fill the budget by importance, then everything is re-sorted to chronological
 * order so the replay reads forward in time. A title card opens and a summary
 * card closes.
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
      durationMs: 3000,
      evidenceSpanIds: [],
    },
    ...actionScenes,
    {
      sceneType: 'summary',
      title: failures > 0 ? 'Finished — with failures' : 'Finished',
      narration: summaryNarration,
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
    if (sc.evidenceSpanIds.length > 0) {
      out.push('')
      out.push(
        `_evidence: ${sc.evidenceSpanIds.length} span(s) — ${sc.evidenceSpanIds.slice(0, 6).join(', ')}_`,
      )
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
 * for its duration with a progress bar; controls let a viewer scrub. This is
 * the "free clip" a run produces; an MP4 is the same storyboard fed to Remotion
 * in a consumer package.
 */
export function renderStoryboardHtml(storyboard: Storyboard, opts: HtmlRenderOptions = {}): string {
  const docTitle = opts.title ?? storyboard.title
  const scenesJson = JSON.stringify(
    storyboard.scenes.map((s) => ({
      icon: SCENE_ICON[s.sceneType],
      type: s.sceneType,
      title: s.title,
      narration: s.narration,
      durationMs: s.durationMs,
      evidence: s.evidenceSpanIds.length,
    })),
  )
  // Inline everything; the JS player is tiny and dependency-free.
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
  .stage { width: min(820px, 94vw); }
  h1 { font-size: 1.1rem; font-weight: 600; color: #9aa7b5; margin: 0 0 14px; letter-spacing: .02em; }
  .card { background: #111824; border: 1px solid #1e2a3a; border-radius: 14px; padding: 28px 30px;
    min-height: 230px; box-shadow: 0 12px 40px rgba(0,0,0,.45); position: relative; overflow: hidden; }
  .card::before { content: ""; position: absolute; inset: 0 0 auto 0; height: 3px; background: var(--accent, #3b82f6); }
  .icon { font-size: 2.6rem; line-height: 1; }
  .title { font-size: 1.5rem; font-weight: 650; margin: 14px 0 8px; }
  .narration { color: #b6c2cf; font-size: 1.05rem; }
  .meta { position: absolute; bottom: 16px; right: 22px; color: #5b6b7d; font-size: .8rem; }
  .type-error { --accent: #ef4444; } .type-diff { --accent: #22c55e; } .type-terminal { --accent: #eab308; }
  .type-browser { --accent: #06b6d4; } .type-summary { --accent: #a855f7; } .type-title_card { --accent: #3b82f6; }
  .scene-enter { animation: pop .45s cubic-bezier(.2,.7,.3,1.2); }
  @keyframes pop { from { opacity: 0; transform: translateY(10px) scale(.985); } to { opacity: 1; transform: none; } }
  .bar { height: 4px; background: #1e2a3a; border-radius: 4px; margin-top: 16px; overflow: hidden; }
  .bar > i { display: block; height: 100%; width: 0; background: var(--accent, #3b82f6); transition: width .1s linear; }
  .controls { display: flex; gap: 10px; align-items: center; margin-top: 14px; color: #8b98a6; font-size: .85rem; }
  button { background: #1b2636; color: #e6edf3; border: 1px solid #2a3a4f; border-radius: 8px;
    padding: 6px 12px; cursor: pointer; font: inherit; }
  button:hover { background: #243349; }
  .dots { display: flex; gap: 5px; margin-left: auto; }
  .dot { width: 7px; height: 7px; border-radius: 50%; background: #2a3a4f; cursor: pointer; }
  .dot.on { background: var(--accent, #3b82f6); }
</style>
</head>
<body>
<div class="stage">
  <h1>🎬 ${escapeHtml(docTitle)}</h1>
  <div class="card" id="card">
    <div class="icon" id="icon"></div>
    <div class="title" id="title"></div>
    <div class="narration" id="narration"></div>
    <div class="meta" id="meta"></div>
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
  const card = document.getElementById('card'), counter = document.getElementById('counter');
  const dotsEl = document.getElementById('dots');
  SCENES.forEach((_, k) => { const d = document.createElement('span'); d.className = 'dot'; d.onclick = () => go(k); dotsEl.appendChild(d); });
  function paint() {
    const s = SCENES[i];
    card.className = 'card scene-enter type-' + s.type;
    document.getElementById('icon').textContent = s.icon;
    document.getElementById('title').textContent = s.title;
    document.getElementById('narration').textContent = s.narration;
    document.getElementById('meta').textContent = s.evidence ? (s.evidence + ' span' + (s.evidence === 1 ? '' : 's')) : '';
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
