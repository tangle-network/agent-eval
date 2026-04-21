import { describe, it, expect } from 'vitest'
import {
  InMemoryWorkspaceInspector,
  fileExists,
  fileContains,
  rowCount,
  rowWhere,
  runAssertions,
  type WorkspaceSnapshot,
} from '../src/workspace-inspector'

function snap(partial: Partial<WorkspaceSnapshot> = {}): WorkspaceSnapshot {
  return { files: {}, rows: {}, kv: {}, ...partial }
}

describe('InMemoryWorkspaceInspector', () => {
  it('returns the snapshot set for a scope', async () => {
    const insp = new InMemoryWorkspaceInspector()
    insp.set('workspace_1', snap({ files: { 'vault/a.md': 'hi' } }))
    const s = await insp.snapshot({ scopeId: 'workspace_1' })
    expect(s.files).toEqual({ 'vault/a.md': 'hi' })
  })

  it('returns empty shape for unknown scope — regression: undefined would break downstream assertions', async () => {
    const insp = new InMemoryWorkspaceInspector()
    const s = await insp.snapshot({ scopeId: 'missing' })
    expect(s).toEqual({ files: {}, rows: {}, kv: {} })
  })
})

describe('fileExists / fileContains', () => {
  it('fileExists passes when file present', () => {
    const r = fileExists('a.md').check(snap({ files: { 'a.md': 'x' } }))
    expect(r.pass).toBe(true)
    expect(r.score).toBe(1)
  })
  it('fileExists fails when absent', () => {
    const r = fileExists('a.md').check(snap())
    expect(r.pass).toBe(false)
    expect(r.detail).toContain('a.md')
  })
  it('fileContains passes on substring hit', () => {
    const r = fileContains('a.md', 'hello').check(snap({ files: { 'a.md': 'well hello there' } }))
    expect(r.pass).toBe(true)
  })
  it('fileContains fails with a descriptive detail when the substring is missing', () => {
    const r = fileContains('a.md', 'foo').check(snap({ files: { 'a.md': 'bar' } }))
    expect(r.pass).toBe(false)
    expect(r.detail).toMatch(/missing substring/)
  })
})

describe('rowCount', () => {
  it('passes inside range', () => {
    const r = rowCount('deals', 1, 10).check(snap({ rows: { deals: [{}, {}, {}] } }))
    expect(r.pass).toBe(true)
    expect(r.score).toBe(1)
  })
  it('partial credit below min — regression: binary pass/fail loses tuning signal', () => {
    const r = rowCount('deals', 10).check(snap({ rows: { deals: [{}, {}, {}] } }))
    expect(r.pass).toBe(false)
    expect(r.score).toBeCloseTo(0.3, 2)
  })
  it('partial credit above max', () => {
    const r = rowCount('deals', 1, 10).check(snap({ rows: { deals: new Array(20).fill({}) } }))
    expect(r.pass).toBe(false)
    expect(r.score).toBe(0.5)
  })
  it('treats missing table as 0 rows', () => {
    const r = rowCount('missing', 1).check(snap())
    expect(r.pass).toBe(false)
  })
})

describe('rowWhere', () => {
  it('passes when predicate matches enough rows', () => {
    const r = rowWhere<{ status: string }>('deals', (row) => row.status === 'closed', { min: 2 }).check(
      snap({ rows: { deals: [{ status: 'open' }, { status: 'closed' }, { status: 'closed' }] } }),
    )
    expect(r.pass).toBe(true)
  })
  it('partial credit when min not met', () => {
    const r = rowWhere<{ status: string }>('deals', (row) => row.status === 'closed', { min: 3 }).check(
      snap({ rows: { deals: [{ status: 'closed' }] } }),
    )
    expect(r.pass).toBe(false)
    expect(r.score).toBeCloseTo(1 / 3, 2)
  })
})

describe('runAssertions', () => {
  it('aggregates pass as AND and score as mean', () => {
    const result = runAssertions(snap({ files: { 'a.md': 'content' }, rows: { deals: [{}, {}, {}] } }), [
      fileExists('a.md'),
      rowCount('deals', 1, 10),
    ])
    expect(result.pass).toBe(true)
    expect(result.score).toBe(1)
    expect(result.results).toHaveLength(2)
  })

  it('aggregate pass is AND across assertions — regression: one fail doesn\'t sink the aggregate pass', () => {
    const result = runAssertions(snap({ files: { 'a.md': 'content' } }), [
      fileExists('a.md'),
      fileExists('missing.md'),
    ])
    expect(result.pass).toBe(false)
    expect(result.score).toBe(0.5)
  })
})
