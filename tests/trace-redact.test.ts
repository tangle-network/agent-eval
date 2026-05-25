import { describe, expect, it } from 'vitest'
import { DEFAULT_REDACTION_RULES, redactString, redactValue } from '../src/trace'

describe('redactString', () => {
  it('redacts email, ssn, credit card, bearer — regression: missing these leaks PII into traces', () => {
    const input =
      'Contact me at jane.doe@example.com, SSN 123-45-6789, card 4111 1111 1111 1111, Bearer eyJhbGciOi123456.abcdefg'
    const { output, report } = redactString(input)
    expect(output).not.toContain('jane.doe@example.com')
    expect(output).not.toContain('123-45-6789')
    expect(output).not.toContain('Bearer eyJ')
    expect(report.redactionCount).toBeGreaterThanOrEqual(3)
    expect(Object.keys(report.byRule)).toContain('email')
    expect(Object.keys(report.byRule)).toContain('ssn')
  })

  it('leaves clean strings unchanged', () => {
    const input = 'The quick brown fox jumps over the lazy dog.'
    const { output, report } = redactString(input)
    expect(output).toBe(input)
    expect(report.redactionCount).toBe(0)
  })

  it('accepts custom rules', () => {
    const { output } = redactString('API_KEY=sk-tan-abcd', [
      { id: 'tangle-key', pattern: /sk-tan-[A-Za-z0-9]+/g },
    ])
    expect(output).toContain('[redacted:tangle-key]')
  })
})

describe('redactValue', () => {
  it('walks nested objects and arrays', () => {
    const input = {
      user: { email: 'a@b.com', name: 'safe' },
      messages: [{ content: 'reach me: phone 555-867-5309' }, { content: 'no secrets here' }],
    }
    const { value, report } = redactValue(input)
    const asJson = JSON.stringify(value)
    expect(asJson).not.toContain('a@b.com')
    expect(asJson).not.toContain('555-867-5309')
    expect(report.redactionCount).toBeGreaterThanOrEqual(2)
  })

  it('leaves non-string leaves alone — regression: stringifying numbers would break downstream typings', () => {
    const { value } = redactValue({ age: 42, active: true, data: null })
    expect(value).toEqual({ age: 42, active: true, data: null })
  })

  it('DEFAULT_REDACTION_RULES catches AWS + private key markers', () => {
    const { output } = redactString(
      'aws AKIAIOSFODNN7EXAMPLE leaked\n-----BEGIN PRIVATE KEY-----\nMIIE\n-----END PRIVATE KEY-----',
    )
    expect(output).toContain('[redacted:aws-access-key]')
    expect(output).toContain('[redacted:private-key-block]')
    expect(DEFAULT_REDACTION_RULES.find((r) => r.id === 'ssn')).toBeDefined()
  })
})
