import { describe, expect, it } from 'vitest'
import {
  type ClusteredPairedBinaryOptions,
  clusteredPairedBinary,
  holm,
  ValidationError,
} from '../src/index'

interface BinaryRow {
  task: string
  cluster: string
  arm: string
  pass: boolean
  rep?: string
  note?: string
}

function row(task: string, cluster: string, arm: string, pass: boolean, note?: string): BinaryRow {
  return { task, cluster, arm, pass, note }
}

function options(
  overrides: Partial<ClusteredPairedBinaryOptions<BinaryRow>> = {},
): ClusteredPairedBinaryOptions<BinaryRow> {
  return {
    baselineArm: 'baseline',
    treatmentArm: 'candidate',
    pairKey: (value) => value.task,
    clusterKey: (value) => value.cluster,
    arm: (value) => value.arm,
    pass: (value) => value.pass,
    repKey: (value) => value.rep,
    seed: 1337,
    bootstrapResamples: 2_000,
    signFlipResamples: 5_000,
    ...overrides,
  }
}

describe('clusteredPairedBinary', () => {
  it('retains original matched and unpaired rows while reporting both weighting schemes', () => {
    const a1Base = row('a1', 'cluster-a', 'baseline', false, 'original-a1-base')
    const a1Candidate = row('a1', 'cluster-a', 'candidate', true, 'original-a1-candidate')
    const cOnly = row('c-only', 'cluster-c', 'baseline', false)
    const dOnly = row('d-only', 'cluster-d', 'candidate', true)
    const rows = [
      a1Base,
      a1Candidate,
      row('a2', 'cluster-a', 'baseline', false),
      row('a2', 'cluster-a', 'candidate', true),
      row('a3', 'cluster-a', 'baseline', true),
      row('a3', 'cluster-a', 'candidate', false),
      row('b1', 'cluster-b', 'baseline', true),
      row('b1', 'cluster-b', 'candidate', false),
      cOnly,
      dOnly,
    ]

    const result = clusteredPairedBinary(rows, options())

    expect(result.matchedPairs).toHaveLength(4)
    expect(result.matchedPairs[0]!.baseline).toBe(a1Base)
    expect(result.matchedPairs[0]!.treatment).toBe(a1Candidate)
    expect(result.unpairedBaseline).toEqual([cOnly])
    expect(result.unpairedBaseline[0]).toBe(cOnly)
    expect(result.unpairedTreatment).toEqual([dOnly])
    expect(result.unpairedTreatment[0]).toBe(dOnly)

    expect(result.statistics).not.toBeNull()
    expect(result.statistics!.b10).toBe(2)
    expect(result.statistics!.b01).toBe(2)
    expect(result.statistics!.taskWeightedRiskDifference).toBe(0)
    expect(result.statistics!.equalClusterMean).toBeCloseTo(-1 / 3, 12)
    expect(result.statistics!.clusters).toEqual([
      {
        clusterKey: 'cluster-a',
        nPairs: 3,
        b10: 2,
        b01: 1,
        meanDifference: 1 / 3,
      },
      {
        clusterKey: 'cluster-b',
        nPairs: 1,
        b10: 0,
        b01: 1,
        meanDifference: -1,
      },
    ])
  })

  it('resamples whole unequal-sized clusters rather than individual tasks', () => {
    const rows: BinaryRow[] = []
    for (let index = 0; index < 10; index++) {
      rows.push(row(`large-${index}`, 'large', 'baseline', false))
      rows.push(row(`large-${index}`, 'large', 'candidate', true))
    }
    rows.push(row('small-0', 'small', 'baseline', true))
    rows.push(row('small-0', 'small', 'candidate', false))

    const result = clusteredPairedBinary(
      rows,
      options({ seed: 7, bootstrapResamples: 2_000, alternative: 'greater' }),
    )

    expect(result.statistics!.taskWeightedRiskDifference).toBeCloseTo(9 / 11, 12)
    expect(result.statistics!.equalClusterMean).toBe(0)
    // A whole-cluster draw can select the small regressing cluster twice or
    // the large improving cluster twice. Task-IID resampling would hide this.
    expect(result.statistics!.bootstrap!.lower).toBe(-1)
    expect(result.statistics!.bootstrap!.upper).toBe(1)
    expect(result.statistics!.signFlip.statistic).toBeCloseTo(9 / 11, 12)
    expect(result.statistics!.signFlip.pValue).toBe(0.5)
  })

  it('uses exact sign flips when the non-zero cluster count is within the limit', () => {
    const rows: BinaryRow[] = []
    for (let index = 0; index < 3; index++) {
      rows.push(row(`task-${index}`, `cluster-${index}`, 'baseline', false))
      rows.push(row(`task-${index}`, `cluster-${index}`, 'candidate', true))
    }

    const result = clusteredPairedBinary(rows, options({ alternative: 'greater' }))

    expect(result.statistics!.signFlip).toEqual({
      statistic: 1,
      pValue: 1 / 8,
      alternative: 'greater',
      method: 'exact',
      assignments: 8,
      nClusters: 3,
      nNonZeroClusters: 3,
      seed: null,
    })
  })

  it('uses deterministic Monte Carlo sign flips above the exact limit', () => {
    const rows: BinaryRow[] = []
    for (let index = 0; index < 8; index++) {
      const candidatePass = index !== 7
      rows.push(row(`task-${index}`, `cluster-${index}`, 'baseline', !candidatePass))
      rows.push(row(`task-${index}`, `cluster-${index}`, 'candidate', candidatePass))
    }
    const config = options({ exactClusterLimit: 2, seed: 42, signFlipResamples: 4_000 })

    const forward = clusteredPairedBinary(rows, config)
    const reversed = clusteredPairedBinary([...rows].reverse(), config)

    expect(forward).toEqual(reversed)
    expect(forward.statistics!.signFlip.method).toBe('monte-carlo')
    expect(forward.statistics!.signFlip.assignments).toBe(4_000)
    expect(forward.statistics!.signFlip.pValue).toBeGreaterThan(0)
    expect(forward.statistics!.signFlip.pValue).toBeLessThanOrEqual(1)
  })

  it('tests the task-weighted effect instead of a conflicting equal-cluster estimand', () => {
    const rows: BinaryRow[] = []
    for (let cluster = 0; cluster < 30; cluster++) {
      rows.push(row(`positive-${cluster}`, `positive-${cluster}`, 'baseline', false))
      rows.push(row(`positive-${cluster}`, `positive-${cluster}`, 'candidate', true))
    }
    for (let cluster = 0; cluster < 10; cluster++) {
      for (let task = 0; task < 2; task++) {
        rows.push(row(`negative-${cluster}-${task}`, `negative-${cluster}`, 'baseline', true))
        rows.push(row(`negative-${cluster}-${task}`, `negative-${cluster}`, 'candidate', false))
      }
    }

    const result = clusteredPairedBinary(
      rows,
      options({
        seed: 36020260709,
        bootstrapResamples: 10_000,
        signFlipResamples: 200_000,
        exactClusterLimit: 20,
        alternative: 'greater',
      }),
    )

    expect(result.statistics!.taskWeightedRiskDifference).toBeCloseTo(0.2, 12)
    expect(result.statistics!.equalClusterMean).toBeCloseTo(0.5, 12)
    expect(result.statistics!.bootstrap!.lower).toBeLessThan(0)
    expect(result.statistics!.signFlip.statistic).toBeCloseTo(
      result.statistics!.taskWeightedRiskDifference,
      12,
    )
    expect(result.statistics!.signFlip.pValue).toBeGreaterThan(0.05)
  })

  it('returns null statistics instead of fabricating a zero when no rows match', () => {
    const baseline = row('baseline-only', 'cluster-a', 'baseline', false)
    const treatment = row('candidate-only', 'cluster-b', 'candidate', true)

    const result = clusteredPairedBinary([baseline, treatment], options())

    expect(result.matchedPairs).toEqual([])
    expect(result.unpairedBaseline).toEqual([baseline])
    expect(result.unpairedTreatment).toEqual([treatment])
    expect(result.statistics).toBeNull()
  })

  it('distinguishes a measured concordant zero from absent matched evidence', () => {
    const rows = [
      row('task-1', 'cluster-a', 'baseline', true),
      row('task-1', 'cluster-a', 'candidate', true),
    ]

    const result = clusteredPairedBinary(rows, options())

    expect(result.statistics).not.toBeNull()
    expect(result.statistics!.taskWeightedRiskDifference).toBe(0)
    expect(result.statistics!.equalClusterMean).toBe(0)
    expect(result.statistics!.bootstrap).toBeNull()
    expect(result.statistics!.signFlip.pValue).toBe(1)
  })

  it('does not fabricate a zero-width cluster interval from one independent cluster', () => {
    const rows = [
      row('task-1', 'only-repository', 'baseline', false),
      row('task-1', 'only-repository', 'candidate', true),
    ]

    const result = clusteredPairedBinary(rows, options({ alternative: 'greater' }))

    expect(result.statistics!.taskWeightedRiskDifference).toBe(1)
    expect(result.statistics!.bootstrap).toBeNull()
    expect(result.statistics!.signFlip).toMatchObject({ statistic: 1, pValue: 0.5 })
  })

  it('rejects too few bootstrap draws before a nominal interval can collapse to one draw', () => {
    const rows = [
      row('improves', 'repository-a', 'baseline', false),
      row('improves', 'repository-a', 'candidate', true),
      row('regresses', 'repository-b', 'baseline', true),
      row('regresses', 'repository-b', 'candidate', false),
    ]

    expect(() => clusteredPairedBinary(rows, options({ seed: 7, bootstrapResamples: 1 }))).toThrow(
      /bootstrapResamples must be at least 40 for confidence 0\.95/,
    )
  })

  it('rejects a matched work item whose arms claim different clusters', () => {
    const rows = [
      row('task-1', 'cluster-a', 'baseline', false),
      row('task-1', 'cluster-b', 'candidate', true),
    ]
    expect(() => clusteredPairedBinary(rows, options())).toThrow(/crosses clusters/)
  })

  it('validates accessor outputs and inference configuration', () => {
    const rows = [
      row('task-1', 'cluster-a', 'baseline', false),
      row('task-1', 'cluster-a', 'candidate', true),
    ]
    expect(() => clusteredPairedBinary(rows, options({ clusterKey: () => '' }))).toThrow(
      /clusterKey accessor must return a non-empty string/,
    )
    expect(() => clusteredPairedBinary(rows, options({ seed: 1.5 }))).toThrow(
      /seed must be an integer/,
    )
    expect(() => clusteredPairedBinary(rows, options({ confidence: 1 }))).toThrow(
      /confidence must be in \(0,1\)/,
    )
    expect(() => clusteredPairedBinary(rows, options({ bootstrapResamples: 0 }))).toThrow(
      /bootstrapResamples must be a positive integer/,
    )
    expect(() => clusteredPairedBinary(rows, options({ exactClusterLimit: 21 }))).toThrow(
      /exactClusterLimit must be an integer in \[0,20\]/,
    )
    expect(() =>
      clusteredPairedBinary(
        rows,
        options({ alternative: 'up' as ClusteredPairedBinaryOptions<BinaryRow>['alternative'] }),
      ),
    ).toThrow(/alternative must be/)
    expect(() =>
      clusteredPairedBinary(
        rows,
        options({ pass: (() => 'yes') as unknown as (value: BinaryRow) => boolean }),
      ),
    ).toThrow(/pass accessor must return boolean/)
  })
})

describe('holm', () => {
  it('applies monotone step-down adjustment and restores input order', () => {
    expect(holm([0.04, 0.01, 0.03])).toEqual({
      adjusted: [0.06, 0.03, 0.06],
      significant: [false, true, false],
    })
  })

  it('handles ties, the alpha boundary, and an empty family', () => {
    expect(holm([0.025, 0.025])).toEqual({
      adjusted: [0.05, 0.05],
      significant: [true, true],
    })
    expect(holm([])).toEqual({ adjusted: [], significant: [] })
  })

  it('rejects invalid p-values and alpha', () => {
    for (const call of [() => holm([0.1, Number.NaN]), () => holm([-0.1]), () => holm([0.1], 0)]) {
      expect(call).toThrow(ValidationError)
    }
    expect(() => holm([0.1, Number.NaN])).toThrow(/pValues\[1\] must be in \[0,1\]/)
    expect(() => holm([-0.1])).toThrow(/pValues\[0\] must be in \[0,1\]/)
    expect(() => holm([0.1], 0)).toThrow(/alpha must be in \(0,1\)/)
  })
})
