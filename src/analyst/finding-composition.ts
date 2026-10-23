import { z } from 'zod'
import { hashCanonical } from '../ledger-core/canonical'
import { findingEvidenceRefSchema } from './finding-primitives'
import type { AnalystFinding } from './types'

/** What was deliberately changed; this is separate from a finding's event-to-meta scope. */
export const TREATMENT_LAYERS = [
  'Task',
  'Model',
  'Budget',
  'Team',
  'Roles',
  'Tools',
  'Memory',
  'Process',
  'Oversight',
] as const
export type TreatmentLayer = (typeof TREATMENT_LAYERS)[number]
const identity = z
  .string()
  .min(1)
  .refine((s) => s.trim() === s)
const timestamp = z.string().refine((s) => Number.isFinite(Date.parse(s)))
const uniqueIdentities = z
  .array(identity)
  .min(1)
  .refine((xs) => new Set(xs).size === xs.length)

export const findingTreatmentSchema = z
  .object({
    id: identity,
    definition_digest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    definition_refs: z.array(findingEvidenceRefSchema).min(1),
    layers: z
      .array(z.enum(TREATMENT_LAYERS))
      .min(1)
      .refine((xs) => new Set(xs).size === xs.length),
  })
  .strict()

/** Required nullable values distinguish an unavailable observation from observed absence. */
export const findingConditionsSchema = z
  .object({
    id: identity,
    population: uniqueIdentities,
    observed_at: timestamp,
    evidence_refs: z.array(findingEvidenceRefSchema).min(1),
    runtime_version: identity.nullable(),
    lab_commit: identity.nullable(),
    model_version: identity.nullable(),
    provider_version: identity.nullable(),
    seat: identity.nullable(),
    host_load: z.number().finite().nonnegative().nullable(),
    started_at: timestamp.nullable(),
    operator_steers: z
      .array(
        z
          .object({
            id: identity,
            at: timestamp.nullable(),
            planned: z.boolean().nullable(),
            evidence_ref: findingEvidenceRefSchema,
          })
          .strict(),
      )
      .refine((xs) => new Set(xs.map((x) => x.id)).size === xs.length)
      .nullable(),
  })
  .strict()

export type FindingTreatment = z.infer<typeof findingTreatmentSchema>
export type FindingConditions = z.infer<typeof findingConditionsSchema>
type Composition = Pick<AnalystFinding, 'treatment' | 'conditions'>

function sortedTreatments(values: readonly FindingTreatment[]): FindingTreatment[] {
  return values
    .map((value) => ({ ...value, layers: [...value.layers].sort() }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

/** Fixed environment differences partition claims; varying covariates retain their full provenance. */
export function findingCompositionKey(finding: Composition): string {
  if (finding.treatment === undefined && finding.conditions === undefined) return ''
  const fixed =
    finding.conditions === undefined
      ? null
      : [
          ...new Set(
            finding.conditions.map((c) =>
              hashCanonical({
                runtime_version: c.runtime_version,
                lab_commit: c.lab_commit,
                model_version: c.model_version,
                provider_version: c.provider_version,
                seat: c.seat,
                operator_steers:
                  c.operator_steers === null
                    ? 'unknown'
                    : c.operator_steers.some((s) => s.planned !== true)
                      ? 'unplanned-or-unknown'
                      : 'no-unplanned-steers',
              }),
            ),
          ),
        ].sort()
  return `:composition:${hashCanonical({ treatment: finding.treatment === undefined ? null : sortedTreatments(finding.treatment).map(({ definition_refs: _refs, ...identity }) => identity), fixed })}`
}

function conditionSnapshots(findings: readonly Composition[]): FindingConditions[] {
  const byId = new Map<string, FindingConditions>()
  for (const finding of findings)
    for (const value of finding.conditions ?? []) {
      const snapshot = structuredClone(value)
      const normalized = {
        ...snapshot,
        population: [...value.population].sort(),
        evidence_refs: [...snapshot.evidence_refs].sort((a, b) =>
          hashCanonical(a) < hashCanonical(b) ? -1 : hashCanonical(a) > hashCanonical(b) ? 1 : 0,
        ),
        operator_steers:
          snapshot.operator_steers === null
            ? null
            : [...snapshot.operator_steers].sort((a, b) =>
                a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
              ),
      }
      const prior = byId.get(value.id)
      if (prior && hashCanonical(prior) !== hashCanonical(normalized))
        throw new TypeError('Conflicting immutable condition snapshot')
      byId.set(value.id, normalized)
    }
  return [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

/** A snapshot ID must have one meaning across an aggregation input, before partitioning. */
export function assertConsistentFindingConditions(findings: readonly Composition[]): void {
  conditionSnapshots(findings)
}

/** All aggregation paths reuse this union, including promotion's underlying-run re-pooling. */
export function mergeFindingComposition(findings: readonly Composition[]): Composition {
  const first = findings[0]
  if (!first) return {}
  for (const finding of findings)
    for (const values of [finding.treatment, finding.conditions]) {
      if (values && new Set(values.map((value) => value.id)).size !== values.length)
        throw new TypeError('Duplicate finding composition id')
    }
  const key = findingCompositionKey(first)
  if (findings.some((f) => findingCompositionKey(f) !== key))
    throw new TypeError('Cannot pool different finding compositions')
  const result: Composition = {}
  if (first.treatment !== undefined)
    result.treatment = sortedTreatments(first.treatment).map((value) => {
      const refs = new Map(
        findings
          .flatMap((f) => f.treatment!.find((t) => t.id === value.id)!.definition_refs)
          .map((ref) => [hashCanonical(ref), ref] as const),
      )
      return {
        ...value,
        definition_refs: [...refs.entries()]
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([, ref]) => structuredClone(ref)),
      }
    })
  if (first.conditions !== undefined) {
    result.conditions = conditionSnapshots(findings)
  }
  return result
}
