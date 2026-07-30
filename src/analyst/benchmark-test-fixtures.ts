import type { AnalystBenchmarkCase } from './benchmark'
import { makeFinding } from './types'

export const root = 'trace://run/span/root'
export const failed = 'trace://run/span/failed-tool'
export const corrected = 'trace://run/span/corrected-output'

export function finding(input: {
  subject: string
  evidence: string[]
  idBasis?: string
  claim?: string
}) {
  return makeFinding({
    analyst_id: 'test',
    area: 'failure-mode',
    subject: input.subject,
    claim: input.claim ?? `Finding for ${input.subject}`,
    id_basis: input.idBasis,
    severity: 'high',
    confidence: 1,
    evidence_refs: input.evidence.map((uri) => ({ kind: 'span' as const, uri })),
  })
}

export const badCase: AnalystBenchmarkCase<string> = {
  id: 'known-bad',
  clusterId: 'task-bad',
  labelState: 'positive',
  input: 'bad',
  expectedIssues: [
    {
      id: 'tool-failure',
      subjects: ['failure-mode:tool-failure'],
      evidence: [{ kind: 'span', uri: failed }],
      criticalEvidence: [{ kind: 'span', uri: failed }],
    },
    {
      id: 'unsupported-claim',
      subjects: ['failure-mode:unsupported-claim'],
      evidence: [{ kind: 'span', uri: corrected }],
    },
  ],
  labeledEvidence: [
    { kind: 'span', uri: root },
    { kind: 'span', uri: failed },
    { kind: 'span', uri: corrected },
  ],
  tags: ['failed', 'tool-use'],
  metadata: { source: 'fixture' },
}

export const cleanCase: AnalystBenchmarkCase<string> = {
  id: 'known-good',
  clusterId: 'task-good',
  labelState: 'trusted-negative',
  input: 'good',
  expectedIssues: [],
  labeledEvidence: [{ kind: 'span', uri: root }],
}
