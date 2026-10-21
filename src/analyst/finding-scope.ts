/**
 * What a finding is about and what it was measured on — AnalystFinding 1.1.0.
 *
 * A 1.0.0 finding states a claim with no layer and no population, so "a flat
 * team beat a deep hierarchy", measured on 4 runs of one play where run 2
 * inherited run 1's code, reads exactly like a lab-wide rule. Schema 1.1.0
 * makes the population part of the record:
 *
 *   - `layer` names the level the claim is about, on one ladder from a single
 *     event up to the whole lab, plus `meta` for findings about the measurement
 *     itself (a judge, a ruler, an analyst).
 *   - `scope` names the measured population, its size and time window, and the
 *     domain path it was drawn from.
 *   - `method` says whether the claim was computed, measured or judged; a
 *     judged claim without calibration reads as uncalibrated.
 *   - `evidence_units` lists the measured units with their lineage. When it is
 *     present the stored `scope.n` and `scope.population` must equal it, so the
 *     declared population cannot drift from the evidence.
 *
 * A claim moves above the layer it was measured at only through `promote`.
 */

import { z } from 'zod'
import {
  ANALYST_SEVERITIES,
  type AnalystFinding,
  type AnalystSeverity,
  FINDING_SCOPE_FIELDS,
  type ProposalFinding,
} from './types'

/**
 * The layer ladder, lowest first. `problem` is what discovery-lab calls a
 * theatre. `meta` sits outside the ladder: it is about the instrument, not the
 * agents, so it never promotes and never bounds another layer.
 */
export const FINDING_LAYERS = [
  'event',
  'turn',
  'agent',
  'team',
  'run',
  'play',
  'problem',
  'domain',
  'lab',
  'meta',
] as const

export type FindingLayer = (typeof FINDING_LAYERS)[number]

/** Rank on the ladder; `meta` has none. */
function findingLayerRank(layer: FindingLayer): number | null {
  return layer === 'meta' ? null : FINDING_LAYERS.indexOf(layer)
}

export interface FindingScope {
  /**
   * Ids of the measured units. A population is stored resolved, never as a
   * query: the ids are what `n`, `evidence_units` and promotion's lineage
   * check are compared against, and a query re-run later can select a
   * different set. Select populations with `queryFindings` (layer, subject,
   * domain path, analyst) and store the ids it returned.
   */
  population: string[]
  /** Units measured. Below 2, readers label the finding an anecdote. */
  n: number
  /** ISO-8601 bounds of the measured activity. */
  window: { from: string; to: string }
  /** Domain taxonomy path of any depth, broadest first. */
  domain_path?: string[]
}

export interface FindingCalibration {
  /** Gold items the judge was scored against. */
  gold_n: number
  /** Share of gold items where the judge matched the gold label. */
  agreement: number
  /** Chance-corrected agreement (Cohen's κ). */
  kappa: number
}

export interface FindingMethod {
  kind: 'computed' | 'measured' | 'judged'
  name: string
  version: string
  calibration?: FindingCalibration
}

export interface FindingMeasure {
  name: string
  value: number
  unit: string
  interval?: [number, number]
  /** Confidence level of `interval`, in (0, 1). */
  level?: number
}

/**
 * One measured unit. `derived_from` is the unit this one inherited state from
 * (run 2 built on run 1's code): `null` records an independent start, and an
 * absent field records lineage nobody captured. Unknown lineage counts as
 * shared, so it can never manufacture independent support for a claim.
 */
export interface FindingEvidenceUnit {
  id: string
  layer: FindingLayer
  derived_from?: string | null
}

const nonEmpty = z.string().refine((value) => value.trim().length > 0, {
  message: 'must be a non-empty string',
})
const timestamp = z.string().refine((value) => Number.isFinite(Date.parse(value)), {
  message: 'must be a valid timestamp',
})
const finite = z.number().refine(Number.isFinite, { message: 'must be finite' })
const unitRate = finite.refine((value) => value >= 0 && value <= 1, { message: 'must be in [0,1]' })

const layerSchema = z.enum(FINDING_LAYERS)

const scopeSchema = z
  .object({
    population: z.array(nonEmpty),
    n: z.number().int().nonnegative(),
    window: z.object({ from: timestamp, to: timestamp }).strict(),
    domain_path: z.array(nonEmpty).min(1).optional(),
  })
  .strict()

const methodSchema = z
  .object({
    kind: z.enum(['computed', 'measured', 'judged']),
    name: nonEmpty,
    version: nonEmpty,
    calibration: z
      .object({
        gold_n: z.number().int().positive(),
        agreement: unitRate,
        kappa: finite.refine((value) => value >= -1 && value <= 1, {
          message: 'must be in [-1,1]',
        }),
      })
      .strict()
      .optional(),
  })
  .strict()

const measureSchema = z
  .object({
    name: nonEmpty,
    value: finite,
    unit: z.string(),
    interval: z.tuple([finite, finite]).optional(),
    level: finite
      .refine((value) => value > 0 && value < 1, { message: 'must be in (0,1)' })
      .optional(),
  })
  .strict()

const evidenceUnitSchema = z
  .object({
    id: nonEmpty,
    layer: layerSchema,
    derived_from: nonEmpty.nullable().optional(),
  })
  .strict()

const findingObject = z
  .object({
    schema_version: z.enum(['1.0.0', '1.1.0']),
    finding_id: nonEmpty,
    analyst_id: nonEmpty,
    produced_at: timestamp,
    severity: z.enum(ANALYST_SEVERITIES),
    area: nonEmpty,
    claim: nonEmpty,
    rationale: z.string().optional(),
    evidence_refs: z.array(
      z
        .object({
          kind: z.enum(['span', 'event', 'artifact', 'finding', 'metric']),
          uri: nonEmpty,
          excerpt: z.string().optional(),
        })
        .strict(),
    ),
    recommended_action: z.string().optional(),
    validation_plan: z.string().optional(),
    confidence: unitRate,
    subject: z.string().optional(),
    derived_from_judge: z.boolean().optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
    layer: layerSchema.optional(),
    scope: scopeSchema.optional(),
    method: methodSchema.optional(),
    measure: measureSchema.optional(),
    confounders: z.array(nonEmpty).optional(),
    valid_for: nonEmpty.optional(),
    claim_id: nonEmpty.optional(),
    evidence_units: z.array(evidenceUnitSchema).min(1).optional(),
  })
  .strict()

type FindingShape = z.infer<typeof findingObject>

function checkFinding(finding: FindingShape, context: z.RefinementCtx): void {
  const issue = (path: PropertyKey[], message: string): void =>
    context.addIssue({ code: 'custom', path, message })
  if (finding.schema_version === '1.0.0') {
    for (const field of FINDING_SCOPE_FIELDS) {
      if (finding[field] !== undefined) issue([field], `${field} requires schema_version 1.1.0`)
    }
    return
  }
  // A 1.1.0 finding exists to state its layer and population; one without
  // them is a 1.0.0 finding with a misleading version.
  if (finding.layer === undefined) issue(['layer'], '1.1.0 findings require a layer')
  if (finding.scope === undefined) issue(['scope'], '1.1.0 findings require a scope')
  if (finding.method === undefined) issue(['method'], '1.1.0 findings require a method')
  const { scope, measure, evidence_units: units } = finding
  if (scope) {
    if (Date.parse(scope.window.from) > Date.parse(scope.window.to)) {
      issue(['scope', 'window'], 'window.from must not be after window.to')
    }
    if (new Set(scope.population).size !== scope.population.length) {
      issue(['scope', 'population'], 'population ids must be unique')
    }
    if (scope.population.length > 0 && scope.population.length !== scope.n) {
      issue(['scope', 'n'], `n ${scope.n} does not match ${scope.population.length} population ids`)
    }
  }
  if (measure?.interval && measure.interval[0] > measure.interval[1]) {
    issue(['measure', 'interval'], 'interval lower bound exceeds its upper bound')
  }
  if (measure?.level !== undefined && measure.interval === undefined) {
    issue(['measure', 'level'], 'level describes an interval; none is present')
  }
  if (finding.method?.kind !== 'judged' && finding.method?.calibration !== undefined) {
    issue(['method', 'calibration'], 'only judged findings carry a calibration')
  }
  if (!units) return
  const ids = units.map((unit) => unit.id)
  if (new Set(ids).size !== ids.length) issue(['evidence_units'], 'unit ids must be unique')
  if (scope) {
    if (scope.n !== ids.length) {
      issue(['scope', 'n'], `n ${scope.n} does not match ${ids.length} evidence units`)
    }
    const population = [...scope.population].sort()
    const unitIds = [...ids].sort()
    if (
      population.length !== unitIds.length ||
      population.some((id, index) => id !== unitIds[index])
    ) {
      issue(['scope', 'population'], 'population must name exactly the evidence units')
    }
  }
  const findingRank = finding.layer === undefined ? null : findingLayerRank(finding.layer)
  if (findingRank === null) return
  for (const [index, unit] of units.entries()) {
    const unitRank = findingLayerRank(unit.layer)
    if (unitRank !== null && unitRank > findingRank) {
      issue(
        ['evidence_units', index, 'layer'],
        `a ${finding.layer} finding cannot rest on a ${unit.layer} unit`,
      )
    }
  }
}

/** The one validator for stored findings of either schema version. Unknown fields fail. */
export const AnalystFindingSchema = findingObject.superRefine(checkFinding)

/** A finding admitted as candidate-generation input; same rules plus its origin. */
export const ProposalFindingSchema = findingObject
  .extend({ proposal_origin: z.enum(['search', 'production']) })
  .strict()
  .superRefine(checkFinding)

// Compile-time proof that the schemas and the hand-written types agree.
const _findingType: z.ZodType<AnalystFinding> = AnalystFindingSchema
const _proposalType: z.ZodType<ProposalFinding> = ProposalFindingSchema
void _findingType
void _proposalType

export type FindingParseOutcome =
  | { succeeded: true; value: AnalystFinding }
  | { succeeded: false; error: { path: string; message: string } }

/** Validate one stored finding of schema 1.0.0 or 1.1.0. */
export function parseAnalystFinding(value: unknown): FindingParseOutcome {
  const parsed = AnalystFindingSchema.safeParse(value)
  if (parsed.success) return { succeeded: true, value: parsed.data as AnalystFinding }
  const issue = parsed.error.issues[0]
  return {
    succeeded: false,
    error: {
      path: (issue?.path ?? []).map(String).join('.'),
      message: issue?.message ?? 'finding does not match the schema',
    },
  }
}

/**
 * A finding's scope as a reader sees it. A 1.0.0 finding states neither layer
 * nor population, so both read `unknown` — never a guessed value.
 */
export interface FindingScopeReading {
  layer: FindingLayer | 'unknown'
  n: number | 'unknown'
  /** Units with distinct lineage roots; unknown lineage counts as one shared root. */
  independent_n: number | 'unknown'
  domain_path: readonly string[] | null
  labels: FindingReaderLabel[]
}

/**
 * - `unscoped`: a 1.0.0 finding with no layer or population.
 * - `anecdote`: measured on fewer than two units.
 * - `uncalibrated`: judged, with no calibration against gold labels.
 * - `lineage-unknown`: at least one unit has no recorded lineage.
 */
export type FindingReaderLabel = 'unscoped' | 'anecdote' | 'uncalibrated' | 'lineage-unknown'

export function readFindingScope(finding: AnalystFinding): FindingScopeReading {
  if (finding.schema_version === '1.0.0' || !finding.scope || !finding.layer) {
    return {
      layer: 'unknown',
      n: 'unknown',
      independent_n: 'unknown',
      domain_path: null,
      labels: ['unscoped'],
    }
  }
  const labels: FindingReaderLabel[] = []
  if (finding.scope.n < 2) labels.push('anecdote')
  if (finding.method?.kind === 'judged' && finding.method.calibration === undefined) {
    labels.push('uncalibrated')
  }
  const units = finding.evidence_units
  if (units?.some((unit) => unit.derived_from === undefined)) labels.push('lineage-unknown')
  return {
    layer: finding.layer,
    n: finding.scope.n,
    independent_n: units ? independentUnitCount(units) : 'unknown',
    domain_path: finding.scope.domain_path ?? null,
    labels,
  }
}

/** Root token shared by every unit whose lineage was not recorded. */
export const UNKNOWN_LINEAGE = '?unknown-lineage'

/**
 * Lineage root of each unit, keyed by unit id. A unit derived from another
 * unit in the list shares that unit's root; a unit derived from an id outside
 * the list takes that id as its root; unknown lineage maps to one shared root.
 */
export function lineageRoots(units: ReadonlyArray<FindingEvidenceUnit>): Map<string, string> {
  const byId = new Map(units.map((unit) => [unit.id, unit]))
  const roots = new Map<string, string>()
  for (const unit of units) {
    let current: FindingEvidenceUnit | undefined = unit
    let root = unit.id
    const seen = new Set<string>()
    while (current && !seen.has(current.id)) {
      seen.add(current.id)
      if (current.derived_from === undefined) {
        root = UNKNOWN_LINEAGE
        break
      }
      if (current.derived_from === null) {
        root = current.id
        break
      }
      root = current.derived_from
      current = byId.get(current.derived_from)
    }
    roots.set(unit.id, root)
  }
  return roots
}

/** Units with distinct lineage roots. */
export function independentUnitCount(units: ReadonlyArray<FindingEvidenceUnit>): number {
  return new Set(lineageRoots(units).values()).size
}

/** One entry per unit id, sorted; a later copy that records lineage fills an earlier unknown. */
export function mergeEvidenceUnits(units: readonly FindingEvidenceUnit[]): FindingEvidenceUnit[] {
  const byId = new Map<string, FindingEvidenceUnit>()
  for (const unit of units) {
    const existing = byId.get(unit.id)
    if (!existing || (existing.derived_from === undefined && unit.derived_from !== undefined)) {
      byId.set(unit.id, { ...unit })
    }
  }
  return [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

/** The window spanning every finding's scope window. */
export function spanningWindow(findings: readonly AnalystFinding[]): FindingScope['window'] {
  const windows = findings.map((finding) => finding.scope!.window)
  return {
    from: windows.map((w) => w.from).reduce((a, b) => (Date.parse(b) < Date.parse(a) ? b : a)),
    to: windows.map((w) => w.to).reduce((a, b) => (Date.parse(b) > Date.parse(a) ? b : a)),
  }
}

export function mostSevere(findings: readonly AnalystFinding[]): AnalystSeverity {
  return ANALYST_SEVERITIES[
    Math.min(...findings.map((finding) => ANALYST_SEVERITIES.indexOf(finding.severity)))
  ]!
}
