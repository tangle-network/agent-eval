import { ValidationError } from '../errors'
import type {
  AnalyzeCrossSurfaceInteractionsInput,
  CrossSurfaceCandidate,
  CrossSurfaceComponent,
  CrossSurfaceTaskRow,
} from './cross-surface-types'

/** Validated indexes shared by analysis and deterministic selection. */
export interface CrossSurfaceAnalysisContext<TRow extends CrossSurfaceTaskRow> {
  input: AnalyzeCrossSurfaceInteractionsInput<TRow>
  components: CrossSurfaceComponent[]
  candidates: CrossSurfaceCandidate[]
  componentById: Map<string, CrossSurfaceComponent>
  candidateById: Map<string, CrossSurfaceCandidate>
  candidateByComponents: Map<string, CrossSurfaceCandidate>
  singleByComponent: Map<string, CrossSurfaceCandidate>
  rowsByCandidate: Map<string, Map<string, TRow>>
  componentIndex: Map<string, number>
  candidateIndex: Map<string, number>
}

export function validateCrossSurfaceInput<TRow extends CrossSurfaceTaskRow>(
  input: AnalyzeCrossSurfaceInteractionsInput<TRow>,
): CrossSurfaceAnalysisContext<TRow> {
  assertNonEmptyUnique(input.taskOrder, 'taskOrder')
  assertNonEmptyUnique(input.componentOrder, 'componentOrder')
  if (input.componentOrder.length < 2) {
    throw new ValidationError(
      'analyzeCrossSurfaceInteractions: componentOrder must contain at least two surfaces',
    )
  }
  assertNonEmptyUnique(input.candidateOrder, 'candidateOrder')
  assertNonEmptyUnique(input.costMetricOrder, 'costMetricOrder')
  if (input.costMetricOrder.includes('score')) {
    throw new ValidationError(
      `analyzeCrossSurfaceInteractions: costMetricOrder cannot contain reserved metric 'score'`,
    )
  }
  validateBootstrap(input)
  validateSelection(input)

  const componentById = indexUnique(
    input.components,
    (component) => component.componentId,
    'component',
  )
  assertExactSet(input.componentOrder, componentById.keys(), 'componentOrder', 'components')
  const surfaces = new Set<string>()
  for (const component of componentById.values()) {
    assertNonEmpty(component.componentId, 'componentId')
    assertNonEmpty(component.surfaceId, `surfaceId for component '${component.componentId}'`)
    if (surfaces.has(component.surfaceId)) {
      throw new ValidationError(
        `analyzeCrossSurfaceInteractions: surfaceId '${component.surfaceId}' has more than one component; ` +
          'the interaction stage requires one independently selected finalist per surface',
      )
    }
    surfaces.add(component.surfaceId)
    if (typeof component.bestSingleEligible !== 'boolean') {
      throw new ValidationError(
        `analyzeCrossSurfaceInteractions: component '${component.componentId}' must declare bestSingleEligible`,
      )
    }
  }

  const componentIndex = new Map(input.componentOrder.map((id, index) => [id, index]))
  const candidateById = indexUnique(
    input.candidates,
    (candidate) => candidate.candidateId,
    'candidate',
  )
  assertExactSet(input.candidateOrder, candidateById.keys(), 'candidateOrder', 'candidates')
  if (!candidateById.has(input.baselineCandidateId)) {
    throw new ValidationError(
      `analyzeCrossSurfaceInteractions: unknown baselineCandidateId '${input.baselineCandidateId}'`,
    )
  }

  const candidateByComponents = new Map<string, CrossSurfaceCandidate>()
  const singleByComponent = new Map<string, CrossSurfaceCandidate>()
  for (const candidate of candidateById.values()) {
    validateCandidate(candidate, componentById, componentIndex, input.baselineCandidateId)
    const key = crossSurfaceComponentSetKey(candidate.componentIds)
    const duplicate = candidateByComponents.get(key)
    if (duplicate) {
      throw new ValidationError(
        `analyzeCrossSurfaceInteractions: candidates '${duplicate.candidateId}' and ` +
          `'${candidate.candidateId}' materialize the same component set`,
      )
    }
    candidateByComponents.set(key, candidate)
    if (candidate.componentIds.length === 1) {
      singleByComponent.set(candidate.componentIds[0]!, candidate)
    }
  }
  const baseline = candidateById.get(input.baselineCandidateId)!
  if (baseline.componentIds.length !== 0) {
    throw new ValidationError(
      `analyzeCrossSurfaceInteractions: baseline '${baseline.candidateId}' must have zero components`,
    )
  }
  for (const componentId of input.componentOrder) {
    if (!singleByComponent.has(componentId)) {
      throw new ValidationError(
        `analyzeCrossSurfaceInteractions: no single-surface candidate for component '${componentId}'`,
      )
    }
  }
  for (let left = 0; left < input.componentOrder.length; left++) {
    for (let right = left + 1; right < input.componentOrder.length; right++) {
      const ids = [input.componentOrder[left]!, input.componentOrder[right]!]
      if (!candidateByComponents.has(crossSurfaceComponentSetKey(ids))) {
        throw new ValidationError(
          `analyzeCrossSurfaceInteractions: missing pair candidate for components [${ids.join(', ')}]`,
        )
      }
    }
  }

  const rowsByCandidate = new Map<string, Map<string, TRow>>()
  const taskIds = new Set(input.taskOrder)
  for (const row of input.rows) {
    const candidate = candidateById.get(row.candidateId)
    if (!candidate) {
      throw new ValidationError(
        `analyzeCrossSurfaceInteractions: row for task '${row.taskId}' names unknown candidate '${row.candidateId}'`,
      )
    }
    if (!taskIds.has(row.taskId)) {
      throw new ValidationError(
        `analyzeCrossSurfaceInteractions: row for candidate '${row.candidateId}' names task '${row.taskId}' ` +
          'outside the declared taskOrder',
      )
    }
    validateRow(input, row, candidate)
    const byTask = rowsByCandidate.get(row.candidateId) ?? new Map<string, TRow>()
    if (byTask.has(row.taskId)) {
      throw new ValidationError(
        `analyzeCrossSurfaceInteractions: duplicate row for candidate '${row.candidateId}' and task '${row.taskId}'`,
      )
    }
    byTask.set(row.taskId, row)
    rowsByCandidate.set(row.candidateId, byTask)
  }
  for (const candidateId of input.candidateOrder) {
    const byTask = rowsByCandidate.get(candidateId)
    const missing = input.taskOrder.filter((taskId) => !byTask?.has(taskId))
    if (missing.length > 0) {
      throw new ValidationError(
        `analyzeCrossSurfaceInteractions: candidate '${candidateId}' is missing declared task row(s) ` +
          `[${missing.join(', ')}]; encode failed attempts explicitly instead of changing the task axis`,
      )
    }
  }
  const expectedRows = input.candidateOrder.length * input.taskOrder.length
  if (input.rows.length !== expectedRows) {
    throw new ValidationError(
      `analyzeCrossSurfaceInteractions: expected exactly ${expectedRows} candidate × task rows, got ${input.rows.length}`,
    )
  }

  return {
    input,
    components: input.componentOrder.map((id) => componentById.get(id)!),
    candidates: input.candidateOrder.map((id) => candidateById.get(id)!),
    componentById,
    candidateById,
    candidateByComponents,
    singleByComponent,
    rowsByCandidate,
    componentIndex,
    candidateIndex: new Map(input.candidateOrder.map((id, index) => [id, index])),
  }
}

export function crossSurfaceRowsFor<TRow extends CrossSurfaceTaskRow>(
  context: CrossSurfaceAnalysisContext<TRow>,
  candidateId: string,
): TRow[] {
  return context.input.taskOrder.map((taskId) => crossSurfaceRowFor(context, candidateId, taskId))
}

export function crossSurfaceRowFor<TRow extends CrossSurfaceTaskRow>(
  context: CrossSurfaceAnalysisContext<TRow>,
  candidateId: string,
  taskId: string,
): TRow {
  return context.rowsByCandidate.get(candidateId)!.get(taskId)!
}

export function canonicalCrossSurfaceComponents<TRow extends CrossSurfaceTaskRow>(
  context: CrossSurfaceAnalysisContext<TRow>,
  componentIds: string[],
): string[] {
  return [...componentIds].sort(
    (left, right) => context.componentIndex.get(left)! - context.componentIndex.get(right)!,
  )
}

export function crossSurfaceComponentSetKey(componentIds: readonly string[]): string {
  return JSON.stringify(componentIds)
}

function validateBootstrap<TRow extends CrossSurfaceTaskRow>(
  input: AnalyzeCrossSurfaceInteractionsInput<TRow>,
): void {
  const { seed, resamples, confidence } = input.bootstrap
  if (!Number.isInteger(seed)) {
    throw new ValidationError(`analyzeCrossSurfaceInteractions: bootstrap.seed must be an integer`)
  }
  if (!Number.isInteger(resamples) || resamples <= 0) {
    throw new ValidationError(
      `analyzeCrossSurfaceInteractions: bootstrap.resamples must be a positive integer`,
    )
  }
  if (!Number.isFinite(confidence) || confidence <= 0 || confidence >= 1) {
    throw new ValidationError(
      `analyzeCrossSurfaceInteractions: bootstrap.confidence must be in (0,1)`,
    )
  }
}

function validateSelection<TRow extends CrossSurfaceTaskRow>(
  input: AnalyzeCrossSurfaceInteractionsInput<TRow>,
): void {
  const policy = input.selection
  for (const [name, value] of [
    ['minimumFiringTasks', policy.minimumFiringTasks],
    ['minimumEffectTasks', policy.minimumEffectTasks],
  ] as const) {
    if (!Number.isInteger(value) || value < 0 || value > input.taskOrder.length) {
      throw new ValidationError(
        `analyzeCrossSurfaceInteractions: selection.${name} must be an integer in [0,${input.taskOrder.length}]`,
      )
    }
  }
  if (!Number.isInteger(policy.minimumBundleComponents) || policy.minimumBundleComponents < 2) {
    throw new ValidationError(
      `analyzeCrossSurfaceInteractions: selection.minimumBundleComponents must be an integer >= 2`,
    )
  }
  for (const [metric, limit] of Object.entries(policy.maximumMedianCostRatioToBaseline)) {
    if (!input.costMetricOrder.includes(metric)) {
      throw new ValidationError(
        `analyzeCrossSurfaceInteractions: cost limit names undeclared metric '${metric}'`,
      )
    }
    if (!Number.isFinite(limit) || limit <= 0) {
      throw new ValidationError(
        `analyzeCrossSurfaceInteractions: cost ratio limit for '${metric}' must be positive and finite`,
      )
    }
  }
}

function validateCandidate(
  candidate: CrossSurfaceCandidate,
  componentById: Map<string, CrossSurfaceComponent>,
  componentIndex: Map<string, number>,
  baselineCandidateId: string,
): void {
  assertNonEmpty(candidate.candidateId, 'candidateId')
  assertNonEmpty(candidate.contentHash, `contentHash for candidate '${candidate.candidateId}'`)
  if (!Number.isInteger(candidate.artifactBytes) || candidate.artifactBytes < 0) {
    throw new ValidationError(
      `analyzeCrossSurfaceInteractions: artifactBytes for candidate '${candidate.candidateId}' must be a non-negative integer`,
    )
  }
  assertUnique(candidate.componentIds, `componentIds for candidate '${candidate.candidateId}'`)
  for (const componentId of candidate.componentIds) {
    if (!componentById.has(componentId)) {
      throw new ValidationError(
        `analyzeCrossSurfaceInteractions: candidate '${candidate.candidateId}' names unknown component '${componentId}'`,
      )
    }
  }
  const canonical = [...candidate.componentIds].sort(
    (left, right) => componentIndex.get(left)! - componentIndex.get(right)!,
  )
  if (!arraysEqual(candidate.componentIds, canonical)) {
    throw new ValidationError(
      `analyzeCrossSurfaceInteractions: candidate '${candidate.candidateId}' components must follow componentOrder`,
    )
  }
  if (candidate.candidateId !== baselineCandidateId && candidate.componentIds.length === 0) {
    throw new ValidationError(
      `analyzeCrossSurfaceInteractions: only baseline '${baselineCandidateId}' may have zero components`,
    )
  }
}

function validateRow<TRow extends CrossSurfaceTaskRow>(
  input: AnalyzeCrossSurfaceInteractionsInput<TRow>,
  row: TRow,
  candidate: CrossSurfaceCandidate,
): void {
  if (!arraysEqual(row.componentIds, candidate.componentIds)) {
    throw new ValidationError(
      `analyzeCrossSurfaceInteractions: row '${row.candidateId}/${row.taskId}' componentIds do not match its candidate`,
    )
  }
  if (!['complete', 'missing', 'invalid'].includes(row.completeness)) {
    throw new ValidationError(
      `analyzeCrossSurfaceInteractions: row '${row.candidateId}/${row.taskId}' has unknown completeness '${String(row.completeness)}'`,
    )
  }
  if (row.completeness === 'complete') {
    if (typeof row.pass !== 'boolean' || !Number.isFinite(row.score)) {
      throw new ValidationError(
        `analyzeCrossSurfaceInteractions: complete row '${row.candidateId}/${row.taskId}' requires boolean pass and finite score`,
      )
    }
    if (row.rejectReason !== null) {
      throw new ValidationError(
        `analyzeCrossSurfaceInteractions: complete row '${row.candidateId}/${row.taskId}' cannot carry rejectReason`,
      )
    }
  } else {
    if (row.pass !== null || row.score !== null) {
      throw new ValidationError(
        `analyzeCrossSurfaceInteractions: ${row.completeness} row '${row.candidateId}/${row.taskId}' must use null pass and score`,
      )
    }
    if (typeof row.rejectReason !== 'string' || row.rejectReason.trim() === '') {
      throw new ValidationError(
        `analyzeCrossSurfaceInteractions: ${row.completeness} row '${row.candidateId}/${row.taskId}' requires rejectReason`,
      )
    }
  }
  assertExactSet(
    input.costMetricOrder,
    Object.keys(row.cost),
    `cost keys for row '${row.candidateId}/${row.taskId}'`,
    'costMetricOrder',
  )
  for (const metric of input.costMetricOrder) {
    const value = row.cost[metric]
    if (value === null || value === undefined || !Number.isFinite(value) || value < 0) {
      throw new ValidationError(
        `analyzeCrossSurfaceInteractions: unknown or invalid cost '${metric}' on row ` +
          `'${row.candidateId}/${row.taskId}'; every attempt must report a non-negative finite value`,
      )
    }
  }
  const evidenceByComponent = indexUnique(
    row.componentEvidence,
    (evidence) => evidence.componentId,
    `componentEvidence on row '${row.candidateId}/${row.taskId}'`,
  )
  assertExactSet(
    candidate.componentIds,
    evidenceByComponent.keys(),
    `componentEvidence on row '${row.candidateId}/${row.taskId}'`,
    'candidate components',
  )
  for (const evidence of evidenceByComponent.values()) {
    assertTriState(evidence.fired, 'fired', row)
    assertTriState(evidence.effectObserved, 'effectObserved', row)
  }
}

function assertTriState<TRow extends CrossSurfaceTaskRow>(
  value: boolean | null,
  field: string,
  row: TRow,
): void {
  if (value !== true && value !== false && value !== null) {
    throw new ValidationError(
      `analyzeCrossSurfaceInteractions: ${field} on row '${row.candidateId}/${row.taskId}' must be boolean or null`,
    )
  }
}

function indexUnique<T>(
  items: readonly T[],
  id: (item: T) => string,
  label: string,
): Map<string, T> {
  const result = new Map<string, T>()
  for (const item of items) {
    const key = id(item)
    assertNonEmpty(key, `${label} id`)
    if (result.has(key)) {
      throw new ValidationError(`analyzeCrossSurfaceInteractions: duplicate ${label} id '${key}'`)
    }
    result.set(key, item)
  }
  return result
}

function assertNonEmptyUnique(values: readonly string[], label: string): void {
  if (values.length === 0) {
    throw new ValidationError(`analyzeCrossSurfaceInteractions: ${label} is empty`)
  }
  assertUnique(values, label)
  for (const value of values) assertNonEmpty(value, label)
}

function assertUnique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) {
    throw new ValidationError(`analyzeCrossSurfaceInteractions: ${label} contains duplicates`)
  }
}

function assertNonEmpty(value: string, label: string): void {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ValidationError(
      `analyzeCrossSurfaceInteractions: ${label} must be a non-empty string`,
    )
  }
}

function assertExactSet(
  expected: readonly string[],
  actualIterable: Iterable<string>,
  actualLabel: string,
  expectedLabel: string,
): void {
  const actual = [...actualIterable]
  const expectedSet = new Set(expected)
  const actualSet = new Set(actual)
  const missing = expected.filter((value) => !actualSet.has(value))
  const extra = actual.filter((value) => !expectedSet.has(value))
  if (missing.length > 0 || extra.length > 0 || actual.length !== expected.length) {
    throw new ValidationError(
      `analyzeCrossSurfaceInteractions: ${actualLabel} does not match ${expectedLabel}; ` +
        `missing=[${missing.join(', ')}], extra=[${extra.join(', ')}]`,
    )
  }
}

function arraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}
