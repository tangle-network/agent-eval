/** Carrier faults are reissued; model outcomes stand. Closed enumeration. */
export interface ReissuePolicy {
  carrierEvents: ('http-status' | 'transport-error' | 'deadline' | 'empty-content')[]
  modelOutcomesStand: true
  maxIssues: number
}

export type ReissueVerdict = 'reissue' | 'stands' | 'exhausted'

/**
 * Classify one rollout event under the registered reissue policy. A carrier
 * event within the issue budget is reissued; a model outcome always stands;
 * a carrier event past `maxIssues` is exhausted and reported, never retried.
 */
export function classifyReissue(
  policy: ReissuePolicy,
  event: string,
  issuesSoFar: number,
): ReissueVerdict {
  if (!(policy.carrierEvents as string[]).includes(event)) return 'stands'
  return issuesSoFar < policy.maxIssues ? 'reissue' : 'exhausted'
}
