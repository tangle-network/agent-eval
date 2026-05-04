import { objectiveEval, type ControlEvalResult } from '../control-runtime'
import type {
  DataAcquisitionPlan,
  KnowledgeAcquisitionMode,
  KnowledgeBundle,
  KnowledgeImportance,
  KnowledgeReadinessReport,
  KnowledgeRecommendedAction,
  KnowledgeRequirement,
  UserQuestion,
} from './types'

export interface ScoreKnowledgeReadinessOptions {
  taskId: string
  requirements: KnowledgeRequirement[]
  evidenceIds?: string[]
  claimIds?: string[]
  wikiPageIds?: string[]
  userAnswers?: Record<string, string>
  metadata?: Record<string, unknown>
  now?: Date
}

export function scoreKnowledgeReadiness(options: ScoreKnowledgeReadinessOptions): KnowledgeReadinessReport {
  const now = options.now ?? new Date()
  const requirements = options.requirements.map(normalizeRequirement)
  const missing = requirements.filter((requirement) => isRequirementMissing(requirement, now))
  const blockingMissingRequirements = missing.filter(isBlockingGap)
  const nonBlockingGaps = missing.filter((requirement) => !isBlockingGap(requirement))
  const readinessScore = weightedReadinessAt(requirements, now)
  const bundle: KnowledgeBundle = {
    taskId: options.taskId,
    requirements,
    evidenceIds: unique([...(options.evidenceIds ?? []), ...requirements.flatMap((r) => r.evidenceIds)]),
    claimIds: unique(options.claimIds ?? []),
    wikiPageIds: unique(options.wikiPageIds ?? []),
    userAnswers: options.userAnswers ?? {},
    missing,
    readinessScore,
    metadata: options.metadata,
  }
  const recommendedAction = chooseRecommendedAction(blockingMissingRequirements, nonBlockingGaps)
  const severity = blockingMissingRequirements.length > 0
    ? 'critical'
    : nonBlockingGaps.some((gap) => gap.importance === 'high')
      ? 'warning'
      : 'info'
  const reason = blockingMissingRequirements.length > 0
    ? `${blockingMissingRequirements.length} blocking knowledge requirement(s) are missing.`
    : nonBlockingGaps.length > 0
      ? `${nonBlockingGaps.length} non-blocking knowledge gap(s) remain.`
      : 'All declared knowledge requirements are ready.'

  return {
    taskId: options.taskId,
    readinessScore,
    blockingMissingRequirements,
    nonBlockingGaps,
    recommendedAction,
    bundle,
    severity,
    reason,
  }
}

export function blockingKnowledgeEval(
  report: KnowledgeReadinessReport,
  options: { id?: string; minimumScore?: number } = {},
): ControlEvalResult {
  const minimumScore = options.minimumScore ?? 0.7
  const passed = report.blockingMissingRequirements.length === 0 && report.readinessScore >= minimumScore
  return objectiveEval({
    id: options.id ?? 'knowledge-ready',
    passed,
    score: report.readinessScore,
    severity: passed ? 'info' : report.severity,
    detail: report.reason,
    evidence: report.blockingMissingRequirements.map((r) => r.id).join(', ') || undefined,
    metadata: { knowledgeReadiness: report },
  })
}

export function userQuestionsForKnowledgeGaps(gaps: KnowledgeRequirement[]): UserQuestion[] {
  return gaps
    .filter((gap) => gap.acquisitionMode === 'ask_user' || gap.fallbackPolicy === 'ask')
    .map((gap) => ({
      id: `question_${gap.id}`,
      question: `Please provide: ${gap.description}`,
      reason: `Required for ${gap.requiredFor.join(', ') || 'the task'}.`,
      requirementId: gap.id,
      importance: gap.importance,
      answerType: gap.sensitivity === 'secret' ? 'credential' : 'free_text',
      impactIfUnknown: impactFor(gap),
    }))
}

export function acquisitionPlansForKnowledgeGaps(gaps: KnowledgeRequirement[]): DataAcquisitionPlan[] {
  const byMode = new Map<string, KnowledgeRequirement[]>()
  for (const gap of gaps) {
    const mode = planMode(gap.acquisitionMode)
    if (!mode) continue
    const bucket = byMode.get(mode) ?? []
    bucket.push(gap)
    byMode.set(mode, bucket)
  }
  return [...byMode.entries()].map(([mode, requirements]) => ({
    id: `acquire_${mode}`,
    requirementIds: requirements.map((r) => r.id),
    mode: mode as DataAcquisitionPlan['mode'],
    description: descriptionForPlan(mode as DataAcquisitionPlan['mode'], requirements),
    priority: maxImportance(requirements.map((r) => r.importance)),
    questions: mode === 'ask_user' ? userQuestionsForKnowledgeGaps(requirements) : undefined,
  }))
}

function normalizeRequirement(requirement: KnowledgeRequirement): KnowledgeRequirement {
  return {
    ...requirement,
    confidenceNeeded: clamp01(requirement.confidenceNeeded),
    currentConfidence: clamp01(requirement.currentConfidence),
    evidenceIds: unique(requirement.evidenceIds),
  }
}

function weightedReadinessAt(requirements: KnowledgeRequirement[], now: Date): number {
  if (requirements.length === 0) return 1
  let weightSum = 0
  let scoreSum = 0
  for (const requirement of requirements) {
    const weight = importanceWeight(requirement.importance)
    const score = isExpired(requirement, now)
      ? 0
      : requirement.confidenceNeeded <= 0
      ? 1
      : Math.min(1, requirement.currentConfidence / requirement.confidenceNeeded)
    weightSum += weight
    scoreSum += weight * score
  }
  return clamp01(scoreSum / weightSum)
}

function isRequirementMissing(requirement: KnowledgeRequirement, now: Date): boolean {
  return isExpired(requirement, now) || requirement.currentConfidence < requirement.confidenceNeeded
}

function isExpired(requirement: KnowledgeRequirement, now: Date): boolean {
  if (!requirement.validUntil) return false
  const deadline = Date.parse(requirement.validUntil)
  if (!Number.isFinite(deadline)) return false
  return deadline <= now.getTime()
}

function isBlockingGap(requirement: KnowledgeRequirement): boolean {
  return requirement.importance === 'blocking'
    || requirement.fallbackPolicy === 'block'
    || requirement.sensitivity === 'secret'
}

function chooseRecommendedAction(
  blocking: KnowledgeRequirement[],
  nonBlocking: KnowledgeRequirement[],
): KnowledgeRecommendedAction {
  const gaps = blocking.length > 0 ? blocking : nonBlocking
  if (gaps.length === 0) return 'run_agent'
  if (blocking.some((gap) => gap.acquisitionMode === 'ask_user' || gap.fallbackPolicy === 'ask')) return 'ask_user'
  if (blocking.some((gap) => gap.acquisitionMode === 'query_connector')) return 'query_connectors'
  if (blocking.some((gap) => gap.acquisitionMode === 'inspect_repo' || gap.acquisitionMode === 'run_command')) return 'inspect_repo'
  if (blocking.some((gap) => gap.acquisitionMode === 'search_web')) return 'collect_web_data'
  if (blocking.some((gap) => gap.acquisitionMode === 'not_available')) return 'abort_or_rescope'
  if (nonBlocking.some((gap) => gap.importance === 'high')) return 'build_domain_wiki'
  return 'continue_with_caveat'
}

function planMode(mode: KnowledgeAcquisitionMode): DataAcquisitionPlan['mode'] | null {
  if (mode === 'infer_low_confidence' || mode === 'not_available') return null
  return mode
}

function descriptionForPlan(mode: DataAcquisitionPlan['mode'], requirements: KnowledgeRequirement[]): string {
  const labels = requirements.map((r) => r.description).join('; ')
  if (mode === 'ask_user') return `Ask the user for: ${labels}`
  if (mode === 'search_web') return `Search web or documentation sources for: ${labels}`
  if (mode === 'query_connector') return `Query configured connectors for: ${labels}`
  if (mode === 'inspect_repo') return `Inspect repository context for: ${labels}`
  if (mode === 'run_command') return `Run local commands to collect: ${labels}`
  return `Build domain wiki evidence for: ${labels}`
}

function impactFor(requirement: KnowledgeRequirement): string {
  if (requirement.fallbackPolicy === 'block') return 'The agent should not run until this is known.'
  if (requirement.fallbackPolicy === 'continue_with_caveat') return 'The agent may continue, but must disclose uncertainty.'
  if (requirement.fallbackPolicy === 'use_default') return 'The agent will use the configured default if skipped.'
  return 'The agent should ask before continuing.'
}

function maxImportance(values: KnowledgeImportance[]): KnowledgeImportance {
  const order: KnowledgeImportance[] = ['blocking', 'high', 'medium', 'low']
  return order.find((value) => values.includes(value)) ?? 'low'
}

function importanceWeight(importance: KnowledgeImportance): number {
  if (importance === 'blocking') return 8
  if (importance === 'high') return 4
  if (importance === 'medium') return 2
  return 1
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(1, value))
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)]
}
