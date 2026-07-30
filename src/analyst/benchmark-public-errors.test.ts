import { describe, expect, it } from 'vitest'
import { publicBenchmarkError } from './benchmark-public-errors'

describe('publicBenchmarkError', () => {
  it('keeps the beginning and final exception from long errors', () => {
    const error = publicBenchmarkError(new Error(`START ${'x'.repeat(800)} FINAL_EXCEPTION`))

    expect(error.message).toContain('START')
    expect(error.message).toContain('chars omitted')
    expect(error.message).toContain('FINAL_EXCEPTION')
    expect(error.message.length).toBeLessThanOrEqual(500)
  })

  it('redacts explicit and patterned secrets before truncating', () => {
    const secret = 'provider-secret-value'
    const error = publicBenchmarkError(
      new Error(`Bearer bearer-token ${secret} ${'x'.repeat(800)} api_key=tail-secret`),
      [secret],
    )

    expect(error.message).not.toContain(secret)
    expect(error.message).not.toContain('bearer-token')
    expect(error.message).not.toContain('tail-secret')
    expect(error.message.match(/\[REDACTED\]/g)?.length).toBeGreaterThanOrEqual(3)
  })
})
