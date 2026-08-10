import { describe, expect, it } from 'vitest'
import {
  NO_DECISIVE_FAILURE,
  parseAnalystResponse,
  repairFinding,
} from '../../src/trace-repair/analyst-response'

describe('the analyst may say exactly two things', () => {
  it('reads the bare decline literal', () => {
    const outcome = parseAnalystResponse(`  ${NO_DECISIVE_FAILURE}\n`)
    expect(outcome).toEqual({ succeeded: true, value: { kind: 'no-decisive-failure' } })
  })

  it('reads one finding, in snake case or camel case', () => {
    for (const key of ['failure_claim', 'failureClaim']) {
      const outcome = parseAnalystResponse(
        JSON.stringify({
          k: 7,
          [key]: 'the test file was never created',
          intervention: { kind: 'shell', action: 'touch /app/tests/test_main.py' },
        }),
      )
      expect(outcome).toMatchObject({
        succeeded: true,
        value: { kind: 'finding', k: 7, failureClaim: 'the test file was never created' },
      })
    }
  })

  it('reads a finding out of a fenced block wrapped in prose', () => {
    const reply = [
      'Looking at the trace, step 7 is where it goes wrong.',
      '```json',
      JSON.stringify({ k: 7, failure_claim: 'wrong path', intervention: { kind: 'edit', action: 'x' } }),
      '```',
    ].join('\n')
    expect(parseAnalystResponse(reply)).toMatchObject({ succeeded: true, value: { k: 7 } })
  })

  it('refuses a reply that hedges with several findings', () => {
    const reply = `[${JSON.stringify({ k: 1, failure_claim: 'a', intervention: { kind: 'shell', action: 'x' } })},${JSON.stringify(
      { k: 2, failure_claim: 'b', intervention: { kind: 'shell', action: 'y' } },
    )}]`
    expect(parseAnalystResponse(reply)).toMatchObject({
      succeeded: false,
      failure: 'not-a-single-answer',
    })
  })

  it('never defaults a missing field', () => {
    const base = {
      k: 3,
      failure_claim: 'x',
      intervention: { kind: 'shell', action: 'echo hi' },
    }
    const cases: [Record<string, unknown>, string][] = [
      [{ ...base, k: undefined }, 'missing-k'],
      [{ ...base, k: 1.5 }, 'missing-k'],
      [{ ...base, failure_claim: '   ' }, 'missing-failure-claim'],
      [{ ...base, intervention: undefined }, 'missing-intervention'],
      [{ ...base, intervention: { kind: 'shell' } }, 'missing-intervention'],
      [{ ...base, intervention: { kind: 'patch', action: 'x' } }, 'unknown-intervention-kind'],
    ]
    for (const [body, failure] of cases) {
      expect(parseAnalystResponse(JSON.stringify(body))).toMatchObject({
        succeeded: false,
        failure,
      })
    }
  })

  it('refuses an empty reply and a reply with no answer in it', () => {
    expect(parseAnalystResponse('   ')).toMatchObject({ succeeded: false, failure: 'unreadable' })
    expect(parseAnalystResponse('I am not sure what went wrong.')).toMatchObject({
      succeeded: false,
      failure: 'unreadable',
    })
  })

  it('reads a structured decline as a decline', () => {
    expect(parseAnalystResponse(JSON.stringify({ no_decisive_failure: true }))).toMatchObject({
      succeeded: true,
      value: { kind: 'no-decisive-failure' },
    })
  })
})

describe('repairFinding', () => {
  it('refuses a non-positive k and an empty claim', () => {
    const intervention = { kind: 'shell', action: 'echo hi' } as const
    expect(() => repairFinding({ k: 0, failureClaim: 'x', intervention })).toThrow(/positive/)
    expect(() => repairFinding({ k: 1, failureClaim: ' ', intervention })).toThrow(/failure claim/)
  })
})
