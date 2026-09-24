/**
 * Step diff between two runs, with the first divergence marked.
 *
 * Steps pair in three passes, each over the steps still unpaired:
 *   1. `id`: the same step id in both runs, e.g. a forked run that kept its
 *      parent's span ids.
 *   2. `position`: the same index with the same name and kind.
 *   3. `name`: the same name and kind anywhere, first unpaired step in order.
 * A step left unpaired exists in only one run. The first divergence is the
 * first index at which the two runs stop agreeing step for step, and it says
 * how: a paired step changed, one run replaced, added or removed a step, or the
 * runs ran the same steps in a different order.
 *
 * `diffSteps` reads plain `DiffStep` lists, so the same diff serves agent-eval
 * trace stores (`firstDivergenceView`) and flat OTLP spans
 * (`diffStepsFromSpans`). Use it to attribute "why is variant B better?" to a
 * step, and to compare sibling or parent and child runs of a search tree.
 */

import type { DiagnosisSpan } from '../diagnosis/spans'
import type { Span } from '../trace/schema'
import type { TraceStore } from '../trace/store'
import { buildTrajectory, type TrajectoryStep } from '../trajectory'

/** One step of a run, as the diff reads it. */
export interface DiffStep {
  /** The step's id within its run. */
  id: string
  name: string
  kind: string
  /** Fields compared once two steps pair, such as status, tool or model. */
  fields: Readonly<Record<string, string | number | boolean | null>>
}

export type StepPairing = 'id' | 'position' | 'name'

export interface FieldDifference {
  field: string
  a: string | number | boolean | null
  b: string | number | boolean | null
}

export interface StepPair {
  /** Index in run A. */
  a: number
  /** Index in run B. */
  b: number
  pairedBy: StepPairing
  /** Empty when the paired steps agree on name, kind and every field. */
  differences: FieldDifference[]
}

export type StepDivergenceKind = 'changed' | 'replaced' | 'only-in-a' | 'only-in-b' | 'reordered'

export interface StepDivergence {
  /** The first index at which the runs stop agreeing; equals `commonPrefixLen`. */
  index: number
  kind: StepDivergenceKind
  /** Index of the step at `index` in each run, or null when that run has ended. */
  a: number | null
  b: number | null
  /** Set when `kind` is `changed`. */
  differences: FieldDifference[]
  reason: string
}

export interface StepDiff {
  /** Paired steps in run A order. */
  pairs: StepPair[]
  /** Indexes of run A steps with no partner in run B. */
  onlyInA: number[]
  /** Indexes of run B steps with no partner in run A. */
  onlyInB: number[]
  /** Leading steps paired index for index with no difference. */
  commonPrefixLen: number
  /** Null when the runs agree step for step. */
  firstDivergence: StepDivergence | null
}

export function diffSteps(a: readonly DiffStep[], b: readonly DiffStep[]): StepDiff {
  const partnerOfA = new Map<number, { b: number; pairedBy: StepPairing }>()
  const pairedB = new Set<number>()
  const pair = (i: number, j: number, pairedBy: StepPairing) => {
    partnerOfA.set(i, { b: j, pairedBy })
    pairedB.add(j)
  }

  const bById = new Map<string, number[]>()
  b.forEach((step, j) => {
    const list = bById.get(step.id)
    if (list) list.push(j)
    else bById.set(step.id, [j])
  })
  a.forEach((step, i) => {
    const j = bById.get(step.id)?.find((candidate) => !pairedB.has(candidate))
    if (j !== undefined) pair(i, j, 'id')
  })
  a.forEach((step, i) => {
    if (partnerOfA.has(i) || i >= b.length || pairedB.has(i)) return
    if (sameShape(step, b[i]!)) pair(i, i, 'position')
  })
  a.forEach((step, i) => {
    if (partnerOfA.has(i)) return
    const j = b.findIndex((candidate, index) => !pairedB.has(index) && sameShape(step, candidate))
    if (j >= 0) pair(i, j, 'name')
  })

  const pairs: StepPair[] = [...partnerOfA.entries()]
    .sort(([x], [y]) => x - y)
    .map(([i, partner]) => ({
      a: i,
      b: partner.b,
      pairedBy: partner.pairedBy,
      differences: differencesBetween(a[i]!, b[partner.b]!),
    }))
  const pairByA = new Map(pairs.map((entry) => [entry.a, entry]))
  const partnerOfB = new Map(pairs.map((entry) => [entry.b, entry.a]))

  let prefix = 0
  while (prefix < a.length && prefix < b.length) {
    const entry = pairByA.get(prefix)
    if (!entry || entry.b !== prefix || entry.differences.length > 0) break
    prefix += 1
  }

  return {
    pairs,
    onlyInA: a.map((_, i) => i).filter((i) => !partnerOfA.has(i)),
    onlyInB: b.map((_, j) => j).filter((j) => !pairedB.has(j)),
    commonPrefixLen: prefix,
    firstDivergence:
      prefix === a.length && prefix === b.length
        ? null
        : divergenceAt(prefix, a, b, pairByA.get(prefix), partnerOfB),
  }
}

function divergenceAt(
  index: number,
  a: readonly DiffStep[],
  b: readonly DiffStep[],
  pairOfA: StepPair | undefined,
  partnerOfB: ReadonlyMap<number, number>,
): StepDivergence {
  const stepA = a[index]
  const stepB = b[index]
  const base = {
    index,
    a: stepA ? index : null,
    b: stepB ? index : null,
    differences: [] as FieldDifference[],
  }
  if (stepA && stepB && pairOfA?.b === index) {
    return {
      ...base,
      kind: 'changed',
      differences: pairOfA.differences,
      reason: `at index ${index}, ${describe(stepA)} changed: ${pairOfA.differences
        .map((d) => `${d.field} ${String(d.a)} vs ${String(d.b)}`)
        .join('; ')}`,
    }
  }
  const aUnpaired = stepA !== undefined && pairOfA === undefined
  const bUnpaired = stepB !== undefined && !partnerOfB.has(index)
  if (stepA && stepB && aUnpaired && bUnpaired) {
    return {
      ...base,
      kind: 'replaced',
      reason: `at index ${index}, A ran ${describe(stepA)} and B ran ${describe(stepB)}`,
    }
  }
  if (stepA && aUnpaired) {
    return {
      ...base,
      kind: 'only-in-a',
      reason: `at index ${index}, only A has ${describe(stepA)}`,
    }
  }
  if (stepB && bUnpaired) {
    return {
      ...base,
      kind: 'only-in-b',
      reason: `at index ${index}, only B has ${describe(stepB)}`,
    }
  }
  return {
    ...base,
    kind: 'reordered',
    reason: `at index ${index}, A ran ${describe(stepA!)} and B ran ${describe(stepB!)}; both steps occur in the other run at a different position`,
  }
}

function sameShape(x: DiffStep, y: DiffStep): boolean {
  return x.name === y.name && x.kind === y.kind
}

function differencesBetween(x: DiffStep, y: DiffStep): FieldDifference[] {
  const differences: FieldDifference[] = []
  if (x.kind !== y.kind) differences.push({ field: 'kind', a: x.kind, b: y.kind })
  if (x.name !== y.name) differences.push({ field: 'name', a: x.name, b: y.name })
  const fields = [...new Set([...Object.keys(x.fields), ...Object.keys(y.fields)])].sort()
  for (const field of fields) {
    const left = x.fields[field] ?? null
    const right = y.fields[field] ?? null
    if (left !== right) differences.push({ field, a: left, b: right })
  }
  return differences
}

function describe(step: DiffStep): string {
  return `${step.kind} "${step.name}"`
}

// ── agent-eval trace store ────────────────────────────────────────────

export interface DivergenceReport {
  runA: string
  runB: string
  /** Null when the runs agree step for step. */
  firstDivergenceIndex: number | null
  aStep?: TrajectoryStep
  bStep?: TrajectoryStep
  reason?: string
  commonPrefixLen: number
  /** The step diff behind the first divergence, over trajectory step indexes. */
  diff: StepDiff
}

export async function firstDivergenceView(
  store: TraceStore,
  runA: string,
  runB: string,
): Promise<DivergenceReport> {
  const [a, b] = await Promise.all([buildTrajectory(store, runA), buildTrajectory(store, runB)])
  const diff = diffSteps(a.steps.map(trajectoryDiffStep), b.steps.map(trajectoryDiffStep))
  const divergence = diff.firstDivergence
  return {
    runA,
    runB,
    firstDivergenceIndex: divergence?.index ?? null,
    ...(divergence?.a != null ? { aStep: a.steps[divergence.a] } : {}),
    ...(divergence?.b != null ? { bStep: b.steps[divergence.b] } : {}),
    ...(divergence ? { reason: divergence.reason } : {}),
    commonPrefixLen: diff.commonPrefixLen,
    diff,
  }
}

function trajectoryDiffStep(step: TrajectoryStep): DiffStep {
  const span: Span = step.span
  const fields: Record<string, string | number | boolean | null> = {
    status: span.status ?? null,
  }
  if (span.kind === 'tool') fields.tool = span.toolName
  if (span.kind === 'llm') fields.model = span.model
  if (span.kind === 'judge') fields.dimension = span.dimension
  return { id: span.spanId, name: span.name, kind: span.kind, fields }
}

// ── flat OTLP spans ───────────────────────────────────────────────────

/**
 * One run's spans as diff steps, in containment order: depth first, siblings
 * by start time, the same order `buildTrajectory` gives a trace store run.
 * Spans whose parent is absent, or whose parents form a cycle, start their own
 * subtree, so every span appears exactly once.
 */
export function diffStepsFromSpans(spans: readonly DiagnosisSpan[]): DiffStep[] {
  const ids = new Set(spans.map((span) => span.spanId))
  const children = new Map<string | null, DiagnosisSpan[]>()
  for (const span of spans) {
    const parent =
      span.parentSpanId !== null && ids.has(span.parentSpanId) ? span.parentSpanId : null
    const list = children.get(parent)
    if (list) list.push(span)
    else children.set(parent, [span])
  }
  const byStart = (x: DiagnosisSpan, y: DiagnosisSpan) =>
    (x.startMs ?? 0) - (y.startMs ?? 0) || x.spanId.localeCompare(y.spanId)
  for (const list of children.values()) list.sort(byStart)
  const ordered: DiffStep[] = []
  const visited = new Set<string>()
  const visit = (span: DiagnosisSpan) => {
    if (visited.has(span.spanId)) return
    visited.add(span.spanId)
    ordered.push({
      id: span.spanId,
      name: span.name,
      kind: span.kind,
      fields: { status: span.status, tool: span.toolName, model: span.model },
    })
    for (const child of children.get(span.spanId) ?? []) visit(child)
  }
  for (const root of children.get(null) ?? []) visit(root)
  for (const span of [...spans].sort(byStart)) visit(span)
  return ordered
}
