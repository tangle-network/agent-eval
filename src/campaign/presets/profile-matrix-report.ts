/**
 * The profile-matrix decision page: one self-contained HTML string (inline
 * SVG and CSS, no network, light and dark) rendered from
 * `analyzeProfileMatrix`, so the page shows exactly the numbers a caller reads.
 */

import { escapeHtml as esc } from '../../reporting-html'
import {
  analyzeProfileMatrix,
  type ProfileMatrixAnalysis,
  type ProfileMatrixAxisSummary,
  type ProfileMatrixCostAxis,
  type ProfileMatrixInterval,
  type ProfileMatrixProfileStats,
  type ProfileMatrixReportOptions,
} from './profile-matrix-analysis'
import type { ProfileMatrixRaceResult } from './race-profile-matrix'

/** Render the decision page for a profile matrix or a race over one. */
export function renderProfileMatrixReport(options: ProfileMatrixReportOptions): string {
  const a = analyzeProfileMatrix(options)
  const race = options.race
  const sections = [
    section('Frontier', frontier(a)),
    section('Profiles', profileTable(a)),
    section('Factor main effects', factorTable(a)),
    section('Slices', sliceHeatmap(a)),
    section('Error overlap', overlap(a)),
    section('Item difficulty', difficulty(a)),
    section('Calibration', calibration(a)),
    section('Power', `<p>${powerSentence(a)}</p>`),
    ...(race ? [section('Race', raceSection(race))] : []),
  ]
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${esc(a.title)}</title>`,
    `<meta name="description" content="${esc(description(a))}">`,
    `<style>${STYLE}</style>`,
    '</head>',
    '<body><main>',
    `<h1>${esc(a.title)}</h1>`,
    `<div class="decision">${decision(a, race)}</div>`,
    ...sections,
    '</main></body></html>',
  ].join('\n')
}

const STYLE = `
:root{color-scheme:light;--surface:#fcfcfb;--panel:#ffffff;--border:#e4e3de;--grid:#ecebe7;
--text:#0b0b0b;--text-2:#52514e;--text-3:#7a7974;--accent:#2a78d6;--base:#eb6834;--better:#2a78d6;
--worse:#e34948;--flat:#9b9a95;--seq:#1c5cab;--seq-2:#eb6834;--on-seq:#ffffff;--thin:#efeeea}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){color-scheme:dark;--surface:#1a1a19;
--panel:#222221;--border:#383835;--grid:#2c2c2a;--text:#f0efec;--text-2:#c3c2b7;--text-3:#8f8e86;
--accent:#3987e5;--base:#d95926;--better:#3987e5;--worse:#e66767;--flat:#77766f;--seq:#6da7ec;
--seq-2:#d95926;--on-seq:#0b0b0b;--thin:#2a2a28}}
:root[data-theme="dark"]{color-scheme:dark;--surface:#1a1a19;--panel:#222221;--border:#383835;
--grid:#2c2c2a;--text:#f0efec;--text-2:#c3c2b7;--text-3:#8f8e86;--accent:#3987e5;--base:#d95926;
--better:#3987e5;--worse:#e66767;--flat:#77766f;--seq:#6da7ec;--seq-2:#d95926;--on-seq:#0b0b0b;--thin:#2a2a28}
*{box-sizing:border-box}
body{margin:0;background:var(--surface);color:var(--text);
font:15px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:1120px;margin:0 auto;padding:32px 16px 64px}
h1{font-size:28px;line-height:1.2;margin:0 0 16px}
h2{font-size:19px;margin:40px 0 8px;padding-top:20px;border-top:1px solid var(--border)}
p{margin:8px 0}.muted{color:var(--text-3)}.note{color:var(--text-2);font-size:13px}
.decision{background:var(--panel);border:1px solid var(--border);border-radius:8px;padding:12px 16px}
.decision p{margin:6px 0}
.scroll{overflow-x:auto;margin:12px 0}
table{border-collapse:collapse;font-size:13px;font-variant-numeric:tabular-nums}
th,td{padding:6px 8px;border-bottom:1px solid var(--border);text-align:right;white-space:nowrap}
th{color:var(--text-2);font-weight:600}th:first-child,td:first-child{text-align:left}
td .sub{display:block;color:var(--text-3);font-size:11px}
td.cell{text-align:center;min-width:64px}td.cell .sub{color:inherit;opacity:.75}
td.tight{min-width:40px;padding:6px 3px}td.thin{background:var(--thin);color:var(--text-3)}
td.diag{color:var(--text-3)}
.charts{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,460px),1fr));gap:16px}
figure{margin:12px 0;background:var(--panel);border:1px solid var(--border);border-radius:8px;padding:8px}
figcaption{font-size:12px;color:var(--text-2);padding:4px 6px}
svg{display:block;width:100%;height:auto}svg text{fill:var(--text-2);font-size:11px}
svg .title{fill:var(--text);font-size:12px;font-weight:600}
.grid{stroke:var(--grid);stroke-width:1}.zero{stroke:var(--text-3);stroke-width:1}
.whisker{stroke:var(--flat);stroke-width:1.5;stroke-opacity:.45}.step{fill:none;stroke:var(--accent);stroke-width:2;stroke-dasharray:4 3}
.pt{fill:var(--flat);stroke:var(--panel);stroke-width:2}.pt.front{fill:var(--accent)}
.ring{fill:none;stroke:var(--base);stroke-width:2}.pt:hover{stroke:var(--text)}
.forest{width:120px;height:16px;display:inline-block;vertical-align:middle}
.ci{stroke-width:2}.ci.up,.up{stroke:var(--better);fill:var(--better)}
.ci.down,.down{stroke:var(--worse);fill:var(--worse)}.ci.flat,.flat{stroke:var(--flat);fill:var(--flat)}
.bar{fill:var(--accent)}.bar.single{fill-opacity:.3}.bar:hover{fill:var(--text-2)}.diagonal{stroke:var(--text-3);stroke-dasharray:3 3}
.cal{fill:none;stroke:var(--accent);stroke-width:2}.calpt{fill:var(--accent);stroke:var(--panel);stroke-width:2}
.callout{border-left:3px solid var(--base);padding:6px 12px;background:var(--panel)}
.small-multiples{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:12px}
`

function section(title: string, body: string): string {
  return `<section><h2>${esc(title)}</h2>\n${body}\n</section>`
}

function num(value: number | null | undefined, digits = 3): string {
  return value === null || value === undefined || !Number.isFinite(value)
    ? '—'
    : value.toFixed(digits)
}

function signed(value: number | null | undefined, digits = 3): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—'
  return `${value > 0 ? '+' : value < 0 ? '-' : '±'}${Math.abs(value).toFixed(digits)}`
}

function pct(value: number | null | undefined): string {
  return value === null || value === undefined ? '—' : `${Math.round(value * 100)}%`
}

function bounds(i: { low: number | null; high: number | null }, f = signed): string {
  return i.low === null || i.high === null ? 'no interval' : `[${f(i.low)}, ${f(i.high)}]`
}

function grouped(value: number): string {
  return Math.round(value)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

function cost(axis: ProfileMatrixCostAxis, value: number | null): string {
  if (value === null) return '—'
  if (axis === 'usd') return `$${value < 0.1 ? value.toFixed(4) : value.toFixed(2)}`
  if (axis === 'tokens') return grouped(value)
  return `${value < 10 ? value.toFixed(1) : grouped(value)} s`
}

/** Whether an interval lies wholly above zero, wholly below it, or crosses it. */
function direction(i: { low: number | null; high: number | null }): 'up' | 'down' | 'flat' {
  if (i.low !== null && i.low > 0) return 'up'
  if (i.high !== null && i.high < 0) return 'down'
  return 'flat'
}

const DIRECTION_WORD = { up: 'better', down: 'worse', flat: 'unresolved' } as const

const P_NOTE =
  'Better and worse follow the interval. p is the exact sign-flip test over clusters, which ' +
  'stays high when few clusters disagree even if the interval excludes zero: read both.'

function shared(a: ProfileMatrixAnalysis): string {
  return `${a.sharedCases.length} shared case${a.sharedCases.length === 1 ? '' : 's'}`
}

function description(a: ProfileMatrixAnalysis): string {
  const counts = { up: 0, down: 0, flat: 0 }
  for (const p of a.profiles) if (p.vsBaseline) counts[direction(p.vsBaseline)] += 1
  return (
    `${a.profiles.length} profiles on ${shared(a)} against ${a.baseline}: ` +
    `${counts.up} better, ${counts.down} worse, ${counts.flat} unresolved at ${pct(a.level)}.`
  )
}

function decision(a: ProfileMatrixAnalysis, race: ProfileMatrixRaceResult | undefined): string {
  const base = a.profiles[0]!
  const lines = [
    `${a.profiles.length} profiles compared on ${shared(a)} in ${a.sharedClusters} independent ` +
      `cluster${a.sharedClusters === 1 ? '' : 's'}, every profile scored on each. Baseline ` +
      `<strong>${esc(a.baseline)}</strong> scores ${num(base.quality?.estimate)} ` +
      `${base.quality ? bounds(base.quality, num) : ''}.`,
  ]
  const by = (d: 'up' | 'down') =>
    a.profiles.filter((p) => p.vsBaseline && direction(p.vsBaseline) === d)
  const list = (ps: ProfileMatrixProfileStats[]) =>
    ps.map((p) => `${esc(p.profileId)} (${signed(p.vsBaseline!.estimate)})`).join(', ')
  const better = by('up')
  const worse = by('down')
  const unresolved = a.profiles.length - 1 - better.length - worse.length
  lines.push(
    `Better than the baseline at ${pct(a.level)}: ${better.length ? list(better) : 'none'}. ` +
      `Worse: ${worse.length ? list(worse) : 'none'}. Unresolved: ${unresolved}.`,
  )
  for (const axis of a.axes.filter((x) => x.drawn)) {
    lines.push(`Pareto set on ${AXIS_NAME[axis.axis]}: ${axis.frontier.map(esc).join(', ')}.`)
  }
  const top = Math.max(...a.profiles.map((p) => p.quality?.estimate ?? 0))
  const leaders = a.profiles.filter((p) => p.quality?.estimate === top)
  if (a.oracle !== null && leaders.length > 0) {
    const named =
      leaders.length === 1
        ? esc(leaders[0]!.profileId)
        : `${esc(leaders[0]!.profileId)} and ${leaders.length - 1} tied`
    lines.push(
      `Choosing the right profile per case would score ${num(a.oracle)}; the best single profile ` +
        `(${named}) scores ${num(top)}.`,
    )
  }
  if (typeof a.power?.detectable === 'number') {
    lines.push(
      `Differences below about ${num(a.power.detectable, 2)} are beyond what this n resolves.`,
    )
  }
  if (race) {
    lines.push(
      `Raced: ${race.cellsRun} of ${race.plannedCells} planned cells run; leader ` +
        `<strong>${esc(race.leader)}</strong>. ${esc(race.selectionBias)}`,
    )
  }
  return lines.map((line) => `<p>${line}</p>`).join('\n')
}

const AXIS_NAME: Record<ProfileMatrixCostAxis, string> = {
  usd: 'dollars',
  tokens: 'tokens',
  seconds: 'latency',
}

const AXIS_TITLE: Record<ProfileMatrixCostAxis, string> = {
  usd: 'Dollars per case',
  tokens: 'Tokens per case',
  seconds: 'Median seconds per case',
}

function ticks(min: number, max: number, count = 5): number[] {
  const span = max - min
  const raw = span / count
  const power = 10 ** Math.floor(Math.log10(raw))
  const step = [1, 2, 2.5, 5, 10].map((m) => m * power).find((s) => span / s <= count)!
  const out: number[] = []
  for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-9; v += step) {
    out.push(Number(v.toFixed(10)))
  }
  return out
}

function extent(values: readonly number[], clamp?: readonly [number, number]): [number, number] {
  let low = Math.min(...values)
  let high = Math.max(...values)
  if (low === high) {
    low -= Math.abs(low) * 0.1 || 0.5
    high += Math.abs(high) * 0.1 || 0.5
  }
  const pad = (high - low) * 0.08
  low -= pad
  high += pad
  return clamp ? [Math.max(clamp[0], low), Math.min(clamp[1], high)] : [low, high]
}

function tickLabel(axis: ProfileMatrixCostAxis | 'quality', value: number): string {
  const short = (v: number) => Number(v.toPrecision(3)).toString()
  if (axis === 'tokens' && Math.abs(value) >= 1000) return `${short(value / 1000)}k`
  if (axis === 'usd') return `$${short(value)}`
  return short(value)
}

function frontier(a: ProfileMatrixAnalysis): string {
  const drawn = a.axes.filter((axis) => axis.drawn)
  const skipped = a.axes
    .filter((axis) => !axis.drawn)
    .map(
      (axis) => `<p class="note">${esc(AXIS_TITLE[axis.axis])} not drawn: ${esc(axis.note)}.</p>`,
    )
  return [
    `<p class="note">Quality on the ${shared(a)} against each cost; whiskers are ${pct(a.level)} intervals. ` +
      'Filled blue points form the Pareto set (no other profile is both better and cheaper), joined ' +
      'by the dashed staircase; the orange ring marks the baseline.</p>',
    `<div class="charts">${drawn.map((axis) => scatter(a, axis)).join('')}</div>`,
    ...skipped,
  ].join('\n')
}

function scatter(a: ProfileMatrixAnalysis, axis: ProfileMatrixAxisSummary): string {
  const [W, H, L, R, T, B] = [560, 330, 52, 16, 14, 46]
  const xOf = (p: ProfileMatrixProfileStats) =>
    axis.axis === 'seconds' ? p.latency!.p50 : p.costPerCase[axis.axis]!
  const points = a.profiles.map((p) => ({ p, x: xOf(p), q: p.quality! }))
  const ys = points.flatMap(({ q }) => [q.estimate, q.low ?? q.estimate, q.high ?? q.estimate])
  const [x0, x1] = extent(points.map((pt) => pt.x))
  const [y0, y1] = extent(ys, ys.every((y) => y >= 0 && y <= 1) ? [0, 1] : undefined)
  const sx = (v: number) => L + ((v - x0) / (x1 - x0)) * (W - L - R)
  const sy = (v: number) => H - B - ((v - y0) / (y1 - y0)) * (H - T - B)
  const parts: string[] = []
  for (const t of ticks(y0, y1)) {
    parts.push(`<line class="grid" x1="${L}" x2="${W - R}" y1="${sy(t)}" y2="${sy(t)}"/>`)
    parts.push(
      `<text x="${L - 6}" y="${sy(t) + 4}" text-anchor="end">${tickLabel('quality', t)}</text>`,
    )
  }
  for (const t of ticks(x0, x1)) {
    parts.push(
      `<text x="${sx(t)}" y="${H - B + 16}" text-anchor="middle">${tickLabel(axis.axis, t)}</text>`,
    )
  }
  const front = axis.frontier.map((id) => points.find((pt) => pt.p.profileId === id)!)
  if (front.length > 1) {
    const path = front
      .map((pt, i) =>
        i === 0 ? `M${sx(pt.x)} ${sy(pt.q.estimate)}` : `H${sx(pt.x)} V${sy(pt.q.estimate)}`,
      )
      .join(' ')
    parts.push(`<path class="step" d="${path}"/>`)
  }
  for (const { x, q } of points) {
    if (q.low === null || q.high === null) continue
    const cx = sx(x)
    parts.push(`<line class="whisker" x1="${cx}" x2="${cx}" y1="${sy(q.low)}" y2="${sy(q.high)}"/>`)
  }
  // Every point is an obstacle, so a label never covers a mark.
  const placed: LabelBox[] = points.map(({ x, q }) => {
    const [cx, cy] = [sx(x), sy(q.estimate)]
    return [cx - 6, cx + 6, cy - 6, cy + 6]
  })
  for (const { p, x, q } of points) {
    const onFront = axis.frontier.includes(p.profileId)
    const [cx, cy] = [sx(x), sy(q.estimate)]
    const tip = `${p.profileId}: quality ${num(q.estimate)} ${bounds(q, num)}, ${cost(axis.axis, x)}`
    parts.push(
      `<circle class="pt${onFront ? ' front' : ''}" cx="${cx}" cy="${cy}" r="5.5">` +
        `<title>${esc(tip)}</title></circle>`,
    )
    if (p.profileId === a.baseline) parts.push(`<circle class="ring" cx="${cx}" cy="${cy}" r="9"/>`)
    if (onFront || p.profileId === a.baseline) {
      const at = placeLabel(cx, cy, p.profileId, placed, [L, W - R, T, H - B])
      parts.push(
        `<text x="${at.x}" y="${at.y}" text-anchor="${at.anchor}">${esc(p.profileId)}</text>`,
      )
    }
  }
  parts.push(
    `<text class="title" x="${(L + W - R) / 2}" y="${H - 8}" text-anchor="middle">${AXIS_TITLE[axis.axis]}</text>`,
  )
  parts.push(
    `<text class="title" transform="translate(14 ${(T + H - B) / 2}) rotate(-90)" text-anchor="middle">Quality</text>`,
  )
  const label = `Quality against ${AXIS_NAME[axis.axis]} for ${points.length} profiles`
  return (
    `<figure><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(label)}">${parts.join('')}</svg>` +
    `<figcaption>${esc(AXIS_TITLE[axis.axis])}: ${esc(axis.note)}.</figcaption></figure>`
  )
}

type LabelBox = readonly [x0: number, x1: number, y0: number, y1: number]

/**
 * Place a point label beside its point where it overlaps no label already placed and stays
 * inside the plot, trying right then left at widening vertical offsets. Width is estimated
 * from the 11px label font.
 */
function placeLabel(
  cx: number,
  cy: number,
  text: string,
  placed: LabelBox[],
  [left, right, top, bottom]: readonly [number, number, number, number],
): { x: number; y: number; anchor: 'start' | 'end' } {
  const width = text.length * 6.2
  const candidates = [-8, 16, -22, 30, -36, 44, -50].flatMap((dy) =>
    (['start', 'end'] as const).map((anchor) => {
      const x = anchor === 'start' ? cx + 11 : cx - 11
      const box: LabelBox = [
        anchor === 'start' ? x : x - width,
        anchor === 'start' ? x + width : x,
        cy + dy - 10,
        cy + dy + 2,
      ]
      return { x, y: cy + dy, anchor, box }
    }),
  )
  const inside = ({ box }: (typeof candidates)[number]) =>
    box[0] >= left && box[1] <= right && box[2] >= top && box[3] <= bottom
  const free = ({ box }: (typeof candidates)[number]) =>
    placed.every((o) => box[1] <= o[0] || box[0] >= o[1] || box[3] <= o[2] || box[2] >= o[3])
  const at =
    candidates.find((c) => inside(c) && free(c)) ?? candidates.find(inside) ?? candidates[0]!
  placed.push(at.box)
  return at
}

function forest(i: ProfileMatrixInterval | null | undefined, span: number): string {
  if (!i) return ''
  const W = 120
  const sx = (v: number) => Math.max(1, Math.min(W - 1, ((v + span) / (2 * span)) * W))
  const d = direction(i)
  const ci =
    i.low !== null && i.high !== null
      ? `<line class="ci ${d}" x1="${sx(i.low)}" x2="${sx(i.high)}" y1="8" y2="8"/>`
      : ''
  return (
    `<svg class="forest" viewBox="0 0 ${W} 16" aria-hidden="true">` +
    `<line class="zero" x1="${W / 2}" x2="${W / 2}" y1="1" y2="15"/>${ci}` +
    `<circle class="${d}" cx="${sx(i.estimate)}" cy="8" r="4"/></svg>`
  )
}

function forestSpan(intervals: readonly (ProfileMatrixInterval | null | undefined)[]): number {
  const values = intervals.flatMap((i) => (i ? [i.estimate, i.low ?? 0, i.high ?? 0] : []))
  return Math.max(0.05, ...values.map(Math.abs)) * 1.05
}

function profileTable(a: ProfileMatrixAnalysis): string {
  const usd = a.axes.some((axis) => axis.axis === 'usd' && axis.drawn)
  const span = forestSpan(a.profiles.map((p) => p.vsBaseline))
  const head = [
    'Profile',
    'Scored',
    'Failed',
    `Quality [${pct(a.level)}]`,
    'Δ vs baseline',
    '',
    'To resolve',
    'Tokens / correct',
    ...(usd ? ['$ / correct'] : []),
    'Seconds p50 · p90',
  ]
  const rows = a.profiles.map((p) => {
    const levels = Object.values(p.factors).join(' · ')
    const named = Object.entries(p.factors)
      .map(([k, v]) => `${k}=${v}`)
      .join(', ')
    const vs = p.vsBaseline
    const cells = [
      `${esc(p.profileId)}${p.profileId === a.baseline ? ' <span class="muted">(baseline)</span>' : ''}` +
        (levels ? `<span class="sub" title="${esc(named)}">${esc(levels)}</span>` : ''),
      `${p.casesScored} / ${p.casesAttempted}`,
      pct(p.failureRate),
      p.quality
        ? `${num(p.quality.estimate)} <span class="sub">${bounds(p.quality, num)}</span>`
        : '—',
      vs
        ? `${signed(vs.estimate)} ${DIRECTION_WORD[direction(vs)]}<span class="sub">${bounds(vs)}, p ${num(vs.pValue)}</span>`
        : '—',
      forest(vs, span),
      vs ? (vs.casesToResolve === null ? '—' : grouped(vs.casesToResolve)) : '—',
      cost('tokens', p.costPerCorrect.tokens),
      ...(usd ? [cost('usd', p.costPerCorrect.usd)] : []),
      `${num(p.latency?.p50, 1)} · ${num(p.latency?.p90, 1)}`,
    ]
    return `<tr>${cells.map((c) => `<td>${c}</td>`).join('')}</tr>`
  })
  return [
    `<p class="note">Scored counts each profile’s cases with a score out of those it attempted; ` +
      `failed is the rest. Every other number is measured on the ${shared(a)}. ` +
      `A case counts as correct at a score of ${a.passScore} or more. Δ is the paired mean difference ` +
      'from the baseline with its clustered interval; to resolve is the number of paired cases a ' +
      'two-sided test needs for 80% power at the observed difference and discordance (unclustered). ' +
      `Seconds are dispatch time where the cell recorded it. ${P_NOTE}</p>`,
    table(head, rows),
  ].join('\n')
}

function table(head: readonly string[], rows: readonly string[]): string {
  return (
    `<div class="scroll"><table><thead><tr>${head.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead>` +
    `<tbody>${rows.join('\n')}</tbody></table></div>`
  )
}

function factorTable(a: ProfileMatrixAnalysis): string {
  if (a.factorEffects.length === 0) return '<p class="note">No factor levels were given.</p>'
  const span = forestSpan(a.factorEffects.map((e) => e.effect))
  const rows = a.factorEffects.map((e) =>
    [
      `<tr><td>${esc(e.factor)}</td>`,
      `<td>${esc(e.level)} <span class="muted">vs ${esc(e.reference)}</span></td>`,
      `<td>${e.matchedPairs}</td>`,
      e.effect
        ? `<td>${signed(e.effect.estimate)} ${DIRECTION_WORD[direction(e.effect)]}<span class="sub">${bounds(e.effect)}, p ${num(e.pValue)}</span></td>`
        : '<td class="muted">confounded: no profile pair differs only here</td>',
      `<td>${forest(e.effect, span)}</td></tr>`,
    ].join(''),
  )
  return [
    `<p class="note">The effect of moving one factor from the reference level, all else equal: the mean, ` +
      `over profile pairs that differ only in that factor, of their paired difference on the ${shared(a)}, ` +
      `with a clustered ${pct(a.level)} interval. ${P_NOTE}</p>`,
    table(['Factor', 'Level', 'Matched pairs', 'Effect', ''], rows),
  ].join('\n')
}

function shade(value: number | null, variable: '--seq' | '--seq-2'): string {
  if (value === null) return ''
  const share = Math.round(Math.max(0, Math.min(1, value)) * 85)
  const ink = share > 50 ? 'color:var(--on-seq);' : ''
  return ` style="${ink}background:color-mix(in oklab,var(${variable}) ${share}%,var(--panel))"`
}

function sliceHeatmap(a: ProfileMatrixAnalysis): string {
  if (a.slices.length === 0) return '<p class="note">No slices were given.</p>'
  const rows = a.profiles.map((p) => {
    const cells = a.slices.map((slice) => {
      const cell = a.sliceCells.find((c) => c.profileId === p.profileId && c.slice === slice)!
      const tip = `${p.profileId} on ${slice}: ${num(cell.quality)} over ${cell.n} cases`
      if (cell.n === 0) return `<td class="cell thin" title="${esc(tip)}"></td>`
      if (cell.n < 5) {
        return `<td class="cell thin" title="${esc(tip)}">${num(cell.quality, 2)}<span class="sub">n ${cell.n}</span></td>`
      }
      return `<td class="cell"${shade(cell.quality, '--seq')} title="${esc(tip)}">${num(cell.quality, 2)}<span class="sub">n ${cell.n}</span></td>`
    })
    return `<tr><td>${esc(p.profileId)}</td>${cells.join('')}</tr>`
  })
  return [
    '<p class="note">Mean score on each profile’s own scored cases in each slice, the largest slice ' +
      'first. Cells with fewer than five cases are greyed: too few to read. Profiles that ran ' +
      'different cases are not comparable here; the paired numbers above are.</p>',
    table(['Profile', ...a.slices], rows),
  ].join('\n')
}

function overlap(a: ProfileMatrixAnalysis): string {
  if (a.sharedCases.length === 0) return '<p class="note">No case was scored by every profile.</p>'
  const ids = a.profiles.map((p) => p.profileId)
  const pair = (x: string, y: string) =>
    a.errorOverlap.find((o) => (o.a === x && o.b === y) || (o.a === y && o.b === x))!
  const rows = ids.map((row, i) => {
    const cells = ids.map((col, j) => {
      if (i === j) {
        const wrong = 1 - (a.profiles[i]!.quality?.estimate ?? 0)
        return `<td class="cell tight diag" title="${esc(row)} error rate">${pct(wrong)}</td>`
      }
      const o = pair(row, col)
      const [value, variable, what] =
        j > i
          ? [o.bothWrong, '--seq-2' as const, 'both wrong']
          : [o.disagree, '--seq' as const, 'disagree']
      return `<td class="cell tight"${shade(value, variable)} title="${esc(`${row} and ${col}: ${what} ${pct(value)}`)}">${pct(value)}</td>`
    })
    return `<tr><td>${i + 1}. ${esc(row)}</td>${cells.join('')}</tr>`
  })
  const best = Math.max(...a.profiles.map((p) => p.quality?.estimate ?? 0))
  return [
    `<p class="note">On the ${shared(a)}, profiles numbered as in the rows. Above the diagonal (orange): share both profiles got wrong. ` +
      'Below it (blue): share exactly one got right. The diagonal is each profile’s error rate. Profiles ' +
      'that disagree often and rarely fail together are candidates to route between.</p>',
    table(['', ...ids.map((_, i) => `${i + 1}`)], rows),
    `<p>Oracle ceiling: ${num(a.oracle)} (a case counts when any profile got it right), against ${num(best)} for the best single profile.</p>`,
  ].join('\n')
}

function difficulty(a: ProfileMatrixAnalysis): string {
  const items = a.difficulty
  if (items.length === 0) return '<p class="note">No case was scored.</p>'
  const [H, L, T, B] = [160, 36, 8, 22]
  const barW = Math.max(2, Math.min(14, Math.floor(860 / items.length)))
  const W = L + items.length * barW + 8
  const sy = (v: number) => H - B - v * (H - T - B)
  const parts = [0, 0.5, 1].map(
    (t) =>
      `<line class="grid" x1="${L}" x2="${W - 8}" y1="${sy(t)}" y2="${sy(t)}"/>` +
      `<text x="${L - 6}" y="${sy(t) + 4}" text-anchor="end">${t}</text>`,
  )
  items.forEach((item, i) => {
    const tip = `${item.caseId}${item.slice ? ` (${item.slice})` : ''}: ${item.solved} of ${item.scored} profiles right`
    const h = Math.max(1, item.share * (H - T - B))
    const y = sy(item.share) - (item.share === 0 ? 1 : 0)
    const kind = item.scored < 2 ? 'bar single' : 'bar'
    parts.push(
      `<rect class="${kind}" x="${L + i * barW + 1}" y="${y}" width="${barW - 2}" height="${h}" rx="1">` +
        `<title>${esc(tip)}</title></rect>`,
    )
  })
  parts.push(
    `<text x="${L}" y="${H - 6}">hardest</text><text x="${W - 8}" y="${H - 6}" text-anchor="end">easiest</text>`,
  )
  const multi = items.filter((item) => item.scored >= 2)
  const none = multi.filter((item) => item.solved === 0)
  const all = multi.filter((item) => item.solved === item.scored)
  const listed = none.slice(0, 24).map((item) => esc(item.caseId))
  const more = none.length > listed.length ? ` and ${none.length - listed.length} more` : ''
  const single = items.length - multi.length
  return [
    '<p class="note">Each bar is one case: the share of the profiles that scored it which got it right, ' +
      `hardest first. ${single ? 'Faint bars are cases only one profile scored.' : ''}</p>`,
    `<figure><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Share of profiles right per case">${parts.join('')}</svg></figure>`,
    `<p>Of the ${multi.length} cases two or more profiles scored, ${none.length} no profile got right` +
      `${none.length ? ` (${listed.join(', ')}${more})` : ''} and ${all.length} every profile got right. ` +
      `${single ? `${single} more were scored by one profile only. ` : ''}` +
      'Cases nobody solves are worth reading for label errors before they are read as hard.</p>',
  ].join('\n')
}

function calibration(a: ProfileMatrixAnalysis): string {
  if (a.calibration.length === 0) {
    return '<p class="note">No profile returned a probability (pass <code>probabilityOf</code> to read one).</p>'
  }
  const S = 200
  const pad = 26
  const sc = (v: number) => pad + v * (S - 2 * pad)
  const plots = a.calibration.map((c) => {
    const maxN = Math.max(...c.bins.map((b) => b.n))
    const pts = c.bins.map((b) => ({ x: sc(b.evalMean), y: S - sc(b.outcomeMean), b }))
    const line = pts.map((p, i) => `${i ? 'L' : 'M'}${p.x} ${p.y}`).join(' ')
    const dots = pts
      .map(
        (p) =>
          `<circle class="calpt" cx="${p.x}" cy="${p.y}" r="${3 + 4 * Math.sqrt(p.b.n / maxN)}">` +
          `<title>${esc(`forecast ${num(p.b.evalMean, 2)}, right ${num(p.b.outcomeMean, 2)}, n ${p.b.n}`)}</title></circle>`,
      )
      .join('')
    return (
      `<figure><svg viewBox="0 0 ${S} ${S}" role="img" aria-label="${esc(`Calibration of ${c.profileId}`)}">` +
      `<line class="grid" x1="${pad}" x2="${S - pad}" y1="${S - pad}" y2="${S - pad}"/>` +
      `<line class="diagonal" x1="${sc(0)}" y1="${S - sc(0)}" x2="${sc(1)}" y2="${S - sc(1)}"/>` +
      `<path class="cal" d="${line}"/>${dots}` +
      `<text x="${pad}" y="${S - 8}">forecast</text><text x="4" y="${pad - 8}">right</text></svg>` +
      `<figcaption>${esc(c.profileId)}: n ${c.n}, ECE ${num(c.ece)}, Brier ${num(c.brier)}</figcaption></figure>`
    )
  })
  return [
    '<p class="note">Forecast probability of being right against the share actually right, in ten bins; ' +
      'the dashed diagonal is perfect calibration and dot area follows the bin count.</p>',
    `<div class="small-multiples">${plots.join('')}</div>`,
  ].join('\n')
}

function powerSentence(a: ProfileMatrixAnalysis): string {
  const p = a.power
  if (!p)
    return 'Power is not computed: it needs at least two shared cases and one profile besides the baseline.'
  const base =
    `With ${p.n} shared cases in ${p.clusters} independent cluster${p.clusters === 1 ? '' : 's'} and a ` +
    `median discordance of ${pct(p.discordance)} against the baseline, `
  const finding =
    p.detectable === null
      ? 'no paired difference up to 1.0 reaches 80% power at this n.'
      : `the smallest paired difference this design detects with 80% power is about ${num(p.detectable, 2)} ` +
        `(whole-cluster bootstrap, ${pct(a.level)} interval); a smaller difference in the table is not resolvable here.`
  const floor = p.certifiable
    ? ''
    : ` With ${p.clusters} clusters an exact sign-flip test cannot reach the ${pct(1 - a.level)} level at any effect; it needs at least ${p.minClusters}.`
  return base + finding + floor
}

function raceSection(race: ProfileMatrixRaceResult): string {
  const reason = {
    'one-left': 'one profile was left',
    'cell-budget': 'the next batch would have passed the cell budget',
    'batches-ended': 'the batch list ended',
  }[race.stoppedBecause]
  const saved = race.plannedCells ? 1 - race.cellsRun / race.plannedCells : 0
  const log = race.log.flatMap((batch) =>
    batch.standings.map(
      (s) =>
        `<tr><td>${batch.batch}</td><td>${batch.casesSeen}</td><td>${esc(batch.leader)}</td>` +
        `<td>${esc(s.profileId)}</td><td>${s.n}</td><td>${signed(s.difference)}</td>` +
        `<td>${bounds(s)}</td><td>${s.dropped ? '<strong>dropped</strong>' : 'kept'}` +
        `${s.reason ? `<span class="sub">${esc(s.reason)}</span>` : ''}</td></tr>`,
    ),
  )
  const final = race.final.rows.map(
    (row) =>
      `<tr><td>${esc(row.profileId)}${row.profileId === race.leader ? ' <span class="muted">(leader)</span>' : ''}</td>` +
      `<td>${num(row.quality)}</td><td>${row.vsBaseline ? signed(row.vsBaseline.difference) : '—'}</td>` +
      `<td>${row.vsBaseline ? bounds(row.vsBaseline) : '—'}</td></tr>`,
  )
  return [
    `<p>Stopped because ${reason}, after ${race.casesRaced.length} cases: ${race.cellsRun} of ` +
      `${race.plannedCells} planned cells run (${pct(saved)} not spent). Survivors: ${race.survivors.map(esc).join(', ')}.</p>`,
    '<h3>Elimination log</h3>',
    table(
      [
        'Batch',
        'Cases seen',
        'Leader',
        'Profile',
        'Paired n',
        'Δ vs leader',
        'Interval',
        'Decision',
      ],
      log,
    ),
    `<h3>Final comparison on ${race.final.cases} cases every survivor scored</h3>`,
    table(['Profile', 'Quality', 'Δ vs baseline', 'Interval'], final),
    `<p class="callout">${esc(race.selectionBias)}</p>`,
  ].join('\n')
}
