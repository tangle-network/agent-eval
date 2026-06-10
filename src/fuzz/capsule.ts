/**
 * The capsule — the artifact every fuzz run produces.
 *
 * `buildCapsule` assembles the coverage map + verified failures + QD archive into
 * a pure `CapsuleData` (no clock, no I/O — deterministic and snapshot-testable).
 * `renderCapsuleHtml` turns it into a standalone page: a coverage heat-map + the
 * minimized failure exemplars. One artifact, three audiences — the customer sees
 * how hard we tested, the team sees where to harden, growth gets a shareable proof.
 */

import type { CellObservation } from '../rl/active-curriculum'
import type { AdversarialScenario } from '../rl/adversarial'
import { buildCoverage } from './cube'
import type { CapsuleData, CoverageCell, FuzzCell, VerifiedFailure } from './types'

export interface BuildCapsuleInput<S> {
  target: string
  cells: FuzzCell[]
  observations: CellObservation[]
  /** cellId → the hardest (lowest-scoring) scenario kept for that cell. */
  archive: Map<string, AdversarialScenario<S>>
  failures: VerifiedFailure<S>[]
  candidateFailures: number
  runsUsed: number
}

export function buildCapsule<S>(input: BuildCapsuleInput<S>): CapsuleData<S> {
  const coverage = buildCoverage(input.cells, input.observations)
  const covered = coverage.filter((c) => c.runs > 0)
  const meanRobustness =
    covered.length === 0 ? 0 : covered.reduce((a, c) => a + (c.robustness ?? 0), 0) / covered.length

  const cellById = new Map(input.cells.map((c) => [c.id, c]))
  const archive: CapsuleData<S>['archive'] = []
  for (const [cellId, scenario] of input.archive) {
    const cell = cellById.get(cellId)
    if (cell) archive.push({ cell, scenario })
  }

  const failures = [...input.failures].sort((a, b) => b.severity - a.severity)

  return {
    target: input.target,
    coverage,
    failures,
    archive,
    stats: {
      totalRuns: input.runsUsed,
      cellsTotal: input.cells.length,
      cellsCovered: covered.length,
      candidateFailures: input.candidateFailures,
      verifiedFailures: failures.length,
      meanRobustness,
    },
  }
}

// ── HTML capsule ────────────────────────────────────────────────────────────

function esc(s: string): string {
  return s.replace(
    /[&<>"]/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string,
  )
}

/** red (0) → amber (.5) → green (1); uncovered cells render gray. */
function robustnessColor(r: number | null): string {
  if (r == null) return '#2a2a2e'
  const hue = Math.round(r * 120) // 0 = red, 120 = green
  return `hsl(${hue} 70% 42%)`
}

function pct(x: number): string {
  return `${Math.round(x * 100)}%`
}

/** Derive the axis order + distinct values from the coverage cells' coords. */
function deriveAxes(coverage: CoverageCell[]): Array<{ name: string; values: string[] }> {
  const order: string[] = []
  const seen = new Map<string, Set<string>>()
  for (const c of coverage) {
    for (const [k, v] of Object.entries(c.cell.coords)) {
      if (!seen.has(k)) {
        seen.set(k, new Set())
        order.push(k)
      }
      seen.get(k)!.add(v)
    }
  }
  return order.map((name) => ({ name, values: [...(seen.get(name) ?? [])] }))
}

function heatmapHtml(coverage: CoverageCell[]): string {
  const axes = deriveAxes(coverage)
  const byId = new Map(coverage.map((c) => [c.cell.id, c]))
  const tile = (c: CoverageCell | undefined, label: string, sub: string): string => {
    const r = c?.robustness ?? null
    const title = c
      ? `${pct(r ?? 0)} robust · ${c.runs} runs · ${pct(c.failureRate)} fail`
      : 'not covered'
    return `<div class="tile" style="background:${robustnessColor(r ?? null)}" title="${esc(title)}"><span class="tl">${esc(label)}</span><span class="tv">${c && r != null ? pct(r) : '—'}</span><span class="ts">${esc(sub)}</span></div>`
  }

  // 2-axis → a real matrix; otherwise a flat grid sorted worst-first.
  const rowAxis = axes[0]
  const colAxis = axes[1]
  if (axes.length === 2 && rowAxis && colAxis) {
    const head =
      `<tr><th></th>` + colAxis.values.map((v) => `<th>${esc(v)}</th>`).join('') + `</tr>`
    const rows = rowAxis.values
      .map((rv) => {
        const cells = colAxis.values
          .map((cv) => {
            const id = `${rowAxis.name}=${rv}|${colAxis.name}=${cv}`
            const c = byId.get(id)
            return `<td>${tile(c, '', `${cv}`)}</td>`
          })
          .join('')
        return `<tr><th class="rh">${esc(rv)}</th>${cells}</tr>`
      })
      .join('')
    return `<div class="axis-label">rows: <b>${esc(rowAxis.name)}</b> · cols: <b>${esc(colAxis.name)}</b></div><table class="heat">${head}${rows}</table>`
  }

  const sorted = [...coverage].sort((a, b) => (a.robustness ?? 2) - (b.robustness ?? 2))
  const tiles = sorted
    .map((c) => {
      const label = Object.values(c.cell.coords).join(' · ')
      return tile(c, label, `${c.runs} runs`)
    })
    .join('')
  return `<div class="grid">${tiles}</div>`
}

function failuresHtml<S>(failures: VerifiedFailure<S>[], limit: number): string {
  if (failures.length === 0)
    return `<p class="none">No verified failures — the agent held across every covered cell.</p>`
  return failures
    .slice(0, limit)
    .map((f) => {
      const coords = Object.entries(f.cell.coords)
        .map(([k, v]) => `${k}:${v}`)
        .join(' · ')
      const bar = `<div class="sevbar"><div class="sevfill" style="width:${pct(f.severity)}"></div></div>`
      return `<div class="fail"><div class="fmeta"><span class="fcell">${esc(coords)}</span>${f.failureClass ? `<span class="fclass">${esc(f.failureClass)}</span>` : ''}<span class="fsev">sev ${pct(f.severity)}</span></div>${bar}<div class="ftext">${esc(f.text ?? '(scenario text not captured)')}</div></div>`
    })
    .join('')
}

export interface RenderCapsuleOptions {
  /** Max failure exemplars to show. Default 8. */
  maxFailures?: number
  /** ISO timestamp to stamp into the page (keeps the pure capsule clock-free). */
  generatedAt?: string
}

/** Render a self-contained HTML capsule — the coverage heat-map + verified failures. */
export function renderCapsuleHtml<S>(
  capsule: CapsuleData<S>,
  opts: RenderCapsuleOptions = {},
): string {
  const s = capsule.stats
  const kpi = (label: string, value: string, accent = '#e6e6e6'): string =>
    `<div class="kpi"><div class="kv" style="color:${accent}">${esc(value)}</div><div class="kl">${esc(label)}</div></div>`
  const lift = capsule.lift
    ? kpi(
        'hardening lift',
        `${capsule.lift.before.toFixed(2)} → ${capsule.lift.after.toFixed(2)}`,
        '#5ad17a',
      )
    : ''
  const stamp = opts.generatedAt ?? capsule.generatedAt ?? ''

  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Fuzz capsule — ${esc(capsule.target)}</title>
<style>
:root{color-scheme:dark}
*{box-sizing:border-box}
body{margin:0;background:#0c0c0f;color:#e6e6e6;font:14px/1.5 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
.wrap{max-width:980px;margin:0 auto;padding:40px 24px}
h1{font-size:22px;margin:0 0 2px;letter-spacing:-.01em}
.sub{color:#8a8a93;font-size:13px;margin-bottom:28px}
.kpis{display:flex;gap:14px;flex-wrap:wrap;margin-bottom:32px}
.kpi{background:#16161b;border:1px solid #24242b;border-radius:12px;padding:14px 18px;min-width:120px}
.kv{font-size:24px;font-weight:650;letter-spacing:-.02em}
.kl{color:#8a8a93;font-size:12px;margin-top:2px}
h2{font-size:13px;text-transform:uppercase;letter-spacing:.08em;color:#8a8a93;margin:34px 0 14px}
.axis-label{color:#8a8a93;font-size:12px;margin-bottom:10px}
table.heat{border-collapse:separate;border-spacing:6px}
table.heat th{font-weight:500;color:#a8a8b0;font-size:12px;padding:4px 8px;text-align:center}
table.heat th.rh{text-align:right}
.tile{position:relative;width:96px;height:62px;border-radius:10px;display:flex;flex-direction:column;justify-content:center;align-items:center;color:#06120a;font-weight:600}
.tile .tv{font-size:18px}
.tile .ts{font-size:10px;opacity:.8;font-weight:500}
.grid{display:flex;flex-wrap:wrap;gap:8px}
.grid .tile{width:132px;height:70px}
.grid .tl{font-size:10px;font-weight:600;opacity:.9;padding:0 6px;text-align:center}
.fail{background:#16161b;border:1px solid #24242b;border-left:3px solid #d1495b;border-radius:10px;padding:12px 14px;margin-bottom:10px}
.fmeta{display:flex;gap:10px;align-items:center;font-size:12px;color:#a8a8b0;margin-bottom:8px}
.fcell{color:#cfcfd6}
.fclass{background:#2a1a1d;color:#e58a96;padding:1px 8px;border-radius:999px;font-size:11px}
.fsev{margin-left:auto;color:#e58a96}
.sevbar{height:4px;background:#24242b;border-radius:2px;overflow:hidden;margin-bottom:10px}
.sevfill{height:100%;background:#d1495b}
.ftext{font-size:13px;color:#d8d8df;white-space:pre-wrap}
.none{color:#5ad17a}
.foot{color:#5a5a63;font-size:11px;margin-top:36px}
</style></head><body><div class="wrap">
<h1>Adversarial fuzz · ${esc(capsule.target)}</h1>
<div class="sub">${s.totalRuns} scenarios across ${s.cellsCovered}/${s.cellsTotal} cells of the behavior hypercube${stamp ? ` · ${esc(stamp)}` : ''}</div>
<div class="kpis">
${kpi('mean robustness', pct(s.meanRobustness), s.meanRobustness < 0.6 ? '#e58a96' : '#5ad17a')}
${kpi('verified failures', String(s.verifiedFailures), s.verifiedFailures > 0 ? '#e58a96' : '#5ad17a')}
${kpi('cells covered', `${s.cellsCovered}/${s.cellsTotal}`)}
${kpi('scenarios run', String(s.totalRuns))}
${lift}
</div>
<h2>Coverage map</h2>
${heatmapHtml(capsule.coverage)}
<h2>Verified failures${s.candidateFailures > s.verifiedFailures ? ` · ${s.verifiedFailures} of ${s.candidateFailures} candidates passed the validity gates` : ''}</h2>
${failuresHtml(capsule.failures, opts.maxFailures ?? 8)}
<div class="foot">Failures shown are gate-verified: each is a fair, answerable task that reproduces under a meaning-preserving rephrase. Minimized to the smallest trigger.</div>
</div></body></html>`
}
