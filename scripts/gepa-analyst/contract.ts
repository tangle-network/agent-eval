/** Serialized scenarios, per-case counts, artifacts, and score-ledger rows. */
import type { AnalystBenchmarkCase } from '../../src/analyst/benchmark'
import type { AnalystIssueExpectation } from '../../src/analyst/benchmark'
import { type TraceAnalystArtifact } from '../../src/campaign/analyst-surface'
import type { Scenario } from '../../src/campaign/types'

export interface GepaAnalystScenario extends Scenario {
  kind: 'trace-analyst'
  labelState: 'positive'
  pool: string
  trajectoryId: string
  expectedIssues: AnalystIssueExpectation[]
  labeledEvidence?: AnalystBenchmarkCase['labeledEvidence']
  /** Labeled incorrect-step count — the case's share of the micro denominator. */
  goldMass: number
  /** Widest contiguous run of labeled incorrect steps. */
  maxBlockWidth: number
  stratum: 'wide' | 'narrow'
}

export interface MatchCounts {
  expectedIssues: number
  tp: number
  fp: number
  fn: number
}

export interface GepaAnalystArtifact extends TraceAnalystArtifact {
  surfaceSha256: string
  rawSubjects: string[]
  matchCounts: MatchCounts
  missedIssueIds: string[]
  contractViolation?: boolean
  executionError?: string
  blockDiagnostics?: unknown
}

export interface PoolProvenance {
  name: string
  labelsPath: string
  labelsSha256: string
  filteredLabelsPath?: string
  filteredLabelsSha256?: string
}

export interface LedgerScoreRow {
  scenarioId: string
  surfaceSha256: string
  /** The signal GEPA optimizes: gold-mass-weighted in round 2, plain in family mode. */
  composite: number
  /** Unweighted judge composite (f1, averaged with critical-step accuracy). */
  rawComposite: number
  goldMassWeight: number
  f1: number
  counts: MatchCounts
  dimensions: Record<string, number>
  notes: string
}

export type GoldMassWeight = (scenario: Pick<GepaAnalystScenario, 'goldMass'>) => number
