import type { SupervisorRunIntegrityEvidence, SupervisorRunIntegrityIssue } from './integrity-types'

export const MAX_EXAMPLES = 20

export function evidence(path: string, value: unknown): SupervisorRunIntegrityEvidence {
  return { path, value }
}

export function issue(
  init: Omit<SupervisorRunIntegrityIssue, 'evidence'> & {
    evidence?: readonly SupervisorRunIntegrityEvidence[]
  },
): SupervisorRunIntegrityIssue {
  return { ...init, evidence: init.evidence ?? [] }
}
