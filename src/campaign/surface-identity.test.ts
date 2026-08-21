import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { canonicalString } from '../ledger-core/canonical'
import {
  componentSurfaceIdentityMaterial,
  surfaceHash,
  surfaceHashMatches,
} from './surface-identity'
import type { ComponentSurface } from './types'

/** Component names that sort differently by collation than by code unit. */
const mixedCase: ComponentSurface = {
  kind: 'components',
  components: { Accuracy: 'a', brevity: 'b', Clarity: 'c' },
}

/** The material this package minted before the identity moved to RFC 8785. */
function retiredMaterial(surface: ComponentSurface): string {
  return JSON.stringify({
    schema: 'tangle.component-surface',
    components: Object.fromEntries(
      Object.entries(surface.components).sort(([left], [right]) => left.localeCompare(right)),
    ),
  })
}

const retiredHash = (surface: ComponentSurface): string =>
  createHash('sha256').update(retiredMaterial(surface)).digest('hex').slice(0, 16)

describe('component surface identity', () => {
  /**
   * The defect this closes: the identity is stored and later recomputed, so an
   * order that comes from the host's collation rather than from the value means
   * the same surface can fail to match its own recorded identity on another
   * machine.
   */
  it('orders component names by code unit, not by the host collation', () => {
    expect(componentSurfaceIdentityMaterial(mixedCase)).toBe(
      canonicalString({ schema: 'tangle.component-surface', components: mixedCase.components }),
    )
    const names = Object.keys(mixedCase.components)
    expect([...names].sort()).toEqual(['Accuracy', 'Clarity', 'brevity'])
    expect([...names].sort((a, b) => a.localeCompare(b))).toEqual([
      'Accuracy',
      'brevity',
      'Clarity',
    ])
    // The orders disagree here; the identity moves for every component surface
    // regardless, which is why the retired material still has to verify.
    expect(retiredMaterial(mixedCase)).not.toBe(componentSurfaceIdentityMaterial(mixedCase))
  })

  it('still matches an identity minted by the retired material', () => {
    const stored = retiredHash(mixedCase)
    expect(stored).not.toBe(surfaceHash(mixedCase))
    expect(surfaceHashMatches(mixedCase, stored)).toBe(true)
    expect(surfaceHashMatches(mixedCase, surfaceHash(mixedCase))).toBe(true)
  })

  it('refuses an identity that belongs to a different surface', () => {
    const edited: ComponentSurface = {
      kind: 'components',
      components: { ...mixedCase.components, brevity: 'edited' },
    }
    expect(surfaceHashMatches(edited, retiredHash(mixedCase))).toBe(false)
    expect(surfaceHashMatches(edited, surfaceHash(mixedCase))).toBe(false)
  })

  /**
   * The retention window covers every stored component-surface identity, not
   * just a mixed-case one: RFC 8785 orders the two top-level keys as well, so
   * `components` precedes `schema` where the retired builder emitted them in
   * literal order.
   */
  it('moves the identity even for names that sort the same either way', () => {
    const ascii: ComponentSurface = {
      kind: 'components',
      components: { alpha: 'a', beta: 'b' },
    }
    expect(surfaceHash(ascii)).not.toBe(retiredHash(ascii))
    expect(surfaceHashMatches(ascii, retiredHash(ascii))).toBe(true)
  })
})
