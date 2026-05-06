/**
 * NIST AI RMF 1.0 — Govern / Map / Measure / Manage mapping.
 *
 * Each subcategory derives its status from concrete framework state:
 *   MEASURE 2.x: do we have a calibration regime? contamination controls?
 *   MEASURE 2.7: are red-team results available?
 *   MANAGE 1.x: are outcome metrics captured? correlation measured?
 *   GOVERN 1.x: dataset + prompt provenance recorded?
 *
 * We ship the mapping and the derivation rules; consumers supply the
 * GovernanceContext.
 */

import type { GovernanceContext, GovernanceFinding, GovernanceReport } from './types'
import { summarize } from './types'

export async function nistAiRmfReport(ctx: GovernanceContext): Promise<GovernanceReport> {
  const findings: GovernanceFinding[] = []

  // GOVERN 1.1 — "Accountable individual identified"
  if (!ctx.owner?.email) {
    findings.push({
      id: 'G-1.1',
      severity: 'high',
      control: 'NIST-AI-RMF:GOVERN-1.1',
      summary: 'No responsible owner recorded for the AI system.',
      remediation: 'Assign an accountable individual + email in GovernanceContext.owner.',
    })
  }

  // GOVERN 1.3 — "Inventory + lifecycle tracking"
  if (ctx.datasets.length === 0) {
    findings.push({
      id: 'G-1.3',
      severity: 'high',
      control: 'NIST-AI-RMF:GOVERN-1.3',
      summary: 'No versioned datasets recorded for the evaluation period.',
      remediation: 'Register each dataset with a Dataset manifest (content hash + provenance).',
    })
  } else {
    // Validate content hashes are stable
    for (const manifest of ctx.datasets) {
      if (!manifest.contentHash || manifest.contentHash.length < 16) {
        findings.push({
          id: 'G-1.3-hash',
          severity: 'medium',
          control: 'NIST-AI-RMF:GOVERN-1.3',
          summary: `Dataset "${manifest.name}" has weak or missing content hash.`,
          evidence: `contentHash="${manifest.contentHash}"`,
          remediation: 'Call dataset.manifest() to compute SHA-256; commit the manifest alongside releases.',
        })
      }
    }
  }

  // MEASURE 2.6 — "Safety + adversarial testing"
  if (!ctx.redTeam) {
    findings.push({
      id: 'M-2.6',
      severity: 'high',
      control: 'NIST-AI-RMF:MEASURE-2.6',
      summary: 'No red-team evaluation attached to the report period.',
      remediation: 'Run redTeamDataset() against the system and attach the RedTeamReport to context.redTeam.',
    })
  } else if (ctx.redTeam.overallPassRate < 0.8) {
    findings.push({
      id: 'M-2.6-rate',
      severity: 'high',
      control: 'NIST-AI-RMF:MEASURE-2.6',
      summary: `Red-team pass rate ${(ctx.redTeam.overallPassRate * 100).toFixed(1)}% below 80% threshold.`,
      evidence: JSON.stringify(ctx.redTeam.passRateByCategory),
      remediation: 'Harden the failing categories; rerun the battery.',
    })
  }

  // MEASURE 2.1 — "Test results against defined metrics"
  const runs = await ctx.traceStore.listRuns({ since: Date.parse(ctx.periodStart), until: Date.parse(ctx.periodEnd) })
  if (runs.length === 0) {
    findings.push({
      id: 'M-2.1',
      severity: 'critical',
      control: 'NIST-AI-RMF:MEASURE-2.1',
      summary: 'No eval runs recorded for the reporting period.',
      remediation: 'Emit traces for every deployment-relevant evaluation.',
    })
  }

  // MEASURE 2.11 — "Calibration + validation regime"
  if (!ctx.judgeCalibration || ctx.judgeCalibration.length === 0) {
    findings.push({
      id: 'M-2.11',
      severity: 'medium',
      control: 'NIST-AI-RMF:MEASURE-2.11',
      summary: 'No judge-vs-human calibration recorded.',
      remediation: 'Build a human golden set; run calibrateJudge() before trusting LLM judge scores.',
    })
  } else {
    const weak = ctx.judgeCalibration.filter((c) => Number.isFinite(c.pearson) && c.pearson < 0.6)
    if (weak.length > 0) {
      findings.push({
        id: 'M-2.11-weak',
        severity: 'medium',
        control: 'NIST-AI-RMF:MEASURE-2.11',
        summary: `${weak.length} judge(s) show weak agreement with humans (Pearson < 0.6).`,
        remediation: 'Retrain or replace the underperforming judges.',
      })
    }
  }

  // MANAGE 1.1 — "Outcomes tracked post-deployment"
  if (!ctx.outcomeStore) {
    findings.push({
      id: 'MN-1.1',
      severity: 'medium',
      control: 'NIST-AI-RMF:MANAGE-1.1',
      summary: 'No deployment outcomes captured — meta-eval correlation cannot be computed.',
      remediation: 'Attach an OutcomeStore and ingest production outcome metrics.',
    })
  } else {
    const outcomes = await ctx.outcomeStore.list({ since: Date.parse(ctx.periodStart), until: Date.parse(ctx.periodEnd) })
    if (outcomes.length === 0) {
      findings.push({
        id: 'MN-1.1-empty',
        severity: 'medium',
        control: 'NIST-AI-RMF:MANAGE-1.1',
        summary: 'OutcomeStore present but no outcomes captured for the period.',
      })
    }
  }

  // Validate that dataset manifests carry strong SHA-256-shaped content hashes.
  const hashChecks: Array<{ name: string; ok: boolean }> = []
  for (const manifest of ctx.datasets) {
    // We don't persist the scenarios here; the check is that the caller's
    // manifest already carries a hash in the expected hex format.
    hashChecks.push({ name: manifest.name, ok: /^[0-9a-f]{64}$/.test(manifest.contentHash) })
  }

  const payload = {
    controlsEvaluated: [
      'GOVERN-1.1', 'GOVERN-1.3',
      'MEASURE-2.1', 'MEASURE-2.6', 'MEASURE-2.11',
      'MANAGE-1.1',
    ],
    runCount: runs.length,
    redTeamPassRate: ctx.redTeam?.overallPassRate ?? null,
    datasetHashChecks: hashChecks,
  }

  return {
    framework: 'NIST-AI-RMF',
    version: '1.0.0',
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
