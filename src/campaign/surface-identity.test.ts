import { describe, expect, it } from 'vitest'

import { renderSurfaceDiff } from './surface-identity'
import type { CodeSurface } from './types'

function codeSurface(digit: string): CodeSurface {
  return {
    kind: 'code',
    worktreeRef: `/tmp/${digit}`,
    baseRef: 'main',
    baseCommit: 'a'.repeat(40),
    baseTree: 'b'.repeat(40),
    candidateCommit: digit.repeat(40),
    candidateTree: digit.repeat(40),
    patch: {
      format: 'git-diff-binary',
      sha256: `sha256:${digit.repeat(64)}`,
      byteLength: 42,
    },
    summary: 'Measured implementation change',
  }
}

describe('renderSurfaceDiff', () => {
  it('identifies an exact code patch instead of a mutable worktree path', () => {
    const diff = renderSurfaceDiff(codeSurface('c'), codeSurface('d'))
    expect(diff).toContain(`patch=sha256:${'c'.repeat(64)}`)
    expect(diff).toContain(`patch=sha256:${'d'.repeat(64)}`)
    expect(diff).toContain('patchBytes=42')
    expect(diff).not.toContain('/tmp/')
  })
})
