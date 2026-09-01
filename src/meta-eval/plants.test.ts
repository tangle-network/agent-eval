import { describe, expect, it } from 'vitest'
import { CaptureIntegrityError, ValidationError } from '../errors'
import type { CandidateScore, GoldenItem } from '../judge-calibration'
import { calibrateJudge } from '../judge-calibration'
import {
  catchRate,
  definePlant,
  type PerturbedPlant,
  type Plant,
  type PlantManifest,
  type PlantOutcome,
  perturbEvidence,
  plantByPerturbation,
  seedPlants,
} from './index'

const dataset: GoldenItem[] = [
  { itemId: 'work-1', humanScore: 1 },
  { itemId: 'work-2', humanScore: 1 },
  { itemId: 'work-3', humanScore: 0 },
  { itemId: 'work-4', humanScore: 1 },
]

function wrongValuePlant(id: string): Plant {
  return definePlant({
    id,
    kind: 'wrong-value',
    item: { itemId: `${id}-item`, humanScore: 0 },
    expectedVerdict: 'reject',
  })
}

const plants: Plant[] = [
  wrongValuePlant('plant-a'),
  definePlant({
    id: 'plant-b',
    kind: 'self-certifying',
    item: { itemId: 'plant-b-item', humanScore: 0 },
    expectedVerdict: 'reject',
  }),
  definePlant({
    id: 'plant-c',
    kind: 'unreachable-input',
    item: { itemId: 'plant-c-item', humanScore: 0 },
    expectedVerdict: 'reject',
  }),
]

/** A grader that answers every plant with the same grade. */
function gradeAll(manifest: PlantManifest, score: number | null): PlantOutcome[] {
  return manifest.itemIds.map((itemId) => ({ itemId, score }))
}

describe('definePlant', () => {
  it('refuses a record whose expectation contradicts its label', () => {
    expect(() =>
      definePlant({
        id: 'inverted',
        kind: 'wrong-value',
        item: { itemId: 'inverted-item', humanScore: 1 },
        expectedVerdict: 'reject',
      }),
    ).toThrow(ValidationError)
  })

  it('refuses a label that states neither a rejection nor an acceptance', () => {
    expect(() =>
      definePlant({
        id: 'undecided',
        kind: 'duplicate',
        item: { itemId: 'undecided-item', humanScore: 0.5 },
        expectedVerdict: 'reject',
      }),
    ).toThrow(/neither a rejection nor an acceptance/)
  })

  it('refuses an empty id, an unknown kind, and a non-finite label', () => {
    const item = { itemId: 'x', humanScore: 0 }
    expect(() =>
      definePlant({ id: '  ', kind: 'duplicate', item, expectedVerdict: 'reject' }),
    ).toThrow(ValidationError)
    expect(() =>
      definePlant({
        id: 'bad-kind',
        kind: 'off-by-one' as Plant['kind'],
        item,
        expectedVerdict: 'reject',
      }),
    ).toThrow(/expected one of wrong-value/)
    expect(() =>
      definePlant({
        id: 'bad-label',
        kind: 'duplicate',
        item: { itemId: 'y', humanScore: Number.NaN },
        expectedVerdict: 'reject',
      }),
    ).toThrow(/expected a finite number/)
  })

  it('copies the item so a later mutation cannot change what is sealed', () => {
    const item: GoldenItem = { itemId: 'copied', humanScore: 0 }
    const plant = definePlant({ id: 'copy', kind: 'wrong-value', item, expectedVerdict: 'reject' })
    item.humanScore = 1
    expect(plant.item.humanScore).toBe(0)
  })
})

describe('perturbEvidence', () => {
  it('prefers the expectation, which falsifies the claim without touching execution', () => {
    const result = perturbEvidence({ check: '[ "$n" -ge 5 ]', expect: 'count=42' })
    expect(result).toEqual({
      evidence: { check: '[ "$n" -ge 5 ]', expect: 'count=43' },
      field: 'expect',
      how: 'number-off-by-one',
      original: '42',
      perturbed: '43',
    })
  })

  it('flips a comparison in the check when the expectation carries no number', () => {
    const result = perturbEvidence({
      check: 'test "$(wc -l < out.txt)" -ge 100',
      expect: 'the row budget holds',
    })
    expect(result).toEqual({
      evidence: {
        check: 'test "$(wc -l < out.txt)" -lt 100',
        expect: 'the row budget holds',
      },
      field: 'check',
      how: 'comparison-flipped',
      original: ' -ge ',
      perturbed: ' -lt ',
    })
  })

  it('leaves a digit run that is part of an identity alone', () => {
    // The defect this helper exists to prevent: bump one of these and the
    // check stops executing, so the plant measures the environment.
    for (const check of [
      'python3 report.py',
      'test -f file42.txt',
      'grep -F 1.5 out.txt',
      'iconv -t utf-8 in.txt',
      'python3 report.py --input file42.txt --scale 1.5 --encoding utf-8',
    ]) {
      expect(perturbEvidence({ check })).toBeNull()
    }
  })

  it('takes the last standalone number, because a measured value trails its label', () => {
    const result = perturbEvidence({ expect: 'n>=5 OK cells=8' })
    expect(result?.original).toBe('8')
    expect(result?.evidence).toEqual({ expect: 'n>=5 OK cells=9' })
  })

  it('does not flip a bare redirection, and falls through to the number instead', () => {
    const result = perturbEvidence({ check: 'awk "NR > 3" data.txt > out.txt' })
    expect(result?.how).toBe('number-off-by-one')
    expect(result?.evidence).toEqual({ check: 'awk "NR > 4" data.txt > out.txt' })
  })

  it('bumps a value wider than Number.MAX_SAFE_INTEGER by exactly one', () => {
    const result = perturbEvidence({ expect: 'total=9007199254740993' })
    expect(result?.perturbed).toBe('9007199254740994')
    // The same bump through a double rounds back onto a value the grader
    // would still verify, which is why this goes through BigInt.
    expect(String(Number('9007199254740993') + 1)).not.toBe(result?.perturbed)
  })

  it('returns null when nothing is perturbable', () => {
    expect(perturbEvidence({})).toBeNull()
    expect(perturbEvidence({ check: 'ls build', expect: 'the directory exists' })).toBeNull()
  })
})

describe('plantByPerturbation', () => {
  it('builds a wrong-value reject plant from a verified claim', () => {
    const derived = plantByPerturbation({
      id: 'plant-throughput',
      itemId: 'claim-118-plant',
      evidence: { check: 'grep -c row out.txt', expect: 'rows=42' },
      group: 'throughput',
    })
    if (derived === null) throw new Error('expected a perturbation')
    expect(derived.plant).toEqual({
      id: 'plant-throughput',
      kind: 'wrong-value',
      item: { itemId: 'claim-118-plant', humanScore: 0, group: 'throughput' },
      expectedVerdict: 'reject',
    })
    expect(derived.evidence).toEqual({ check: 'grep -c row out.txt', expect: 'rows=43' })
    expect(derived.field).toBe('expect')
    expect(derived.how).toBe('number-off-by-one')
  })

  it('returns null when the claim has no perturbable evidence', () => {
    expect(
      plantByPerturbation({
        id: 'prose-only',
        itemId: 'prose-only-item',
        evidence: { expect: 'the report reads well' },
      }),
    ).toBeNull()
  })

  it('refuses an empty id and an empty itemId', () => {
    const evidence = { expect: 'n=5' }
    expect(() => plantByPerturbation({ id: '  ', itemId: 'x', evidence })).toThrow(ValidationError)
    expect(() => plantByPerturbation({ id: 'named', itemId: ' ', evidence })).toThrow(
      /has an empty itemId/,
    )
  })

  it('refuses a score the run would accept, through definePlant', () => {
    const evidence = { expect: 'n=5' }
    expect(() =>
      plantByPerturbation({ id: 'too-good', itemId: 'too-good-item', evidence, humanScore: 0.9 }),
    ).toThrow(/humanScore 0.9 says accept/)
    expect(() =>
      plantByPerturbation({ id: 'undecided', itemId: 'undecided-item', evidence, humanScore: 0.5 }),
    ).toThrow(/neither a rejection nor an acceptance/)
  })

  it('seeds and scores end to end', () => {
    const derived: PerturbedPlant | null = plantByPerturbation({
      id: 'plant-throughput',
      itemId: 'claim-118-plant',
      evidence: { check: 'test "$rows" -ge 100', expect: 'the row budget holds' },
    })
    if (derived === null) throw new Error('expected a perturbation')
    const { items, manifest } = seedPlants(dataset, [derived.plant], { seed: 21 })
    expect(items).toHaveLength(dataset.length + 1)
    // Nothing the grader receives says the item was derived.
    for (const item of items) expect(Object.keys(item).sort()).toEqual(['humanScore', 'itemId'])
    const report = catchRate(gradeAll(manifest, 1), manifest)
    expect(report.status).toBe('evaluated')
    expect(report.rate).toBe(0)
    expect(report.missedIds).toEqual(['plant-throughput'])
    expect(report.byKind['wrong-value']).toEqual({
      seeded: 1,
      caught: 0,
      missed: 1,
      indecisive: 0,
      rate: 0,
    })
    expect(catchRate(gradeAll(manifest, 0), manifest).rate).toBe(1)
  })
})

describe('seedPlants', () => {
  it('is deterministic in the seed', () => {
    const first = seedPlants(dataset, plants, { seed: 11 })
    const second = seedPlants(dataset, plants, { seed: 11 })
    expect(second.manifest.itemIds).toEqual(first.manifest.itemIds)
    expect(second.manifest.seal).toBe(first.manifest.seal)
    expect(second.items).toEqual(first.items)
  })

  it('mixes plants into the set without marking them', () => {
    const { items, manifest } = seedPlants(dataset, plants, { seed: 3 })
    expect(items).toHaveLength(dataset.length + plants.length)
    expect(manifest.itemIds).toHaveLength(dataset.length + plants.length)
    // Nothing a grader receives says which items are seeded.
    for (const item of items) expect(Object.keys(item).sort()).toEqual(['humanScore', 'itemId'])
    expect(manifest.plants.map((plant) => plant.id)).toEqual(['plant-a', 'plant-b', 'plant-c'])
  })

  it('changes the seal when the plant set changes', () => {
    const base = seedPlants(dataset, plants, { seed: 5 }).manifest
    const added = seedPlants(dataset, [...plants, wrongValuePlant('plant-d')], { seed: 5 }).manifest
    const removed = seedPlants(dataset, plants.slice(0, 2), { seed: 5 }).manifest
    const relabelled = seedPlants(
      dataset,
      [
        definePlant({
          id: 'plant-a',
          kind: 'duplicate',
          item: { itemId: 'plant-a-item', humanScore: 0 },
          expectedVerdict: 'reject',
        }),
        ...plants.slice(1),
      ],
      { seed: 5 },
    ).manifest
    expect(new Set([base.seal, added.seal, removed.seal, relabelled.seal]).size).toBe(4)
  })

  it('changes the seal when the seed or the threshold changes', () => {
    const base = seedPlants(dataset, plants, { seed: 5 }).manifest
    const otherSeed = seedPlants(dataset, plants, { seed: 6 }).manifest
    const otherThreshold = seedPlants(dataset, plants, { seed: 5, acceptThreshold: 0.7 }).manifest
    expect(otherSeed.seal).not.toBe(base.seal)
    expect(otherThreshold.seal).not.toBe(base.seal)
  })

  it('refuses a plant that shadows an item already in the set', () => {
    const shadow = definePlant({
      id: 'shadow',
      kind: 'duplicate',
      item: { itemId: 'work-1', humanScore: 0 },
      expectedVerdict: 'reject',
    })
    expect(() => seedPlants(dataset, [shadow])).toThrow(/already in the set/)
  })

  it('refuses a duplicate plant id and a duplicate dataset id', () => {
    expect(() => seedPlants(dataset, [wrongValuePlant('twin'), wrongValuePlant('twin')])).toThrow(
      /duplicate plant id/,
    )
    const repeated: GoldenItem = { itemId: 'work-1', humanScore: 1 }
    expect(() => seedPlants([...dataset, repeated], plants)).toThrow(/duplicate dataset itemId/)
  })

  it('refuses a plant whose expectation the run threshold contradicts', () => {
    const control = definePlant({
      id: 'control',
      kind: 'duplicate',
      item: { itemId: 'control-item', humanScore: 0.6 },
      expectedVerdict: 'accept',
    })
    expect(() => seedPlants(dataset, [control], { acceptThreshold: 0.8 })).toThrow(
      /on the reject side of acceptThreshold 0.8/,
    )
    expect(() => seedPlants(dataset, [control], { acceptThreshold: 0.5 })).not.toThrow()
  })
})

describe('catchRate', () => {
  it('scores a grader that verifies every plant at 0 and names every id', () => {
    const { manifest } = seedPlants(dataset, plants, { seed: 2 })
    const report = catchRate(gradeAll(manifest, 1), manifest)
    expect(report.status).toBe('evaluated')
    expect(report.rate).toBe(0)
    expect(report.caught).toBe(0)
    expect(report.missed).toBe(3)
    expect(report.missedIds.sort()).toEqual(['plant-a', 'plant-b', 'plant-c'])
    expect(report.byKind['wrong-value']).toEqual({
      seeded: 1,
      caught: 0,
      missed: 1,
      indecisive: 0,
      rate: 0,
    })
  })

  it('scores a grader that catches every plant at 1', () => {
    const { manifest } = seedPlants(dataset, plants, { seed: 2 })
    const report = catchRate(gradeAll(manifest, 0), manifest)
    expect(report.status).toBe('evaluated')
    expect(report.rate).toBe(1)
    expect(report.caught).toBe(3)
    expect(report.missedIds).toEqual([])
  })

  it('shows the refuse-everything grader as refusing the unseeded work too', () => {
    const { manifest } = seedPlants(dataset, plants, { seed: 2 })
    const report = catchRate(gradeAll(manifest, 0), manifest)
    expect(report.rate).toBe(1)
    expect(report.unseeded).toEqual({ n: 4, decided: 4, rejected: 4, rejectionRate: 1 })
  })

  it('separates a discriminating grader from the refuse-everything one', () => {
    const { manifest } = seedPlants(dataset, plants, { seed: 2 })
    const plantItemIds = new Set(manifest.plants.map((plant) => plant.item.itemId))
    const results = manifest.itemIds.map((itemId) => ({
      itemId,
      score: plantItemIds.has(itemId) ? 0 : 1,
    }))
    const report = catchRate(results, manifest)
    expect(report.rate).toBe(1)
    expect(report.unseeded.rejectionRate).toBe(0)
  })

  it('is incomplete when a seeded id has no result, and reports no rate', () => {
    const { manifest } = seedPlants(dataset, plants, { seed: 4 })
    const results = gradeAll(manifest, 0).filter((result) => result.itemId !== 'plant-b-item')
    const report = catchRate(results, manifest)
    expect(report.status).toBe('incomplete')
    expect(report.rate).toBeNull()
    expect(report.missingIds).toEqual(['plant-b'])
    expect(report.reason).toMatch(/1 of 3 seeded plants have no result/)
    for (const counts of Object.values(report.byKind)) expect(counts.rate).toBeNull()
  })

  it('is not_evaluated with no rate when nothing was seeded', () => {
    const { manifest } = seedPlants(dataset, [])
    const report = catchRate(gradeAll(manifest, 1), manifest)
    expect(report.status).toBe('not_evaluated')
    expect(report.rate).toBeNull()
    expect(report.seeded).toBe(0)
    expect(report.byKind).toEqual({})
  })

  it('is not_evaluated when every seeded plant is indecisive', () => {
    const { manifest } = seedPlants(dataset, plants, { seed: 8 })
    const report = catchRate(gradeAll(manifest, null), manifest)
    expect(report.status).toBe('not_evaluated')
    expect(report.rate).toBeNull()
    expect(report.indecisive).toBe(3)
    expect(report.reason).toMatch(/no check tested the seeded defect/)
  })

  it('counts an indecisive plant apart from both arms', () => {
    const { manifest } = seedPlants(dataset, plants, { seed: 9 })
    const results = gradeAll(manifest, 0).map((result) =>
      result.itemId === 'plant-c-item' ? { itemId: result.itemId, score: null } : result,
    )
    const report = catchRate(results, manifest)
    expect(report.status).toBe('evaluated')
    expect(report.caught).toBe(2)
    expect(report.missed).toBe(0)
    expect(report.indecisive).toBe(1)
    expect(report.rate).toBe(1)
    expect(report.byKind['unreachable-input']).toEqual({
      seeded: 1,
      caught: 0,
      missed: 0,
      indecisive: 1,
      rate: null,
    })
  })

  it('scores an accept plant by the same rule', () => {
    const control = definePlant({
      id: 'known-good',
      kind: 'duplicate',
      item: { itemId: 'known-good-item', humanScore: 1 },
      expectedVerdict: 'accept',
    })
    const { manifest } = seedPlants(dataset, [...plants, control], { seed: 12 })
    const report = catchRate(gradeAll(manifest, 0), manifest)
    expect(report.seeded).toBe(4)
    expect(report.caught).toBe(3)
    expect(report.missedIds).toEqual(['known-good'])
    expect(report.rate).toBe(0.75)
  })

  it('refuses a manifest edited after it was sealed', () => {
    const { manifest } = seedPlants(dataset, plants, { seed: 4 })
    const tampered: PlantManifest = {
      ...manifest,
      plants: manifest.plants.filter((plant) => plant.id !== 'plant-a'),
    }
    expect(() => catchRate(gradeAll(manifest, 1), tampered)).toThrow(CaptureIntegrityError)
    expect(() => catchRate(gradeAll(manifest, 1), tampered)).toThrow(
      /the plant set changed after it was sealed/,
    )
  })

  it('refuses results from a different run', () => {
    const { manifest } = seedPlants(dataset, plants, { seed: 4 })
    expect(() =>
      catchRate([...gradeAll(manifest, 0), { itemId: 'from-elsewhere', score: 0 }], manifest),
    ).toThrow(/never handed out/)
    expect(() =>
      catchRate([...gradeAll(manifest, 0), { itemId: 'work-1', score: 0 }], manifest),
    ).toThrow(/duplicate result/)
  })

  it('refuses a non-finite score', () => {
    const { manifest } = seedPlants(dataset, plants, { seed: 4 })
    const results = gradeAll(manifest, 0).map((result) =>
      result.itemId === 'work-1' ? { itemId: result.itemId, score: Number.NaN } : result,
    )
    expect(() => catchRate(results, manifest)).toThrow(/expected a finite number or null/)
  })
})

describe('composition with judge calibration', () => {
  it('takes a judge run CandidateScore array unchanged', () => {
    const { items, manifest } = seedPlants(dataset, plants, { seed: 13 })
    const judgeScores: CandidateScore[] = items.map((item) => ({
      itemId: item.itemId,
      score: item.humanScore,
    }))
    // The same array both instruments read: one reports agreement with the
    // labels, the other reports the catch rate over the seeded subset.
    const calibration = calibrateJudge(items, judgeScores)
    expect(calibration.n).toBe(items.length)
    expect(calibration.mae).toBe(0)
    const report = catchRate(judgeScores, manifest)
    expect(report.status).toBe('evaluated')
    expect(report.rate).toBe(1)
  })
})
