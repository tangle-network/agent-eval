import { describe, expect, it } from 'vitest'
import {
  assertPolicyEditAuthorContextBudget,
  selectPolicyEditAuthorRows,
} from './policy-edit-author-context'

describe('selectPolicyEditAuthorRows', () => {
  it('preserves hardest, largest regression, and largest improvement', () => {
    const rows = [
      { scenarioId: 'hard', composite: 0.1 },
      { scenarioId: 'regressed', composite: 0.5 },
      { scenarioId: 'improved', composite: 0.8 },
      { scenarioId: 'ordinary', composite: 0.6 },
    ]
    const referenceByScenario = new Map([
      ['hard', 0.1],
      ['regressed', 0.9],
      ['improved', 0.2],
      ['ordinary', 0.5],
    ])

    expect(selectPolicyEditAuthorRows(rows, { limit: 3, referenceByScenario })).toEqual([
      rows[0],
      rows[1],
      rows[2],
    ])
  })

  it('deduplicates scenario IDs and never exceeds the limit', () => {
    const firstDuplicate = { scenarioId: 'duplicate', composite: 0.1, notes: 'first' }
    const rows = [
      firstDuplicate,
      { scenarioId: 'duplicate', composite: 0.05, notes: 'second' },
      { scenarioId: 'b', composite: 0.2 },
      { scenarioId: 'c', composite: 0.3 },
    ]

    const selected = selectPolicyEditAuthorRows(rows, { limit: 2 })
    expect(selected).toHaveLength(2)
    expect(selected.filter((row) => row.scenarioId === 'duplicate')).toEqual([firstDuplicate])
  })

  it('preserves first-occurrence caller order when explicitly requested', () => {
    const firstDuplicate = { scenarioId: 'first', composite: 0.9, notes: 'first' }
    const rows = [
      firstDuplicate,
      { scenarioId: 'second', composite: 0.1 },
      { scenarioId: 'first', composite: 0, notes: 'duplicate' },
      { scenarioId: 'third', composite: 0.5 },
      { scenarioId: 'fourth', composite: 0.2 },
    ]

    expect(selectPolicyEditAuthorRows(rows, { limit: 3, scenarioOrder: 'input' })).toEqual([
      firstDuplicate,
      rows[1],
      rows[3],
    ])
  })

  it('ranks hardest rows with scenario ID as the stable tie break', () => {
    const rows = [
      { scenarioId: 'z', composite: 0.1 },
      { scenarioId: 'a', composite: 0.1 },
      { scenarioId: 'm', composite: 0.2 },
    ]

    expect(selectPolicyEditAuthorRows(rows, { limit: 3 }).map((row) => row.scenarioId)).toEqual([
      'a',
      'z',
      'm',
    ])
  })

  it('uses scenario ID as the stable tie break for equal deltas', () => {
    const rows = [
      { scenarioId: 'hard', composite: 0 },
      { scenarioId: 'regression-z', composite: 0.4 },
      { scenarioId: 'regression-a', composite: 0.4 },
      { scenarioId: 'improvement-z', composite: 0.8 },
      { scenarioId: 'improvement-a', composite: 0.8 },
    ]
    const referenceByScenario = new Map([
      ['hard', 0],
      ['regression-z', 0.6],
      ['regression-a', 0.6],
      ['improvement-z', 0.6],
      ['improvement-a', 0.6],
    ])

    expect(
      selectPolicyEditAuthorRows(rows, { limit: 3, referenceByScenario }).map(
        (row) => row.scenarioId,
      ),
    ).toEqual(['hard', 'regression-a', 'improvement-a'])
  })

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])('rejects invalid limit %s', (limit) => {
    expect(() => selectPolicyEditAuthorRows([], { limit })).toThrow(
      /limit must be a positive safe integer/,
    )
  })

  it('rejects non-finite scores before selection', () => {
    expect(() =>
      selectPolicyEditAuthorRows([{ scenarioId: 'bad', composite: Number.NaN }], { limit: 1 }),
    ).toThrow(/composite must be finite for 'bad'/)
    expect(() =>
      selectPolicyEditAuthorRows([{ scenarioId: 'bad', composite: 0.5 }], {
        limit: 1,
        referenceByScenario: new Map([['bad', Number.POSITIVE_INFINITY]]),
      }),
    ).toThrow(/reference must be finite for 'bad'/)
  })

  it('rejects an unknown scenario order', () => {
    expect(() =>
      selectPolicyEditAuthorRows([], { limit: 1, scenarioOrder: 'unknown' as never }),
    ).toThrow(/scenarioOrder must be 'ranked' or 'input'/)
  })
})

describe('assertPolicyEditAuthorContextBudget', () => {
  it('returns the exact serialization and measured character count', () => {
    const value = { scenarios: [{ scenarioId: 'a', composite: 0.5 }] }
    const json = JSON.stringify(value)

    expect(assertPolicyEditAuthorContextBudget(value, json.length)).toEqual({
      json,
      actualChars: json.length,
      maxChars: json.length,
    })
  })

  it('reports actual and maximum counts when the budget is exceeded', () => {
    const value = { evidence: 'too long' }
    const actualChars = JSON.stringify(value).length

    expect(() => assertPolicyEditAuthorContextBudget(value, actualChars - 1)).toThrow(
      `actualChars=${actualChars}, maxChars=${actualChars - 1}`,
    )
  })

  it.each([
    0,
    -1,
    1.5,
    Number.MAX_SAFE_INTEGER + 1,
  ])('rejects invalid character budget %s', (maxChars) => {
    expect(() => assertPolicyEditAuthorContextBudget({}, maxChars)).toThrow(
      /maxChars must be a positive safe integer/,
    )
  })
})
