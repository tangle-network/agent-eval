import { describe, expect, it } from 'vitest'
import { applySkillPatch, patchEditCount, type SkillPatch } from '../../src/campaign/skill-patch'

const DOC = [
  '# Skill',
  '',
  '## Rules',
  '- always cite a source',
  '- be concise',
  '',
  '## End',
].join('\n')

function patch(ops: SkillPatch['ops']): SkillPatch {
  return { label: 'l', rationale: 'r', ops }
}

describe('applySkillPatch', () => {
  it('adds after an anchored line', () => {
    const r = applySkillPatch(
      DOC,
      patch([{ op: 'add', after: '- be concise', text: '- never fabricate' }]),
    )
    expect(r.applied).toBe(1)
    expect(r.rejected).toEqual([])
    expect(r.surface.split('\n')).toEqual([
      '# Skill',
      '',
      '## Rules',
      '- always cite a source',
      '- be concise',
      '- never fabricate',
      '',
      '## End',
    ])
  })

  it('appends when no anchor is given', () => {
    const r = applySkillPatch(DOC, patch([{ op: 'add', text: '## Appendix' }]))
    expect(r.applied).toBe(1)
    expect(r.surface.endsWith('## End\n## Appendix')).toBe(true)
  })

  it('deletes the first line containing the anchor', () => {
    const r = applySkillPatch(DOC, patch([{ op: 'delete', anchor: 'be concise' }]))
    expect(r.applied).toBe(1)
    expect(r.surface).not.toContain('be concise')
    expect(r.surface).toContain('always cite a source')
  })

  it('replaces the anchored line with (multi-line) text', () => {
    const r = applySkillPatch(
      DOC,
      patch([
        { op: 'replace', anchor: '- be concise', text: '- be concise\n- prefer active voice' },
      ]),
    )
    expect(r.applied).toBe(1)
    expect(r.surface).toContain('- prefer active voice')
    // The replaced line is gone exactly once; the new block is present.
    expect(r.surface.match(/- be concise/g)!.length).toBe(1)
  })

  it('applies multiple ops in order against the evolving buffer', () => {
    const r = applySkillPatch(
      DOC,
      patch([
        { op: 'add', after: '## Rules', text: '- verify dates' },
        { op: 'delete', anchor: '- be concise' },
      ]),
    )
    expect(r.applied).toBe(2)
    const lines = r.surface.split('\n')
    expect(lines).toContain('- verify dates')
    expect(r.surface).not.toContain('be concise')
    // 'verify dates' lands directly under the Rules heading.
    expect(lines[lines.indexOf('## Rules') + 1]).toBe('- verify dates')
  })

  it('rejects an unanchored op but still applies the rest (fail-loud, not silent-drop)', () => {
    const r = applySkillPatch(
      DOC,
      patch([
        { op: 'replace', anchor: 'NONEXISTENT LINE', text: 'x' },
        { op: 'add', after: '- be concise', text: '- never fabricate' },
      ]),
    )
    expect(r.applied).toBe(1)
    expect(r.rejected).toHaveLength(1)
    expect(r.rejected[0]!.reason).toContain('replace anchor not found')
    expect(r.surface).toContain('- never fabricate')
  })

  it('rejects empty add text', () => {
    const r = applySkillPatch(DOC, patch([{ op: 'add', after: '## Rules', text: '   ' }]))
    expect(r.applied).toBe(0)
    expect(r.rejected[0]!.reason).toBe('empty add text')
    expect(r.surface).toBe(DOC)
  })

  it('a fully-unanchored patch leaves the surface byte-identical', () => {
    const r = applySkillPatch(
      DOC,
      patch([
        { op: 'delete', anchor: 'zzz' },
        { op: 'replace', anchor: 'yyy', text: 'q' },
      ]),
    )
    expect(r.applied).toBe(0)
    expect(r.rejected).toHaveLength(2)
    expect(r.surface).toBe(DOC)
  })

  it('sequences a success-success-FAIL-success patch correctly against the evolving buffer', () => {
    const r = applySkillPatch(
      DOC,
      patch([
        { op: 'add', after: '## Rules', text: '- op1 added' }, // success (under Rules)
        { op: 'replace', anchor: '- be concise', text: '- op2 replaced' }, // success
        { op: 'delete', anchor: 'MISSING_ANCHOR_XYZ' }, // FAIL (unanchored)
        { op: 'add', after: '## End', text: '- op4 added' }, // success (after End)
      ]),
    )
    expect(r.applied).toBe(3)
    expect(r.rejected).toHaveLength(1)
    expect(r.rejected[0]!.reason).toContain('delete anchor not found')
    const lines = r.surface.split('\n')
    // op1 landed directly under '## Rules'; op2 replaced 'be concise'; op4 after '## End'.
    expect(lines[lines.indexOf('## Rules') + 1]).toBe('- op1 added')
    expect(r.surface).toContain('- op2 replaced')
    expect(r.surface).not.toContain('- be concise')
    expect(lines[lines.indexOf('## End') + 1]).toBe('- op4 added')
    // The original 'cite a source' rule is untouched by the failed delete.
    expect(r.surface).toContain('- always cite a source')
  })

  it('patchEditCount counts ops (the edit-budget axis)', () => {
    expect(
      patchEditCount(
        patch([
          { op: 'delete', anchor: 'a' },
          { op: 'delete', anchor: 'b' },
        ]),
      ),
    ).toBe(2)
  })
})
