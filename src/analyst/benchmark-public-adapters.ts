import type { AnalystBenchmarkRunner } from './benchmark'
import { agentRxPredictionsToFindings } from './benchmark-datasets'
import {
  codeTraceStepEvidenceUri,
  codeTraceStepFromEvidence,
} from './benchmark-evidence-validation'
import type { PublicAnalystBenchmarkDataset } from './benchmark-public-types'
import type { AnalystFinding, AnalystRunInputs } from './types'
import { makeFinding } from './types'

export function emptyPublicBenchmarkRunner(): AnalystBenchmarkRunner<AnalystRunInputs> {
  return {
    id: 'empty',
    analyze() {
      return {
        findings: [],
        usage: {
          calls: 0,
          tokens: { input: 0, output: 0 },
          cost: { kind: 'observed', usd: 0 },
        },
        metadata: { baseline: 'emit-no-findings' },
      }
    },
  }
}

export function adaptPublicBenchmarkFindings(
  dataset: PublicAnalystBenchmarkDataset,
  trajectoryId: string,
  findings: readonly AnalystFinding[],
  analystId: string,
): AnalystFinding[] {
  return dataset === 'agentrx'
    ? adaptAgentRxFindings(trajectoryId, findings, analystId)
    : adaptCodeTraceFindings(trajectoryId, findings, analystId)
}

function adaptAgentRxFindings(
  trajectoryId: string,
  findings: readonly AnalystFinding[],
  analystId: string,
): AnalystFinding[] {
  if (findings.length === 0) return []
  if (findings.length !== 1) {
    throw new Error(
      `AgentRx model analyst must emit zero or one root cause, received ${findings.length}`,
    )
  }
  const source = findings[0]!
  if (!source.subject) {
    throw new Error('AgentRx model analyst finding is missing its failure-category subject')
  }
  const steps = exactFindingSteps(trajectoryId, source)
  if (steps.length !== 1) {
    throw new Error(
      `AgentRx model analyst must cite exactly one root-cause step, received ${steps.length}`,
    )
  }
  const [adapted] = agentRxPredictionsToFindings(
    trajectoryId,
    [
      {
        failure_case: source.subject,
        step_number: steps[0]!,
        description: source.rationale ?? source.claim,
      },
    ],
    {
      analystId,
      producedAt: source.produced_at,
      confidence: source.confidence,
    },
  )
  if (!adapted) throw new Error('AgentRx output adapter produced no root-cause finding')
  return [
    {
      ...adapted,
      metadata: {
        ...adapted.metadata,
        sourceFindingId: source.finding_id,
      },
    },
  ]
}

function adaptCodeTraceFindings(
  trajectoryId: string,
  findings: readonly AnalystFinding[],
  analystId: string,
): AnalystFinding[] {
  const clean = findings.filter((finding) => finding.subject === 'clean')
  if (clean.length > 0) {
    if (findings.length !== 1) {
      throw new Error('CodeTraceBench model analyst mixed a clean verdict with incorrect steps')
    }
    exactFindingSteps(trajectoryId, clean[0]!)
    return []
  }
  const byStep = new Map<number, AnalystFinding>()
  for (const source of findings) {
    const steps = exactFindingSteps(trajectoryId, source)
    for (const step of steps) {
      if (byStep.has(step)) continue
      byStep.set(
        step,
        makeFinding({
          analyst_id: analystId,
          area: 'incorrect',
          subject: `incorrect-step-${step}`,
          claim: `Step ${step} is incorrect. ${source.claim}`,
          rationale: source.rationale,
          severity: source.severity,
          confidence: source.confidence,
          evidence_refs: [
            {
              kind: 'span',
              uri: codeTraceStepEvidenceUri(trajectoryId, step),
              excerpt: source.evidence_refs.find(
                (evidence) => evidence.uri === codeTraceStepEvidenceUri(trajectoryId, step),
              )?.excerpt,
            },
          ],
          recommended_action: source.recommended_action,
          metadata: { sourceFindingId: source.finding_id },
          produced_at: source.produced_at,
          id_basis: `incorrect-step-${step}`,
        }),
      )
    }
  }
  return [...byStep].sort(([left], [right]) => left - right).map(([, finding]) => finding)
}

function exactFindingSteps(trajectoryId: string, finding: AnalystFinding): number[] {
  if (finding.evidence_refs.length === 0) {
    throw new Error(`model finding '${finding.finding_id}' has no step evidence`)
  }
  const steps = finding.evidence_refs.map((evidence) => {
    const parsed = codeTraceStepFromEvidence(evidence.uri)
    if (!parsed || parsed.traceId !== trajectoryId) {
      throw new Error(
        `model finding '${finding.finding_id}' cites non-case evidence '${evidence.uri}'`,
      )
    }
    return parsed.step
  })
  return [...new Set(steps)]
}
