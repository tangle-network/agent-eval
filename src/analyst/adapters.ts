/**
 * Adapter factory — lifts the semantic-concept judge into the Analyst
 * contract without re-implementing it.
 *
 * It builds an Analyst with a stable id (caller chooses; a default is given),
 * a version derived from the judge's version plus an adapter revision, and an
 * `analyze()` that calls the judge and lifts its output to `AnalystFinding[]`
 * through `makeFinding()`. The judge's `Severity` ('critical' | 'major' |
 * 'minor' | 'info') projects onto `AnalystSeverity`: 'major' becomes 'high'
 * and 'minor' becomes 'medium'.
 *
 * The adapter owns no state. Calling the factory twice is safe.
 */



import {
  type SemanticConceptJudgeOptions,
} from '../semantic-concept-judge'






// ── Severity bridges ───────────────────────────────────────────────



// ── SemanticConceptJudge → Analyst ─────────────────────────────────

export interface SemanticConceptJudgeAdapterOpts {
  id?: string
  area?: string
  /** Registry context owns cancellation and the per-analyst cost ledger. */
  options: Omit<SemanticConceptJudgeOptions, 'costLedger' | 'signal'>
  /** Maximum post-cancellation wait for a provider receipt. Default 5 seconds. */
  settlementTimeoutMs?: number
}


