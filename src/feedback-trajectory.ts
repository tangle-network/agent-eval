import type { DatasetScenario, DatasetSplit } from './dataset'
import type { ControlEvalResult, ControlRunResult, ControlStep } from './control-runtime'
import type { OptimizationExample } from './optimization-loop'

export type FeedbackArtifactType =
  | 'text'
  | 'code'
  | 'plan'
  | 'research'
  | 'action'
  | 'ui'
  | 'decision'
  | 'data'
  | 'other'

export type FeedbackLabelSource = 'user' | 'judge' | 'environment' | 'metric' | 'policy' | 'system'

export type FeedbackLabelKind =
  | 'approve'
  | 'reject'
  | 'select'
  | 'edit'
  | 'rank'
  | 'rate'
  | 'comment'
  | 'metric_outcome'
  | 'policy_block'
  | 'revision_request'

export type FeedbackSeverity = 'info' | 'warning' | 'error' | 'critical'

export interface FeedbackTask {
  intent: string
  context?: unknown
}

export interface ProposedSideEffect {
  type: string
  risk?: 'low' | 'medium' | 'high'
  costUsd?: number
  externalSideEffect?: boolean
  requiresApproval?: boolean
  metadata?: Record<string, unknown>
}

export interface FeedbackLabel {
  id?: string
  source: FeedbackLabelSource
  kind: FeedbackLabelKind
  value: unknown
  reason?: string
  severity?: FeedbackSeverity
  createdAt: string
  metadata?: Record<string, unknown>
}

export interface FeedbackAttempt {
  id: string
  stepIndex: number
  artifactType: FeedbackArtifactType
  artifact: unknown
  options?: unknown[]
  proposedAction?: ProposedSideEffect
  evals?: ControlEvalResult[]
  feedback?: FeedbackLabel[]
  createdAt: string
  metadata?: Record<string, unknown>
}

export interface FeedbackOutcome {
  success?: boolean
  score?: number
  metrics?: Record<string, number>
  costUsd?: number
  detail?: string
  observedAt?: string
  metadata?: Record<string, unknown>
}

export interface FeedbackTrajectory {
  id: string
  projectId?: string
  scenarioId?: string
  task: FeedbackTask
  attempts: FeedbackAttempt[]
  labels: FeedbackLabel[]
  outcome?: FeedbackOutcome
  split?: DatasetSplit
  tags?: Record<string, string>
  createdAt: string
  updatedAt?: string
  metadata?: Record<string, unknown>
}

export interface FeedbackTrajectoryStore {
  save(trajectory: FeedbackTrajectory): Promise<void>
  get(id: string): Promise<FeedbackTrajectory | null>
  list(filter?: FeedbackTrajectoryFilter): Promise<FeedbackTrajectory[]>
  appendAttempt(id: string, attempt: FeedbackAttempt): Promise<FeedbackTrajectory>
  appendLabel(id: string, label: FeedbackLabel, attemptId?: string): Promise<FeedbackTrajectory>
}

export interface FeedbackTrajectoryFilter {
  projectId?: string
  scenarioId?: string
  split?: DatasetSplit
  tag?: [string, string]
}

export interface FeedbackSplitPolicy {
  trainPct?: number
  devPct?: number
  testPct?: number
  holdoutPct?: number
}

export interface PreferenceMemoryEntry {
  instruction: string
  rationale: string
  weight: number
  sourceTrajectoryId: string
  sourceLabelId?: string
  category?: string
}

export interface FeedbackOptimizerRow extends OptimizationExample {
  trajectoryId: string
  labelKinds: FeedbackLabelKind[]
  score?: number
}

export interface FeedbackReplayResult {
  trajectoryId: string
  pass: boolean
  score?: number
  labels: FeedbackLabel[]
  outcome?: FeedbackOutcome
  metadata?: Record<string, unknown>
}

export interface FeedbackReplayAdapter {
  replay(trajectory: FeedbackTrajectory): Promise<Omit<FeedbackReplayResult, 'trajectoryId'>> | Omit<FeedbackReplayResult, 'trajectoryId'>
}

const DEFAULT_SPLIT_POLICY: Required<FeedbackSplitPolicy> = {
  trainPct: 70,
  devPct: 15,
  testPct: 10,
  holdoutPct: 5,
}

export class InMemoryFeedbackTrajectoryStore implements FeedbackTrajectoryStore {
  private readonly trajectories = new Map<string, FeedbackTrajectory>()

  async save(trajectory: FeedbackTrajectory): Promise<void> {
    this.trajectories.set(trajectory.id, cloneTrajectory(trajectory))
  }

  async get(id: string): Promise<FeedbackTrajectory | null> {
    const trajectory = this.trajectories.get(id)
    return trajectory ? cloneTrajectory(trajectory) : null
  }

  async list(filter: FeedbackTrajectoryFilter = {}): Promise<FeedbackTrajectory[]> {
    return [...this.trajectories.values()]
      .filter((trajectory) => matchesFilter(trajectory, filter))
      .map(cloneTrajectory)
  }

  async appendAttempt(id: string, attempt: FeedbackAttempt): Promise<FeedbackTrajectory> {
    const trajectory = this.trajectories.get(id)
    if (!trajectory) throw new Error(`FeedbackTrajectoryStore.appendAttempt: unknown trajectory "${id}"`)
    const next = cloneTrajectory({
      ...trajectory,
      attempts: [...trajectory.attempts, attempt],
      updatedAt: attempt.createdAt,
    })
    this.trajectories.set(id, next)
    return cloneTrajectory(next)
  }

  async appendLabel(id: string, label: FeedbackLabel, attemptId?: string): Promise<FeedbackTrajectory> {
    const trajectory = this.trajectories.get(id)
    if (!trajectory) throw new Error(`FeedbackTrajectoryStore.appendLabel: unknown trajectory "${id}"`)
    const attempts = attemptId
      ? trajectory.attempts.map((attempt) => attempt.id === attemptId
        ? { ...attempt, feedback: [...(attempt.feedback ?? []), label] }
        : attempt)
      : trajectory.attempts
    const next = cloneTrajectory({
      ...trajectory,
      attempts,
      labels: attemptId ? trajectory.labels : [...trajectory.labels, label],
      updatedAt: label.createdAt,
    })
    this.trajectories.set(id, next)
    return cloneTrajectory(next)
  }
}

export class FileSystemFeedbackTrajectoryStore implements FeedbackTrajectoryStore {
  private readonly dir: string
  private readonly memory = new InMemoryFeedbackTrajectoryStore()
  private loaded = false

  constructor(options: { dir: string }) {
    this.dir = options.dir
  }

  async save(trajectory: FeedbackTrajectory): Promise<void> {
    await this.load()
    await this.memory.save(trajectory)
    await this.append({ op: 'save', trajectory })
  }

  async get(id: string): Promise<FeedbackTrajectory | null> {
    await this.load()
    return this.memory.get(id)
  }

  async list(filter: FeedbackTrajectoryFilter = {}): Promise<FeedbackTrajectory[]> {
    await this.load()
    return this.memory.list(filter)
  }

  async appendAttempt(id: string, attempt: FeedbackAttempt): Promise<FeedbackTrajectory> {
    await this.load()
    const next = await this.memory.appendAttempt(id, attempt)
    await this.append({ op: 'appendAttempt', id, attempt })
    return next
  }

  async appendLabel(id: string, label: FeedbackLabel, attemptId?: string): Promise<FeedbackTrajectory> {
    await this.load()
    const next = await this.memory.appendLabel(id, label, attemptId)
    await this.append({ op: 'appendLabel', id, label, attemptId })
    return next
  }

  private async append(record: unknown): Promise<void> {
    const { appendFile, mkdir } = await import('node:fs/promises')
    const { join } = await import('node:path')
    await mkdir(this.dir, { recursive: true })
    await appendFile(join(this.dir, 'feedback-trajectories.ndjson'), JSON.stringify(record) + '\n', 'utf8')
  }

  private async load(): Promise<void> {
    if (this.loaded) return
    const { readFile } = await import('node:fs/promises')
    const { join } = await import('node:path')
    const file = join(this.dir, 'feedback-trajectories.ndjson')
    try {
      const raw = await readFile(file, 'utf8')
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue
        try {
          const record = JSON.parse(line) as
            | { op: 'save'; trajectory: FeedbackTrajectory }
            | { op: 'appendAttempt'; id: string; attempt: FeedbackAttempt }
            | { op: 'appendLabel'; id: string; label: FeedbackLabel; attemptId?: string }
          if (record.op === 'save') await this.memory.save(record.trajectory)
          if (record.op === 'appendAttempt') await this.memory.appendAttempt(record.id, record.attempt)
          if (record.op === 'appendLabel') await this.memory.appendLabel(record.id, record.label, record.attemptId)
        } catch {
          /* corrupt records are skipped so one bad line does not discard the corpus */
        }
      }
    } catch {
      /* first run */
    }
    this.loaded = true
  }
}

export function createFeedbackTrajectory(input: {
  id?: string
  projectId?: string
  scenarioId?: string
  task: FeedbackTask
  attempts?: FeedbackAttempt[]
  labels?: FeedbackLabel[]
  outcome?: FeedbackOutcome
  split?: DatasetSplit
  tags?: Record<string, string>
  createdAt?: string
  metadata?: Record<string, unknown>
}): FeedbackTrajectory {
  const createdAt = input.createdAt ?? new Date().toISOString()
  const id = input.id ?? `ft_${stableHash(`${input.projectId ?? ''}|${input.scenarioId ?? ''}|${input.task.intent}|${createdAt}`).toString(16)}`
  return {
    id,
    projectId: input.projectId,
    scenarioId: input.scenarioId,
    task: input.task,
    attempts: input.attempts ?? [],
    labels: input.labels ?? [],
    outcome: input.outcome,
    split: input.split,
    tags: input.tags,
    createdAt,
    metadata: input.metadata,
  }
}

export function assignFeedbackSplit(
  trajectory: Pick<FeedbackTrajectory, 'id' | 'projectId' | 'scenarioId' | 'task'>,
  policy: FeedbackSplitPolicy = {},
): DatasetSplit {
  const split = { ...DEFAULT_SPLIT_POLICY, ...policy }
  const total = split.trainPct + split.devPct + split.testPct + split.holdoutPct
  if (total <= 0) throw new Error('assignFeedbackSplit: split percentages must sum above zero')
  const bucket = stableHash(`${trajectory.projectId ?? ''}|${trajectory.scenarioId ?? ''}|${trajectory.id}|${trajectory.task.intent}`) % total
  if (bucket < split.trainPct) return 'train'
  if (bucket < split.trainPct + split.devPct) return 'dev'
  if (bucket < split.trainPct + split.devPct + split.testPct) return 'test'
  return 'holdout'
}

export function withAssignedFeedbackSplit(
  trajectory: FeedbackTrajectory,
  policy?: FeedbackSplitPolicy,
): FeedbackTrajectory {
  return {
    ...trajectory,
    split: trajectory.split ?? assignFeedbackSplit(trajectory, policy),
  }
}

export function feedbackTrajectoryToDatasetScenario(trajectory: FeedbackTrajectory): DatasetScenario {
  const withSplit = withAssignedFeedbackSplit(trajectory)
  return {
    id: withSplit.scenarioId ?? withSplit.id,
    split: withSplit.split,
    payload: withSplit,
    tags: {
      ...(withSplit.projectId ? { projectId: withSplit.projectId } : {}),
      ...(withSplit.tags ?? {}),
      source: 'feedback-trajectory',
    },
  }
}

export function feedbackTrajectoriesToDatasetScenarios(
  trajectories: FeedbackTrajectory[],
): DatasetScenario[] {
  return trajectories.map(feedbackTrajectoryToDatasetScenario)
}

export function feedbackTrajectoryToOptimizerRow(trajectory: FeedbackTrajectory): FeedbackOptimizerRow {
  const labels = allLabels(trajectory)
  return {
    scenarioId: trajectory.scenarioId ?? trajectory.id,
    trajectoryId: trajectory.id,
    labelKinds: [...new Set(labels.map((label) => label.kind))],
    score: trajectory.outcome?.score ?? scoreFromLabels(labels),
    metadata: {
      projectId: trajectory.projectId,
      split: trajectory.split,
      intent: trajectory.task.intent,
      attempts: trajectory.attempts.length,
      outcome: trajectory.outcome,
      labels,
    },
  }
}

export function feedbackTrajectoriesToOptimizerRows(
  trajectories: FeedbackTrajectory[],
): FeedbackOptimizerRow[] {
  return trajectories.map(feedbackTrajectoryToOptimizerRow)
}

export async function replayFeedbackTrajectory(
  trajectory: FeedbackTrajectory,
  adapter: FeedbackReplayAdapter,
): Promise<FeedbackReplayResult> {
  try {
    const result = await adapter.replay(trajectory)
    return {
      trajectoryId: trajectory.id,
      ...result,
    }
  } catch (err) {
    const createdAt = new Date().toISOString()
    const message = err instanceof Error ? err.message : String(err)
    return {
      trajectoryId: trajectory.id,
      pass: false,
      labels: [{
        source: 'system',
        kind: 'reject',
        value: false,
        reason: message,
        severity: 'error',
        createdAt,
      }],
      outcome: {
        success: false,
        score: 0,
        detail: message,
        observedAt: createdAt,
      },
      metadata: { replayError: true },
    }
  }
}

export async function replayFeedbackTrajectories(
  trajectories: FeedbackTrajectory[],
  adapter: FeedbackReplayAdapter,
): Promise<FeedbackReplayResult[]> {
  const results: FeedbackReplayResult[] = []
  for (const trajectory of trajectories) {
    results.push(await replayFeedbackTrajectory(trajectory, adapter))
  }
  return results
}

export function summarizePreferenceMemory(
  trajectories: FeedbackTrajectory[],
  options: { maxEntries?: number } = {},
): PreferenceMemoryEntry[] {
  const maxEntries = options.maxEntries ?? 20
  const entries: PreferenceMemoryEntry[] = []
  for (const trajectory of trajectories) {
    for (const label of allLabels(trajectory)) {
      const instruction = instructionFromLabel(trajectory, label)
      if (!instruction) continue
      entries.push({
        instruction,
        rationale: label.reason ?? `${label.kind} label from ${label.source}`,
        weight: weightForLabel(label),
        sourceTrajectoryId: trajectory.id,
        sourceLabelId: label.id,
        category: label.kind,
      })
    }
  }

  const byInstruction = new Map<string, PreferenceMemoryEntry>()
  for (const entry of entries) {
    const key = entry.instruction.toLowerCase().replace(/\s+/g, ' ').trim()
    const existing = byInstruction.get(key)
    if (!existing || entry.weight > existing.weight) byInstruction.set(key, entry)
  }
  return [...byInstruction.values()]
    .sort((a, b) => b.weight - a.weight)
    .slice(0, maxEntries)
}

export function renderPreferenceMemoryMarkdown(entries: PreferenceMemoryEntry[]): string {
  const lines = ['# Preference Memory', '']
  for (const entry of entries) {
    lines.push(`- ${entry.instruction}`)
    lines.push(`  Rationale: ${entry.rationale}`)
    lines.push(`  Source: ${entry.sourceTrajectoryId}`)
    lines.push('')
  }
  return lines.join('\n').trim() + '\n'
}

export function serializeFeedbackTrajectoriesJsonl(trajectories: FeedbackTrajectory[]): string {
  return trajectories
    .slice()
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((trajectory) => JSON.stringify(canonicalize(trajectory)))
    .join('\n') + '\n'
}

export function parseFeedbackTrajectoriesJsonl(jsonl: string): FeedbackTrajectory[] {
  const trajectories: FeedbackTrajectory[] = []
  for (const line of jsonl.split('\n')) {
    if (!line.trim()) continue
    trajectories.push(JSON.parse(line) as FeedbackTrajectory)
  }
  return trajectories
}

export function controlRunToFeedbackTrajectory<TState, TAction, TActionResult>(
  run: ControlRunResult<TState, TAction, TActionResult>,
  options: {
    projectId?: string
    scenarioId?: string
    artifactType?: FeedbackArtifactType
    artifactFromStep?: (step: ControlStep<TState, TAction, TActionResult>) => unknown
    proposedActionFromStep?: (step: ControlStep<TState, TAction, TActionResult>) => ProposedSideEffect | undefined
    createdAt?: string
  } = {},
): FeedbackTrajectory {
  const createdAt = options.createdAt ?? new Date().toISOString()
  const trajectoryId = run.runId ?? `ft_control_${stableHash(`${run.intent}|${createdAt}`).toString(16)}`
  return createFeedbackTrajectory({
    id: trajectoryId,
    projectId: options.projectId,
    scenarioId: options.scenarioId,
    task: { intent: run.intent },
    createdAt,
    attempts: run.steps.map((step) => ({
      id: `${trajectoryId}_step_${step.index}`,
      stepIndex: step.index,
      artifactType: options.artifactType ?? 'action',
      artifact: options.artifactFromStep?.(step) ?? step.actionOutcome?.result ?? step.decision,
      proposedAction: options.proposedActionFromStep?.(step),
      evals: step.evalsAfter,
      createdAt: step.startedAt,
      metadata: {
        decision: step.decision,
        actionOutcome: step.actionOutcome,
      },
    })),
    labels: [
      {
        source: 'system',
        kind: run.pass ? 'approve' : 'reject',
        value: run.pass,
        reason: run.reason,
        severity: run.pass ? 'info' : 'error',
        createdAt,
      },
    ],
    outcome: {
      success: run.pass,
      score: run.score,
      costUsd: run.spentCostUsd,
      detail: run.reason,
      observedAt: createdAt,
      metadata: {
        stoppedBy: run.stoppedBy,
        failureClass: run.failureClass,
      },
    },
  })
}

function allLabels(trajectory: FeedbackTrajectory): FeedbackLabel[] {
  const labels = [
    ...trajectory.labels,
    ...trajectory.attempts.flatMap((attempt) => attempt.feedback ?? []),
  ]
  const seen = new Set<string>()
  return labels.filter((label) => {
    const key = label.id ?? `${label.source}|${label.kind}|${label.createdAt}|${JSON.stringify(label.value)}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function scoreFromLabels(labels: FeedbackLabel[]): number | undefined {
  if (!labels.length) return undefined
  const scored = labels.map((label) => {
    if (label.kind === 'approve' || label.kind === 'select') return 1
    if (label.kind === 'reject' || label.kind === 'policy_block') return 0
    if (label.kind === 'rate' && typeof label.value === 'number') return Math.max(0, Math.min(1, label.value))
    return undefined
  }).filter((value): value is number => typeof value === 'number')
  if (!scored.length) return undefined
  return Math.round((scored.reduce((sum, value) => sum + value, 0) / scored.length) * 1000) / 1000
}

function instructionFromLabel(trajectory: FeedbackTrajectory, label: FeedbackLabel): string | undefined {
  if (label.kind === 'reject' && label.reason) return `Avoid outputs like "${compact(trajectory.task.intent, 80)}" when: ${label.reason}`
  if (label.kind === 'revision_request' && label.reason) return `Revise similar work by applying: ${label.reason}`
  if (label.kind === 'select' && label.reason) return `Prefer selected options for "${compact(trajectory.task.intent, 80)}" because: ${label.reason}`
  if (label.kind === 'approve' && label.reason) return `Repeat the pattern approved for "${compact(trajectory.task.intent, 80)}": ${label.reason}`
  if (label.kind === 'comment' && label.reason) return label.reason
  return undefined
}

function weightForLabel(label: FeedbackLabel): number {
  const severity = label.severity === 'critical' ? 4 : label.severity === 'error' ? 3 : label.severity === 'warning' ? 2 : 1
  const source = label.source === 'user' ? 3 : label.source === 'metric' || label.source === 'environment' ? 2 : 1
  return severity * source
}

function matchesFilter(trajectory: FeedbackTrajectory, filter: FeedbackTrajectoryFilter): boolean {
  if (filter.projectId && trajectory.projectId !== filter.projectId) return false
  if (filter.scenarioId && trajectory.scenarioId !== filter.scenarioId) return false
  if (filter.split && trajectory.split !== filter.split) return false
  if (filter.tag) {
    const [key, value] = filter.tag
    if (trajectory.tags?.[key] !== value) return false
  }
  return true
}

function cloneTrajectory(trajectory: FeedbackTrajectory): FeedbackTrajectory {
  return JSON.parse(JSON.stringify(trajectory)) as FeedbackTrajectory
}

function compact(value: string, max: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim()
  return normalized.length > max ? `${normalized.slice(0, max).trim()}...` : normalized
}

function stableHash(input: string): number {
  let hash = 2166136261
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

function canonicalize(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(canonicalize)
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    out[key] = canonicalize((value as Record<string, unknown>)[key])
  }
  return out
}
