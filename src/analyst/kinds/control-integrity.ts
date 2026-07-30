import {
  analyzeSupervisorRunIntegrity,
  type SupervisorRunIntegrityEvidence,
} from '../../supervisor-run/integrity'
import type { SupervisorRunSources, SupervisorRunTree } from '../../supervisor-run/types'
import type { ExactCapableAnalyst } from '../exact-types'
import { type AnalystContext, type AnalystFinding, type EvidenceRef, makeFinding } from '../types'

const ANALYST_ID = 'control-integrity'

function shown(value: unknown): string {
  if (value === undefined) return '<absent>'
  const encoded = JSON.stringify(value)
  return encoded === undefined ? String(value) : encoded
}

function evidenceRef(namespace: string, value: SupervisorRunIntegrityEvidence): EvidenceRef {
  return {
    kind: 'metric',
    uri: `supervisor-run://${encodeURIComponent(namespace)}/${value.path}`,
    excerpt: shown(value.value),
  }
}

/** Translate typed supervisor-run integrity issues into the shared analyst envelope. */
export function emitControlIntegrityFindings(
  input: SupervisorRunSources | SupervisorRunTree,
  producedAt: string,
): AnalystFinding[] {
  const report = analyzeSupervisorRunIntegrity(input, { capturedAt: producedAt })
  return report.issues.map((issue) =>
    makeFinding({
      analyst_id: ANALYST_ID,
      produced_at: producedAt,
      area: issue.area,
      severity: issue.severity,
      subject: `${report.runRef}/${issue.subject}`,
      claim: issue.claim,
      rationale: issue.detail,
      evidence_refs: issue.evidence.map((value) => evidenceRef(report.runRef, value)),
      recommended_action: issue.recommendedAction,
      validation_plan:
        'Re-run this deterministic analyst on the retained SupervisorRunSources or SupervisorRunTree after correcting the producer.',
      confidence: 1,
      metadata: {
        integrity_code: issue.code,
        integrity_input: report.input,
        integrity_run_ref: report.runRef,
        integrity_subject: issue.subject,
        ...issue.metadata,
      },
    }),
  )
}

/** Deterministic Analyst adapter for `SupervisorRunSources | SupervisorRunTree`. */
export class ControlIntegrityAnalyst
  implements ExactCapableAnalyst<SupervisorRunSources | SupervisorRunTree>
{
  readonly id = ANALYST_ID
  readonly description =
    'Deterministic supervisor-run integrity checks with explicit unavailable evidence.'
  readonly inputKind = 'custom' as const
  readonly cost = { kind: 'deterministic' as const, est_usd_per_run: 0 }
  readonly version = '2.0.0'
  readonly executionConfig = {
    kind: 'control-integrity',
    produced_at_source: 'tags.producedAt-or-system-clock',
  } as const

  async analyze(
    input: SupervisorRunSources | SupervisorRunTree,
    ctx: AnalystContext,
  ): Promise<AnalystFinding[]> {
    const producedAt = ctx.tags?.producedAt ?? new Date().toISOString()
    const findings = emitControlIntegrityFindings(input, producedAt)
    ctx.log?.(`control-integrity: ${findings.length} finding(s)`, {
      input: 'nodes' in input ? 'SupervisorRunTree' : 'SupervisorRunSources',
    })
    return findings
  }
}

export const CONTROL_INTEGRITY_ANALYST = new ControlIntegrityAnalyst()
