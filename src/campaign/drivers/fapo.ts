/**
 * @experimental
 *
 * FAPO (Fully Autonomous Prompt Optimization) is an orchestration policy, not
 * a new prompt mutation primitive. The paper's loop evaluates an inspectable
 * workflow, attributes failures to an edit level, proposes ONE scoped change,
 * reviews it, measures it, and escalates from prompt -> parameters -> structure
 * only when prompt-level search is exhausted and attribution supports the
 * higher-cost edit.
 *
 * This substrate driver encodes that policy while keeping the edit generators
 * pluggable:
 *   - prompt: usually `gepaDriver`, `skillOptDriver`, or a runtime reflective driver
 *   - parameter: `parameterSweepDriver` or a caller-supplied config driver
 *   - structural: a caller-supplied code/worktree driver from agent-runtime
 *
 * It deliberately does not import Claude Code, LangGraph, or Cisco's tenant
 * runtime. agent-eval owns measurement and driver contracts; runtime-shaped
 * code generation stays downstream.
 *
 * Grounded sources:
 *   - Kassianik et al., "FAPO: Fully Autonomous Prompt Optimization of
 *     Multi-Step LLM Pipelines", arXiv:2606.19605v1.
 *   - cisco-foundation-ai/fully-automated-prompt-optimization at
 *     376b50c57d5e2423e5a5de46e0d315a761d272d8.
 */

import type {
  GenerationCandidate,
  GenerationRecord,
  ImprovementDriver,
  MutableSurface,
  ProposeContext,
  ProposedCandidate,
  SurfaceProposer,
} from '../types'
import { isProposedCandidate } from '../types'

export type FapoOptimizationLevel = 'prompt' | 'parameter' | 'structural'

const FAPO_LEVELS: readonly FapoOptimizationLevel[] = ['prompt', 'parameter', 'structural']

export interface FapoScopeContract {
  /** Levels the tenant/playbook allows. Defaults to the levels with drivers. */
  allowedLevels?: readonly FapoOptimizationLevel[]
  /** Explicitly forbidden levels; wins over `allowedLevels`. */
  forbiddenLevels?: readonly FapoOptimizationLevel[]
}

export interface FapoFailureCluster {
  label: string
  level: FapoOptimizationLevel
  count: number
  confidence?: 'high' | 'medium' | 'low'
  suggestedFix?: string
  caseIds?: string[]
}

export interface FapoAttributionSignals {
  counts: Record<FapoOptimizationLevel, number>
  clusters: FapoFailureCluster[]
}

export interface FapoReviewIssue {
  checkName: string
  severity: 'block' | 'warn'
  description: string
  location?: string
}

export interface FapoReviewResult {
  verdict: 'pass' | 'warn' | 'fail'
  issues?: FapoReviewIssue[]
  suggestions?: string[]
}

export interface FapoReviewInput<TFindings = unknown> {
  level: FapoOptimizationLevel
  candidate: ProposedCandidate
  context: ProposeContext<TFindings>
  reason: string
}

export interface FapoDriverOptions<TFindings = unknown> {
  /** Level-specific candidate proposers. At least one is required. */
  proposers?: Partial<Record<FapoOptimizationLevel, SurfaceProposer<TFindings>>>
  /** @deprecated Use `proposers`. */
  drivers?: Partial<Record<FapoOptimizationLevel, SurfaceProposer<TFindings>>>
  /** Convenience aliases for `proposers.<level>`. */
  promptProposer?: SurfaceProposer<TFindings>
  parameterProposer?: SurfaceProposer<TFindings>
  structuralProposer?: SurfaceProposer<TFindings>
  /** @deprecated Use `promptProposer`. */
  promptDriver?: SurfaceProposer<TFindings>
  /** @deprecated Use `parameterProposer`. */
  parameterDriver?: SurfaceProposer<TFindings>
  /** @deprecated Use `structuralProposer`. */
  structuralDriver?: SurfaceProposer<TFindings>
  /** Tenant/playbook-derived allowed and forbidden edit levels. */
  scope?: FapoScopeContract
  /**
   * Independent reviewer hook. Return `fail` to block a candidate before eval,
   * mirroring FAPO's variant-reviewer phase.
   */
  reviewCandidate?: (input: FapoReviewInput<TFindings>) => Promise<FapoReviewResult>
  /**
   * FAPO proposes one scoped change per cycle. Keep this at 1 unless you are
   * intentionally relaxing the paper loop for a batch experiment.
   */
  proposalsPerCycle?: number
  /** Consecutive non-improving variants required before a level is exhausted. Default 3. */
  plateauWindow?: number
  /** Distinct strategies required before declaring a plateau. Default 3. */
  minDistinctStrategies?: number
  /** Candidate score delta needed to count as an improvement. Default 0. */
  minImprovement?: number
  /** Paper-faithful default: try prompt edits before escalating. */
  promptFirst?: boolean
  /** Paper-faithful default: try parameter/config edits before structural code edits. */
  parameterBeforeStructural?: boolean
}

interface FapoAttempt {
  level: FapoOptimizationLevel
  composite: number
  strategy: string
}

interface FapoPolicyState {
  attempts: FapoAttempt[]
  exhausted: Record<FapoOptimizationLevel, boolean>
  signals: FapoAttributionSignals
}

/** Build a FAPO policy driver from level-specific candidate generators. */
export function fapoDriver<TFindings = unknown>(
  opts: FapoDriverOptions<TFindings>,
): ImprovementDriver<TFindings> {
  const drivers = levelDrivers(opts)
  const allowed = allowedLevels(opts, drivers)
  const plateauWindow = opts.plateauWindow ?? 3
  const minDistinctStrategies = opts.minDistinctStrategies ?? 3
  const minImprovement = opts.minImprovement ?? 0
  const proposalsPerCycle = opts.proposalsPerCycle ?? 1

  if (allowed.length === 0) {
    throw new Error('fapoDriver: at least one allowed level must have a driver')
  }
  if (plateauWindow < 1) throw new Error('fapoDriver: plateauWindow must be >= 1')
  if (minDistinctStrategies < 1) {
    throw new Error('fapoDriver: minDistinctStrategies must be >= 1')
  }
  if (proposalsPerCycle < 1) throw new Error('fapoDriver: proposalsPerCycle must be >= 1')

  return {
    kind: 'fapo',
    async propose(ctx: ProposeContext<TFindings>): Promise<ProposedCandidate[]> {
      const state = policyState(ctx.history, ctx.findings, {
        plateauWindow,
        minDistinctStrategies,
        minImprovement,
      })
      const decision = chooseLevel({
        allowed,
        available: allowed.filter((level) => !state.exhausted[level]),
        drivers,
        state,
        promptFirst: opts.promptFirst ?? true,
        parameterBeforeStructural: opts.parameterBeforeStructural ?? true,
      })
      if (!decision) return []

      const driver = drivers[decision.level]
      if (!driver) {
        throw new Error(`fapoDriver: selected ${decision.level} but no driver is configured`)
      }

      const requested = Math.min(ctx.populationSize, proposalsPerCycle)
      const raw = await driver.propose({ ...ctx, populationSize: requested })
      const wrapped = raw
        .map((candidate) => normalizeProposal(candidate))
        .map((candidate) => wrapProposal(candidate, decision.level, decision.reason))

      const reviewed: ProposedCandidate[] = []
      for (const candidate of wrapped) {
        const review = opts.reviewCandidate
          ? await opts.reviewCandidate({
              level: decision.level,
              candidate,
              context: ctx,
              reason: decision.reason,
            })
          : { verdict: 'pass' as const }
        if (review.verdict === 'fail') continue
        const warn = review.verdict === 'warn' ? renderReviewWarnings(review) : ''
        reviewed.push(
          warn ? { ...candidate, rationale: `${candidate.rationale}\n${warn}` } : candidate,
        )
      }

      if (wrapped.length > 0 && reviewed.length === 0) {
        throw new Error(
          `fapoDriver: reviewer blocked every ${decision.level} candidate; refusing to evaluate an unreviewed variant`,
        )
      }
      return reviewed
    },
    decide({ history }) {
      const last = history[history.length - 1]
      if (last && last.candidates.length === 0) {
        return { stop: true, reason: 'FAPO produced no scoped candidate in the prior generation' }
      }
      const state = policyState(history, [], {
        plateauWindow,
        minDistinctStrategies,
        minImprovement,
      })
      const everyAllowedLevelExhausted = allowed.every((level) => state.exhausted[level])
      return everyAllowedLevelExhausted
        ? { stop: true, reason: `all FAPO levels exhausted (${allowed.join(', ')})` }
        : { stop: false }
    },
  }
}

function levelDrivers<TFindings>(
  opts: FapoDriverOptions<TFindings>,
): Partial<Record<FapoOptimizationLevel, SurfaceProposer<TFindings>>> {
  return {
    ...(opts.proposers ?? {}),
    ...(opts.drivers ?? {}),
    ...(opts.promptProposer ? { prompt: opts.promptProposer } : {}),
    ...(opts.parameterProposer ? { parameter: opts.parameterProposer } : {}),
    ...(opts.structuralProposer ? { structural: opts.structuralProposer } : {}),
    ...(opts.promptDriver ? { prompt: opts.promptDriver } : {}),
    ...(opts.parameterDriver ? { parameter: opts.parameterDriver } : {}),
    ...(opts.structuralDriver ? { structural: opts.structuralDriver } : {}),
  }
}

function allowedLevels<TFindings>(
  opts: FapoDriverOptions<TFindings>,
  drivers: Partial<Record<FapoOptimizationLevel, SurfaceProposer<TFindings>>>,
): FapoOptimizationLevel[] {
  const explicit = opts.scope?.allowedLevels
  const forbidden = new Set(opts.scope?.forbiddenLevels ?? [])
  return FAPO_LEVELS.filter((level) => {
    if (!drivers[level]) return false
    if (forbidden.has(level)) return false
    return explicit ? explicit.includes(level) : true
  })
}

function policyState(
  history: readonly GenerationRecord[],
  findings: readonly unknown[],
  opts: { plateauWindow: number; minDistinctStrategies: number; minImprovement: number },
): FapoPolicyState {
  const attempts = extractAttempts(history)
  return {
    attempts,
    exhausted: {
      prompt: isLevelExhausted('prompt', attempts, opts),
      parameter: isLevelExhausted('parameter', attempts, opts),
      structural: isLevelExhausted('structural', attempts, opts),
    },
    signals: extractFapoAttributionSignals(findings),
  }
}

function extractAttempts(history: readonly GenerationRecord[]): FapoAttempt[] {
  const attempts: FapoAttempt[] = []
  for (const generation of history) {
    for (const candidate of generation.candidates) {
      const level = candidateLevel(candidate)
      if (!level) continue
      attempts.push({
        level,
        composite: candidate.composite,
        strategy: candidateStrategy(candidate),
      })
    }
  }
  return attempts
}

function candidateLevel(candidate: GenerationCandidate): FapoOptimizationLevel | null {
  const label = candidate.label ?? ''
  const rationale = candidate.rationale ?? ''
  return parseLevel(label) ?? parseLevel(rationale)
}

function parseLevel(text: string): FapoOptimizationLevel | null {
  const match = /\bfapo:(prompt|parameter|structural)\b/.exec(text)
  return match ? (match[1] as FapoOptimizationLevel) : null
}

function candidateStrategy(candidate: GenerationCandidate): string {
  const label = candidate.label ?? candidate.rationale ?? candidate.surfaceHash
  return (
    label.replace(/\bfapo:(prompt|parameter|structural):?/g, '').trim() || candidate.surfaceHash
  )
}

function isLevelExhausted(
  level: FapoOptimizationLevel,
  attempts: readonly FapoAttempt[],
  opts: { plateauWindow: number; minDistinctStrategies: number; minImprovement: number },
): boolean {
  const own = attempts.filter((attempt) => attempt.level === level)
  if (own.length < opts.plateauWindow) return false
  const distinctStrategies = new Set(own.map((attempt) => attempt.strategy)).size
  if (distinctStrategies < opts.minDistinctStrategies) return false

  let best = Number.NEGATIVE_INFINITY
  let nonImproving = 0
  for (const attempt of own) {
    if (attempt.composite > best + opts.minImprovement) {
      best = attempt.composite
      nonImproving = 0
    } else {
      nonImproving += 1
    }
  }
  return nonImproving >= opts.plateauWindow
}

function chooseLevel<TFindings>(args: {
  allowed: readonly FapoOptimizationLevel[]
  available: readonly FapoOptimizationLevel[]
  drivers: Partial<Record<FapoOptimizationLevel, ImprovementDriver<TFindings>>>
  state: FapoPolicyState
  promptFirst: boolean
  parameterBeforeStructural: boolean
}): { level: FapoOptimizationLevel; reason: string } | null {
  const { available, state } = args
  if (available.length === 0) return null

  const triedPrompt = state.attempts.some((attempt) => attempt.level === 'prompt')
  if (args.promptFirst && available.includes('prompt') && !triedPrompt) {
    return {
      level: 'prompt',
      reason: 'prompt-first policy: no prompt-level variant has been tried yet',
    }
  }

  const supported = available.filter((level) => state.signals.counts[level] > 0)
  if (supported.includes('prompt')) {
    return {
      level: 'prompt',
      reason: `attribution has ${state.signals.counts.prompt} prompt-addressable failure(s)`,
    }
  }

  const strongest = supported.sort(
    (a, b) => state.signals.counts[b] - state.signals.counts[a] || levelRank(a) - levelRank(b),
  )[0]
  if (strongest) {
    if (
      strongest === 'structural' &&
      args.parameterBeforeStructural &&
      available.includes('parameter') &&
      args.drivers.parameter
    ) {
      return {
        level: 'parameter',
        reason:
          'attribution indicates a non-prompt bottleneck; trying parameter/config edits before structural edits',
      }
    }
    return {
      level: strongest,
      reason: `attribution has ${state.signals.counts[strongest]} ${strongest}-addressable failure(s)`,
    }
  }

  // No usable attribution yet. FAPO can still start at the cheapest allowed
  // level, but it should not silently jump to structure after prompt exhausts.
  if (state.attempts.length === 0) {
    const first = available.slice().sort((a, b) => levelRank(a) - levelRank(b))[0]!
    return { level: first, reason: 'no attribution yet; starting at the cheapest allowed level' }
  }
  return null
}

function levelRank(level: FapoOptimizationLevel): number {
  return level === 'prompt' ? 0 : level === 'parameter' ? 1 : 2
}

function normalizeProposal(value: MutableSurface | ProposedCandidate): ProposedCandidate {
  return isProposedCandidate(value)
    ? value
    : { surface: value, label: 'candidate', rationale: 'bare candidate from level driver' }
}

function wrapProposal(
  candidate: ProposedCandidate,
  level: FapoOptimizationLevel,
  reason: string,
): ProposedCandidate {
  const label = candidate.label ? `fapo:${level}:${candidate.label}` : `fapo:${level}`
  return {
    ...candidate,
    label,
    rationale: [
      `fapo:${level} selected by reviewed escalation policy`,
      `Reason: ${reason}`,
      candidate.rationale ? `Level driver rationale: ${candidate.rationale}` : '',
    ]
      .filter(Boolean)
      .join('\n'),
  }
}

function renderReviewWarnings(review: FapoReviewResult): string {
  const issues = review.issues?.filter((issue) => issue.severity === 'warn') ?? []
  if (issues.length === 0) return ''
  return `Reviewer warnings:\n${issues.map((issue) => `- ${issue.checkName}: ${issue.description}`).join('\n')}`
}

export function extractFapoAttributionSignals(
  findings: readonly unknown[],
): FapoAttributionSignals {
  const signals: FapoAttributionSignals = {
    counts: { prompt: 0, parameter: 0, structural: 0 },
    clusters: [],
  }
  for (const finding of findings) {
    collectFinding(signals, finding)
  }
  return signals
}

function collectFinding(signals: FapoAttributionSignals, finding: unknown): void {
  if (!finding) return
  if (typeof finding === 'string') {
    const level = inferLevelFromText(finding)
    if (level) addCluster(signals, { label: finding, level, count: 1 })
    return
  }
  if (Array.isArray(finding)) {
    for (const item of finding) collectFinding(signals, item)
    return
  }
  if (typeof finding !== 'object') return
  const obj = finding as Record<string, unknown>

  collectLevelPartition(signals, obj.level_partition ?? obj.levelPartition)
  collectCounts(signals, obj)
  collectClusters(signals, obj.clusters, true)

  const explicit = parseFindingLevel(obj.level ?? obj.optimization_level ?? obj.optimizationLevel)
  const text = textFields(obj)
  const inferred = explicit ?? inferLevelFromText(text)
  if (inferred) {
    addCluster(signals, {
      label: text || inferred,
      level: inferred,
      count: numberField(obj.count) ?? 1,
      confidence: confidenceField(obj.confidence),
      suggestedFix: stringField(obj.suggested_fix ?? obj.suggestedFix ?? obj.recommended_action),
      caseIds: stringArrayField(obj.case_ids ?? obj.caseIds),
    })
  }
}

function collectLevelPartition(signals: FapoAttributionSignals, raw: unknown): void {
  if (!raw || typeof raw !== 'object') return
  const partition = raw as Record<string, unknown>
  for (const level of FAPO_LEVELS) {
    const bucket = partition[level]
    if (!bucket || typeof bucket !== 'object') continue
    const obj = bucket as Record<string, unknown>
    const count = numberField(obj.count) ?? 0
    if (count > 0) signals.counts[level] += count
    collectClusters(signals, obj.clusters, false)
  }
}

function collectCounts(signals: FapoAttributionSignals, obj: Record<string, unknown>): void {
  const prompt = numberField(obj.prompt_addressable ?? obj.promptAddressable)
  const structural = numberField(obj.structural_addressable ?? obj.structuralAddressable)
  const tool = numberField(obj.tool_addressable ?? obj.toolAddressable)
  if (prompt) signals.counts.prompt += prompt
  if (structural) signals.counts.structural += structural
  if (tool) signals.counts.structural += tool
}

function collectClusters(
  signals: FapoAttributionSignals,
  raw: unknown,
  countClusters: boolean,
): void {
  if (!Array.isArray(raw)) return
  for (const item of raw) {
    if (countClusters) {
      collectFinding(signals, item)
      continue
    }
    const cluster = parseCluster(item)
    if (cluster) signals.clusters.push(cluster)
  }
}

function addCluster(signals: FapoAttributionSignals, cluster: FapoFailureCluster): void {
  signals.counts[cluster.level] += Math.max(1, cluster.count)
  signals.clusters.push(cluster)
}

function parseCluster(raw: unknown): FapoFailureCluster | null {
  if (!raw || typeof raw !== 'object') return null
  const obj = raw as Record<string, unknown>
  const text = textFields(obj)
  const level =
    parseFindingLevel(obj.level ?? obj.optimization_level ?? obj.optimizationLevel) ??
    inferLevelFromText(text)
  if (!level) return null
  return {
    label: text || level,
    level,
    count: numberField(obj.count) ?? 1,
    confidence: confidenceField(obj.confidence),
    suggestedFix: stringField(obj.suggested_fix ?? obj.suggestedFix ?? obj.recommended_action),
    caseIds: stringArrayField(obj.case_ids ?? obj.caseIds),
  }
}

function parseFindingLevel(raw: unknown): FapoOptimizationLevel | null {
  if (typeof raw !== 'string') return null
  const lower = raw.toLowerCase()
  if (lower === 'prompt' || lower === 'parameter' || lower === 'structural') return lower
  if (lower === 'chain' || lower === 'tool' || lower === 'code') return 'structural'
  if (lower === 'config' || lower === 'params') return 'parameter'
  return null
}

function inferLevelFromText(text: string): FapoOptimizationLevel | null {
  const lower = text.toLowerCase()
  if (
    /\b(retrieval_k|temperature|top_p|max_tokens|max_completion_tokens|reasoning_effort|config|parameter)\b/.test(
      lower,
    )
  ) {
    return 'parameter'
  }
  if (
    /\b(retriev\w*|search\w*|bm25|hop|evidence|cascade|tool|node|chain|state|structur\w*|topology|import)\b/.test(
      lower,
    )
  ) {
    return 'structural'
  }
  if (
    /\b(format\w*|verbose|brevity|abstain\w*|reasoning|instruction|prompt|output|answer)\b/.test(
      lower,
    )
  ) {
    return 'prompt'
  }
  return null
}

function textFields(obj: Record<string, unknown>): string {
  return [
    obj.label,
    obj.claim,
    obj.recommended_action,
    obj.suggested_fix,
    obj.suggestedFix,
    obj.message,
    obj.text,
    obj.heuristic,
    obj.area,
  ]
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .join(' ')
}

function numberField(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function confidenceField(value: unknown): FapoFailureCluster['confidence'] {
  return value === 'high' || value === 'medium' || value === 'low' ? value : undefined
}

function stringArrayField(value: unknown): string[] | undefined {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : undefined
}

export type JsonPrimitive = string | number | boolean | null
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue }

export interface ParameterChange {
  path: string | readonly string[]
  value: JsonValue
}

export interface ParameterCandidate {
  label: string
  rationale: string
  /** Deep-merged into the current JSON surface. */
  patch?: Record<string, JsonValue>
  /** Dot-path writes, e.g. `{ path: 'retrieval.k', value: 10 }`. */
  changes?: readonly ParameterChange[]
}

export interface ParameterSweepDriverOptions {
  candidates: readonly ParameterCandidate[]
  /** Optional parser for non-JSON config surface strings. */
  parse?: (surface: string) => Record<string, JsonValue>
  /** Optional serializer for non-JSON config surface strings. */
  stringify?: (config: Record<string, JsonValue>) => string
}

/** Config/parameter-level driver for FAPO's middle escalation level. */
export function parameterSweepDriver(opts: ParameterSweepDriverOptions): ImprovementDriver {
  if (opts.candidates.length === 0) {
    throw new Error('parameterSweepDriver: candidates must not be empty')
  }
  return {
    kind: 'parameter-sweep',
    async propose(ctx: ProposeContext): Promise<ProposedCandidate[]> {
      if (typeof ctx.currentSurface !== 'string') {
        throw new Error('parameterSweepDriver: currentSurface must be a JSON string config surface')
      }
      const parse = opts.parse ?? parseJsonObject
      const stringify =
        opts.stringify ?? ((config: Record<string, JsonValue>) => JSON.stringify(config, null, 2))
      const current = parse(ctx.currentSurface)
      const tried = triedLabels(ctx.history)
      const out: ProposedCandidate[] = []
      for (const candidate of opts.candidates) {
        if (tried.has(candidate.label)) continue
        const next = applyParameterCandidate(current, candidate)
        const surface = stringify(next)
        if (surface === ctx.currentSurface) continue
        out.push({ surface, label: candidate.label, rationale: candidate.rationale })
        if (out.length >= ctx.populationSize) break
      }
      return out
    },
  }
}

function parseJsonObject(surface: string): Record<string, JsonValue> {
  const parsed = JSON.parse(surface)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('parameterSweepDriver: JSON surface must parse to an object')
  }
  return parsed as Record<string, JsonValue>
}

function triedLabels(history: readonly GenerationRecord[]): Set<string> {
  const tried = new Set<string>()
  for (const generation of history) {
    for (const candidate of generation.candidates) {
      if (!candidate.label) continue
      tried.add(candidate.label)
      tried.add(candidateStrategy(candidate))
    }
  }
  return tried
}

function applyParameterCandidate(
  current: Record<string, JsonValue>,
  candidate: ParameterCandidate,
): Record<string, JsonValue> {
  const next = cloneJsonObject(current)
  if (candidate.patch) deepMerge(next, candidate.patch)
  for (const change of candidate.changes ?? []) {
    setPath(
      next,
      typeof change.path === 'string' ? change.path.split('.') : [...change.path],
      change.value,
    )
  }
  return next
}

function cloneJsonObject(value: Record<string, JsonValue>): Record<string, JsonValue> {
  return JSON.parse(JSON.stringify(value)) as Record<string, JsonValue>
}

function deepMerge(target: Record<string, JsonValue>, patch: Record<string, JsonValue>): void {
  for (const [key, value] of Object.entries(patch)) {
    if (isPlainObject(value) && isPlainObject(target[key])) {
      deepMerge(target[key] as Record<string, JsonValue>, value as Record<string, JsonValue>)
    } else {
      target[key] = value
    }
  }
}

function setPath(target: Record<string, JsonValue>, path: string[], value: JsonValue): void {
  if (path.length === 0) throw new Error('parameterSweepDriver: change path must not be empty')
  let cursor: Record<string, JsonValue> = target
  for (const part of path.slice(0, -1)) {
    const existing = cursor[part]
    if (!isPlainObject(existing)) {
      cursor[part] = {}
    }
    cursor = cursor[part] as Record<string, JsonValue>
  }
  cursor[path[path.length - 1]!] = value
}

function isPlainObject(value: unknown): value is Record<string, JsonValue> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}
