import { describe, expect, it } from 'vitest'
import { parseRawFinding, RAW_FINDING_SCHEMA_PROMPT } from './finding-signature'

function rawFinding(extra: Record<string, unknown> = {}) {
  return {
    severity: 'high',
    claim: 'turn 4 rewrote prod config against a stated staging-only constraint',
    confidence: 0.9,
    evidence: [
      { uri: 'trace://t1/span/s4', excerpt: 'writing prod.yaml' },
      { uri: 'trace://t1/span/s7', excerpt: 'no, I said staging' },
    ],
    ...extra,
  }
}

describe('raw finding schema — wasted_turns', () => {
  it('accepts and preserves a measured cost', () => {
    const parsed = parseRawFinding(rawFinding({ wasted_turns: 3 }))

    expect(parsed?.wasted_turns).toBe(3)
  })

  it('accepts the floor value of one burned turn', () => {
    expect(parseRawFinding(rawFinding({ wasted_turns: 1 }))?.wasted_turns).toBe(1)
  })

  it('leaves an unmeasured finding without the key rather than defaulting it', () => {
    const parsed = parseRawFinding(rawFinding())

    expect(parsed).not.toBeNull()
    expect(parsed && 'wasted_turns' in parsed).toBe(false)
    expect(parsed?.wasted_turns).toBeUndefined()
  })

  it('round-trips through JSON with the cost intact', () => {
    const parsed = parseRawFinding(rawFinding({ wasted_turns: 12 }))
    const reparsed = parseRawFinding(JSON.parse(JSON.stringify(parsed)))

    expect(reparsed).toEqual(parsed)
    expect(reparsed?.wasted_turns).toBe(12)
  })

  it('round-trips an absent cost through JSON without inventing the key', () => {
    const parsed = parseRawFinding(rawFinding())
    const reparsed = parseRawFinding(JSON.parse(JSON.stringify(parsed)))

    expect(reparsed).toEqual(parsed)
    expect(reparsed && 'wasted_turns' in reparsed).toBe(false)
  })

  it('parses a cost out of a fenced JSON string, same as every other field', () => {
    const fenced = `\`\`\`json\n${JSON.stringify(rawFinding({ wasted_turns: 5 }))}\n\`\`\``

    expect(parseRawFinding(fenced)?.wasted_turns).toBe(5)
  })

  // A 0 is the strictly-between convention, not this field's convention. It is
  // rejected so two off-by-one counts cannot share one ranked list.
  it.each([0, -1, 2.5, Number.NaN, Number.POSITIVE_INFINITY, '3', null])(
    'rejects %p as a cost',
    (value) => {
      expect(parseRawFinding(rawFinding({ wasted_turns: value }))).toBeNull()
    },
  )

  it('still rejects unknown fields', () => {
    expect(parseRawFinding(rawFinding({ burned_turns: 3 }))).toBeNull()
  })

  // The schema is strict, so a field the prompt omits is a field the model
  // never emits, and a field the prompt describes differently is a field the
  // model mis-measures. The two must move together.
  it('is described in the schema prompt the actor reads', () => {
    expect(RAW_FINDING_SCHEMA_PROMPT).toContain('wasted_turns?: integer >= 1')
    expect(RAW_FINDING_SCHEMA_PROMPT).toMatch(/never 0/i)
    expect(RAW_FINDING_SCHEMA_PROMPT).toMatch(/never a sum across clustered instances/i)
  })
})
