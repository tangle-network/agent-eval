import type {
  CrossSurfaceCandidateEvidence,
  CrossSurfaceEvidenceBreakdown,
  CrossSurfacePairEvidence,
  CrossSurfaceTaskRow,
} from './cross-surface-types'

export function summarizeCandidateEvidence<TRow extends CrossSurfaceTaskRow>(
  rows: TRow[],
  componentIds: string[],
  field: 'fired' | 'effectObserved',
): CrossSurfaceCandidateEvidence {
  if (componentIds.length === 0) {
    return {
      byComponent: [],
      allObservedTaskIds: [],
      someObservedTaskIds: [],
      noneObservedTaskIds: [],
      unobservedTaskIds: [],
    }
  }
  const byComponent: CrossSurfaceEvidenceBreakdown[] = componentIds.map((componentId) => {
    const observedTaskIds: string[] = []
    const notObservedTaskIds: string[] = []
    const unobservedTaskIds: string[] = []
    for (const row of rows) {
      const value = evidenceValue(row, componentId, field)
      if (value === true) observedTaskIds.push(row.taskId)
      else if (value === false) notObservedTaskIds.push(row.taskId)
      else unobservedTaskIds.push(row.taskId)
    }
    return { componentId, observedTaskIds, notObservedTaskIds, unobservedTaskIds }
  })
  const allObservedTaskIds: string[] = []
  const someObservedTaskIds: string[] = []
  const noneObservedTaskIds: string[] = []
  const unobservedTaskIds: string[] = []
  for (const row of rows) {
    const values = componentIds.map((componentId) => evidenceValue(row, componentId, field))
    if (values.some((value) => value === null)) unobservedTaskIds.push(row.taskId)
    else if (values.every(Boolean)) allObservedTaskIds.push(row.taskId)
    else if (values.some(Boolean)) someObservedTaskIds.push(row.taskId)
    else noneObservedTaskIds.push(row.taskId)
  }
  return {
    byComponent,
    allObservedTaskIds,
    someObservedTaskIds,
    noneObservedTaskIds,
    unobservedTaskIds,
  }
}

export function summarizePairEvidence<TRow extends CrossSurfaceTaskRow>(
  rows: TRow[],
  leftComponentId: string,
  rightComponentId: string,
  field: 'fired' | 'effectObserved',
): CrossSurfacePairEvidence {
  const bothTaskIds: string[] = []
  const leftOnlyTaskIds: string[] = []
  const rightOnlyTaskIds: string[] = []
  const neitherTaskIds: string[] = []
  const unobservedTaskIds: string[] = []
  for (const row of rows) {
    const left = evidenceValue(row, leftComponentId, field)
    const right = evidenceValue(row, rightComponentId, field)
    if (left === null || right === null) unobservedTaskIds.push(row.taskId)
    else if (left && right) bothTaskIds.push(row.taskId)
    else if (left) leftOnlyTaskIds.push(row.taskId)
    else if (right) rightOnlyTaskIds.push(row.taskId)
    else neitherTaskIds.push(row.taskId)
  }
  return {
    bothTaskIds,
    leftOnlyTaskIds,
    rightOnlyTaskIds,
    neitherTaskIds,
    unobservedTaskIds,
  }
}

function evidenceValue(
  row: CrossSurfaceTaskRow,
  componentId: string,
  field: 'fired' | 'effectObserved',
): boolean | null {
  return row.componentEvidence.find((evidence) => evidence.componentId === componentId)![field]
}

export function appendEvidenceReasons<TReason extends string>(
  reasons: TReason[],
  evidence: CrossSurfaceCandidateEvidence,
  minimum: number,
  requireObserved: boolean,
  belowReason: TReason,
  unobservedReason: TReason,
): void {
  if (evidence.byComponent.some((component) => component.observedTaskIds.length < minimum)) {
    reasons.push(belowReason)
  }
  if (
    requireObserved &&
    evidence.byComponent.some((component) => component.unobservedTaskIds.length > 0)
  ) {
    reasons.push(unobservedReason)
  }
}
