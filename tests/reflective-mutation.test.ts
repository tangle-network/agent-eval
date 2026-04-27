import { describe, it, expect } from 'vitest'
import {
  buildReflectionPrompt,
  parseReflectionResponse,
  DEFAULT_MUTATION_PRIMITIVES,
} from '../src/index'

describe('buildReflectionPrompt', () => {
  it('quotes the parent payload as JSON', () => {
    const prompt = buildReflectionPrompt({
      target: 'pass-focus',
      parentPayload: { instructions: 'be strict' },
      topTrials: [],
      bottomTrials: [],
      childCount: 1,
    })
    expect(prompt).toContain('be strict')
    expect(prompt).toContain('pass-focus')
    expect(prompt).toContain('Mutation target')
  })

  it('quotes specific missed expectations from bottom trials', () => {
    const prompt = buildReflectionPrompt({
      target: 't',
      parentPayload: {},
      topTrials: [],
      bottomTrials: [
        {
          id: 'trial-1',
          score: 3,
          inputName: 'fixture-a',
          expectations: [
            { id: 'g1', phrase: 'no primary action', matched: false },
            { id: 'g2', phrase: 'fees not disclosed', matched: false },
            { id: 'g3', phrase: 'unrelated golden', matched: true }, // matched ones should NOT appear
          ],
          emitted: 'I noticed the buttons are misaligned.',
        },
      ],
      childCount: 2,
    })
    expect(prompt).toContain('trial-1')
    expect(prompt).toContain('no primary action')
    expect(prompt).toContain('fees not disclosed')
    expect(prompt).not.toContain('unrelated golden')
    expect(prompt).toContain('buttons are misaligned')
  })

  it('mentions every default mutation primitive', () => {
    const prompt = buildReflectionPrompt({
      target: 't',
      parentPayload: {},
      topTrials: [],
      bottomTrials: [],
      childCount: 1,
    })
    for (const primitive of DEFAULT_MUTATION_PRIMITIVES) {
      expect(prompt).toContain(primitive)
    }
  })

  it('honours custom mutation primitives override', () => {
    const prompt = buildReflectionPrompt({
      target: 't',
      parentPayload: {},
      topTrials: [],
      bottomTrials: [],
      childCount: 1,
      mutationPrimitives: ['CUSTOM-PRIMITIVE-XYZ'],
    })
    expect(prompt).toContain('CUSTOM-PRIMITIVE-XYZ')
    expect(prompt).not.toContain(DEFAULT_MUTATION_PRIMITIVES[0])
  })

  it('truncates long emitted text', () => {
    const big = 'a'.repeat(1000)
    const prompt = buildReflectionPrompt({
      target: 't',
      parentPayload: {},
      topTrials: [],
      bottomTrials: [{ id: 't1', score: 0, emitted: big }],
      childCount: 1,
    })
    expect(prompt).toContain('truncated')
    expect(prompt.length).toBeLessThan(big.length + 1500)
  })
})

describe('parseReflectionResponse', () => {
  it('parses a clean JSON response', () => {
    const raw = JSON.stringify({
      proposals: [
        { label: 'tighter', rationale: 'fixes primary action gap', payload: { instructions: 'must show primary' } },
      ],
    })
    const out = parseReflectionResponse(raw)
    expect(out).toHaveLength(1)
    expect(out[0]!.label).toBe('tighter')
    expect((out[0]!.payload as { instructions: string }).instructions).toBe('must show primary')
  })

  it('strips markdown fences', () => {
    const raw = '```json\n' + JSON.stringify({ proposals: [{ payload: { x: 1 } }] }) + '\n```'
    const out = parseReflectionResponse(raw)
    expect(out).toHaveLength(1)
    expect(out[0]!.label).toBe('mutation') // default label when missing
  })

  it('tolerates surrounding prose', () => {
    const raw = 'sure, here is the JSON:\n```\n' + JSON.stringify({ proposals: [{ payload: { x: 1 } }] }) + '\n```\nlmk if you want more'
    const out = parseReflectionResponse(raw)
    expect(out).toHaveLength(1)
  })

  it('returns [] on malformed JSON', () => {
    expect(parseReflectionResponse('not json at all')).toEqual([])
    expect(parseReflectionResponse('{ not even close')).toEqual([])
  })

  it('respects maxProposals', () => {
    const raw = JSON.stringify({
      proposals: [
        { payload: { x: 1 } },
        { payload: { x: 2 } },
        { payload: { x: 3 } },
      ],
    })
    expect(parseReflectionResponse(raw, 2)).toHaveLength(2)
  })

  it('skips proposal entries missing payload', () => {
    const raw = JSON.stringify({ proposals: [{ label: 'no payload' }, { payload: { x: 1 } }] })
    expect(parseReflectionResponse(raw)).toHaveLength(1)
  })

  it('accepts a bare JSON array of proposals (regression)', () => {
    // gpt-4o-mini and similar instruct-tuned models often emit just the
    // array shown in the schema example instead of wrapping it in
    // {proposals:[...]}. The parser must accept that shape so the mutator
    // doesn't return zero children and stall the optimizer.
    const raw = JSON.stringify([
      { label: 'tighten', rationale: 'add concrete', payload: { persona: 'A' } },
      { label: 'add example', rationale: 'cover gap',  payload: { persona: 'B' } },
    ])
    const out = parseReflectionResponse(raw, 5)
    expect(out).toHaveLength(2)
    expect((out[0].payload as { persona: string }).persona).toBe('A')
  })

  it('accepts a bare array even when the model adds prose around it', () => {
    const raw = `Sure, here are my proposals:\n[ {"label":"l","rationale":"r","payload":{"persona":"X"}} ]\nLet me know if you want more.`
    const out = parseReflectionResponse(raw)
    expect(out).toHaveLength(1)
    expect((out[0].payload as { persona: string }).persona).toBe('X')
  })
})
