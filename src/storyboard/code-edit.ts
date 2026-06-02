/**
 * Code-edit extraction + the "watch the agent write code" animation.
 *
 * The base storyboard (./index) compresses a run into scenes but keeps scenes
 * payload-free (title + narration + evidence span ids). To actually SHOW the
 * code an agent wrote, this module pulls the concrete edit (path, diff,
 * before/after, language) out of the raw edit-tool spans and renders a
 * self-contained HTML replay that types each file out, character by character,
 * like an editor recording.
 *
 * Additive on purpose: it reuses the canonical `Span` (trace/schema) and the
 * `Storyboard` IR (./index) without modifying the reducer/compiler — so it
 * composes with the existing pipeline and a Remotion consumer can read the same
 * `CodeEdit[]` to render an MP4.
 */

import type { Span } from '../trace/schema'
import type { Scene, Storyboard } from './index'

const EDIT_TOOLS =
  /(edit|write|patch|apply|str_replace|create.*file|save|insert|update.*file|multi_edit)/i

/** A concrete code change lifted from a tool span. */
export interface CodeEdit {
  /** Span the edit came from — back-reference into the trace. */
  spanId: string
  path: string
  language?: string
  /** Unified diff, when the tool carried one. */
  diff?: string
  /** Full file body before / after, when present — enables true keystroke
   *  animation rather than only flashing a diff. */
  before?: string
  after?: string
  additions: number
  deletions: number
  startedAt: number
}

function languageOf(path: string): string | undefined {
  const ext = path.includes('.') ? path.split('.').pop()?.toLowerCase() : undefined
  if (!ext) return undefined
  const map: Record<string, string> = {
    ts: 'ts',
    tsx: 'tsx',
    js: 'js',
    jsx: 'jsx',
    mjs: 'js',
    cjs: 'js',
    py: 'python',
    rs: 'rust',
    go: 'go',
    sol: 'solidity',
    java: 'java',
    rb: 'ruby',
    php: 'php',
    c: 'c',
    cpp: 'cpp',
    cs: 'csharp',
    css: 'css',
    scss: 'scss',
    html: 'html',
    json: 'json',
    yaml: 'yaml',
    yml: 'yaml',
    toml: 'toml',
    md: 'markdown',
    sh: 'bash',
    sql: 'sql',
  }
  return map[ext] ?? ext
}

function pick(obj: unknown, keys: string[]): string | undefined {
  if (!obj || typeof obj !== 'object') return undefined
  const rec = obj as Record<string, unknown>
  for (const k of Object.keys(rec)) {
    if (keys.includes(k.toLowerCase())) {
      const v = rec[k]
      if (typeof v === 'string') return v
    }
  }
  return undefined
}

function countDiff(diff?: string): { additions: number; deletions: number } {
  if (!diff) return { additions: 0, deletions: 0 }
  let additions = 0
  let deletions = 0
  for (const line of diff.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) additions++
    else if (line.startsWith('-') && !line.startsWith('---')) deletions++
  }
  return { additions, deletions }
}

/** Extract a CodeEdit from a single span, or undefined if it is not an edit. */
export function codeEditFromSpan(span: Span): CodeEdit | undefined {
  if (span.kind !== 'tool') return undefined
  const tool = span as Extract<Span, { kind: 'tool' }>
  if (!EDIT_TOOLS.test(tool.toolName)) return undefined
  const path = pick(tool.args, ['path', 'file_path', 'filepath', 'filename', 'file'])
  if (!path) return undefined
  const diff = pick(tool.args, ['diff', 'patch'])
  const after = pick(tool.args, ['content', 'new_str', 'new_string', 'newtext', 'text', 'body'])
  const before = pick(tool.args, ['old_str', 'old_string', 'oldtext', 'original'])
  const counts = countDiff(diff)
  return {
    spanId: span.spanId,
    path,
    language: languageOf(path),
    diff,
    before,
    after,
    additions: diff ? counts.additions : after ? after.split('\n').length : 0,
    deletions: diff ? counts.deletions : 0,
    startedAt: span.startedAt,
  }
}

/** All code edits in a run, in chronological order. */
export function extractCodeEdits(spans: readonly Span[]): CodeEdit[] {
  return spans
    .map(codeEditFromSpan)
    .filter((e): e is CodeEdit => e != null)
    .sort((a, b) => a.startedAt - b.startedAt)
}

/** Pair each code-edit (`diff`) scene with its concrete edit, matched via the
 *  scene's evidence span ids. Scenes without a recoverable edit are dropped. */
export function codeEditsForStoryboard(
  storyboard: Storyboard,
  spans: readonly Span[],
): Array<{ scene: Scene; edit: CodeEdit }> {
  const bySpan = new Map(extractCodeEdits(spans).map((e) => [e.spanId, e]))
  const out: Array<{ scene: Scene; edit: CodeEdit }> = []
  for (const scene of storyboard.scenes) {
    if (scene.sceneType !== 'diff') continue
    const edit = scene.evidenceSpanIds
      .map((id) => bySpan.get(id))
      .find((e): e is CodeEdit => e != null)
    if (edit) out.push({ scene, edit })
  }
  return out
}

/** The text the animation types for an edit: prefer the full new file body,
 *  then the added lines of a diff, then a minimal placeholder so the scene is
 *  never blank. */
export function editAnimationText(edit: CodeEdit): string {
  if (edit.after && edit.after.trim()) return edit.after
  if (edit.diff) {
    const added = edit.diff
      .split('\n')
      .filter((l) => l.startsWith('+') && !l.startsWith('+++'))
      .map((l) => l.slice(1))
      .join('\n')
    if (added.trim()) return added
  }
  return `// ${edit.path}\n// (${edit.additions} line${edit.additions === 1 ? '' : 's'} written)`
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

export interface CodeAnimationOptions {
  /** Page title. Default "Agent writing code". */
  title?: string
  /** Characters typed per animation tick. Higher = faster. Default 4. */
  charsPerTick?: number
  /** Pause between files, ms. Default 900. */
  pauseBetweenMs?: number
}

/**
 * Render a self-contained HTML page that animates the agent writing each file,
 * character by character, with a filename tab, line numbers, and a blinking
 * cursor — the shareable "watch it build" clip. No build step, no assets, no
 * deps. The same `CodeEdit[]` feeds a Remotion MP4 renderer in a consumer
 * package; this is the dependency-free baseline.
 */
export function renderCodeAnimationHtml(
  source: readonly Span[] | readonly CodeEdit[],
  opts: CodeAnimationOptions = {},
): string {
  const edits: CodeEdit[] =
    source.length > 0 && 'path' in (source[0] as object)
      ? (source as CodeEdit[])
      : extractCodeEdits(source as readonly Span[])

  const files = edits.map((e) => ({
    path: e.path,
    language: e.language ?? '',
    additions: e.additions,
    deletions: e.deletions,
    code: editAnimationText(e),
  }))
  const title = opts.title ?? 'Agent writing code'
  const charsPerTick = opts.charsPerTick ?? 4
  const pauseBetweenMs = opts.pauseBetweenMs ?? 900
  const filesJson = JSON.stringify(files)

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${esc(title)}</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; background: #0b0f17; color: #e6edf3;
    font: 14px/1.55 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    display: flex; flex-direction: column; min-height: 100vh; align-items: center; justify-content: center; gap: 14px; }
  h1 { font-family: ui-sans-serif, system-ui, sans-serif; font-size: 1rem; font-weight: 600; color: #9aa7b5; margin: 0; }
  .editor { width: min(900px, 94vw); background: #0d1320; border: 1px solid #1e2a3a; border-radius: 12px;
    overflow: hidden; box-shadow: 0 16px 50px rgba(0,0,0,.5); }
  .tabbar { display: flex; align-items: center; gap: 8px; background: #111a29; padding: 9px 14px; border-bottom: 1px solid #1e2a3a; }
  .dot { width: 11px; height: 11px; border-radius: 50%; }
  .dot.r { background: #ff5f56; } .dot.y { background: #ffbd2e; } .dot.g { background: #27c93f; }
  .tab { margin-left: 10px; background: #0d1320; padding: 5px 12px; border-radius: 7px 7px 0 0;
    color: #cdd9e5; font-family: ui-sans-serif, system-ui, sans-serif; font-size: .85rem; }
  .lang { color: #5b6b7d; font-size: .75rem; margin-left: 6px; }
  .adds { margin-left: auto; color: #3fb950; font-size: .78rem; font-family: ui-sans-serif, system-ui, sans-serif; }
  .dels { color: #f85149; margin-left: 8px; }
  .codewrap { display: flex; max-height: 60vh; overflow: auto; }
  .gutter { padding: 14px 10px 14px 14px; text-align: right; color: #3a4757; user-select: none; white-space: pre; }
  pre { margin: 0; padding: 14px 18px 14px 6px; white-space: pre; tab-size: 2; flex: 1; }
  .cursor { display: inline-block; width: 8px; margin-left: 1px; background: #58a6ff; animation: blink .9s steps(1) infinite; }
  @keyframes blink { 50% { opacity: 0; } }
  .controls { display: flex; gap: 10px; align-items: center; font-family: ui-sans-serif, system-ui, sans-serif; font-size: .85rem; color: #8b98a6; }
  button { background: #1b2636; color: #e6edf3; border: 1px solid #2a3a4f; border-radius: 8px; padding: 6px 12px; cursor: pointer; font: inherit; }
  button:hover { background: #243349; }
  .empty { padding: 40px; color: #5b6b7d; }
</style>
</head>
<body>
  <h1>✏️ ${esc(title)}</h1>
  <div class="editor">
    <div class="tabbar">
      <span class="dot r"></span><span class="dot y"></span><span class="dot g"></span>
      <span class="tab" id="tab">—</span><span class="lang" id="lang"></span>
      <span class="adds" id="adds"></span>
    </div>
    <div class="codewrap"><div class="gutter" id="gutter">1</div><pre id="code"></pre></div>
  </div>
  <div class="controls">
    <button id="pp">⏸ Pause</button><button id="restart">↻ Restart</button>
    <span id="counter"></span>
  </div>
<script>
  const FILES = ${filesJson};
  const CPT = ${charsPerTick}, PAUSE = ${pauseBetweenMs};
  const codeEl = document.getElementById('code'), gutterEl = document.getElementById('gutter');
  const tabEl = document.getElementById('tab'), langEl = document.getElementById('lang');
  const addsEl = document.getElementById('adds'), counterEl = document.getElementById('counter');
  let fi = 0, ci = 0, playing = true, raf = 0, paused = false;
  if (!FILES.length) { codeEl.innerHTML = '<span class="empty">No code edits in this run.</span>'; }
  function esc(s){return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}
  function setHeader(){ const f = FILES[fi]; tabEl.textContent = f.path; langEl.textContent = f.language || '';
    addsEl.innerHTML = '+' + f.additions + (f.deletions ? ' <span class="dels">-' + f.deletions + '</span>' : '');
    counterEl.textContent = (fi+1) + ' / ' + FILES.length + ' files'; }
  function paint(){ const f = FILES[fi]; const shown = f.code.slice(0, ci);
    const lines = (shown.match(/\\n/g) || []).length + 1;
    gutterEl.textContent = Array.from({length: lines}, (_, k) => k+1).join('\\n');
    codeEl.innerHTML = esc(shown) + '<span class="cursor">&nbsp;</span>';
    const wrap = codeEl.parentElement; wrap.scrollTop = wrap.scrollHeight; }
  function tick(){ if (paused || !FILES.length) return;
    const f = FILES[fi];
    if (ci < f.code.length){ ci = Math.min(f.code.length, ci + CPT); paint(); raf = requestAnimationFrame(tick); }
    else if (fi < FILES.length - 1){ setTimeout(() => { fi++; ci = 0; setHeader(); paint(); raf = requestAnimationFrame(tick); }, PAUSE); }
    else { playing = false; document.getElementById('pp').textContent = '▶ Play'; } }
  document.getElementById('pp').onclick = () => { if (!playing){ playing = true; paused = false; tick(); } else { paused = !paused; if (!paused) tick(); } document.getElementById('pp').textContent = paused ? '▶ Play' : '⏸ Pause'; };
  document.getElementById('restart').onclick = () => { fi = 0; ci = 0; playing = true; paused = false; document.getElementById('pp').textContent = '⏸ Pause'; setHeader(); paint(); cancelAnimationFrame(raf); tick(); };
  if (FILES.length){ setHeader(); paint(); tick(); }
</script>
</body>
</html>
`
}
