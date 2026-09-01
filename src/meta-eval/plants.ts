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
 * Authoring the wrong item is the step before all of that, and it is where the
 * measurement silently breaks. {@link plantByPerturbation} takes a claim a
 * grader verified and alters exactly one load-bearing value in its evidence,
 * so the grader is asked a question it must fail. Hand-rolled perturbation
 * bumps a number that is part of an identity — `python3`, `file42.txt`, `1.5`,
 * `utf-8` — and the check stops EXECUTING; the plant then measures the
 * environment rather than the grader. {@link perturbEvidence} refuses those
 * digit runs by construction.
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

/**
 * A claim's executable evidence: the command a grader runs and the output it
 * must produce.
 */
export interface PlantEvidence {
  /** The command a grader runs to test the claim. */
  check?: string
  /** The output that command must produce for the claim to stand. */
  expect?: string
}

/** Which evidence field {@link perturbEvidence} altered. */
export type PerturbedField = 'check' | 'expect'

/** How {@link perturbEvidence} altered it. */
export type PerturbationKind = 'number-off-by-one' | 'comparison-flipped'

export interface EvidencePerturbation {
  /** The evidence with exactly one value altered. */
  evidence: PlantEvidence
  /** Which field changed. */
  field: PerturbedField
  /** How it changed. */
  how: PerturbationKind
  /**
   * The exact substring that was replaced. A comparison token carries its
   * surrounding spaces, because the spaces are what make ` -ge ` a comparison
   * and not part of a word.
   */
  original: string
  /** What replaced it. */
  perturbed: string
}

/**
 * Characters that make a digit run part of something larger than a number.
 *
 * A run that touches one of these is an identity — `python3`, `file42.txt`,
 * `1.5`, `utf-8` — and bumping it renames a program, a file, a version, or an
 * encoding instead of falsifying the claim. The check then stops EXECUTING,
 * and a plant that cannot run measures the environment rather than the grader:
 * it reads as caught, for a reason that has nothing to do with the seeded
 * defect.
 */
const NUMBER_GLUE = /[A-Za-z0-9_./-]/

/**
 * Comparison tokens that mean one thing only, each with its inversion.
 *
 * A bare `>` or `<` is absent on purpose: in a shell check it is a
 * redirection, so flipping it rewrites where output goes rather than what the
 * test asks, and the check stops testing the claim.
 */
const COMPARISON_FLIPS: readonly (readonly [string, string])[] = [
  [' -ge ', ' -lt '],
  [' -gt ', ' -le '],
  [' -le ', ' -gt '],
  [' -lt ', ' -ge '],
  [' -eq ', ' -ne '],
  [' -ne ', ' -eq '],
  ['>=', '<'],
  ['<=', '>'],
  ['==', '!='],
  ['!=', '=='],
]

interface Span {
  start: number
  end: number
}

/**
 * The last digit run in `text` that is a number and nothing else, or null.
 *
 * The last is taken because a measured value trails its label — `count=42`,
 * `n>=5 OK cells=8` — and because the choice has to be deterministic: the same
 * claim must always yield the same plant, or two runs of the same authoring
 * step seed two different answer keys for one item.
 */
function lastStandaloneNumber(text: string): Span | null {
  const digits = /\d+/g
  let found: Span | null = null
  let match = digits.exec(text)
  while (match !== null) {
    const start = match.index
    const end = start + match[0].length
    // charAt returns '' outside the string, and NUMBER_GLUE never matches ''.
    if (!NUMBER_GLUE.test(text.charAt(start - 1)) && !NUMBER_GLUE.test(text.charAt(end))) {
      found = { start, end }
    }
    match = digits.exec(text)
  }
  return found
}

/**
 * The first flippable comparison in `text`, or null.
 *
 * Any single flip inverts the test wherever it sits, so unlike the number rule
 * there is no safety ordering among the matches. The first is taken so the
 * result is fixed by the head of the command and does not move when a later
 * comparison is added.
 */
function firstComparison(text: string): { span: Span; flipped: string } | null {
  for (let index = 0; index < text.length; index += 1) {
    for (const [token, flipped] of COMPARISON_FLIPS) {
      if (text.startsWith(token, index)) {
        return { span: { start: index, end: index + token.length }, flipped }
      }
    }
  }
  return null
}

function replaceSpan(text: string, span: Span, value: string): string {
  return text.slice(0, span.start) + value + text.slice(span.end)
}

/**
 * Rebuild the evidence with one field replaced. An absent field is dropped
 * rather than set to undefined, so the record always has a canonical JSON form.
 */
function withField(
  check: string | undefined,
  expect: string | undefined,
  field: PerturbedField,
  value: string,
): PlantEvidence {
  const nextCheck = field === 'check' ? value : check
  const nextExpect = field === 'expect' ? value : expect
  return {
    ...(nextCheck === undefined ? {} : { check: nextCheck }),
    ...(nextExpect === undefined ? {} : { expect: nextExpect }),
  }
}

function offByOne(
  check: string | undefined,
  expect: string | undefined,
  field: PerturbedField,
  text: string,
  span: Span,
): EvidencePerturbation {
  const original = text.slice(span.start, span.end)
  const perturbed = (BigInt(original) + 1n).toString()
  return {
    evidence: withField(check, expect, field, replaceSpan(text, span, perturbed)),
    field,
    how: 'number-off-by-one',
    original,
    perturbed,
  }
}

/**
 * Derive a known-wrong version of a claim's evidence by altering exactly one
 * value, or return null when no value can be altered safely.
 *
 * Exactly one value changes. A perturbation that moves two does not name the
 * defect it seeded, so a grader that catches it says nothing about which defect
 * the grader can see.
 *
 * The preference order IS the safety order:
 *
 * 1. the last standalone number in `expect` — it falsifies the claim while the
 *    command still runs exactly as it did;
 * 2. a flipped comparison in `check` — it inverts a test that was passing;
 * 3. the last standalone number in `check` — last because a number in a command
 *    can name an input (a port, a width, a version) rather than a threshold,
 *    and renaming an input breaks execution, not the claim.
 *
 * "Standalone" excludes a digit run glued to a word, a dot, a slash, or a
 * hyphen: `python3`, `file42.txt`, `1.5`, `utf-8`. That exclusion is why this
 * helper exists. Hand-rolled perturbation bumps one of those, the check stops
 * executing, and the plant measures the environment instead of the grader.
 *
 * A number is bumped with BigInt, so a value wider than
 * `Number.MAX_SAFE_INTEGER` moves by exactly one. Bumped as a `number` it
 * rounds back to itself, and the plant is then a correct claim the grader is
 * right to verify.
 */
export function perturbEvidence(evidence: PlantEvidence): EvidencePerturbation | null {
  const check = typeof evidence.check === 'string' ? evidence.check : undefined
  const expect = typeof evidence.expect === 'string' ? evidence.expect : undefined

  if (expect !== undefined) {
    const span = lastStandaloneNumber(expect)
    if (span !== null) return offByOne(check, expect, 'expect', expect, span)
  }
  if (check !== undefined) {
    const comparison = firstComparison(check)
    if (comparison !== null) {
      return {
        evidence: withField(
          check,
          expect,
          'check',
          replaceSpan(check, comparison.span, comparison.flipped),
        ),
        field: 'check',
        how: 'comparison-flipped',
        original: check.slice(comparison.span.start, comparison.span.end),
        perturbed: comparison.flipped,
      }
    }
    const span = lastStandaloneNumber(check)
    if (span !== null) return offByOne(check, expect, 'check', check, span)
  }
  return null
}

export interface PerturbedPlant {
  plant: Plant
  /** The perturbed evidence to write into the item the grader is handed. */
  evidence: PlantEvidence
  field: PerturbedField
  how: PerturbationKind
  original: string
  perturbed: string
}

/**
 * Derive a reject-direction plant from a claim a grader verified, by perturbing
 * one value.
 *
 * {@link definePlant} takes a {@link GoldenItem} and never authors a wrong item
 * from a right one, so until now every caller hand-rolled the perturbation.
 * This is that step, done once and the same way every time: the claim's
 * evidence is altered by {@link perturbEvidence}, the result is a `wrong-value`
 * plant the grader owes a `reject`, and the record itself is built by
 * `definePlant` so every refusal there still applies — in particular the one
 * that catches an `expectedVerdict` its `humanScore` contradicts.
 *
 * Returns null when nothing in the evidence can be perturbed. That is not a
 * failure: a claim with no executable evidence cannot be made wrong in a way a
 * grader could execute, and seeding it would measure prose.
 *
 * Refuses an empty `id` or `itemId`. Both name the record — one in the manifest
 * and in `missedIds`, the other in the join with the results — and a miss
 * nobody can look up is not a measurement.
 */
export function plantByPerturbation(input: {
  id: string
  itemId: string
  evidence: PlantEvidence
  /** Score for the perturbed item. Must sit below the run's accept threshold. Default 0. */
  humanScore?: number
  group?: string
}): PerturbedPlant | null {
  const { id, itemId, evidence, humanScore = 0, group } = input
  if (typeof id !== 'string' || id.trim() === '') {
    throw new ValidationError('plantByPerturbation: id must be a non-empty string')
  }
  if (typeof itemId !== 'string' || itemId.trim() === '') {
    throw new ValidationError(`plantByPerturbation: plant "${id}" has an empty itemId`)
  }
  const perturbation = perturbEvidence(evidence)
  if (perturbation === null) return null
  const plant = definePlant({
    id,
    kind: 'wrong-value',
    item: { itemId, humanScore, ...(group === undefined ? {} : { group }) },
    expectedVerdict: 'reject',
  })
  return {
    plant,
    evidence: perturbation.evidence,
    field: perturbation.field,
    how: perturbation.how,
    original: perturbation.original,
    perturbed: perturbation.perturbed,
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
