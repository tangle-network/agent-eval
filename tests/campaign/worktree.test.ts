import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { devNull, tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
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
        '--unified=3',
        '--inter-hunk-context=0',
        `-O${devNull}`,
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

  it('finalizes and verifies SHA-256 repositories', async () => {
    const shaRoot = mkdtempSync(join(tmpdir(), 'wt-sha256-repo-'))
    try {
      git(['init', '-q', '-b', 'main', '--object-format=sha256'], shaRoot)
      git(['config', 'user.email', 'test@test.dev'], shaRoot)
      git(['config', 'user.name', 'Test'], shaRoot)
      const emptyHooks = join(shaRoot, '.empty-hooks')
      mkdirSync(emptyHooks)
      git(['config', 'core.hooksPath', emptyHooks], shaRoot)
      writeFileSync(join(shaRoot, 'prompt.txt'), 'baseline prompt\n')
      git(['add', '-A'], shaRoot)
      git(['commit', '-q', '-m', 'init'], shaRoot)

      const adapter = gitWorktreeAdapter({ repoRoot: shaRoot })
      const wt = await adapter.create({ baseRef: 'main', label: 'sha256' })
      writeFileSync(join(wt.path, 'prompt.txt'), 'candidate prompt\n')
      const surface = await adapter.finalize(wt, 'sha256 candidate')

      expect(surface.baseCommit).toMatch(/^[a-f0-9]{64}$/)
      expect(surface.candidateCommit).toMatch(/^[a-f0-9]{64}$/)
      expect(verifyCodeSurface(surface).path).toBe(wt.path)
    } finally {
      rmSync(shaRoot, { recursive: true, force: true })
    }
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

  it('pins patch bytes across repository and global diff config', async () => {
    const priorHome = process.env.HOME
    const priorXdgConfigHome = process.env.XDG_CONFIG_HOME
    const isolatedHome = mkdtempSync(join(tmpdir(), 'wt-git-home-'))
    process.env.HOME = isolatedHome
    process.env.XDG_CONFIG_HOME = isolatedHome
    try {
      const baseline = Buffer.concat(
        Array.from({ length: 1024 }, (_, i) => Buffer.from(`record-${i % 17}\0`.repeat(32))),
      )
      const candidate = Buffer.from(baseline)
      for (let i = 0; i < candidate.length; i += 4096) {
        candidate[i] = ((candidate[i] ?? 0) + 1) & 0xff
      }
      writeFileSync(join(repoRoot, 'fixture.bin'), baseline)
      writeFileSync(
        join(repoRoot, 'context.txt'),
        ['GLOBAL heading', 'one', '', 'two', '', 'three', 'LOCAL heading', 'tail', ''].join('\n'),
      )
      writeFileSync(join(repoRoot, '.gitattributes'), 'context.txt diff=fixture\n')
      git(['add', 'fixture.bin'], repoRoot)
      git(['add', 'context.txt', '.gitattributes'], repoRoot)
      git(['commit', '-q', '-m', 'add binary fixture'], repoRoot)

      const adapter = gitWorktreeAdapter({ repoRoot })
      const globalOrder = join(isolatedHome, 'global-order')
      const repoOrder = join(isolatedHome, 'repo-order')
      writeFileSync(globalOrder, 'fixture.bin\ncontext.txt\n')
      writeFileSync(repoOrder, 'context.txt\nfixture.bin\n')
      git(['config', '--global', 'core.compression', '9'], repoRoot)
      git(['config', '--global', 'diff.context', '20'], repoRoot)
      git(['config', '--global', 'diff.interHunkContext', '20'], repoRoot)
      git(['config', '--global', 'diff.suppressBlankEmpty', 'true'], repoRoot)
      git(['config', '--global', 'diff.orderFile', globalOrder], repoRoot)
      git(['config', '--global', 'diff.fixture.xfuncname', '^GLOBAL'], repoRoot)
      git(['config', 'core.compression', '1'], repoRoot)
      git(['config', 'diff.context', '0'], repoRoot)
      git(['config', 'diff.interHunkContext', '0'], repoRoot)
      git(['config', 'diff.suppressBlankEmpty', 'false'], repoRoot)
      git(['config', 'diff.orderFile', repoOrder], repoRoot)
      git(['config', 'diff.fixture.xfuncname', '^LOCAL'], repoRoot)
      const repoConfigured = await adapter.create({ baseRef: 'main', label: 'repo-config' })
      writeFileSync(join(repoConfigured.path, 'fixture.bin'), candidate)
      writeFileSync(
        join(repoConfigured.path, 'context.txt'),
        ['GLOBAL heading', 'ONE', '', 'two', '', 'THREE', 'LOCAL heading', 'tail', ''].join('\n'),
      )
      const surfaceA = await adapter.finalize(repoConfigured, 'binary candidate A')

      for (const key of [
        'core.compression',
        'diff.context',
        'diff.interHunkContext',
        'diff.suppressBlankEmpty',
        'diff.orderFile',
        'diff.fixture.xfuncname',
      ]) {
        git(['config', '--unset', key], repoRoot)
      }
      const globalConfigured = await adapter.create({
        baseRef: 'main',
        label: 'global-config',
      })
      writeFileSync(join(globalConfigured.path, 'fixture.bin'), candidate)
      writeFileSync(
        join(globalConfigured.path, 'context.txt'),
        ['GLOBAL heading', 'ONE', '', 'two', '', 'THREE', 'LOCAL heading', 'tail', ''].join('\n'),
      )
      const surfaceB = await adapter.finalize(globalConfigured, 'binary candidate B')

      expect(surfaceA.patch).toEqual(surfaceB.patch)
      expect(surfaceContentHash(surfaceA)).toBe(surfaceContentHash(surfaceB))

      git(['config', 'core.compression', '6'], repoRoot)
      git(['config', 'diff.context', '10'], repoRoot)
      git(['config', 'diff.interHunkContext', '10'], repoRoot)
      git(['config', 'diff.suppressBlankEmpty', 'true'], repoRoot)
      git(['config', 'diff.orderFile', repoOrder], repoRoot)
      git(['config', 'diff.fixture.xfuncname', '^LOCAL'], repoRoot)
      expect(() => verifyCodeSurface(surfaceA)).not.toThrow()
      expect(() => verifyCodeSurface(surfaceB)).not.toThrow()
    } finally {
      if (priorHome === undefined) delete process.env.HOME
      else process.env.HOME = priorHome
      if (priorXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME
      else process.env.XDG_CONFIG_HOME = priorXdgConfigHome
      rmSync(isolatedHome, { recursive: true, force: true })
    }
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

  it('rejects raw tracked bytes hidden by a Git clean filter', async () => {
    git(['config', 'filter.hide.clean', "sed 's/^evil$/safe/'"], repoRoot)
    git(['config', 'filter.hide.smudge', 'cat'], repoRoot)
    writeFileSync(join(repoRoot, '.gitattributes'), 'filtered.txt filter=hide\n')
    writeFileSync(join(repoRoot, 'filtered.txt'), 'safe\n')
    git(['add', '-A'], repoRoot)
    git(['commit', '-q', '-m', 'add filtered file'], repoRoot)

    const adapter = gitWorktreeAdapter({ repoRoot })
    const wt = await adapter.create({ baseRef: 'main', label: 'clean-filter-bypass' })
    const surface = await adapter.finalize(wt, 'no-op')
    writeFileSync(join(wt.path, 'filtered.txt'), 'evil\n')

    // Git reports the checkout clean because the configured filter maps the
    // changed bytes back to the committed blob. Verification must read raw
    // filesystem bytes instead of trusting that filtered comparison.
    expect(git(['status', '--porcelain=v1'], wt.path)).toBe('')
    expect(() => verifyCodeSurface(surface)).toThrow(/raw tracked bytes differ/)
  })

  it('rejects checkout bytes rewritten by a Git smudge filter', async () => {
    git(['config', 'filter.rewrite.clean', "sed 's/^evil$/safe/'"], repoRoot)
    git(['config', 'filter.rewrite.smudge', "sed 's/^safe$/evil/'"], repoRoot)
    writeFileSync(join(repoRoot, '.gitattributes'), 'filtered.txt filter=rewrite\n')
    writeFileSync(join(repoRoot, 'filtered.txt'), 'safe\n')
    git(['add', '-A'], repoRoot)
    git(['commit', '-q', '-m', 'add smudged file'], repoRoot)

    const adapter = gitWorktreeAdapter({ repoRoot })
    const wt = await adapter.create({ baseRef: 'main', label: 'smudge-filter-bypass' })

    expect(git(['status', '--porcelain=v1'], wt.path)).toBe('')
    await expect(adapter.finalize(wt, 'no-op')).rejects.toThrow(/raw tracked bytes differ/)
  })

  it('rejects executable-mode changes hidden by core.filemode=false', async () => {
    if (process.platform === 'win32') return
    const adapter = gitWorktreeAdapter({ repoRoot })
    const wt = await adapter.create({ baseRef: 'main', label: 'hidden-mode' })
    const surface = await adapter.finalize(wt, 'no-op')
    git(['config', 'core.filemode', 'false'], wt.path)
    chmodSync(join(wt.path, 'prompt.txt'), 0o755)

    expect(git(['status', '--porcelain=v1'], wt.path)).toBe('')
    expect(() => verifyCodeSurface(surface)).toThrow(/executable mode differs/)
  })

  it('rejects a symbolic worktree locator', async () => {
    const adapter = gitWorktreeAdapter({ repoRoot })
    const wt = await adapter.create({ baseRef: 'main', label: 'linked-locator' })
    const surface = await adapter.finalize(wt, 'no-op')
    const linkedPath = `${wt.path}-link`
    symlinkSync(wt.path, linkedPath, 'dir')
    try {
      expect(() => verifyCodeSurface({ ...surface, worktreeRef: linkedPath })).toThrow(
        /locator must not contain a symbolic link/,
      )
    } finally {
      unlinkSync(linkedPath)
    }
  })

  it('rejects a worktree locator that traverses a symbolic-link parent', async () => {
    if (process.platform === 'win32') return
    const adapter = gitWorktreeAdapter({ repoRoot })
    const wt = await adapter.create({ baseRef: 'main', label: 'linked-parent' })
    const surface = await adapter.finalize(wt, 'no-op')
    const linkedParent = `${dirname(wt.path)}-link`
    symlinkSync(dirname(wt.path), linkedParent, 'dir')
    try {
      expect(() =>
        verifyCodeSurface({
          ...surface,
          worktreeRef: join(linkedParent, basename(wt.path)),
        }),
      ).toThrow(/locator must not contain a symbolic link/)
    } finally {
      unlinkSync(linkedParent)
    }
  })

  it('rejects a tracked symbolic link that escapes the worktree', async () => {
    const outside = join(repoRoot, '..', `${basename(repoRoot)}-outside.txt`)
    writeFileSync(outside, 'outside bytes\n')
    symlinkSync(outside, join(repoRoot, 'outside-link'))
    git(['add', 'outside-link'], repoRoot)
    git(['commit', '-q', '-m', 'add external link'], repoRoot)

    const adapter = gitWorktreeAdapter({ repoRoot })
    const wt = await adapter.create({ baseRef: 'main', label: 'external-link' })
    try {
      await expect(adapter.finalize(wt, 'no-op')).rejects.toThrow(/symbolic link escapes/)
    } finally {
      rmSync(outside, { force: true })
    }
  })

  it('rejects a symbolic link that leaves and re-enters through untracked content', async () => {
    const adapter = gitWorktreeAdapter({ repoRoot })
    const wt = await adapter.create({ baseRef: 'main', label: 'external-trampoline' })
    const outside = `${wt.path}-outside`
    mkdirSync(outside)
    symlinkSync(join(wt.path, 'prompt.txt'), join(outside, 'back'))
    symlinkSync(`../${basename(outside)}/back`, join(wt.path, 'trampoline'))

    await expect(adapter.finalize(wt, 'add external trampoline')).rejects.toThrow(
      /symbolic link escapes/,
    )
  })

  it('rejects Git submodules whose checked-out bytes are outside the tree identity', async () => {
    const adapter = gitWorktreeAdapter({ repoRoot })
    const wt = await adapter.create({ baseRef: 'main', label: 'submodule' })
    const nested = join(wt.path, 'vendor', 'nested')
    mkdirSync(nested, { recursive: true })
    git(['init', '-q', '-b', 'main'], nested)
    git(['config', 'user.email', 'test@test.dev'], nested)
    git(['config', 'user.name', 'Test'], nested)
    const nestedHooks = join(nested, '.empty-hooks')
    mkdirSync(nestedHooks)
    git(['config', 'core.hooksPath', nestedHooks], nested)
    writeFileSync(join(nested, 'module.txt'), 'module bytes\n')
    git(['add', '-A'], nested)
    git(['commit', '-q', '-m', 'nested'], nested)

    await expect(adapter.finalize(wt, 'add embedded repository')).rejects.toThrow(
      /Git submodule.*not bound/,
    )
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
