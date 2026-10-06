import { describe, expect, it } from 'vitest'

import type { ToolSpan } from './trace/schema'
import {
  gateTreatmentApplied,
  gateTreatmentFromToolSpans,
  type ToolMatcher,
} from './treatment-gate'

// A generic, NON-search matcher proves the gate has no domain coupling: here
// the "treatment" is a browser tool. A search A/B would pass its own matcher.
const matchesBrowser: ToolMatcher = (t) => /browser|navigate|click/i.test(t)

describe('gateTreatmentApplied', () => {
  it('applies when a matching tool fired (telemetry present)', () => {
    const g = gateTreatmentApplied({
      toolHistogram: { Read: 3, browser_navigate: 2, Bash: 1 },
      matches: matchesBrowser,
    })
    expect(g.applied).toBe(true)
    expect(g.gated).toBe(false)
    expect(g.matchedCalls).toBe(2)
    expect(g.observedTools).toBe(6)
  })

  it('gates (treatment-not-applied) when tools fired but none match', () => {
    const g = gateTreatmentApplied({
      toolHistogram: { Read: 4, Bash: 2 },
      matches: matchesBrowser,
    })
    expect(g.applied).toBe(false)
    expect(g.gated).toBe(true)
    expect(g.matchedCalls).toBe(0)
    expect(g.observedTools).toBe(6)
    expect(g.reason).toMatch(/never fired/)
  })

  it('fails OPEN on empty telemetry — a gap is never quarantined', () => {
    const g = gateTreatmentApplied({ toolHistogram: {}, matches: matchesBrowser })
    expect(g.applied).toBe(true)
    expect(g.gated).toBe(false)
    expect(g.observedTools).toBe(0)
    expect(g.reason).toMatch(/fail-open/)
  })

  it('fails CLOSED on empty telemetry when opted in', () => {
    const g = gateTreatmentApplied(
      { toolHistogram: {}, matches: matchesBrowser },
      { failOpenWhenNoTelemetry: false },
    )
    expect(g.applied).toBe(false)
    expect(g.gated).toBe(true)
    expect(g.reason).toMatch(/fail-closed/)
  })

  it('ignores zero/negative counts when summing observed tools', () => {
    const g = gateTreatmentApplied({
      toolHistogram: { Read: 0, browser_click: 1 },
      matches: matchesBrowser,
    })
    expect(g.observedTools).toBe(1)
    expect(g.matchedCalls).toBe(1)
    expect(g.applied).toBe(true)
  })

  it('matcher is a pure parameter — different matcher flips the verdict on the same histogram', () => {
    const hist = { Read: 3, web_search: 2 }
    expect(gateTreatmentApplied({ toolHistogram: hist, matches: matchesBrowser }).gated).toBe(true)
    const matchesSearch: ToolMatcher = (t) => /search/i.test(t)
    expect(gateTreatmentApplied({ toolHistogram: hist, matches: matchesSearch }).gated).toBe(false)
  })
})

describe('gateTreatmentFromToolSpans', () => {
  it('counts canonical ToolSpan.toolName without OTLP extraction', () => {
    const spans: ToolSpan[] = [
      {
        spanId: 's1',
        runId: 'r1',
        kind: 'tool',
        name: 'tool',
        startedAt: 0,
        toolName: 'Read',
        args: {},
      },
      {
        spanId: 's2',
        runId: 'r1',
        kind: 'tool',
        name: 'tool',
        startedAt: 1,
        toolName: 'Bash',
        args: {},
      },
    ]
    const g = gateTreatmentFromToolSpans(spans, matchesBrowser)
    expect(g.gated).toBe(true)
    expect(g.observedTools).toBe(2)
    expect(g.matchedCalls).toBe(0)
  })
})
