import { homedir } from 'node:os'
import { basename, isAbsolute, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveRunDir, tangleTracesRoot } from './run-dir'

describe('resolveRunDir', () => {
  it('places a bare name under the shared home root, namespaced by repo', () => {
    expect(resolveRunDir('tax-legal-research-r220', 'traces')).toBe(
      join(homedir(), '.tangle', 'traces', 'traces', 'runs', 'tax-legal-research-r220'),
    )
  })

  it('defaults the repo segment to the CWD basename', () => {
    expect(resolveRunDir('r1')).toBe(
      join(tangleTracesRoot(), basename(process.cwd()), 'runs', 'r1'),
    )
  })

  it('honors an absolute path unchanged (explicit override)', () => {
    const abs = join(homedir(), 'somewhere', 'else')
    expect(isAbsolute(abs)).toBe(true)
    expect(resolveRunDir(abs, 'traces')).toBe(abs)
  })

  it('never lands inside the current repo tree for a bare name', () => {
    const resolved = resolveRunDir('r1', 'traces')
    expect(resolved.startsWith(process.cwd())).toBe(false)
    expect(resolved.startsWith(tangleTracesRoot())).toBe(true)
  })
})
