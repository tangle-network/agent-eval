/** The registry as a short table: one row per procedure version. */

import type { MeasureTotal, ProcedureRegistry, ProcedureVersion } from './registry'

function percent(share: number | null): string {
  return share === null ? 'n/a' : `${(share * 100).toFixed(1)}%`
}

/** A measure's sum, with how many executions did not report it. */
function measure(total: MeasureTotal, digits = 0): string {
  if (total.measured === 0) return total.unmeasured === 0 ? '-' : 'unknown'
  const text = total.sum.toFixed(digits)
  return total.unmeasured === 0 ? text : `${text}+${total.unmeasured}?`
}

function digest(version: ProcedureVersion): string {
  return version.digest === null ? '(no version)' : version.digest.slice(7, 19)
}

function decided(version: ProcedureVersion): string {
  const latest = version.decisions.filter((decision) => decision.current)
  return latest.length === 0 ? '-' : [...new Set(latest.map((d) => d.status))].join(',')
}

export function renderProcedureRegistryTable(registry: ProcedureRegistry, limit = 30): string {
  const join = registry.changeJoin
  const lines = [
    `${registry.versions.length} procedure versions; ${registry.invocations} invocations in ${registry.sessions.read} sessions (${registry.sessions.unreadable} unreadable); ${registry.searches.read} searches`,
    `joined to a change: ${join.joined} of ${join.invocations} invocations (${percent(join.joinedShare)}); none ${join.none}, not recorded ${join.notRecorded}`,
    `with an outcome for a change: ${join.withOutcome} (${percent(join.withOutcomeShare)}); ${join.distinctChanges} distinct changes, ${join.outcomesSupplied} outcomes supplied (hot-fix window ${join.hotfixWindowDays} days)`,
    `cells on a subscription seat (a known basis with no dollar figure): ${registry.versions.reduce((n, v) => n + v.cells.subscription, 0)}`,
    '',
    'version       kind        names                          cells  runs  chg-joined  merged y/n/?  hotfix y/n/?  tokens(runs)  decided',
  ]
  for (const version of registry.versions.slice(0, limit)) {
    const changes = version.sessions.changes
    const counts = (c: { yes: number; no: number; unknown: number }): string =>
      `${c.yes}/${c.no}/${c.unknown}`
    lines.push(
      [
        digest(version).padEnd(13),
        (version.kind ?? 'unclassified').padEnd(11),
        version.names.join(',').slice(0, 30).padEnd(30),
        String(version.cells.count).padStart(5),
        String(version.sessions.invocations).padStart(5),
        String(changes.joined).padStart(10),
        counts(changes.merged).padStart(13),
        counts(changes.hotfixed).padStart(13),
        measure(version.sessions.tokens).padStart(13),
        decided(version),
      ].join('  '),
    )
  }
  if (registry.versions.length > limit) {
    lines.push(`... ${registry.versions.length - limit} more versions in the JSON`)
  }
  const intents = registry.intents
  if (intents !== null) {
    const summary = intents.summary
    lines.push(
      '',
      `${summary.intents} intents in ${summary.sessionsWithTurns} sessions (${summary.sessionsWithoutTurns} record no typed turns); ${summary.labeled} labeled; known end ${summary.knownEnd} (${percent(summary.knownEndShare)})`,
      'kind          intents  known-end  share   corrections-known  joined-to-change  with-outcome',
    )
    for (const row of summary.byKind) {
      if (row.intents === 0) continue
      lines.push(
        [
          (row.kind ?? 'unlabeled').padEnd(12),
          String(row.intents).padStart(8),
          String(row.knownEnd).padStart(10),
          percent(row.knownEndShare).padStart(7),
          String(row.knownCorrections).padStart(18),
          String(row.joinedToChange).padStart(17),
          String(row.withChangeOutcome).padStart(13),
        ].join('  '),
      )
    }
    for (const note of intents.notes) lines.push('', `note: ${note}`)
  }
  for (const note of registry.notes) lines.push('', `note: ${note}`)
  return `${lines.join('\n')}\n`
}
