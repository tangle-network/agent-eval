/** Carrier faults are reissued; model outcomes stand. Closed enumeration. */
export interface ReissuePolicy {
  carrierEvents: ('http-status' | 'transport-error' | 'deadline' | 'empty-content')[]
  modelOutcomesStand: true
  maxIssues: number
}

export type ReissueVerdict = 'reissue' | 'stands' | 'exhausted'
