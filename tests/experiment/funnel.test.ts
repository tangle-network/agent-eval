/**
 * The denominator-chain object: monotone by construction, reconciled on every
 * build, refusing a stage that gains rows, and rendering itself.
 */

import { describe, expect, it } from 'vitest'
import { buildFunnel, composeFunnels, renderFunnelTable } from '../../src/experiment/index'

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
