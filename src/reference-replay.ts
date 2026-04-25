/**
 * Reference replay — score an agent against withheld historical outcomes.
 *
 * This is the generic version of the public-audit replay pattern:
 * run a candidate system on an old task, keep the reference answers hidden
 * until after execution, then score recall/precision and gate promotion
 * across train/dev/test/holdout splits.
 */

export type ReferenceReplaySplit = 'train' | 'dev' | 'test' | 'holdout'

export interface ReferenceReplayItem {
  id: string
  title: string
  description?: string
  severity?: string
  tags?: string[]
  weight?: number
}

export interface ReferenceReplayCandidate {
  id: string
  title: string
  description?: string
  severity?: string
  tags?: string[]
  metadata?: Record<string, unknown>
}

export interface ReferenceReplayScenario {
  id: string
  split?: ReferenceReplaySplit
  references: ReferenceReplayItem[]
  candidates: ReferenceReplayCandidate[]
  metadata?: Record<string, unknown>
}

export interface ReferenceReplayMatch {
  scenarioId: string
  referenceId: string
  candidateId: string | null
  score: number
  matched: boolean
  weight: number
  reason: string
}

export interface ReferenceReplayScenarioScore {
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

export interface ReferenceReplayAggregate {
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

export interface ReferenceReplayScore {
  scenarios: ReferenceReplayScenarioScore[]
  aggregate: ReferenceReplayAggregate
  bySplit: Partial<Record<ReferenceReplaySplit, ReferenceReplayAggregate>>
}

export interface ReferenceMatchResult {
  score: number
  reason?: string
}

export type ReferenceReplayMatcher = (
  reference: ReferenceReplayItem,
  candidate: ReferenceReplayCandidate,
  scenario: ReferenceReplayScenario,
) => ReferenceMatchResult

export interface ReferenceReplayScoreOptions {
  matcher?: ReferenceReplayMatcher
  matchThreshold?: number
  includeHoldout?: boolean
  splits?: ReferenceReplaySplit[]
}

export interface ReferenceReplayPromotionPolicy {
  /** Splits that must improve or stay flat. Default: ['dev', 'test']. */
  requiredSplits?: ReferenceReplaySplit[]
  /** Minimum aggregate F1 lift required on required splits. Default 0. */
  minF1Delta?: number
  /** Maximum F1 drop allowed on any compared split. Default 0. */
  maxRegression?: number
  /** If true, holdout must be present and must not regress. Default true. */
  requireHoldoutNonRegression?: boolean
}

export interface ReferenceReplaySplitComparison {
  split: ReferenceReplaySplit
  baselineF1: number
  candidateF1: number
  f1Delta: number
  baselineRecall: number
  candidateRecall: number
  recallDelta: number
}

export interface ReferenceReplayPromotionDecision {
  promote: boolean
  reason: string
  aggregateDelta: number
  comparisons: ReferenceReplaySplitComparison[]
  regressions: ReferenceReplaySplitComparison[]
}

const DEFAULT_MATCH_THRESHOLD = 0.55
const ALL_SPLITS: ReferenceReplaySplit[] = ['train', 'dev', 'test', 'holdout']

export function scoreReferenceReplay(
  scenarios: ReferenceReplayScenario[],
  options: ReferenceReplayScoreOptions = {},
): ReferenceReplayScore {
  const matcher = options.matcher ?? defaultReferenceReplayMatcher
  const threshold = options.matchThreshold ?? DEFAULT_MATCH_THRESHOLD
  const allowedSplits = new Set(options.splits ?? ALL_SPLITS)
  const scores = scenarios
    .filter((scenario) => {
      const split = scenario.split ?? 'train'
      if (split === 'holdout' && !options.includeHoldout) return false
      return allowedSplits.has(split)
    })
    .map((scenario) => scoreScenario(scenario, matcher, threshold))

  return {
    scenarios: scores,
    aggregate: aggregateScenarioScores(scores),
    bySplit: aggregateBySplit(scores),
  }
}

export function compareReferenceReplay(
  baseline: ReferenceReplayScore,
  candidate: ReferenceReplayScore,
): ReferenceReplaySplitComparison[] {
  const splits = new Set<ReferenceReplaySplit>([
    ...Object.keys(baseline.bySplit) as ReferenceReplaySplit[],
    ...Object.keys(candidate.bySplit) as ReferenceReplaySplit[],
  ])
  return [...splits].sort(bySplitOrder).map((split) => {
    const before = baseline.bySplit[split] ?? emptyAggregate()
    const after = candidate.bySplit[split] ?? emptyAggregate()
    return {
      split,
      baselineF1: before.f1,
      candidateF1: after.f1,
      f1Delta: after.f1 - before.f1,
      baselineRecall: before.recall,
      candidateRecall: after.recall,
      recallDelta: after.recall - before.recall,
    }
  })
}

export function decideReferenceReplayPromotion(
  baseline: ReferenceReplayScore,
  candidate: ReferenceReplayScore,
  policy: ReferenceReplayPromotionPolicy = {},
): ReferenceReplayPromotionDecision {
  const requiredSplits = policy.requiredSplits ?? ['dev', 'test']
  const minF1Delta = policy.minF1Delta ?? 0
  const maxRegression = policy.maxRegression ?? 0
  const requireHoldout = policy.requireHoldoutNonRegression ?? true
  const comparisons = compareReferenceReplay(baseline, candidate)
  const compared = comparisons.filter((item) => requiredSplits.includes(item.split))
  const regressions = comparisons.filter((item) => item.f1Delta < -maxRegression)
  const aggregateDelta = candidate.aggregate.f1 - baseline.aggregate.f1

  if (compared.length === 0) {
    return {
      promote: false,
      reason: `No required split scores found: ${requiredSplits.join(', ')}`,
      aggregateDelta,
      comparisons,
      regressions,
    }
  }

  if (regressions.length > 0) {
    return {
      promote: false,
      reason: `Regression in ${regressions.map((r) => r.split).join(', ')}`,
      aggregateDelta,
      comparisons,
      regressions,
    }
  }

  if (requireHoldout && !comparisons.some((item) => item.split === 'holdout')) {
    return {
      promote: false,
      reason: 'Holdout split is required for promotion',
      aggregateDelta,
      comparisons,
      regressions,
    }
  }

  const requiredMeanDelta = mean(compared.map((item) => item.f1Delta))
  if (requiredMeanDelta < minF1Delta) {
    return {
      promote: false,
      reason: `Required split F1 delta ${formatPct(requiredMeanDelta)} below ${formatPct(minF1Delta)}`,
      aggregateDelta,
      comparisons,
      regressions,
    }
  }

  return {
    promote: true,
    reason: `Required splits improved by ${formatPct(requiredMeanDelta)} with no regressions`,
    aggregateDelta,
    comparisons,
    regressions,
  }
}

export function defaultReferenceReplayMatcher(
  reference: ReferenceReplayItem,
  candidate: ReferenceReplayCandidate,
): ReferenceMatchResult {
  const referenceText = `${reference.title} ${reference.description ?? ''}`
  const candidateText = `${candidate.title} ${candidate.description ?? ''}`
  const textScore = tokenJaccard(referenceText, candidateText)
  const severityScore = reference.severity && candidate.severity
    ? normalize(reference.severity) === normalize(candidate.severity) ? 0.1 : -0.05
    : 0
  const tagScore = tagOverlap(reference.tags, candidate.tags) * 0.15
  const score = clamp01(textScore * 0.85 + tagScore + severityScore)
  return { score, reason: `token=${textScore.toFixed(2)} tags=${tagScore.toFixed(2)} severity=${severityScore.toFixed(2)}` }
}

function scoreScenario(
  scenario: ReferenceReplayScenario,
  matcher: ReferenceReplayMatcher,
  threshold: number,
): ReferenceReplayScenarioScore {
  const candidatesLeft = new Map(scenario.candidates.map((candidate) => [candidate.id, candidate]))
  const matches: ReferenceReplayMatch[] = []

  for (const reference of scenario.references) {
    let best: { candidate: ReferenceReplayCandidate; score: number; reason: string } | null = null
    for (const candidate of candidatesLeft.values()) {
      const result = matcher(reference, candidate, scenario)
      if (!Number.isFinite(result.score)) {
        throw new Error(`reference replay matcher returned non-finite score for ${scenario.id}:${reference.id}:${candidate.id}`)
      }
      if (!best || result.score > best.score) {
        best = { candidate, score: clamp01(result.score), reason: result.reason ?? '' }
      }
    }

    const weight = reference.weight ?? 1
    if (best && best.score >= threshold) {
      candidatesLeft.delete(best.candidate.id)
      matches.push({
        scenarioId: scenario.id,
        referenceId: reference.id,
        candidateId: best.candidate.id,
        score: best.score,
        matched: true,
        weight,
        reason: best.reason,
      })
    } else {
      matches.push({
        scenarioId: scenario.id,
        referenceId: reference.id,
        candidateId: best?.candidate.id ?? null,
        score: best?.score ?? 0,
        matched: false,
        weight,
        reason: best?.reason ?? 'no candidates',
      })
    }
  }

  const matched = matches.filter((match) => match.matched).length
  const total = scenario.references.length
  const falsePositives = candidatesLeft.size
  const matchedWeight = matches.filter((match) => match.matched).reduce((sum, match) => sum + match.weight, 0)
  const totalWeight = matches.reduce((sum, match) => sum + match.weight, 0)
  const precision = ratio(matched, matched + falsePositives)
  const recall = ratio(matched, total)
  return {
    scenarioId: scenario.id,
    split: scenario.split ?? 'train',
    matched,
    total,
    falsePositives,
    matchedWeight,
    totalWeight,
    precision,
    recall,
    f1: f1(precision, recall),
    matches,
  }
}

function aggregateBySplit(
  scores: ReferenceReplayScenarioScore[],
): Partial<Record<ReferenceReplaySplit, ReferenceReplayAggregate>> {
  const out: Partial<Record<ReferenceReplaySplit, ReferenceReplayAggregate>> = {}
  for (const split of ALL_SPLITS) {
    const scoped = scores.filter((score) => score.split === split)
    if (scoped.length > 0) out[split] = aggregateScenarioScores(scoped)
  }
  return out
}

function aggregateScenarioScores(scores: ReferenceReplayScenarioScore[]): ReferenceReplayAggregate {
  const matched = sum(scores.map((score) => score.matched))
  const total = sum(scores.map((score) => score.total))
  const falsePositives = sum(scores.map((score) => score.falsePositives))
  const matchedWeight = sum(scores.map((score) => score.matchedWeight))
  const totalWeight = sum(scores.map((score) => score.totalWeight))
  const precision = ratio(matched, matched + falsePositives)
  const recall = ratio(matched, total)
  return {
    matched,
    total,
    falsePositives,
    matchedWeight,
    totalWeight,
    precision,
    recall,
    f1: f1(precision, recall),
    weightedRecall: ratio(matchedWeight, totalWeight),
  }
}

function emptyAggregate(): ReferenceReplayAggregate {
  return {
    matched: 0,
    total: 0,
    falsePositives: 0,
    matchedWeight: 0,
    totalWeight: 0,
    precision: 0,
    recall: 0,
    f1: 0,
    weightedRecall: 0,
  }
}

function f1(precision: number, recall: number): number {
  return precision + recall === 0 ? 0 : 2 * precision * recall / (precision + recall)
}

function ratio(numerator: number, denominator: number): number {
  return denominator > 0 ? numerator / denominator : 0
}

function tokenJaccard(a: string, b: string): number {
  const left = new Set(tokens(a))
  const right = new Set(tokens(b))
  if (left.size === 0 || right.size === 0) return 0
  let intersection = 0
  for (const token of left) {
    if (right.has(token)) intersection++
  }
  return intersection / (left.size + right.size - intersection)
}

function tagOverlap(a: string[] | undefined, b: string[] | undefined): number {
  if (!a?.length || !b?.length) return 0
  const left = new Set(a.map(normalize))
  const right = new Set(b.map(normalize))
  let intersection = 0
  for (const tag of left) {
    if (right.has(tag)) intersection++
  }
  return intersection / Math.max(left.size, right.size)
}

function tokens(text: string): string[] {
  return normalize(text)
    .split(/\s+/)
    .filter((token) => token.length >= 3 && !STOP_WORDS.has(token))
}

function normalize(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(1, value))
}

function sum(values: number[]): number {
  return values.reduce((acc, value) => acc + value, 0)
}

function mean(values: number[]): number {
  return values.length ? sum(values) / values.length : 0
}

function formatPct(value: number): string {
  return `${(value * 100).toFixed(1)}%`
}

function bySplitOrder(a: ReferenceReplaySplit, b: ReferenceReplaySplit): number {
  return ALL_SPLITS.indexOf(a) - ALL_SPLITS.indexOf(b)
}

const STOP_WORDS = new Set([
  'the',
  'and',
  'for',
  'with',
  'that',
  'this',
  'from',
  'into',
  'onto',
  'are',
  'can',
  'will',
  'should',
  'could',
  'would',
  'when',
  'where',
  'which',
])
