/**
 * Reference replay — score an agent against withheld historical outcomes.
 *
 * This is the generic version of the public-audit replay pattern:
 * run a candidate system on an old task, keep the reference answers hidden
 * until after execution, then score recall/precision and gate promotion
 * across train/dev/test/holdout splits.
 */

export type ReferenceReplaySplit = 'train' | 'dev' | 'test' | 'holdout'


interface ReferenceReplayItem {
  id: string
  title: string
  description?: string
  severity?: string
  tags?: string[]
  weight?: number
}

interface ReferenceReplayCandidate {
  id: string
  title: string
  description?: string
  severity?: string
  tags?: string[]
  metadata?: Record<string, unknown>
}















interface ReferenceReplayMatch {
  scenarioId: string
  referenceId: string
  candidateId: string | null
  score: number
  matched: boolean
  weight: number
  reason: string
}

interface ReferenceReplayScenarioScore {
  scenarioId: string
  split: ReferenceReplaySplit
  matched: number
  total: number
  falsePositives: number
  matchedWeight: number
  totalWeight: number
  precision: number
  recall: number
  f1: number
  matches: ReferenceReplayMatch[]
}

interface ReferenceReplayAggregate {
  matched: number
  total: number
  falsePositives: number
  matchedWeight: number
  totalWeight: number
  precision: number
  recall: number
  f1: number
  weightedRecall: number
}

interface ReferenceReplayScore {
  scenarios: ReferenceReplayScenarioScore[]
  aggregate: ReferenceReplayAggregate
  bySplit: Partial<Record<ReferenceReplaySplit, ReferenceReplayAggregate>>
}













export interface ReferenceReplayCaseRun<Input = unknown> {
  caseId: string
  split: ReferenceReplaySplit
  input: Input
  metadata?: Record<string, unknown>
  references: ReferenceReplayItem[]
  candidates: ReferenceReplayCandidate[]
  score: ReferenceReplayScenarioScore
  durationMs: number
  error?: string
}

export interface ReferenceReplayRun<Input = unknown> {
  id: string
  variantId?: string
  startedAt: number
  completedAt: number
  durationMs: number
  cases: ReferenceReplayCaseRun<Input>[]
  score: ReferenceReplayScore
  metadata?: Record<string, unknown>
}
