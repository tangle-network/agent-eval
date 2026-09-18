import { describe, expect, it } from 'vitest'
import { extractProducedState, type RuntimeEventLike } from './produced-state'

const artifact = (name: string, content?: string): RuntimeEventLike => ({
  type: 'artifact', artifactId: `vault:${name}`, name, mimeType: 'text/markdown', content,
})

describe('produced state represents the latest observed revision', () => {
  it('replaces an obsolete deliverable instead of letting its old content satisfy the task', () => {
    const state = extractProducedState([
      artifact('campaigns/offer.md', 'Unsupported discount: 50%'),
      artifact('campaigns/offer.md', 'Approved offer: no discount'),
    ])
    expect(state.artifacts).toEqual([{ kind: 'text', path: 'campaigns/offer.md', content: 'Approved offer: no discount' }])
  })

  it('keeps only the newest observation when different artifact ids name the same output path', () => {
    const state = extractProducedState([
      { type: 'artifact', artifactId: 'write-1', name: 'result.json', mimeType: 'text/plain', content: 'old' },
      { type: 'artifact', artifactId: 'write-2', name: 'result.json', mimeType: 'application/json', content: '{"paid":false}' },
    ])
    expect(state.artifacts).toEqual([{ kind: 'json', path: 'result.json', content: '{"paid":false}' }])
  })

  it.each([undefined, ''])('does not backfill missing final content from a stale version (%s)', content => {
    const state = extractProducedState([artifact('proof.md', 'Previously complete'), artifact('proof.md', content)])
    expect(state.artifacts).toEqual([{ kind: 'text', path: 'proof.md', content: '' }])
  })

  it('retains distinct outputs and their first-seen ordering', () => {
    const state = extractProducedState([
      artifact('a.md', 'a1'), artifact('b.md', 'b1'), artifact('a.md', 'a2'),
    ])
    expect(state.artifacts.map(item => [item.path, item.content])).toEqual([['a.md', 'a2'], ['b.md', 'b1']])
  })

  it('does not guess that different paths with the same id are aliases', () => {
    const state = extractProducedState([
      { type: 'artifact', artifactId: 'reused-id', name: 'a.md', content: 'a' },
      { type: 'artifact', artifactId: 'reused-id', name: 'b.md', content: 'b' },
    ])
    expect(state.artifacts.map(item => item.path)).toEqual(['a.md', 'b.md'])
  })

  it('uses the same latest-observation rule for URI and id-only artifacts', () => {
    const state = extractProducedState([
      { type: 'artifact', artifactId: 'first', uri: 'vault://proof', content: 'old uri' },
      { type: 'artifact', artifactId: 'second', uri: 'vault://proof', content: 'new uri' },
      { type: 'artifact', artifactId: 'id-only', content: 'old id' },
      { type: 'artifact', artifactId: 'id-only', content: 'new id' },
    ])
    expect(state.artifacts.map(item => [item.path, item.content])).toEqual([
      ['vault://proof', 'new uri'], ['id-only', 'new id'],
    ])
  })

  it('does not retain an old approval after a rejection of that proposal', () => {
    const state = extractProducedState([
      { type: 'proposal_created', proposalId: 'p', title: 'Offer', status: 'approved', content: 'old' },
      { type: 'proposal_created', proposalId: 'p', title: 'Corrected offer', status: 'rejected', content: 'new' },
    ])
    expect(state.proposals).toEqual([{ id: 'p', title: 'Corrected offer', status: 'rejected', content: 'new' }])
  })

  it('does not resurrect a stale body or approval when the latest proposal omits them', () => {
    const state = extractProducedState([
      { type: 'proposal_created', proposalId: 'p', title: 'Offer', status: 'approved', content: 'old' },
      { type: 'proposal_created', proposalId: 'p', title: 'Revised offer' },
    ])
    expect(state.proposals).toEqual([{ id: 'p', title: 'Revised offer', status: 'pending' }])
  })

  it('does not mutate the supplied stream or merge tool result text into artifacts', () => {
    const events = Object.freeze([
      Object.freeze(artifact('proof.md', 'retained')),
      Object.freeze({ type: 'tool_result', toolName: 'search', result: 'paid delivered activated' }),
      Object.freeze({ type: 'text_delta', text: 'a claim is not a receipt' }),
    ])
    expect(extractProducedState(events)).toEqual({
      artifacts: [{ kind: 'text', path: 'proof.md', content: 'retained' }], proposals: [], toolCalls: [],
    })
  })
})
