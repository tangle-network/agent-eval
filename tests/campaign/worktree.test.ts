import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { gitWorktreeAdapter, resolveWorktreePath } from '../../src/campaign/worktree'

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

let repoRoot: string
beforeEach(() => {
  repoRoot = mkdtempSync(join(tmpdir(), 'wt-repo-'))
  git(['init', '-q', '-b', 'main'], repoRoot)
  git(['config', 'user.email', 'test@test.dev'], repoRoot)
  git(['config', 'user.name', 'Test'], repoRoot)
  // Isolate the test repo from any globally-configured git hooks (e.g. a
  // machine-wide pre-commit) by pointing hooksPath at an empty dir.
  const emptyHooks = join(repoRoot, '.empty-hooks')
  mkdirSync(emptyHooks)
  git(['config', 'core.hooksPath', emptyHooks], repoRoot)
  writeFileSync(join(repoRoot, 'prompt.txt'), 'baseline prompt\n')
  git(['add', '-A'], repoRoot)
  git(['commit', '-q', '-m', 'init'], repoRoot)
})
afterEach(() => rmSync(repoRoot, { recursive: true, force: true }))

describe('gitWorktreeAdapter — real git worktrees', () => {
  it('creates an isolated worktree on a fresh branch off baseRef', async () => {
    const adapter = gitWorktreeAdapter({ repoRoot })
    const wt = await adapter.create({ baseRef: 'main', label: 'Tighten the rubric!' })

    expect(wt.branch).toMatch(/^improve\/tighten-the-rubric-/)
    expect(wt.baseRef).toBe('main')
    // The worktree is a real checkout with the baseline content.
    expect(git(['rev-parse', '--abbrev-ref', 'HEAD'], wt.path)).toBe(wt.branch)
    const worktrees = git(['worktree', 'list'], repoRoot)
    expect(worktrees).toContain(wt.path)
  })

  it('finalize commits pending changes and returns a CodeSurface', async () => {
    const adapter = gitWorktreeAdapter({ repoRoot })
    const wt = await adapter.create({ baseRef: 'main', label: 'edit' })

    // Agent writes its change into the worktree.
    writeFileSync(join(wt.path, 'prompt.txt'), 'improved prompt\n')
    const surface = await adapter.finalize(wt, 'improve the prompt')

    expect(surface.kind).toBe('code')
    expect(surface.worktreeRef).toBe(wt.path)
    expect(surface.baseRef).toBe('main')
    expect(surface.summary).toBe('improve the prompt')
    // The change is committed on the branch (one commit beyond base).
    const log = git(['log', '--oneline', 'main..HEAD'], wt.path)
    expect(log).toContain('improve the prompt')
    // baseRef main is untouched.
    expect(git(['show', 'main:prompt.txt'], repoRoot)).toBe('baseline prompt')
  })

  it('finalize on a clean worktree makes no empty commit', async () => {
    const adapter = gitWorktreeAdapter({ repoRoot })
    const wt = await adapter.create({ baseRef: 'main', label: 'noop' })
    await adapter.finalize(wt, 'no changes')
    // No commits beyond base — git refuses empty commits and we don't force one.
    expect(git(['log', '--oneline', 'main..HEAD'], wt.path)).toBe('')
  })

  it('discard removes the worktree and its branch', async () => {
    const adapter = gitWorktreeAdapter({ repoRoot })
    const wt = await adapter.create({ baseRef: 'main', label: 'discard-me' })
    await adapter.discard(wt)

    expect(git(['worktree', 'list'], repoRoot)).not.toContain(wt.path)
    expect(git(['branch', '--list', wt.branch], repoRoot)).toBe('')
  })

  it('two candidates get isolated worktrees off the same base', async () => {
    const adapter = gitWorktreeAdapter({ repoRoot })
    const a = await adapter.create({ baseRef: 'main', label: 'cand-a' })
    const b = await adapter.create({ baseRef: 'main', label: 'cand-b' })
    expect(a.path).not.toBe(b.path)
    expect(a.branch).not.toBe(b.branch)

    writeFileSync(join(a.path, 'prompt.txt'), 'variant A\n')
    writeFileSync(join(b.path, 'prompt.txt'), 'variant B\n')
    await adapter.finalize(a, 'variant A')
    await adapter.finalize(b, 'variant B')

    // Each worktree holds only its own change.
    expect(git(['show', 'HEAD:prompt.txt'], a.path)).toBe('variant A')
    expect(git(['show', 'HEAD:prompt.txt'], b.path)).toBe('variant B')
  })

  it('surfaces a typed error when git fails', async () => {
    const adapter = gitWorktreeAdapter({ repoRoot })
    await expect(adapter.create({ baseRef: 'no-such-ref', label: 'x' })).rejects.toThrow(
      /git worktree add .* failed/,
    )
  })
})

describe('resolveWorktreePath', () => {
  it('returns an existing absolute path as-is', () => {
    const p = mkdtempSync(join(tmpdir(), 'wt-resolve-'))
    try {
      expect(resolveWorktreePath({ kind: 'code', worktreeRef: p })).toBe(p)
    } finally {
      rmSync(p, { recursive: true, force: true })
    }
  })
})
