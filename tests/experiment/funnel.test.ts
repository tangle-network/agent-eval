/**
 * The denominator-chain object: monotone by construction, reconciled on every
 * build, refusing a stage that gains rows, and rendering itself.
 */

import { describe, expect, it } from 'vitest'
import {
  assertFunnelReconciles,
  buildFunnel,
  composeFunnels,
  type ExperimentFunnel,
  FunnelIntegrityError,
  renderFunnelTable,
} from '../../src/experiment/index'

describe('buildFunnel', () => {
  it('chains stage counts and reconciles input = surviving + excluded', () => {
    const funnel = buildFunnel({
      population: 'recorded failures',
      input: 20,
      stages: [
        { id: 'clean-exit', excluded: 5 },
        { id: 'replayable', excluded: 1, waives: ['no-fix-control-passed'] },
      ],
    })
    expect(funnel.stages.map((s) => s.remaining)).toEqual([15, 14])
    expect(funnel.surviving).toBe(14)
    expect(funnel.stages[1]!.waives).toEqual(['no-fix-control-passed'])
  })

  it('refuses a stage that gains rows', () => {
    expect(() =>
      buildFunnel({
        population: 'p',
        input: 10,
        stages: [{ id: 'grows', excluded: -2 }],
      }),
    ).toThrow(FunnelIntegrityError)
    expect(() =>
      buildFunnel({
        population: 'p',
        input: 10,
        stages: [{ id: 'grows', excluded: -2 }],
      }),
    ).toThrow(/gains 2 rows/)
  })

  it('refuses a stage that excludes more rows than entered', () => {
    expect(() =>
      buildFunnel({ population: 'p', input: 3, stages: [{ id: 'over', excluded: 4 }] }),
    ).toThrow(FunnelIntegrityError)
  })

  it('refuses named exclusions that do not sum to the stage total', () => {
    expect(() =>
      buildFunnel({
        population: 'p',
        input: 10,
        stages: [{ id: 's', excluded: 3, exclusions: { 'reason-a': 1, 'reason-b': 1 } }],
      }),
    ).toThrow(/summing to 2 but excludes 3/)
  })

  it('refuses a partition that draws from an unknown stage or overdraws it', () => {
    expect(() =>
      buildFunnel({
        population: 'p',
        input: 10,
        stages: [{ id: 's', excluded: 2 }],
        partitions: [{ id: 'x', from: 'missing', count: 1 }],
      }),
    ).toThrow(/unknown stage/)
    expect(() =>
      buildFunnel({
        population: 'p',
        input: 10,
        stages: [{ id: 's', excluded: 2 }],
        partitions: [{ id: 'x', from: 's', count: 3 }],
      }),
    ).toThrow(/excluded 2/)
  })

  it('assertFunnelReconciles rejects a hand-built chain that gains rows', () => {
    const broken: ExperimentFunnel = {
      population: 'p',
      input: 10,
      stages: [{ id: 's', entering: 10, excluded: 0, remaining: 12 }],
      surviving: 12,
      partitions: [],
    }
    expect(() => assertFunnelReconciles(broken)).toThrow(FunnelIntegrityError)
  })
})

describe('composeFunnels', () => {
  it('chains two funnels whose boundary agrees', () => {
    const admission = buildFunnel({
      population: 'corpus',
      input: 48,
      stages: [{ id: 'admitted', excluded: 16 }],
    })
    const scoring = buildFunnel({
      population: 'admitted rows',
      input: 32,
      stages: [{ id: 'scored', excluded: 2 }],
    })
    const whole = composeFunnels(admission, scoring)
    expect(whole.input).toBe(48)
    expect(whole.surviving).toBe(30)
    expect(whole.stages.map((s) => s.id)).toEqual(['admitted', 'scored'])
  })

  it('refuses composition across a gap or an injection', () => {
    const first = buildFunnel({
      population: 'a',
      input: 10,
      stages: [{ id: 's', excluded: 4 }],
    })
    const second = buildFunnel({ population: 'b', input: 7, stages: [] })
    expect(() => composeFunnels(first, second)).toThrow(/survives 6 rows but 'b' starts from 7/)
  })
})

describe('renderFunnelTable', () => {
  it('renders the chain with the reconciliation line and partitions', () => {
    const funnel = buildFunnel({
      population: 'primary denominator',
      input: 48,
      stages: [
        { id: 'deterministic-oracle', excluded: 5 },
        { id: 'clean-exit', excluded: 8 },
        { id: 'prefix-fidelity', excluded: 3 },
      ],
      partitions: [{ id: 'secondary-prefix-divergent', from: 'prefix-fidelity', count: 3 }],
    })
    const rendered = renderFunnelTable(funnel)
    expect(rendered).toContain('population: primary denominator')
    expect(rendered).toContain('input: 48')
    expect(rendered).toContain('surviving: 32  (input 48 = surviving 32 + excluded 16)')
    expect(rendered).toContain('partition secondary-prefix-divergent: 3 rows')
    expect(rendered).toContain('never pooled')
  })
})
