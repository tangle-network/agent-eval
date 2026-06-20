import { describe, expect, it } from 'vitest'
import type { ProposeContext, ProposedCandidate } from '../types'
import { aceProposer } from './ace'

function ctx(currentSurface: string, findings: unknown[], generation: number): ProposeContext {
  return {
    currentSurface,
    history: [],
    findings,
    populationSize: 1,
    generation,
    signal: new AbortController().signal,
  }
}

const BASE = '# Agent\nDo the task.'

async function one(
  proposer: ReturnType<typeof aceProposer>,
  c: ProposeContext,
): Promise<string | null> {
  const out = (await proposer.propose(c)) as ProposedCandidate[]
  return out.length > 0 ? String(out[0]!.surface) : null
}

describe('aceProposer — append-mostly playbook (anti context-collapse)', () => {
  it('appends gen findings as provenance-tagged bullets, preserving the base prompt', async () => {
    const proposer = aceProposer()
    const surface = await one(
      proposer,
      ctx(BASE, [{ claim: 'fetch a resource before mutating it' }], 1),
    )
    expect(surface).toContain('Do the task.') // base preserved
    expect(surface).toContain('ace-playbook')
    expect(surface).toContain('- [g1] fetch a resource before mutating it')
  })

  it('a LATER generation appends without removing earlier lessons (no collapse)', async () => {
    const proposer = aceProposer()
    const s1 = (await one(proposer, ctx(BASE, [{ claim: 'lesson one' }], 1)))!
    // gen 2 reflects on s1 (carrying the g1 bullet) + a NEW finding.
    const s2 = (await one(proposer, ctx(s1, [{ claim: 'lesson two' }], 2)))!
    expect(s2).toContain('- [g1] lesson one') // old lesson SURVIVES verbatim
    expect(s2).toContain('- [g2] lesson two') // new lesson appended with its gen tag
  })

  it('is idempotent: a recurring finding is NOT re-appended (no duplicate bullets)', async () => {
    const proposer = aceProposer()
    const s1 = (await one(proposer, ctx(BASE, [{ claim: 'always verify' }], 1)))!
    // Same lesson recurs in gen 2 → the playbook is unchanged → no candidate.
    const out2 = await proposer.propose(ctx(s1, [{ claim: 'Always verify.' }], 2))
    expect(out2).toHaveLength(0)
    // And the single bullet appears exactly once.
    expect(s1.match(/always verify/gi)).toHaveLength(1)
  })

  it('FIFO-evicts the OLDEST on overflow — recency kept, distinct lessons never merged', async () => {
    const proposer = aceProposer({ maxEntries: 2 })
    const s1 = (await one(proposer, ctx(BASE, [{ claim: 'first' }], 1)))!
    const s2 = (await one(proposer, ctx(s1, [{ claim: 'second' }], 2)))!
    const s3 = (await one(proposer, ctx(s2, [{ claim: 'third' }], 3)))!
    expect(s3).not.toContain('first') // oldest evicted
    expect(s3).toContain('- [g2] second')
    expect(s3).toContain('- [g3] third')
  })

  it('fail-loud: no findings and no prior playbook ⇒ NO candidate (never fabricates a bullet)', async () => {
    const proposer = aceProposer()
    expect(await proposer.propose(ctx(BASE, [], 0))).toHaveLength(0)
  })

  it('prefers recommended_action over claim when both are present', async () => {
    const proposer = aceProposer()
    const surface = await one(
      proposer,
      ctx(
        BASE,
        [{ claim: 'the date was wrong', recommended_action: 'emit dates as ISO YYYY-MM-DD' }],
        1,
      ),
    )
    expect(surface).toContain('emit dates as ISO YYYY-MM-DD')
    expect(surface).not.toContain('the date was wrong')
  })

  it('rejects maxEntries < 1', () => {
    expect(() => aceProposer({ maxEntries: 0 })).toThrow(/maxEntries/)
  })
})
