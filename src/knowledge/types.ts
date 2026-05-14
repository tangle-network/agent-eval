import type { ControlSeverity } from '../control-runtime'

export type KnowledgeRequirementCategory =
  | 'user_specific'
  | 'company_specific'
  | 'domain_specific'
  | 'codebase_specific'
  | 'market_specific'
  | 'regulatory'
  | 'tool_api'
  | 'credential_or_secret'
  | 'runtime_environment'
  | 'preference'
  | 'historical_context'

export type KnowledgeAcquisitionMode =
  | 'ask_user'
  | 'search_web'
  | 'query_connector'
  | 'inspect_repo'
  | 'run_command'
  | 'infer_low_confidence'
  | 'not_available'

export type KnowledgeImportance = 'blocking' | 'high' | 'medium' | 'low'
export type KnowledgeFreshness = 'static' | 'monthly' | 'weekly' | 'daily' | 'realtime'
export type KnowledgeSensitivity = 'public' | 'private' | 'secret'
export type KnowledgeFallbackPolicy = 'block' | 'ask' | 'continue_with_caveat' | 'use_default'

export interface KnowledgeRequirement {
  id: string
  description: string
  requiredFor: string[]
  category: KnowledgeRequirementCategory
  acquisitionMode: KnowledgeAcquisitionMode
  importance: KnowledgeImportance
  freshness: KnowledgeFreshness
  sensitivity: KnowledgeSensitivity
  confidenceNeeded: number
  currentConfidence: number
  evidenceIds: string[]
  fallbackPolicy: KnowledgeFallbackPolicy
  /**
   * ISO timestamp after which this requirement must be treated as stale.
   * Stale requirements score as missing even when they still have evidence.
   */
  validUntil?: string
  /** ISO timestamp for the last source-grounding or human verification pass. */
  lastVerifiedAt?: string
  metadata?: Record<string, unknown>
}

export interface KnowledgeBundle {
  taskId: string
  requirements: KnowledgeRequirement[]
  evidenceIds: string[]
  claimIds: string[]
  wikiPageIds: string[]
  userAnswers: Record<string, string>
  missing: KnowledgeRequirement[]
  readinessScore: number
  metadata?: Record<string, unknown>
}

export type KnowledgeRecommendedAction =
  | 'run_agent'
  | 'ask_user'
  | 'collect_web_data'
  | 'query_connectors'
  | 'inspect_repo'
  | 'build_domain_wiki'
  | 'continue_with_caveat'
  | 'abort_or_rescope'

export interface KnowledgeReadinessReport {
  taskId: string
  readinessScore: number
  blockingMissingRequirements: KnowledgeRequirement[]
  nonBlockingGaps: KnowledgeRequirement[]
  recommendedAction: KnowledgeRecommendedAction
  bundle: KnowledgeBundle
  severity: ControlSeverity
  reason: string
}

export interface UserQuestion {
  id: string
  question: string
  reason: string
  requirementId: string
  importance: KnowledgeImportance
  answerType: 'free_text' | 'select_one' | 'multi_select' | 'file_upload' | 'credential' | 'url'
  defaultIfSkipped?: string
  impactIfUnknown: string
  options?: string[]
  metadata?: Record<string, unknown>
}

export interface DataAcquisitionPlan {
  id: string
  requirementIds: string[]
  mode:
    | Exclude<KnowledgeAcquisitionMode, 'not_available' | 'infer_low_confidence'>
    | 'build_domain_wiki'
  description: string
  priority: KnowledgeImportance
  expectedEvidenceIds?: string[]
  questions?: UserQuestion[]
  metadata?: Record<string, unknown>
}

export type KnowledgeResponsibleSurface =
  | 'knowledge-requirements'
  | 'data-acquisition'
  | 'retrieval-policy'
  | 'user-question-policy'
