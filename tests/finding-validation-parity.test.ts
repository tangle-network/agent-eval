import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import { parseFindingSubject, parseRawFinding } from '../src/analyst'

interface FindingValidationFixture {
  validSubjects: string[]
  invalidSubjects: string[]
  rows: Array<{ name: string; valid: boolean; value: unknown }>
}

const fixture = JSON.parse(
  readFileSync(
    new URL(
      '../clients/python/tests/fixtures/finding-validation-parity.json',
      import.meta.url,
    ),
    'utf8',
  ),
) as FindingValidationFixture

describe('finding validation parity fixture', () => {
  it.each(fixture.validSubjects)('accepts canonical subject %s', (subject) => {
    expect(parseFindingSubject(subject)).not.toBeNull()
  })

  it.each(fixture.invalidSubjects)('rejects non-canonical subject %s', (subject) => {
    expect(parseFindingSubject(subject)).toBeNull()
  })

  it.each(fixture.rows)('$name has the declared TypeScript validity', ({ valid, value }) => {
    expect(parseRawFinding(value) !== null).toBe(valid)
  })

  it('rejects non-finite confidence at the TypeScript boundary', () => {
    expect(
      parseRawFinding({
        severity: 'high',
        claim: 'Non-finite confidence is invalid.',
        confidence: Number.NaN,
        evidence: [{ uri: 'trace://run/span/step-2' }],
      }),
    ).toBeNull()
  })
})
