import type { BenchmarkReport, DriverResult } from './types'

/**
 * Report generation utilities.
 *
 * Outputs convergence curves, cost curves, quality curves,
 * and per-persona summaries in markdown format.
 */

/** Generate a markdown report from benchmark results */
export function formatBenchmarkReport(report: BenchmarkReport): string {
  const lines: string[] = []

  lines.push(`# Benchmark Report`)
  lines.push(``)
  lines.push(`**Date:** ${report.timestamp}`)
  lines.push(`**Generation:** ${report.generation}`)
  lines.push(`**Prompt Version:** ${report.promptVersion}`)
  lines.push(`**Scenarios:** ${report.scenarioCount}`)
  lines.push(`**Overall Score:** ${report.summary.overallAvg.toFixed(1)}/10`)
  lines.push(``)

  // By persona
  lines.push(`## By Persona`)
  lines.push(``)
  lines.push(`| Persona | Avg | Passed | Total |`)
  lines.push(`|---------|-----|--------|-------|`)
  for (const [name, data] of Object.entries(report.summary.byPersona)) {
    lines.push(`| ${name} | ${data.avg.toFixed(1)} | ${data.passed} | ${data.total} |`)
  }
  lines.push(``)

  // By dimension
  lines.push(`## By Dimension`)
  lines.push(``)
  lines.push(`| Dimension | Avg | Range | N |`)
  lines.push(`|-----------|-----|-------|---|`)
  const dimEntries = Object.entries(report.summary.byDimension)
    .sort((a, b) => a[1].avg - b[1].avg)
  for (const [name, data] of dimEntries) {
    const min = Math.min(...data.scores)
    const max = Math.max(...data.scores)
    lines.push(`| ${name} | ${data.avg.toFixed(1)} | ${min}-${max} | ${data.scores.length} |`)
  }
  lines.push(``)

  // Weakest
  if (report.summary.weakest.length > 0) {
    lines.push(`## Weakest Scenarios`)
    lines.push(``)
    for (const w of report.summary.weakest) {
      lines.push(`- **${w.scenario}** (${w.score.toFixed(1)}): ${w.reason}`)
    }
    lines.push(``)
  }

  // Strongest
  if (report.summary.strongest.length > 0) {
    lines.push(`## Strongest Scenarios`)
    lines.push(``)
    for (const s of report.summary.strongest) {
      lines.push(`- **${s.scenario}** (${s.score.toFixed(1)}): ${s.reason}`)
    }
    lines.push(``)
  }

  return lines.join('\n')
}

/** Generate a markdown report from agent driver results */
export function formatDriverReport(results: DriverResult[]): string {
  const lines: string[] = []

  lines.push(`# Agent Driver Report`)
  lines.push(``)

  for (const r of results) {
    lines.push(`## Persona: ${r.personaId}`)
    lines.push(``)
    lines.push(`- **Completed:** ${r.completed ? 'Yes' : 'No'}`)
    lines.push(`- **Turns to completion:** ${r.turnsToCompletion ?? 'N/A'}`)
    lines.push(`- **Total turns:** ${r.totalTurns}`)
    lines.push(`- **Final state:** ${r.finalState.tasks} tasks, ${r.finalState.events} events, ${r.finalState.vaultFiles.length} vault files`)
    lines.push(``)

    // Convergence curve (ASCII)
    lines.push(`### Convergence`)
    lines.push(``)
    lines.push('```')
    for (let i = 0; i < r.convergenceCurve.length; i++) {
      const pct = r.convergenceCurve[i]
      const bar = '#'.repeat(Math.round(pct / 2))
      lines.push(`  turn ${String(i + 1).padStart(2)}: ${bar} ${pct.toFixed(0)}%`)
    }
    lines.push('```')
    lines.push(``)

    // Per-turn metrics table
    if (r.metrics.length > 0) {
      lines.push(`### Per-Turn Metrics`)
      lines.push(``)
      lines.push(`| Turn | Tasks | Events | Vault | Latency | Completion |`)
      lines.push(`|------|-------|--------|-------|---------|------------|`)
      for (const m of r.metrics) {
        lines.push(`| ${m.turn} | ${m.tasks} | ${m.events} | ${m.vaultFiles} | ${(m.responseLatencyMs / 1000).toFixed(1)}s | ${m.completionPercent.toFixed(0)}% |`)
      }
      lines.push(``)
    }
  }

  return lines.join('\n')
}

/** Print a compact summary to console */
export function printDriverSummary(results: DriverResult[]): void {
  console.log('='.repeat(70))
  console.log(' AGENT DRIVER — RESULTS')
  console.log('='.repeat(70))

  for (const r of results) {
    const status = r.completed ? 'COMPLETE' : 'INCOMPLETE'
    const turns = r.turnsToCompletion ?? r.totalTurns
    console.log(`  ${r.personaId.padEnd(20)} ${status.padEnd(12)} turns=${turns}  tasks=${r.finalState.tasks}  events=${r.finalState.events}  vault=${r.finalState.vaultFiles.length}`)
  }

  console.log()
  const completedCount = results.filter(r => r.completed).length
  console.log(`${completedCount}/${results.length} personas completed`)
}
