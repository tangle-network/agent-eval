/**
 * extractProducedState is the single normalization point from a run's event
 * stream to the `ProducedState` the completion oracle consumes. These tests
 * pin that mapping — a regression here silently corrupts every completion
 * verdict downstream.
 */

import { describe, expect, it } from 'vitest'

import { extractProducedState, type RuntimeEventLike } from './produced-state'

describe('extractProducedState', () => {
  it('collects tool calls, deduplicated in first-seen order', () => {
    const events: RuntimeEventLike[] = [
      { type: 'tool_call', toolName: 'search_vault' },
      { type: 'tool_call', toolName: 'write_document' },
      { type: 'tool_call', toolName: 'search_vault' },
    ]
    expect(extractProducedState(events).toolCalls).toEqual(['search_vault', 'write_document'])
  })

  it('maps artifact events to artifacts with kind, path, and content', () => {
    const state = extractProducedState([
      {
        type: 'artifact',
        artifactId: 'a1',
        name: 'vault/dispute-notice.md',
        mimeType: 'text/markdown',
        content: 'NOTICE OF DISPUTE\n...',
      },
    ])
    expect(state.artifacts).toEqual([
      { kind: 'text', path: 'vault/dispute-notice.md', content: 'NOTICE OF DISPUTE\n...' },
    ])
  })

  it('maps proposal_created events to proposals', () => {
    const state = extractProducedState([
      {
        type: 'proposal_created',
        proposalId: 'p1',
        title: 'File the dispute notice',
        status: 'approved',
      },
    ])
    expect(state.proposals).toEqual([
      { id: 'p1', title: 'File the dispute notice', status: 'approved' },
    ])
  })

  it('defaults a proposal with no status to pending', () => {
    const state = extractProducedState([
      { type: 'proposal_created', proposalId: 'p1', title: 'Draft memo' },
    ])
    expect(state.proposals[0]!.status).toBe('pending')
  })

  it('yields empty content for an artifact with none — the oracle rejects it downstream', () => {
    const state = extractProducedState([{ type: 'artifact', artifactId: 'a1', name: 'stub.md' }])
    expect(state.artifacts[0]!.content).toBe('')
  })

  it('falls back to uri then artifactId for an artifact path', () => {
    const byUri = extractProducedState([
      { type: 'artifact', artifactId: 'a1', uri: 'vault://memo', content: 'x' },
    ])
    expect(byUri.artifacts[0]!.path).toBe('vault://memo')
    const byId = extractProducedState([{ type: 'artifact', artifactId: 'a1', content: 'x' }])
    expect(byId.artifacts[0]!.path).toBe('a1')
  })

  it('infers artifact kind from mime type', () => {
    const json = extractProducedState([
      { type: 'artifact', artifactId: 'a', name: 'f', mimeType: 'application/json', content: '{}' },
    ])
    expect(json.artifacts[0]!.kind).toBe('json')
    const unknown = extractProducedState([
      { type: 'artifact', artifactId: 'a', name: 'f', content: 'x' },
    ])
    expect(unknown.artifacts[0]!.kind).toBe('file')
  })

  it('ignores unrelated event types', () => {
    const state = extractProducedState([
      { type: 'text_delta' },
      { type: 'llm_call' },
      { type: 'task_end' },
      { type: 'tool_call', toolName: 'x' },
    ])
    expect(state.toolCalls).toEqual(['x'])
    expect(state.artifacts).toEqual([])
    expect(state.proposals).toEqual([])
  })

  it('an empty stream yields an empty produced state', () => {
    expect(extractProducedState([])).toEqual({ artifacts: [], proposals: [], toolCalls: [] })
  })

  it('normalizes a realistic mixed stream end to end', () => {
    const state = extractProducedState([
      { type: 'task_start' },
      { type: 'tool_call', toolName: 'search_vault' },
      { type: 'tool_call', toolName: 'write_document' },
      {
        type: 'artifact',
        artifactId: 'a1',
        name: 'vault/wc-dispute.md',
        mimeType: 'text/markdown',
        content: 'body',
      },
      {
        type: 'proposal_created',
        proposalId: 'p1',
        title: 'File dispute notice',
        status: 'approved',
      },
      { type: 'final' },
    ])
    expect(state.toolCalls).toEqual(['search_vault', 'write_document'])
    expect(state.artifacts).toHaveLength(1)
    expect(state.proposals).toHaveLength(1)
  })
})
