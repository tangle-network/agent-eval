/**
 * The capsule — the artifact every exploration produces.
 *
 * `buildCapsule` assembles coverage + verified findings + the QD archive into a
 * pure `CapsuleData` (no clock, no I/O — deterministic and snapshot-testable).
 * `renderCapsuleHtml` turns it into a standalone page: the input-cell heat-map
 * (planned vs covered), per-dimension weakness chips, and the minimized finding
 * exemplars. One artifact — the hardening map and the shareable proof object.
 */

import type { EvalRecord } from './cube'
import { buildCoverage } from './cube'
import type { ArchiveEntry, CapsuleData, Cell, CoverageCell, Finding } from './types'

export interface BuildCapsuleInput<S> {
  target: string
  objective: string
  cells: Cell[]
  log: EvalRecord[]
  /** The objective's notable threshold — drives findingRate. */
  threshold: number
  archive: ArchiveEntry<S>[]
  findings: Finding<S>[]
  candidateFindings: number
  runsUsed: number
}

export function buildCapsule<S>(input: BuildCapsuleInput<S>): CapsuleData<S> {
  const coverage = buildCoverage(input.cells, input.log, input.threshold)
  const covered = coverage.filter((c) => c.runs > 0)
  const meanRobustness =
    covered.length === 0 ? 0 : covered.reduce((a, c) => a + (c.robustness ?? 0), 0) / covered.length
  // Measured-descriptor bins beyond the bare input cell — observed, never planned.
  const behaviorBinsObserved = input.archive.filter((e) => e.binId !== e.cell.id).length

  return {
    target: input.target,
    objective: input.objective,
    coverage,
    findings: [...input.findings].sort((a, b) => b.interest - a.interest),
    archive: [...input.archive].sort((a, b) => b.interest - a.interest),
    stats: {
      totalRuns: input.runsUsed,
      cellsTotal: input.cells.length,
      cellsCovered: covered.length,
      behaviorBinsObserved,
      candidateFindings: input.candidateFindings,
      verifiedFindings: input.findings.length,
      meanRobustness,
    },
  }
}

// ── HTML capsule ──────────────────────────────────────────────────────────────

function esc(s: string): string {
  return s.replace(
    /[&<>"]/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string,
  )
}

/** red (0) → amber (.5) → green (1); uncovered cells render gray. */
function robustnessColor(r: number | null): string {
  if (r == null) return '#2a2a2e'
  return `hsl(${Math.round(r * 120)} 70% 42%)`
}

function pct(x: number): string {
  return `${Math.round(x * 100)}%`
}

function deriveAxes(coverage: CoverageCell[]): Array<{ name: string; values: string[] }> {
  const order: string[] = []
  const seen = new Map<string, Set<string>>()
  for (const c of coverage) {
    for (const [k, v] of Object.entries(c.cell.coords)) {
      if (!seen.has(k)) {
        seen.set(k, new Set())
        order.push(k)
      }
      seen.get(k)?.add(v)
    }
  }
  return order.map((name) => ({ name, values: [...(seen.get(name) ?? [])] }))
}

/** The weakest dimension chip for a cell, e.g. `safety 32%` — shown when scores exist. */
function weakestDim(c: CoverageCell): string {
  const entries = Object.entries(c.dimensions)
  if (entries.length === 0) return ''
  const sorted = entries.sort((a, b) => a[1] - b[1])
  const w = sorted[0]
  if (!w) return ''
  return `<span class="dim">${esc(w[0])} ${pct(w[1])}</span>`
}

function heatmapHtml(coverage: CoverageCell[]): string {
  const axes = deriveAxes(coverage)
  const byId = new Map(coverage.map((c) => [c.cell.id, c]))
  const tile = (c: CoverageCell | undefined, label: string): string => {
    const r = c?.robustness ?? null
    const title = c
      ? `${pct(r ?? 0)} robust · ${c.runs} runs · ${pct(c.findingRate)} flagged`
      : 'not covered'
    return `<div class="tile" style="background:${robustnessColor(r)}" title="${esc(title)}">${label ? `<span class="tl">${esc(label)}</span>` : ''}<span class="tv">${c && r != null ? pct(r) : '—'}</span>${c ? weakestDim(c) : ''}</div>`
  }

  const rowAxis = axes[0]
  const colAxis = axes[1]
  if (axes.length === 2 && rowAxis && colAxis) {
    const head = `<tr><th></th>${colAxis.values.map((v) => `<th>${esc(v)}</th>`).join('')}</tr>`
    const rows = rowAxis.values
      .map((rv) => {
        const cells = colAxis.values
          .map((cv) => {
            const id = `${rowAxis.name}=${rv}|${colAxis.name}=${cv}`
            return `<td>${tile(byId.get(id), '')}</td>`
          })
          .join('')
        return `<tr><th class="rh">${esc(rv)}</th>${cells}</tr>`
      })
      .join('')
    return `<div class="axis-label">rows: <b>${esc(rowAxis.name)}</b> · cols: <b>${esc(colAxis.name)}</b></div><table class="heat">${head}${rows}</table>`
  }

  const sorted = [...coverage].sort((a, b) => (a.robustness ?? 2) - (b.robustness ?? 2))
  return `<div class="grid">${sorted.map((c) => tile(c, Object.values(c.cell.coords).join(' · '))).join('')}</div>`
}

function findingsHtml<S>(findings: Finding<S>[], limit: number): string {
  if (findings.length === 0)
    return `<p class="none">No verified findings — the target held across every covered cell.</p>`
  return findings
    .slice(0, limit)
    .map((f) => {
      const coords = Object.entries(f.cell.coords)
        .map(([k, v]) => `${k}:${v}`)
        .join(' · ')
      const labels = (f.evaluation.labels ?? [])
        .map((l) => `<span class="fclass">${esc(l)}</span>`)
        .join('')
      const dims = Object.entries(f.evaluation.scores ?? {})
        .sort((a, b) => a[1] - b[1])
        .slice(0, 3)
        .map(([k, v]) => `<span class="dim">${esc(k)} ${pct(v)}</span>`)
        .join('')
      return `<div class="fail"><div class="fmeta"><span class="fcell">${esc(coords)}</span>${labels}<span class="fsev">interest ${pct(f.interest)}</span></div><div class="sevbar"><div class="sevfill" style="width:${pct(f.interest)}"></div></div><div class="ftext">${esc(f.text ?? '(scenario text not captured)')}</div>${dims ? `<div class="fdims">${dims}</div>` : ''}</div>`
    })
    .join('')
}

export interface RenderCapsuleOptions {
  /** Max finding exemplars to show. Default 8. */
  maxFindings?: number
  /** ISO timestamp to stamp into the page (keeps the pure capsule clock-free). */
  generatedAt?: string
}

/** Render a self-contained HTML capsule — heat-map + per-dimension chips + verified findings. */
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
<title>${esc(capsule.objective)} capsule — ${esc(capsule.target)}</title>
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
.tile{position:relative;width:104px;height:66px;border-radius:10px;display:flex;flex-direction:column;justify-content:center;align-items:center;gap:1px;color:#06120a;font-weight:600}
.tile .tv{font-size:17px}
.tile .tl{font-size:10px;font-weight:600;opacity:.9;padding:0 6px;text-align:center}
.tile .dim{font-size:9px;font-weight:600;opacity:.85;background:rgba(0,0,0,.22);padding:0 6px;border-radius:999px}
.grid{display:flex;flex-wrap:wrap;gap:8px}
.grid .tile{width:138px;height:74px}
.fail{background:#16161b;border:1px solid #24242b;border-left:3px solid #d1495b;border-radius:10px;padding:12px 14px;margin-bottom:10px}
.fmeta{display:flex;gap:10px;align-items:center;font-size:12px;color:#a8a8b0;margin-bottom:8px}
.fcell{color:#cfcfd6}
.fclass{background:#2a1a1d;color:#e58a96;padding:1px 8px;border-radius:999px;font-size:11px}
.fsev{margin-left:auto;color:#e58a96}
.sevbar{height:4px;background:#24242b;border-radius:2px;overflow:hidden;margin-bottom:10px}
.sevfill{height:100%;background:#d1495b}
.ftext{font-size:13px;color:#d8d8df;white-space:pre-wrap}
.fdims{display:flex;gap:6px;margin-top:8px}
.fdims .dim{background:#1d2530;color:#9fc1e8;padding:1px 8px;border-radius:999px;font-size:11px}
.none{color:#5ad17a}
.foot{color:#5a5a63;font-size:11px;margin-top:36px}
</style></head><body><div class="wrap">
<h1>${esc(capsule.objective)} exploration · ${esc(capsule.target)}</h1>
<div class="sub">${s.totalRuns} scenarios across ${s.cellsCovered}/${s.cellsTotal} planned cells${s.behaviorBinsObserved > 0 ? ` · ${s.behaviorBinsObserved} measured behavior bins` : ''}${stamp ? ` · ${esc(stamp)}` : ''}</div>
<div class="kpis">
${kpi('mean robustness', pct(s.meanRobustness), s.meanRobustness < 0.6 ? '#e58a96' : '#5ad17a')}
${kpi('verified findings', String(s.verifiedFindings), s.verifiedFindings > 0 ? '#e58a96' : '#5ad17a')}
${kpi('cells covered', `${s.cellsCovered}/${s.cellsTotal}`)}
${kpi('scenarios run', String(s.totalRuns))}
${lift}
</div>
<h2>Coverage map</h2>
${heatmapHtml(capsule.coverage)}
<h2>Verified findings${s.candidateFindings > s.verifiedFindings ? ` · ${s.verifiedFindings} of ${s.candidateFindings} candidates passed the validity gates` : ''}</h2>
${findingsHtml(capsule.findings, opts.maxFindings ?? 8)}
<div class="foot">Findings are gate-verified: each is a fair, answerable task that reproduces under a meaning-preserving rephrase, minimized to the smallest trigger.</div>
</div></body></html>`
}
