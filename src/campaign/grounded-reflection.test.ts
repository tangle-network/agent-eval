import { describe, expect, it } from 'vitest'
import {
  classifyUngroundedLiterals,
  rolloutArgumentDiff,
  type ScoredRollout,
} from './grounded-reflection'

const rollouts: ScoredRollout[] = [
  {
    id: 'task0-pass',
    score: 1,
    calls: [{ name: 'create', args: { service_name: 'Email', target_status: '' } }],
  },
  {
    id: 'task1-fail',
    score: 0,
    calls: [
      {
        name: 'create',
        args: { service_name: 'VPN', target_status: 'new', notification_status: 'sent' },
      },
    ],
  },
]

describe('rolloutArgumentDiff', () => {
  it('separates passing vs failing values per field and marks omissions', () => {
    const d = rolloutArgumentDiff(rollouts)
    expect(d.text).toMatch(/service_name: passing runs -> \["Email"\] \| failing runs -> \["VPN"\]/)
    expect(d.text).toMatch(
      /notification_status: passing runs -> NOT SET \(omitted\) \| failing runs -> \["sent"\]/,
    )
    expect(d.passingValues.has('email')).toBe(true)
    expect(d.passingValues.has('sent')).toBe(false)
    expect(d.failingValues.has('sent')).toBe(true)
    expect(d.failingValues.has('new')).toBe(true)
  })

  it('honors passThreshold for partial-credit scoring', () => {
    const d = rolloutArgumentDiff(
      [{ id: 'partial', score: 0.5, calls: [{ name: 'c', args: { field: 'half' } }] }],
      { passThreshold: 0.5 },
    )
    expect(d.passingValues.has('half')).toBe(true)
    expect(d.failingValues.size).toBe(0)
  })

  it('reports the empty case explicitly instead of an empty string', () => {
    expect(rolloutArgumentDiff([]).text).toContain('no calls observed')
  })
})

describe('classifyUngroundedLiterals', () => {
  it('splits harmful (used by failing runs) from benign illustrations', () => {
    const diff = rolloutArgumentDiff(rollouts)
    const report = classifyUngroundedLiterals(
      "Always use 'new' here; set delivery to 'sent'. Example person: 'Doe'.",
      diff,
    )
    expect([...report.ungrounded].sort()).toEqual(['doe', 'new', 'sent'])
    expect([...report.harmful].sort()).toEqual(['new', 'sent'])
  })

  it('ignores grounded literals and multi-word quotes', () => {
    const diff = rolloutArgumentDiff(rollouts)
    const report = classifyUngroundedLiterals(
      "Copy 'email' exactly. Say 'do it now' politely.",
      diff,
    )
    expect(report.ungrounded).toEqual([])
    expect(report.harmful).toEqual([])
  })
})
