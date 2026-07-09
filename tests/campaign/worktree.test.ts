import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { surfaceHash } from '../../src/campaign/presets/run-optimization'
import { surfaceContentHash } from '../../src/campaign/provenance'
import {
  gitWorktreeAdapter,
  resolveWorktreePath,
  verifyCodeSurface,
  WorktreeAdapterError,
} from '../../src/campaign/worktree'

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
    expect(wt.baseCommit).toBe(git(['rev-parse', 'main'], repoRoot))
    expect(wt.baseTree).toBe(git(['rev-parse', 'main^{tree}'], repoRoot))
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
    expect(surface.baseCommit).toBe(git(['rev-parse', 'main'], repoRoot))
    expect(surface.baseTree).toBe(git(['rev-parse', 'main^{tree}'], repoRoot))
    expect(surface.candidateCommit).toBe(git(['rev-parse', 'HEAD'], wt.path))
    expect(surface.candidateTree).toBe(git(['rev-parse', 'HEAD^{tree}'], wt.path))
    const patch = execFileSync(
      'git',
      [
        'diff',
        '--binary',
        '--full-index',
        '--no-color',
        '--no-ext-diff',
        '--no-textconv',
        '--no-renames',
        '--diff-algorithm=myers',
        '--no-indent-heuristic',
        '--src-prefix=a/',
        '--dst-prefix=b/',
        surface.baseCommit,
        surface.candidateCommit,
        '--',
      ],
      { cwd: wt.path },
    )
    expect(surface.patch).toEqual({
      format: 'git-diff-binary',
      sha256: `sha256:${createHash('sha256').update(patch).digest('hex')}`,
      byteLength: patch.byteLength,
    })
    expect(Buffer.from(verifyCodeSurface(surface).patchBytes)).toEqual(patch)
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
    const surface = await adapter.finalize(wt, 'no changes')
    // No commits beyond base — git refuses empty commits and we don't force one.
    expect(git(['log', '--oneline', 'main..HEAD'], wt.path)).toBe('')
    expect(surface.candidateCommit).toBe(surface.baseCommit)
    expect(surface.patch.byteLength).toBe(0)
    expect(surface.patch.sha256).toBe(
      `sha256:${createHash('sha256').update(Buffer.alloc(0)).digest('hex')}`,
    )
    expect(verifyCodeSurface(surface).path).toBe(wt.path)
  })

  it('hashes candidate bytes, not worktree paths or commit metadata', async () => {
    const adapter = gitWorktreeAdapter({ repoRoot })
    const a = await adapter.create({ baseRef: 'main', label: 'same-a' })
    const b = await adapter.create({ baseRef: 'main', label: 'same-b' })
    writeFileSync(join(a.path, 'prompt.txt'), 'identical candidate bytes\n')
    writeFileSync(join(b.path, 'prompt.txt'), 'identical candidate bytes\n')

    const surfaceA = await adapter.finalize(a, 'candidate message A')
    const surfaceB = await adapter.finalize(b, 'candidate message B')

    expect(surfaceA.worktreeRef).not.toBe(surfaceB.worktreeRef)
    expect(surfaceA.candidateCommit).not.toBe(surfaceB.candidateCommit)
    expect(surfaceA.patch).toEqual(surfaceB.patch)
    expect(surfaceA.candidateTree).toBe(surfaceB.candidateTree)
    expect(surfaceContentHash(surfaceA)).toBe(surfaceContentHash(surfaceB))
    expect(surfaceHash(surfaceA)).toBe(surfaceHash(surfaceB))
  })

  it('changes both content hashes when one candidate byte changes', async () => {
    const adapter = gitWorktreeAdapter({ repoRoot })
    const a = await adapter.create({ baseRef: 'main', label: 'bytes-a' })
    const b = await adapter.create({ baseRef: 'main', label: 'bytes-b' })
    writeFileSync(join(a.path, 'prompt.txt'), 'candidate A\n')
    writeFileSync(join(b.path, 'prompt.txt'), 'candidate B\n')

    const surfaceA = await adapter.finalize(a, 'candidate')
    const surfaceB = await adapter.finalize(b, 'candidate')

    expect(surfaceA.patch.sha256).not.toBe(surfaceB.patch.sha256)
    expect(surfaceContentHash(surfaceA)).not.toBe(surfaceContentHash(surfaceB))
    expect(surfaceHash(surfaceA)).not.toBe(surfaceHash(surfaceB))
  })

  it('rejects tracked mutation after finalization before resolving the path', async () => {
    const adapter = gitWorktreeAdapter({ repoRoot })
    const wt = await adapter.create({ baseRef: 'main', label: 'mutated' })
    writeFileSync(join(wt.path, 'prompt.txt'), 'finalized bytes\n')
    const surface = await adapter.finalize(wt, 'finalize')

    writeFileSync(join(wt.path, 'prompt.txt'), 'mutated after finalize\n')

    expect(() => verifyCodeSurface(surface)).toThrow(/changed after finalization/)
    expect(() => resolveWorktreePath(surface)).toThrow(/changed after finalization/)
  })

  it('rejects assume-unchanged entries that can hide tracked mutations', async () => {
    const adapter = gitWorktreeAdapter({ repoRoot })
    const wt = await adapter.create({ baseRef: 'main', label: 'hidden-mutation' })
    const surface = await adapter.finalize(wt, 'no-op')
    git(['update-index', '--assume-unchanged', 'prompt.txt'], wt.path)
    writeFileSync(join(wt.path, 'prompt.txt'), 'hidden mutation\n')

    expect(() => verifyCodeSurface(surface)).toThrow(/hidden index entries/)
  })

  it('rejects an ignored file instead of evaluating bytes outside Git identity', async () => {
    const adapter = gitWorktreeAdapter({ repoRoot })
    const wt = await adapter.create({ baseRef: 'main', label: 'ignored-dirty' })
    writeFileSync(join(wt.path, '.gitignore'), '*.cache\n')
    writeFileSync(join(wt.path, 'agent.cache'), 'mutable execution input\n')

    await expect(adapter.finalize(wt, 'add ignore rule')).rejects.toThrow(
      /changed after finalization.*agent\.cache/s,
    )
  })

  it('rejects a surface pointed at the wrong finalized ref', async () => {
    const adapter = gitWorktreeAdapter({ repoRoot })
    const a = await adapter.create({ baseRef: 'main', label: 'wrong-ref-a' })
    const b = await adapter.create({ baseRef: 'main', label: 'wrong-ref-b' })
    writeFileSync(join(a.path, 'prompt.txt'), 'candidate A\n')
    writeFileSync(join(b.path, 'prompt.txt'), 'candidate B\n')
    const surfaceA = await adapter.finalize(a, 'candidate A')
    await adapter.finalize(b, 'candidate B')

    expect(() => verifyCodeSurface({ ...surfaceA, worktreeRef: b.path })).toThrow(
      /candidate commit mismatch/,
    )
  })

  it('rejects a forged patch digest even when the checkout is unchanged', async () => {
    const adapter = gitWorktreeAdapter({ repoRoot })
    const wt = await adapter.create({ baseRef: 'main', label: 'forged-digest' })
    writeFileSync(join(wt.path, 'prompt.txt'), 'candidate\n')
    const surface = await adapter.finalize(wt, 'candidate')

    expect(() =>
      verifyCodeSurface({
        ...surface,
        patch: { ...surface.patch, sha256: `sha256:${'0'.repeat(64)}` },
      }),
    ).toThrow(/patch mismatch/)
  })

  it('rejects a surface locator pointed at another repository', async () => {
    const adapter = gitWorktreeAdapter({ repoRoot })
    const wt = await adapter.create({ baseRef: 'main', label: 'right-repo' })
    writeFileSync(join(wt.path, 'prompt.txt'), 'candidate\n')
    const surface = await adapter.finalize(wt, 'candidate')

    const otherRepo = mkdtempSync(join(tmpdir(), 'wt-wrong-repo-'))
    try {
      git(['init', '-q', '-b', 'main'], otherRepo)
      git(['config', 'user.email', 'test@test.dev'], otherRepo)
      git(['config', 'user.name', 'Test'], otherRepo)
      const emptyHooks = join(otherRepo, '.empty-hooks')
      mkdirSync(emptyHooks)
      git(['config', 'core.hooksPath', emptyHooks], otherRepo)
      writeFileSync(join(otherRepo, 'prompt.txt'), 'unrelated\n')
      git(['add', '-A'], otherRepo)
      git(['commit', '-q', '-m', 'unrelated'], otherRepo)

      expect(() => verifyCodeSurface({ ...surface, worktreeRef: otherRepo })).toThrow(
        /candidate commit mismatch/,
      )
    } finally {
      rmSync(otherRepo, { recursive: true, force: true })
    }
  })

  it('does not let inherited Git environment redirect verification', async () => {
    const adapter = gitWorktreeAdapter({ repoRoot })
    const wt = await adapter.create({ baseRef: 'main', label: 'env-right-repo' })
    writeFileSync(join(wt.path, 'prompt.txt'), 'candidate\n')
    const surface = await adapter.finalize(wt, 'candidate')

    const otherRepo = mkdtempSync(join(tmpdir(), 'wt-env-wrong-repo-'))
    const priorGitDir = process.env.GIT_DIR
    const priorGitWorkTree = process.env.GIT_WORK_TREE
    try {
      git(['init', '-q', '-b', 'main'], otherRepo)
      git(['config', 'user.email', 'test@test.dev'], otherRepo)
      git(['config', 'user.name', 'Test'], otherRepo)
      const emptyHooks = join(otherRepo, '.empty-hooks')
      mkdirSync(emptyHooks)
      git(['config', 'core.hooksPath', emptyHooks], otherRepo)
      writeFileSync(join(otherRepo, 'prompt.txt'), 'unrelated\n')
      git(['add', '-A'], otherRepo)
      git(['commit', '-q', '-m', 'unrelated'], otherRepo)

      process.env.GIT_DIR = git(['rev-parse', '--absolute-git-dir'], wt.path)
      process.env.GIT_WORK_TREE = wt.path

      expect(() => verifyCodeSurface({ ...surface, worktreeRef: otherRepo })).toThrow(
        /candidate commit mismatch/,
      )
    } finally {
      if (priorGitDir === undefined) delete process.env.GIT_DIR
      else process.env.GIT_DIR = priorGitDir
      if (priorGitWorkTree === undefined) delete process.env.GIT_WORK_TREE
      else process.env.GIT_WORK_TREE = priorGitWorkTree
      rmSync(otherRepo, { recursive: true, force: true })
    }
  })

  it('keeps the exact fork commit when the human base ref advances', async () => {
    const adapter = gitWorktreeAdapter({ repoRoot })
    const wt = await adapter.create({ baseRef: 'main', label: 'moving-base' })
    const originalBase = wt.baseCommit

    writeFileSync(join(repoRoot, 'later.txt'), 'main advanced\n')
    git(['add', 'later.txt'], repoRoot)
    git(['commit', '-q', '-m', 'advance main'], repoRoot)
    writeFileSync(join(wt.path, 'prompt.txt'), 'candidate from original base\n')

    const surface = await adapter.finalize(wt, 'candidate')
    expect(surface.baseCommit).toBe(originalBase)
    expect(surface.baseCommit).not.toBe(git(['rev-parse', 'main'], repoRoot))
    expect(verifyCodeSurface(surface).path).toBe(wt.path)
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
      WorktreeAdapterError,
    )
  })
})

describe('resolveWorktreePath', () => {
  it('returns a verified absolute worktree path', async () => {
    const adapter = gitWorktreeAdapter({ repoRoot })
    const wt = await adapter.create({ baseRef: 'main', label: 'resolve' })
    const surface = await adapter.finalize(wt, 'no-op')
    expect(resolveWorktreePath(surface)).toBe(wt.path)
  })
})
