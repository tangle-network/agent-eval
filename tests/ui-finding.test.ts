import { describe, expect, it } from 'vitest'
import {
  UI_FINDING_SEVERITIES,
  UI_LENSES,
  type UiFinding,
  type UiFindingSeverity,
  type UiLens,
} from '../src/ui-finding'

describe('UI_LENSES', () => {
  it('matches the UiLens union exhaustively', () => {
    // The runtime tuple and the type must stay in sync — if a lens is added
    // to the union without updating the tuple, a lens-keyed Record will
    // silently lose dimensions in downstream code. Enforce both directions.
    const witness: Record<UiLens, true> = {
      consistency: true,
      hierarchy: true,
      layout: true,
      'ux-flow': true,
      duplication: true,
      accessibility: true,
      responsive: true,
      states: true,
      content: true,
      interaction: true,
      'performance-perceived': true,
      other: true,
    }
    for (const lens of UI_LENSES) {
      expect(witness[lens]).toBe(true)
    }
    expect(Object.keys(witness).sort()).toEqual([...UI_LENSES].sort())
  })

  it('contains no duplicates', () => {
    expect(new Set(UI_LENSES).size).toBe(UI_LENSES.length)
  })
})

describe('UI_FINDING_SEVERITIES', () => {
  it('orders severities worst → least bad', () => {
    expect(UI_FINDING_SEVERITIES).toEqual(['critical', 'high', 'med', 'low'])
  })

  it('matches the UiFindingSeverity union exhaustively', () => {
    const witness: Record<UiFindingSeverity, true> = {
      critical: true,
      high: true,
      med: true,
      low: true,
    }
    expect(Object.keys(witness).sort()).toEqual([...UI_FINDING_SEVERITIES].sort())
  })
})

describe('UiFinding shape', () => {
  it('accepts a minimally complete finding', () => {
    const finding: UiFinding = {
      title: 'Primary CTA invisible on hover state',
      lens: 'interaction',
      severity: 'med',
      route: 'home',
      observation: 'CTA background blends into card background on hover.',
      impact: 'Users lose the affordance during the moment they need it most.',
      suggestedFix: 'Add 2px border on hover instead of swapping background.',
      screenshots: [{ path: 'screenshots/home--cta--hover.png', viewport: '1280x800' }],
    }
    expect(finding.title.length).toBeGreaterThan(0)
    expect(finding.screenshots.length).toBe(1)
  })

  it('treats `screenshots` and `tags` as readonly arrays', () => {
    const finding: UiFinding = {
      title: 't',
      lens: 'consistency',
      severity: 'low',
      route: 'r',
      observation: 'o',
      impact: 'i',
      suggestedFix: 's',
      screenshots: [{ path: 'a.png' }],
      tags: ['nav', 'header'],
    }
    // @ts-expect-error — screenshots is readonly.
    finding.screenshots.push({ path: 'b.png' })
    // @ts-expect-error — tags is readonly.
    finding.tags?.push('extra')
  })
})
