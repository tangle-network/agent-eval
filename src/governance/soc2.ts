/**
 * SOC 2 — Common Criteria 7 (system operations + change management)
 * audit trail derived from the trace corpus.
 *
 * This is NOT a formal SOC2 report — that requires an external
 * auditor. What we ship is the machine-readable *evidence* package
 * that an auditor consumes: run counts, deploy events, access log
 * summary, anomaly tracking, response-time SLOs.
 */

import type { GovernanceContext, GovernanceFinding, GovernanceReport } from './types'
import { summarize } from './types'

export async function soc2Report(ctx: GovernanceContext): Promise<GovernanceReport> {
  const findings: GovernanceFinding[] = []
  const start = Date.parse(ctx.periodStart)
  const end = Date.parse(ctx.periodEnd)
  const runs = await ctx.traceStore.listRuns({ since: start, until: end })

  // CC7.1 — "Monitoring to detect anomalies"
  const failureRate = runs.length > 0
    ? runs.filter((r) => r.outcome?.pass === false).length / runs.length
    : null
  if (failureRate !== null && failureRate > 0.2) {
    findings.push({
      id: 'CC7.1-fail-rate',
      severity: 'medium',
      control: 'SOC2:CC7.1',
      summary: `System failure rate ${(failureRate * 100).toFixed(1)}% over the period exceeds 20%.`,
      remediation: 'Investigate failure clusters (failureClusterView) + prioritize remediation.',
    })
  }
  if (runs.length === 0) {
    findings.push({
      id: 'CC7.1-coverage',
      severity: 'high',
      control: 'SOC2:CC7.1',
      summary: 'No telemetry runs recorded for the period — monitoring regime is incomplete.',
    })
  }

  // CC7.2 — "Anomaly investigation"
  const aborted = runs.filter((r) => r.status === 'aborted')
  if (aborted.length > runs.length * 0.05 && aborted.length >= 3) {
    findings.push({
      id: 'CC7.2-abort',
      severity: 'medium',
      control: 'SOC2:CC7.2',
      summary: `${aborted.length} run(s) aborted — investigate pattern.`,
      remediation: 'Use the bisector + failureClusterView to localize the trigger.',
    })
  }

  // CC7.3 — "Response to incidents" — require an event tag for resolved incidents
  const incidentEvents = await ctx.traceStore.events({ kind: 'policy_violation', since: start, until: end })
  const errorEvents = await ctx.traceStore.events({ kind: 'error', since: start, until: end })
  const totalIncidents = incidentEvents.length + errorEvents.length
  if (totalIncidents > 0) {
    // No formal resolution tracking yet — flag medium by default
    findings.push({
      id: 'CC7.3-resolution',
      severity: 'low',
      control: 'SOC2:CC7.3',
      summary: `${totalIncidents} incident-class event(s) recorded; resolution tracking is informal.`,
      remediation: 'Emit a resolution event (kind="log" with payload.resolves=<eventId>) per remediated incident.',
    })
  }

  // CC7.4 — "Configuration change tracking"
  const modelFingerprints = new Set(runs.map((r) => r.modelFingerprint).filter(Boolean) as string[])
  const promptHashes = new Set(runs.map((r) => r.promptSha).filter(Boolean) as string[])
  const codeSha = new Set(runs.map((r) => r.codeSha).filter(Boolean) as string[])
  if (codeSha.size === 0) {
    findings.push({
      id: 'CC7.4-code',
      severity: 'high',
      control: 'SOC2:CC7.4',
      summary: 'No codeSha recorded on runs — cannot attribute scores to a specific release.',
      remediation: 'Populate Run.codeSha with the git SHA of the system at run time.',
    })
  }
  if (promptHashes.size === 0) {
    findings.push({
      id: 'CC7.4-prompt',
      severity: 'medium',
      control: 'SOC2:CC7.4',
      summary: 'No promptSha recorded — prompt changes are untracked.',
    })
  }

  const payload = {
    controls: ['CC7.1', 'CC7.2', 'CC7.3', 'CC7.4'],
    runCount: runs.length,
    failureRate,
    abortedCount: aborted.length,
    incidentEventCount: totalIncidents,
    distinctReleases: {
      codeShas: codeSha.size,
      promptHashes: promptHashes.size,
      modelFingerprints: modelFingerprints.size,
    },
  }

  return {
    framework: 'SOC2',
    version: '2017-Common-Criteria',
    context: {
      organization: ctx.organization,
      systemName: ctx.systemName,
      periodStart: ctx.periodStart,
      periodEnd: ctx.periodEnd,
      owner: ctx.owner,
    },
    summary: summarize(findings),
    findings,
    payload,
    generatedAt: new Date().toISOString(),
  }
}
