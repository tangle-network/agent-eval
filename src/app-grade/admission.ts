/**
 * The calibration record of one App Grade task and the rule that admits it.
 *
 * Calibration grades three submissions, each several times against a fresh product:
 *
 *   reference  the correct build
 *   stale      the build a model writes from memory of an older product surface
 *   broken     the reference with one planted defect
 *
 * A task is admitted only when every reference run reaches the task's pass tier and every
 * stale and broken run fails a gate (F or C). A task whose check separates them only
 * sometimes cannot score a contestant, so one disagreeing run refuses it.
 *
 * The record keeps every input `deriveVerdict` read, so the admission gate re-derives each
 * tier offline instead of trusting the stored one.
 */
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { canonicalString, jsonDocument } from '../ledger-core/canonical'
import {
  deriveVerdict,
  type EngineeringGates,
  TIER_ORDER,
  type Tier,
  type VerdictCheck,
  type VerdictReview,
} from './verdict'

export const CALIBRATION_SCHEMA = 'app-grade-calibration/1'
export const TASK_SCHEMA = 'app-grade-task/1'
export const PLANTS = ['reference', 'stale', 'broken'] as const
export type Plant = (typeof PLANTS)[number]
/** The fewest runs per submission that can show a check separates them every time. */
export const MIN_CALIBRATION_RUNS = 3

export interface CalibrationRun {
  plant: Plant
  run: number
  served: boolean
  checks: VerdictCheck[]
  reviews: VerdictReview[]
  engineering: EngineeringGates
  unmeasured: string[]
  /** The tier the grader stored. Admission re-derives it. */
  tier: Tier
  invalid: boolean
  costUsd: number
  ms: number
  /** Run directory relative to the calibration directory. */
  evidence: string
  /** Errors of earlier grading attempts of this run that threw before any verdict existed. */
  failedAttempts?: string[]
}

export interface CalibrationRecord {
  schema: typeof CALIBRATION_SCHEMA
  taskId: string
  /** `taskDigest` of the task material that was graded. */
  taskDigest: string
  /** The product image every run started, pinned by digest. */
  productImage: string
  productVersion: string
  /** Canonical digest of each submission's files. */
  solutionDigests: Record<Plant, string>
  /** Digest of the App Grade sources that graded the runs. */
  graderDigest: string
  model: string
  passTier: Tier
  /** The check that encodes the fact a from-memory build gets wrong, when the task names one. */
  factCheckId?: string
  runs: CalibrationRun[]
  startedAt: string
  finishedAt: string
  costUsd: number
}

export interface CalibrationDecision {
  admitted: boolean
  reasons: string[]
  tiers: Record<Plant, Tier[]>
}

const rank = (tier: Tier) => TIER_ORDER.indexOf(tier)
const FAILING: ReadonlySet<Tier> = new Set(['F', 'C'])

export function calibrationDecision(record: CalibrationRecord): CalibrationDecision {
  const reasons: string[] = []
  const tiers = { reference: [], stale: [], broken: [] } as Record<Plant, Tier[]>
  if (record.schema !== CALIBRATION_SCHEMA) reasons.push(`schema must be ${CALIBRATION_SCHEMA}`)
  if (!TIER_ORDER.includes(record.passTier) || FAILING.has(record.passTier))
    reasons.push(`pass tier ${record.passTier} must be B, A or S`)
  for (const run of record.runs) {
    const derived = deriveVerdict({
      served: run.served,
      checks: run.checks,
      reviews: run.reviews,
      engineering: run.engineering,
      unmeasured: run.unmeasured,
    })
    if (derived.tier !== run.tier || derived.invalid !== run.invalid) {
      reasons.push(
        `${run.plant} run ${run.run}: stored tier ${run.tier}${run.invalid ? ' (invalid)' : ''} does not re-derive (${derived.tier}${derived.invalid ? ', invalid' : ''})`,
      )
    }
    if (!PLANTS.includes(run.plant)) continue
    tiers[run.plant].push(derived.tier)
    const where = `${run.plant} run ${run.run}`
    if (derived.invalid) reasons.push(`${where}: an integrity check was supported`)
    if (run.plant === 'reference' && rank(derived.tier) < rank(record.passTier))
      reasons.push(
        `${where}: tier ${derived.tier} is below the pass tier ${record.passTier}: ${derived.reasons.slice(0, 3).join('; ')}`,
      )
    if (run.plant !== 'reference' && !FAILING.has(derived.tier))
      reasons.push(`${where}: tier ${derived.tier} passes; a planted build must fail a gate`)
    if (record.factCheckId) {
      const fact = run.checks.find((check) => check.id === record.factCheckId)
      if (!fact) reasons.push(`${where}: fact check ${record.factCheckId} did not run`)
      else if (run.plant === 'reference' && fact.status !== 'pass')
        reasons.push(`${where}: fact check ${record.factCheckId} failed: ${fact.detail}`)
      else if (run.plant === 'stale' && fact.status !== 'fail')
        reasons.push(`${where}: the from-memory build passed fact check ${record.factCheckId}`)
    }
  }
  for (const plant of PLANTS) {
    if (tiers[plant].length < MIN_CALIBRATION_RUNS)
      reasons.push(
        `${plant}: ${tiers[plant].length} run(s); calibration needs ${MIN_CALIBRATION_RUNS}`,
      )
  }
  return { admitted: reasons.length === 0, reasons, tiers }
}

/** RFC 8785 canonical JSON of the value as a JSON file carries it (no undefined fields). */
export function canonicalJson(value: unknown): string {
  return canonicalString(jsonDocument(value))
}

export function sha256(text: string | Buffer): string {
  return createHash('sha256').update(text).digest('hex')
}

export function canonicalDigest(value: unknown): string {
  return sha256(canonicalJson(value))
}

/** Digest of a directory's files by relative path and content: one calibration submission. */
export function treeDigest(dir: string): string {
  const files = (at: string): Array<{ path: string; sha256: string }> =>
    readdirSync(at)
      .sort()
      .flatMap((name) => {
        const full = join(at, name)
        return statSync(full).isDirectory()
          ? files(full)
          : [{ path: relative(dir, full), sha256: sha256(readFileSync(full)) }]
      })
  return canonicalDigest(files(dir))
}

/**
 * The material one App Grade task is graded on. A seed projects to it by removing the
 * per-task records (`leaves`, `provenance`, `admission`, `validationMode`) and the product
 * from the suite, and the grader spec from the leaf; a task directory stores it as is.
 */
export interface TaskMaterial {
  id: string
  suite: Record<string, unknown>
  leaf: Record<string, unknown>
  product: unknown
  spec: unknown
}

/** One digest binds a calibration record to the exact suite, leaf, product and grader spec. */
export function taskMaterialDigest(task: TaskMaterial): string {
  return canonicalDigest({
    schema: TASK_SCHEMA,
    id: task.id,
    suite: task.suite,
    leaf: task.leaf,
    product: task.product,
    spec: task.spec,
  })
}
