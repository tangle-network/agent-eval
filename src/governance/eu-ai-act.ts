/**
 * EU AI Act — risk-class classification + compliance checklist.
 *
 * Classification is declarative: caller supplies the domain/use-case
 * signals (biometric? critical infrastructure? education? employment?
 * access to services?) and we map to the Act's risk tiers:
 *   - "unacceptable" (prohibited)
 *   - "high"        (Annex III — strict obligations)
 *   - "limited"     (transparency obligations)
 *   - "minimal"     (voluntary codes of conduct)
 *
 * Then the compliance checklist enumerates Article 9 (risk mgmt),
 * 10 (data + data governance), 11 (technical documentation), 13
 * (transparency), 14 (human oversight), 15 (accuracy + robustness)
 * requirements and flags gaps.
 */

import type { GovernanceContext, GovernanceFinding, GovernanceReport } from './types'
import { summarize } from './types'

export type EuRiskClass = 'unacceptable' | 'high' | 'limited' | 'minimal'

export interface UseCaseSignals {
  /** Used for biometric identification in public spaces? (Art. 5 — unacceptable). */
  biometricPublic?: boolean
  /** Social scoring by public authorities? (Art. 5). */
  socialScoring?: boolean
  /** Subliminal manipulation? (Art. 5). */
  subliminal?: boolean
  /** Annex III sector: critical infrastructure / education / employment /
   *  access to essential services / law enforcement / migration /
   *  administration of justice / democratic processes? */
  annexIII?: boolean
  /** Interacts directly with natural persons (chatbot, agent)? — limited risk. */
  chatbot?: boolean
  /** Generates synthetic media (image/audio/video/text deepfakes)? — limited risk. */
  generatesSyntheticMedia?: boolean
}

export function classifyEuAiRisk(signals: UseCaseSignals): EuRiskClass {
  if (signals.biometricPublic || signals.socialScoring || signals.subliminal) return 'unacceptable'
  if (signals.annexIII) return 'high'
  if (signals.chatbot || signals.generatesSyntheticMedia) return 'limited'
  return 'minimal'
}

export async function euAiActReport(
  ctx: GovernanceContext,
  signals: UseCaseSignals,
): Promise<GovernanceReport> {
  const riskClass = classifyEuAiRisk(signals)
  const findings: GovernanceFinding[] = []

  if (riskClass === 'unacceptable') {
    findings.push({
      id: 'EU-ART-5',
      severity: 'critical',
      control: 'EU-AI-ACT:Article-5',
      summary: 'Use case matches a prohibited practice under Article 5.',
      remediation: 'Discontinue or substantially redesign the use case.',
    })
  }

  if (riskClass === 'high') {
    // Article 9 — risk management
    if (!ctx.redTeam) {
      findings.push({
        id: 'EU-ART-9',
        severity: 'high',
        control: 'EU-AI-ACT:Article-9',
        summary: 'High-risk system lacks documented adversarial-testing evidence (Art. 9 risk mgmt).',
        remediation: 'Run redTeamDataset() + attach the report.',
      })
    }
    // Article 10 — data + data governance
    if (ctx.datasets.length === 0) {
      findings.push({
        id: 'EU-ART-10',
        severity: 'high',
        control: 'EU-AI-ACT:Article-10',
        summary: 'No training/eval datasets recorded with provenance (Art. 10).',
      })
    }
    // Article 11 — technical documentation (traces + runs)
    const runs = await ctx.traceStore.listRuns({
      since: Date.parse(ctx.periodStart),
      until: Date.parse(ctx.periodEnd),
    })
    if (runs.length === 0) {
      findings.push({
        id: 'EU-ART-11',
        severity: 'high',
        control: 'EU-AI-ACT:Article-11',
        summary: 'No eval runs recorded (Art. 11 technical documentation).',
      })
    }
    // Article 13 — transparency to users
    if (!signals.chatbot && !signals.generatesSyntheticMedia) {
      // High-risk but not a chatbot — transparency may still apply; flag informational
    } else {
      findings.push({
        id: 'EU-ART-13',
        severity: 'info',
        control: 'EU-AI-ACT:Article-13',
        summary: 'Chatbot/synthetic-media transparency obligations apply; verify user-facing disclosures.',
      })
    }
    // Article 14 — human oversight
    if (!ctx.owner?.email) {
      findings.push({
        id: 'EU-ART-14',
        severity: 'high',
        control: 'EU-AI-ACT:Article-14',
        summary: 'No designated human overseer (Art. 14).',
        remediation: 'Populate GovernanceContext.owner with the responsible individual.',
      })
    }
    // Article 15 — accuracy + robustness
    if (!ctx.outcomeStore) {
      findings.push({
        id: 'EU-ART-15',
        severity: 'medium',
        control: 'EU-AI-ACT:Article-15',
        summary: 'No post-deployment outcome measurement; accuracy + robustness are un-attested.',
        remediation: 'Attach an OutcomeStore + run correlationStudy() over the reporting period.',
      })
    }
  }

  if (riskClass === 'limited') {
    findings.push({
      id: 'EU-ART-52',
      severity: 'info',
      control: 'EU-AI-ACT:Article-52',
      summary: 'Transparency obligations apply: disclose AI nature + synthetic content labeling.',
      remediation: 'Ensure user-facing surfaces label AI-generated content.',
    })
  }

  const payload = {
    riskClass,
    signals,
    articlesReviewed: riskClass === 'high'
      ? ['5', '9', '10', '11', '13', '14', '15']
      : riskClass === 'limited' ? ['52'] : ['none'],
  }

  return {
    framework: 'EU-AI-ACT',
    version: 'Regulation-2024-1689',
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
