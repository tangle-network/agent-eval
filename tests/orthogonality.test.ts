import { describe, expect, it } from 'vitest'
import { passOrthogonality } from '../src/index'

describe('passOrthogonality', () => {
  it('returns 1 with fewer than 2 passes (vacuously orthogonal)', () => {
    expect(passOrthogonality({ passes: [] }).orthogonality).toBe(1)
    expect(passOrthogonality({ passes: [{ findings: ['anything'] }] }).orthogonality).toBe(1)
  })

  it('drops near 0 when passes share heavy lexical overlap', () => {
    const findings = [{ description: 'typography spacing rhythm hierarchy hierarchy' }]
    const r = passOrthogonality({ passes: [{ findings }, { findings }] })
    expect(r.orthogonality).toBeLessThan(0.05)
    expect(r.passCount).toBe(2)
  })

  it('approaches 1 when passes share little vocabulary', () => {
    const passA = [{ description: 'typography rhythm spacing hierarchy' }]
    const passB = [{ description: 'compliance disclosure consent provenance verification' }]
    const r = passOrthogonality({ passes: [{ findings: passA }, { findings: passB }] })
    expect(r.orthogonality).toBeGreaterThan(0.9)
  })

  it('honours custom text() extractor', () => {
    const passes = [
      { findings: [{ note: 'red blue green' }] },
      { findings: [{ note: 'crimson azure emerald' }] },
    ]
    const r = passOrthogonality({ passes, text: (item: any) => item.note })
    expect(r.orthogonality).toBeGreaterThan(0.9)
  })

  it('tracks pairwise similarities count for N(N-1)/2 pairs', () => {
    const passes = [
      { findings: [{ x: 'a b c d' }] },
      { findings: [{ x: 'e f g h' }] },
      { findings: [{ x: 'i j k l' }] },
    ]
    const r = passOrthogonality({ passes, text: (item: any) => item.x, minTokenLength: 1 })
    expect(r.similarities.length).toBe(3) // 3 pairs
  })
})
