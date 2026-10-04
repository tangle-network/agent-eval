import { describe, expect, it } from 'vitest'
import { clusterBootstrapMean } from './index'

describe('clusterBootstrapMean', () => {
  it('weights observations equally in the point estimate and reproduces with a seed', () => {
    const observations = [
      { cluster: 'a', value: 1 },
      { cluster: 'a', value: 1 },
      { cluster: 'a', value: 1 },
      { cluster: 'b', value: 0 },
    ]
    const first = clusterBootstrapMean(observations, { seed: 7 })
    expect(first).toMatchObject({ n: 4, clusters: 2, mean: 0.75 })
    expect(clusterBootstrapMean(observations, { seed: 7 })).toEqual(first)
  })

  it('is wider than an item bootstrap when items within a cluster move together', () => {
    const observations = Array.from({ length: 20 }, (_, cluster) =>
      Array.from({ length: 10 }, () => ({ cluster: `c${cluster}`, value: cluster % 2 })),
    ).flat()
    const clustered = clusterBootstrapMean(observations, { seed: 1 })
    const independent = clusterBootstrapMean(
      observations.map((observation, index) => ({
        cluster: `i${index}`,
        value: observation.value,
      })),
      { seed: 1 },
    )
    expect(clustered.mean).toBeCloseTo(0.5, 12)
    expect(clustered.high - clustered.low).toBeGreaterThan(2 * (independent.high - independent.low))
  })

  it('collapses to the point estimate with one cluster and refuses invalid input', () => {
    expect(
      clusterBootstrapMean([
        { cluster: 'x', value: 0.2 },
        { cluster: 'x', value: 0.4 },
      ]),
    ).toMatchObject({ clusters: 1, low: 0.30000000000000004, high: 0.30000000000000004 })
    expect(() => clusterBootstrapMean([])).toThrow(/at least one/)
    expect(() => clusterBootstrapMean([{ cluster: '', value: 1 }])).toThrow(/cluster id/)
    expect(() => clusterBootstrapMean([{ cluster: 'a', value: Number.NaN }])).toThrow(/finite/)
    expect(() => clusterBootstrapMean([{ cluster: 'a', value: 1 }], { confidence: 1 })).toThrow(
      /confidence/,
    )
  })
})
