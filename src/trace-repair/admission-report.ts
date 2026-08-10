/**
 * The published form of an admission run: a JSON artifact a later process can
 * check the campaign against, and the Markdown a reader can audit.
 *
 * A benchmark whose denominator is not auditable is not a benchmark, so both
 * carry the same numbers: every exclusion reason with its count, the funnel per
 * stratum, and the provenance of the three boundaries that decided it.
 */

import type { AdmissionConfig, AdmissionProvenance, AdmissionReport } from './admission'
import {
  ADMISSION_EXCLUSION_MEANING,
  ADMISSION_EXCLUSION_ORDER,
  ADMISSION_STRATA,
  type AdmissionExclusionReason,
  type AdmissionRowVerdict,
  type AdmissionStratum,
  assertChainReconciles,
  type DenominatorChain,
  type DenominatorChainArtifact,
} from './admission-records'

export interface AdmissionArtifact {
  version: 1
  kind: 'tb-repair-admission'
  generatedAt: string
  /** Hash over the admitted ids, the config, and the provenance. */
  digest: string
  config: AdmissionConfig
  provenance: AdmissionProvenance
  chain: DenominatorChainArtifact
  /** Admitted row ids per stratum, the only form the campaign may sample from. */
  admitted: Record<AdmissionStratum, readonly string[]>
  controlCost: { kind: string; usd: number | null }
  /** Every input row, admitted or not, with the stratum and reason it carried. */
  rows: readonly AdmissionRowVerdict[]
}

/** Plain JSON. `JSON.stringify` of this object is the machine-readable artifact. */
export function admissionArtifact(report: AdmissionReport): AdmissionArtifact {
  assertChainReconciles(report.chain)
  return {
    version: 1,
    kind: 'tb-repair-admission',
    generatedAt: report.generatedAt,
    digest: report.digest,
    config: report.config,
    provenance: report.provenance,
    chain: report.chain,
    admitted: {
      'clean-exit': report.strata['clean-exit'],
      'command-error': report.strata['command-error'],
      'signal-kill': report.strata['signal-kill'],
    },
    controlCost: { kind: report.controlCost.kind, usd: report.controlCost.usd },
    rows: report.rows,
  }
}

export interface RenderAdmissionOptions {
  /** Rows listed in the per-row appendix. Default 0, which omits the appendix. */
  rowLimit?: number
}

/** Markdown for the campaign report. Every number here is also in the artifact. */
export function renderAdmissionReport(
  artifact: AdmissionArtifact,
  options: RenderAdmissionOptions = {},
): string {
  const lines: string[] = []
  lines.push('# TB-Repair admission', '')
  lines.push(
    `${artifact.chain.overall.admitted} of ${artifact.chain.overall.input} rows admitted. Digest \`${artifact.digest}\`.`,
    '',
  )
  lines.push(...provenanceSection(artifact))
  lines.push(...chainSection(artifact.chain.overall, 'Denominator chain'))
  for (const chain of artifact.chain.byStratum) {
    lines.push(...chainSection(chain, `Denominator chain — ${chain.scope}`))
  }
  lines.push(...stratumSection(artifact))
  lines.push(...reasonSection(artifact.chain.reasonTotals))
  const rowLimit = options.rowLimit ?? 0
  if (rowLimit > 0) lines.push(...rowSection(artifact.rows, rowLimit))
  return `${lines.join('\n').trimEnd()}\n`
}

function provenanceSection(artifact: AdmissionArtifact): string[] {
  const { provenance, config, controlCost } = artifact
  const cost = controlCost.usd === null ? 'uncaptured' : `$${controlCost.usd.toFixed(4)}`
  return [
    '## Provenance',
    '',
    '| field | value |',
    '| --- | --- |',
    `| generated | ${artifact.generatedAt} |`,
    `| prefix replayer | \`${provenance.replayerId}\` |`,
    `| end-state oracle | \`${provenance.oracleId}\` |`,
    `| control runner | \`${provenance.controlRunnerId}\` |`,
    `| continuation policy | \`${provenance.policyId}\` |`,
    `| policy model | \`${provenance.policyModel}\` |`,
    `| policy seed | ${provenance.policySeed} |`,
    `| policy digest | \`${provenance.policyDigest}\` |`,
    `| policy step budget | ${provenance.policyStepBudget} model call(s) per control rollout |`,
    `| control screening | \`${provenance.controlScreening}\` |`,
    `| certified task oracles | ${formatCertifiedTasks(provenance.certifiedTasks)} |`,
    `| max prefix divergence | ${formatShare(config.maxPrefixDivergence)} |`,
    `| control rollouts per arm | ${config.controlRollouts} |`,
    `| inert action | \`${config.inertAction}\` |`,
    `| strata admitted | ${config.admitStrata.join(', ')} |`,
    `| control model cost | ${cost} (${controlCost.kind}) |`,
    '',
  ]
}

function formatCertifiedTasks(certified: Readonly<Record<string, number>>): string {
  const entries = Object.entries(certified).sort(([a], [b]) => a.localeCompare(b))
  if (entries.length === 0) return 'none'
  return entries.map(([task, flipRate]) => `${task} (flip ${formatShare(flipRate)})`).join(', ')
}

function chainSection(chain: DenominatorChain, heading: string): string[] {
  const lines = [
    `## ${heading}`,
    '',
    '| stage | exclusion reason | entering | excluded | remaining |',
    '| --- | --- | --- | --- | --- |',
  ]
  chain.stages.forEach((stage, index) => {
    lines.push(
      `| ${index + 1} | \`${stage.reason}\` | ${stage.entering} | ${stage.excluded} | ${stage.remaining} |`,
    )
  })
  const excluded = chain.input - chain.admitted
  lines.push(
    '',
    `Input ${chain.input} = admitted ${chain.admitted} + excluded ${excluded}. Admission rate ${formatShare(rate(chain.admitted, chain.input))}.`,
    '',
  )
  return lines
}

function stratumSection(artifact: AdmissionArtifact): string[] {
  const lines = [
    '## Strata',
    '',
    '| stratum | admitted rows | in this campaign |',
    '| --- | --- | --- |',
  ]
  for (const stratum of ADMISSION_STRATA) {
    const admitted = artifact.admitted[stratum].length
    const eligible = artifact.chain.admitStrata.includes(stratum) ? 'yes' : 'no'
    lines.push(`| ${stratum} | ${admitted} | ${eligible} |`)
  }
  lines.push(
    '',
    'Sample within a stratum. A command-level repair cannot address a signal kill, so pooling that population with the others averages an addressable class with an unaddressable one.',
    '',
  )
  return lines
}

function reasonSection(totals: Record<AdmissionExclusionReason, number>): string[] {
  const lines = ['## Exclusions', '', '| reason | rows | what it means |', '| --- | --- | --- |']
  for (const reason of ADMISSION_EXCLUSION_ORDER) {
    lines.push(`| \`${reason}\` | ${totals[reason]} | ${ADMISSION_EXCLUSION_MEANING[reason]} |`)
  }
  lines.push('')
  return lines
}

function rowSection(rows: readonly AdmissionRowVerdict[], limit: number): string[] {
  const lines = [
    '## Rows',
    '',
    '| row | task | stratum | final rc | admitted | excluded by |',
    '| --- | --- | --- | --- | --- | --- |',
  ]
  for (const row of rows.slice(0, limit)) {
    lines.push(
      `| \`${row.rowId}\` | ${row.taskName} | ${row.stratum ?? '—'} | ${row.finalReturncode ?? '—'} | ${row.admitted ? 'yes' : 'no'} | ${row.excludedBy === null ? '—' : `\`${row.excludedBy}\``} |`,
    )
  }
  if (rows.length > limit) lines.push('', `${rows.length - limit} further rows in the artifact.`)
  lines.push('')
  return lines
}

function rate(part: number, total: number): number {
  return total === 0 ? 0 : part / total
}

function formatShare(share: number): string {
  return `${(share * 100).toFixed(2)}%`
}
