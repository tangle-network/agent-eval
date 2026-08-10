/**
 * The denominator chain as a first-class object.
 *
 * A benchmark whose denominator is not auditable is not a benchmark. Every
 * stage names what entered, what it removed, and what survived, so
 * `input = surviving + sum(excluded)` reads off the table instead of being
 * trusted. A stage that gains rows is refused at construction — a funnel is
 * monotone by definition, and a non-monotone one is a broken denominator,
 * not a formatting choice.
 *
 * The object is its own JSON render; `renderFunnelTable` is the text render.
 * `executeAdmissionRule` produces one by running a sealed {@link AdmissionRule}
 * over evidence records.
 */

import { CaptureIntegrityError } from '../errors'
import { type AdmissionRule, type EvidenceRecord, evaluatePredicate } from './ast'

/** A funnel stage gained rows, double-counted them, or failed to reconcile. */
export class FunnelIntegrityError extends CaptureIntegrityError {}

export interface FunnelStageCount {
  id: string
  entering: number
  excluded: number
  remaining: number
  /** Named exclusion reasons summing to `excluded`, when the stage has them. */
  exclusions?: Record<string, number>
  /** Substrate checks this stage deliberately does not apply. Registered, never implicit. */
  waives?: string[]
}

export interface FunnelPartitionCount {
  id: string
  /** Stage whose excluded rows the partition draws from. */
  from: string
  count: number
  /** A partition is reported separately and never pooled into the survivors. */
  pooling: 'never'
}

export interface ExperimentFunnel {
  population: string
  input: number
  stages: FunnelStageCount[]
  surviving: number
  partitions: FunnelPartitionCount[]
}

export interface FunnelStageInput {
  id: string
  /** Rows this stage removed. */
  excluded: number
  exclusions?: Record<string, number>
  waives?: string[]
}

/**
 * Build a funnel from counts and refuse anything non-monotone.
 *
 * Refusals: a negative count, a stage that gains rows (excluded < 0 is the
 * only way to gain — `remaining = entering - excluded` by construction, so a
 * gain cannot be smuggled in through `remaining`), named exclusions that do
 * not sum to the stage total, and a partition drawing from an unknown stage
 * or exceeding what that stage excluded.
 */
export function buildFunnel(input: {
  population: string
  input: number
  stages: FunnelStageInput[]
  partitions?: { id: string; from: string; count: number }[]
}): ExperimentFunnel {
  if (!Number.isInteger(input.input) || input.input < 0) {
    throw new FunnelIntegrityError(
      `funnel input must be a non-negative integer, got ${input.input}`,
    )
  }
  let entering = input.input
  const stages: FunnelStageCount[] = []
  for (const stage of input.stages) {
    if (!Number.isInteger(stage.excluded)) {
      throw new FunnelIntegrityError(
        `funnel stage '${stage.id}' excluded count must be an integer, got ${stage.excluded}`,
      )
    }
    if (stage.excluded < 0) {
      throw new FunnelIntegrityError(
        `funnel stage '${stage.id}' gains ${-stage.excluded} rows — a funnel stage can only remove rows`,
      )
    }
    if (stage.excluded > entering) {
      throw new FunnelIntegrityError(
        `funnel stage '${stage.id}' excludes ${stage.excluded} rows but only ${entering} entered`,
      )
    }
    if (stage.exclusions) {
      const sum = Object.values(stage.exclusions).reduce((a, b) => a + b, 0)
      if (sum !== stage.excluded) {
        throw new FunnelIntegrityError(
          `funnel stage '${stage.id}' names exclusions summing to ${sum} but excludes ${stage.excluded}`,
        )
      }
    }
    const remaining = entering - stage.excluded
    stages.push({
      id: stage.id,
      entering,
      excluded: stage.excluded,
      remaining,
      ...(stage.exclusions ? { exclusions: { ...stage.exclusions } } : {}),
      ...(stage.waives ? { waives: [...stage.waives] } : {}),
    })
    entering = remaining
  }
  const byStage = new Map(stages.map((s) => [s.id, s]))
  const partitions: FunnelPartitionCount[] = (input.partitions ?? []).map((partition) => {
    const source = byStage.get(partition.from)
    if (!source) {
      throw new FunnelIntegrityError(
        `funnel partition '${partition.id}' draws from unknown stage '${partition.from}'`,
      )
    }
    if (partition.count < 0 || partition.count > source.excluded) {
      throw new FunnelIntegrityError(
        `funnel partition '${partition.id}' counts ${partition.count} rows but stage '${partition.from}' excluded ${source.excluded}`,
      )
    }
    return { id: partition.id, from: partition.from, count: partition.count, pooling: 'never' }
  })
  const funnel: ExperimentFunnel = {
    population: input.population,
    input: input.input,
    stages,
    surviving: entering,
    partitions,
  }
  assertFunnelReconciles(funnel)
  return funnel
}

/** A chain that does not add up is a broken denominator, so this throws. */
export function assertFunnelReconciles(funnel: ExperimentFunnel): void {
  const excluded = funnel.stages.reduce((sum, stage) => sum + stage.excluded, 0)
  if (funnel.input !== funnel.surviving + excluded) {
    throw new FunnelIntegrityError(
      `funnel '${funnel.population}' does not reconcile: input ${funnel.input} != surviving ${funnel.surviving} + excluded ${excluded}`,
    )
  }
  let entering = funnel.input
  for (const stage of funnel.stages) {
    if (stage.entering !== entering || stage.remaining !== stage.entering - stage.excluded) {
      throw new FunnelIntegrityError(
        `funnel '${funnel.population}' stage '${stage.id}' does not chain: ` +
          `entering ${stage.entering} (expected ${entering}), remaining ${stage.remaining}`,
      )
    }
    if (stage.remaining > stage.entering) {
      throw new FunnelIntegrityError(
        `funnel '${funnel.population}' stage '${stage.id}' gains rows: ${stage.entering} -> ${stage.remaining}`,
      )
    }
    entering = stage.remaining
  }
}

export interface AdmissionExecution {
  funnel: ExperimentFunnel
  survivors: EvidenceRecord[]
  /** Partition rows by partition id, reported separately and never pooled. */
  partitionRows: Record<string, EvidenceRecord[]>
}

/**
 * Run a sealed admission rule over evidence records. Each stage keeps the rows
 * its predicate accepts; partitions draw from the rows their source stage
 * dropped. The result embeds the funnel, so the denominator chain and the
 * surviving rows can never disagree.
 */
export function executeAdmissionRule(
  rule: AdmissionRule,
  records: readonly EvidenceRecord[],
): AdmissionExecution {
  let current = [...records]
  const droppedAt = new Map<string, EvidenceRecord[]>()
  const stageInputs: FunnelStageInput[] = []
  for (const stage of rule.stages) {
    const kept: EvidenceRecord[] = []
    const dropped: EvidenceRecord[] = []
    for (const record of current) {
      if (evaluatePredicate(stage.keep, record)) kept.push(record)
      else dropped.push(record)
    }
    droppedAt.set(stage.id, dropped)
    stageInputs.push({
      id: stage.id,
      excluded: dropped.length,
      ...(stage.waives ? { waives: stage.waives } : {}),
    })
    current = kept
  }
  const partitionRows: Record<string, EvidenceRecord[]> = {}
  const partitionCounts: { id: string; from: string; count: number }[] = []
  for (const partition of rule.partitions ?? []) {
    const source = droppedAt.get(partition.from)
    if (!source) {
      throw new FunnelIntegrityError(
        `admission partition '${partition.id}' draws from unknown stage '${partition.from}'`,
      )
    }
    const rows = source.filter((record) => evaluatePredicate(partition.keep, record))
    partitionRows[partition.id] = rows
    partitionCounts.push({ id: partition.id, from: partition.from, count: rows.length })
  }
  const funnel = buildFunnel({
    population: rule.population,
    input: records.length,
    stages: stageInputs,
    partitions: partitionCounts,
  })
  return { funnel, survivors: current, partitionRows }
}

/**
 * Chain two funnels whose boundary agrees: the second funnel's input must be
 * exactly the first funnel's survivors. Anything else is a gap or an
 * injection, and both are refused.
 */
export function composeFunnels(
  first: ExperimentFunnel,
  second: ExperimentFunnel,
): ExperimentFunnel {
  if (second.input !== first.surviving) {
    throw new FunnelIntegrityError(
      `cannot compose funnels: '${first.population}' survives ${first.surviving} rows but '${second.population}' starts from ${second.input}`,
    )
  }
  return buildFunnel({
    population: first.population,
    input: first.input,
    stages: [...first.stages, ...second.stages].map((stage) => ({
      id: stage.id,
      excluded: stage.excluded,
      ...(stage.exclusions ? { exclusions: stage.exclusions } : {}),
      ...(stage.waives ? { waives: stage.waives } : {}),
    })),
    partitions: [...first.partitions, ...second.partitions].map((partition) => ({
      id: partition.id,
      from: partition.from,
      count: partition.count,
    })),
  })
}

/**
 * Text render of the chain. One row per stage; the reconciliation line at the
 * bottom restates `input = surviving + excluded` so a reader can check the
 * arithmetic without a tool.
 */
export function renderFunnelTable(funnel: ExperimentFunnel): string {
  const rows = funnel.stages.map((stage) => [
    stage.id + (stage.waives?.length ? ` (waives: ${stage.waives.join(', ')})` : ''),
    String(stage.entering),
    String(stage.excluded),
    String(stage.remaining),
  ])
  const header = ['stage', 'entering', 'excluded', 'remaining']
  const widths = header.map((h, col) => Math.max(h.length, ...rows.map((r) => r[col]!.length)))
  const line = (cells: string[]): string =>
    cells.map((cell, col) => cell.padEnd(widths[col]!)).join('  ')
  const out: string[] = [
    `population: ${funnel.population}`,
    `input: ${funnel.input}`,
    line(header),
    line(widths.map((w) => '-'.repeat(w))),
    ...rows.map((r) => line(r)),
  ]
  const excluded = funnel.stages.reduce((sum, stage) => sum + stage.excluded, 0)
  out.push(
    `surviving: ${funnel.surviving}  (input ${funnel.input} = surviving ${funnel.surviving} + excluded ${excluded})`,
  )
  for (const partition of funnel.partitions) {
    out.push(
      `partition ${partition.id}: ${partition.count} rows from '${partition.from}' — reported separately, never pooled`,
    )
  }
  return out.join('\n')
}
