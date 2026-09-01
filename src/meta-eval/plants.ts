/**
 * Plants — seeded known-wrong items that measure the grader, not the work.
 *
 * A grading run reports how the work scored. It cannot report whether the
 * grader would have noticed a wrong answer, because every item it saw was
 * authored in good faith. A plant closes that hole: an item authored wrong by
 * construction is mixed into the live set, graded by the same path as
 * everything else, and the share of plants the grader refused is the catch
 * rate.
 *
 * Measured motive: a sibling lab ran a deliverable gate that accepted any
 * non-empty submission. It produced six false certifications in seventeen
 * deliveries, and no agent lied — the gate never asked a question the format
 * could fail. A catch rate is the number that would have shown it on day one.
 *
 * This module composes existing primitives rather than adding parallel ones:
 *
 * - A plant IS a {@link GoldenItem} from `../judge-calibration`. Its
 *   `humanScore` is the grade a working grader owes the item, so the same
 *   array feeds `calibrateJudge` unchanged.
 * - The grader's output is `CandidateScore[]`, the array `calibrateJudge` and
 *   `snapshotFromSentinelSet` already consume.
 * - "Caught" is `snapshotFromSentinelSet`'s join with the labels inverted:
 *   the grade lands on the side of `acceptThreshold` the seed demands.
 * - The manifest is sealed with `hashCanonical` from `../ledger-core/canonical`,
 *   the digest the sealed-experiment path uses, so the answer key cannot be
 *   revised once the results are in.
 *
 * Blindness has two halves, and this module owns one. It never puts a plant
 * flag on a graded item: `seedPlants` returns the mixed set and a manifest,
 * and only the manifest knows which ids are seeded. Keeping the manifest out
 * of the graded workspace and publishing its `seal` before grading is the
 * caller's half; {@link catchRate} refuses a manifest whose contents no longer
 * match its seal.
 *
 * Refusals, because a catch rate that cannot refuse is not a measurement:
 *
 * - a seeded id with no result makes the report `incomplete`, never a rate
 *   over the results that did come back;
 * - zero seeded plants makes it `not_evaluated`, never 1.0;
 * - a result for an id the manifest never handed out is refused outright.
 */

import { CaptureIntegrityError, ValidationError } from '../errors'
import type { GoldenItem } from '../judge-calibration'
import { hashCanonical, type LedgerHash } from '../ledger-core/canonical'
import { mulberry32 } from '../statistics/random'

/**
 * How a plant item was authored wrong. The class is reported separately in
 * {@link CatchRateReport.byKind} because a grader is routinely sharp on one
 * and blind to another.
 */
export type PlantKind =
  /** A load-bearing value is altered: a number off by one, a comparison flipped. */
  | 'wrong-value'
  /** The item carries its own check, and that check passes without testing the claim. */
  | 'self-certifying'
  /** The check names an input that does not exist, so it cannot run at all. */
  | 'unreachable-input'
  /** A copy of an item already in the set, which is owed a duplicate flag rather than a second grade. */
  | 'duplicate'

const PLANT_KINDS: readonly PlantKind[] = [
  'wrong-value',
  'self-certifying',
  'unreachable-input',
  'duplicate',
]

/** What a working grader owes a seeded item. */
export type PlantExpectation = 'reject' | 'accept'

const PLANT_EXPECTATIONS: readonly PlantExpectation[] = ['reject', 'accept']

/** The label boundary a plant record is checked against at definition time. */
const RECORD_LABEL_BOUNDARY = 0.5

export interface Plant {
  /** Name of the plant record. Reported in `missedIds` and `missingIds`. */
  id: string
  kind: PlantKind
  /** The seeded item, indistinguishable from a real one once mixed. */
  item: GoldenItem
  /** The verdict a working grader owes this item. */
  expectedVerdict: PlantExpectation
}

/**
 * Build one plant record and refuse an incoherent one.
 *
 * The refusal that matters is the last: a record whose `expectedVerdict`
 * disagrees with `item.humanScore` inverts the measurement silently, because
 * the same item then reads as wrong here and as correct to every calibration
 * instrument that joins on the id.
 *
 * `item` is copied field by field so a later mutation of the caller's object
 * cannot change what the manifest sealed, and `group` is dropped when it is
 * absent so the record always has a canonical JSON form.
 */
export function definePlant(input: {
  id: string
  kind: PlantKind
  item: GoldenItem
  expectedVerdict: PlantExpectation
}): Plant {
  const { id, kind, item, expectedVerdict } = input
  if (typeof id !== 'string' || id.trim() === '') {
    throw new ValidationError('definePlant: id must be a non-empty string')
  }
  if (!PLANT_KINDS.includes(kind)) {
    throw new ValidationError(
      `definePlant: plant "${id}" has kind ${JSON.stringify(kind)}; expected one of ${PLANT_KINDS.join(', ')}`,
    )
  }
  if (!PLANT_EXPECTATIONS.includes(expectedVerdict)) {
    throw new ValidationError(
      `definePlant: plant "${id}" has expectedVerdict ${JSON.stringify(expectedVerdict)}; expected one of ${PLANT_EXPECTATIONS.join(', ')}`,
    )
  }
  if (typeof item.itemId !== 'string' || item.itemId.trim() === '') {
    throw new ValidationError(`definePlant: plant "${id}" has an empty item.itemId`)
  }
  if (!Number.isFinite(item.humanScore) || item.humanScore < 0 || item.humanScore > 1) {
    throw new ValidationError(
      `definePlant: plant "${id}" has humanScore ${item.humanScore}; expected a finite number in [0, 1]`,
    )
  }
  if (item.group !== undefined && typeof item.group !== 'string') {
    throw new ValidationError(`definePlant: plant "${id}" has a non-string item.group`)
  }
  if (item.humanScore === RECORD_LABEL_BOUNDARY) {
    throw new ValidationError(
      `definePlant: plant "${id}" has humanScore ${RECORD_LABEL_BOUNDARY}, which states neither a rejection nor an acceptance`,
    )
  }
  const labelSays: PlantExpectation = item.humanScore < RECORD_LABEL_BOUNDARY ? 'reject' : 'accept'
  if (labelSays !== expectedVerdict) {
    throw new ValidationError(
      `definePlant: plant "${id}" expects the grader to ${expectedVerdict} it, but humanScore ${item.humanScore} says ${labelSays}`,
    )
  }
  return {
    id,
    kind,
    item: {
      itemId: item.itemId,
      humanScore: item.humanScore,
      ...(item.group === undefined ? {} : { group: item.group }),
    },
    expectedVerdict,
  }
}

export interface PlantManifest {
  /**
   * Digest over the seeded order, the plants, and the threshold. Publish it
   * before the grading run: a manifest edited afterwards to match the results
   * no longer matches its seal, and {@link catchRate} refuses it.
   */
  seal: LedgerHash
  /** The seed that fixed the mix order. */
  seed: number
  /** The grade at or above which the graded policy's own gate accepts an item. */
  acceptThreshold: number
  /** Every item id in the seeded set, in the order handed out. */
  itemIds: string[]
  /** The seeded plants. This is the answer key; keep it out of the graded workspace. */
  plants: Plant[]
}

export interface SeededGradingSet {
  /**
   * The mixed set in seeded order. Operator-side: it still carries every
   * item's `humanScore`, so hand the graded policy the payload each `itemId`
   * names, never this array.
   */
  items: GoldenItem[]
  manifest: PlantManifest
}

export interface SeedPlantsOptions {
  /**
   * Fixes the mix order. The same dataset, plants, threshold, and seed always
   * produce the same seeded order and the same seal.
   */
  seed?: number
  /**
   * The grade at or above which the graded policy's own gate accepts an item.
   * Supply the threshold your gate uses; the default suits a judge scoring in
   * [0, 1] with a pass at the midpoint.
   */
  acceptThreshold?: number
}

/**
 * Mix plants into a grading set and seal which items they are.
 *
 * Refusals: a duplicate id anywhere in the mixed set (the join is by id, so a
 * repeat makes one of the two unscoreable), a plant whose item id collides
 * with a dataset item (it would shadow real work and grade it as a plant), a
 * dataset item with no usable label, and a plant whose expectation the run's
 * `acceptThreshold` contradicts.
 */
export function seedPlants(
  dataset: readonly GoldenItem[],
  plants: readonly Plant[],
  options: SeedPlantsOptions = {},
): SeededGradingSet {
  const seed = options.seed ?? 7
  const acceptThreshold = options.acceptThreshold ?? 0.5
  if (!Number.isFinite(seed)) {
    throw new ValidationError(`seedPlants: seed must be a finite number, got ${seed}`)
  }
  if (!Number.isFinite(acceptThreshold) || acceptThreshold <= 0 || acceptThreshold > 1) {
    throw new ValidationError(
      `seedPlants: acceptThreshold must be a finite number in (0, 1], got ${acceptThreshold}`,
    )
  }

  const datasetItems: GoldenItem[] = []
  const seen = new Set<string>()
  for (const item of dataset) {
    if (typeof item.itemId !== 'string' || item.itemId.trim() === '') {
      throw new ValidationError('seedPlants: a dataset item has an empty itemId')
    }
    if (!Number.isFinite(item.humanScore)) {
      throw new ValidationError(
        `seedPlants: dataset item "${item.itemId}" has a non-finite humanScore`,
      )
    }
    if (seen.has(item.itemId)) {
      throw new ValidationError(`seedPlants: duplicate dataset itemId "${item.itemId}"`)
    }
    seen.add(item.itemId)
    datasetItems.push({
      itemId: item.itemId,
      humanScore: item.humanScore,
      ...(item.group === undefined ? {} : { group: item.group }),
    })
  }

  const sealedPlants: Plant[] = []
  const plantIds = new Set<string>()
  for (const plant of plants) {
    const record = definePlant(plant)
    if (plantIds.has(record.id)) {
      throw new ValidationError(`seedPlants: duplicate plant id "${record.id}"`)
    }
    if (seen.has(record.item.itemId)) {
      throw new ValidationError(
        `seedPlants: plant "${record.id}" reuses itemId "${record.item.itemId}", which is already in the set`,
      )
    }
    const thresholdSays: PlantExpectation =
      record.item.humanScore >= acceptThreshold ? 'accept' : 'reject'
    if (thresholdSays !== record.expectedVerdict) {
      throw new ValidationError(
        `seedPlants: plant "${record.id}" expects the grader to ${record.expectedVerdict} it, but humanScore ${record.item.humanScore} is on the ${thresholdSays} side of acceptThreshold ${acceptThreshold}`,
      )
    }
    plantIds.add(record.id)
    seen.add(record.item.itemId)
    sealedPlants.push(record)
  }

  const items = shuffled(
    [...datasetItems, ...sealedPlants.map((plant) => plant.item)],
    mulberry32(seed),
  )
  const itemIds = items.map((item) => item.itemId)
  const manifest: PlantManifest = {
    seal: sealManifest({ seed, acceptThreshold, itemIds, plants: sealedPlants }),
    seed,
    acceptThreshold,
    itemIds,
    plants: sealedPlants,
  }
  return { items, manifest }
}

/**
 * Order by one independent uniform key per item, which is a uniform
 * permutation and a pure function of the seed. A comparator that returns a
 * fresh random sign instead is neither: it is not a consistent ordering, so
 * the permutation it produces is biased and depends on the sort algorithm.
 */
function shuffled<T>(items: readonly T[], random: () => number): T[] {
  return items
    .map((item) => ({ item, key: random() }))
    .sort((left, right) => left.key - right.key)
    .map((entry) => entry.item)
}

function sealManifest(contents: Omit<PlantManifest, 'seal'>): LedgerHash {
  return hashCanonical({
    scheme: 'agent-eval.plant-manifest.v1',
    seed: contents.seed,
    acceptThreshold: contents.acceptThreshold,
    itemIds: contents.itemIds,
    plants: contents.plants,
  })
}

/**
 * One grader outcome for one item. `score: null` says the grader ran and
 * declined to decide — the check never tested the item's defect. Any
 * `CandidateScore` from a judge run is already a valid outcome.
 */
export interface PlantOutcome {
  itemId: string
  score: number | null
}

/**
 * `evaluated` — a rate stands. `incomplete` — a seeded id had no result.
 * `not_evaluated` — nothing was seeded, or nothing seeded was decided.
 */
export type CatchRateStatus = 'evaluated' | 'incomplete' | 'not_evaluated'

export interface PlantKindCounts {
  seeded: number
  caught: number
  missed: number
  indecisive: number
  /** caught / (caught + missed), or null when the report is not `evaluated`. */
  rate: number | null
}

/**
 * How the same grader treated the unseeded items of the same set. No labels
 * are needed to read it: a grader that refuses everything scores `rate` 1.0
 * on reject-plants, and a `rejectionRate` of 1.0 here is what separates that
 * reflex from discrimination.
 */
export interface UnseededRejection {
  n: number
  decided: number
  rejected: number
  /** rejected / decided, or null when nothing unseeded was decided. */
  rejectionRate: number | null
}

export interface CatchRateReport {
  status: CatchRateStatus
  /** Why the status is not `evaluated`. Absent when it is. */
  reason?: string
  seeded: number
  caught: number
  missed: number
  /**
   * The grader returned a result and declined to decide. Counted apart: it
   * enters neither side of `rate`.
   */
  indecisive: number
  /** caught / (caught + missed), or null unless the status is `evaluated`. */
  rate: number | null
  /** One entry per kind actually seeded. A kind nobody seeded is absent, never zero. */
  byKind: Partial<Record<PlantKind, PlantKindCounts>>
  /** Plant ids the grader graded as the seed says it must not. */
  missedIds: string[]
  /** Plant ids with no result at all — the reason a status is `incomplete`. */
  missingIds: string[]
  unseeded: UnseededRejection
}

/**
 * Score a grading run against its sealed manifest.
 *
 * Refusals: a manifest whose contents no longer match its seal, a result for
 * an id the manifest never handed out, and a repeated result id. Each says
 * the results and the manifest describe different runs, and a rate computed
 * across two runs is a fabrication.
 */
export function catchRate(
  results: readonly PlantOutcome[],
  manifest: PlantManifest,
): CatchRateReport {
  const expectedSeal = sealManifest({
    seed: manifest.seed,
    acceptThreshold: manifest.acceptThreshold,
    itemIds: manifest.itemIds,
    plants: manifest.plants,
  })
  if (expectedSeal !== manifest.seal) {
    throw new CaptureIntegrityError(
      `catchRate: manifest contents hash to ${expectedSeal} but the manifest carries seal ${manifest.seal} — the plant set changed after it was sealed`,
    )
  }

  const handedOut = new Set(manifest.itemIds)
  const scoreByItemId = new Map<string, number | null>()
  for (const result of results) {
    if (!handedOut.has(result.itemId)) {
      throw new ValidationError(
        `catchRate: result for "${result.itemId}", which this manifest never handed out`,
      )
    }
    if (scoreByItemId.has(result.itemId)) {
      throw new ValidationError(`catchRate: duplicate result for "${result.itemId}"`)
    }
    if (result.score !== null && !Number.isFinite(result.score)) {
      throw new ValidationError(
        `catchRate: result for "${result.itemId}" has score ${result.score}; expected a finite number or null`,
      )
    }
    scoreByItemId.set(result.itemId, result.score)
  }

  const byKind: Partial<Record<PlantKind, PlantKindCounts>> = {}
  const missedIds: string[] = []
  const missingIds: string[] = []
  let caught = 0
  let missed = 0
  let indecisive = 0

  for (const plant of manifest.plants) {
    let counts = byKind[plant.kind]
    if (counts === undefined) {
      counts = { seeded: 0, caught: 0, missed: 0, indecisive: 0, rate: null }
      byKind[plant.kind] = counts
    }
    counts.seeded += 1
    if (!scoreByItemId.has(plant.item.itemId)) {
      missingIds.push(plant.id)
      continue
    }
    const score = scoreByItemId.get(plant.item.itemId) ?? null
    if (score === null) {
      indecisive += 1
      counts.indecisive += 1
      continue
    }
    const graderSaid: PlantExpectation = score >= manifest.acceptThreshold ? 'accept' : 'reject'
    if (graderSaid === plant.expectedVerdict) {
      caught += 1
      counts.caught += 1
    } else {
      missed += 1
      counts.missed += 1
      missedIds.push(plant.id)
    }
  }

  const seeded = manifest.plants.length
  const decided = caught + missed
  const report: CatchRateReport = {
    status: 'evaluated',
    seeded,
    caught,
    missed,
    indecisive,
    rate: null,
    byKind,
    missedIds,
    missingIds,
    unseeded: unseededRejection(manifest, scoreByItemId),
  }

  if (seeded === 0) {
    return {
      ...report,
      status: 'not_evaluated',
      reason: 'no plant was seeded, so the grader was never asked a question it could fail',
    }
  }
  if (missingIds.length > 0) {
    return {
      ...report,
      status: 'incomplete',
      reason: `${missingIds.length} of ${seeded} seeded plants have no result: ${missingIds.join(', ')}`,
    }
  }
  if (decided === 0) {
    return {
      ...report,
      status: 'not_evaluated',
      reason: `all ${seeded} seeded plants are indecisive: no check tested the seeded defect`,
    }
  }

  for (const counts of Object.values(byKind)) {
    const kindDecided = counts.caught + counts.missed
    counts.rate = kindDecided === 0 ? null : counts.caught / kindDecided
  }
  report.rate = caught / decided
  return report
}

function unseededRejection(
  manifest: PlantManifest,
  scoreByItemId: ReadonlyMap<string, number | null>,
): UnseededRejection {
  const plantItemIds = new Set(manifest.plants.map((plant) => plant.item.itemId))
  let n = 0
  let decided = 0
  let rejected = 0
  for (const itemId of manifest.itemIds) {
    if (plantItemIds.has(itemId)) continue
    n += 1
    const score = scoreByItemId.get(itemId)
    if (score === undefined || score === null) continue
    decided += 1
    if (score < manifest.acceptThreshold) rejected += 1
  }
  return { n, decided, rejected, rejectionRate: decided === 0 ? null : rejected / decided }
}
