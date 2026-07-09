/**
 * VCS-pluggable worktree adapter. One improvement = one worktree, PR-like
 * (multiple commits allowed). A code-tier proposer's `propose()` creates a
 * worktree, an agent commits the change into it, and `finalize()` returns a
 * content-addressed `CodeSurface` the measurement verifies before running.
 * On promotion the worktree becomes the PR branch.
 *
 * The interface is VCS-agnostic so a future `jj` ([jj-vcs](https://github.com/jj-vcs/jj))
 * adapter can slot in without touching proposer code. Only the git adapter
 * ships today. See `docs/design/loop-taxonomy.md`.
 */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { basename, isAbsolute, join } from 'node:path'
import { assertCodeSurfaceIdentity, surfaceContentHash } from '../surface-identity'
import type { CodeSurface } from '../types'

const MAX_GIT_OUTPUT_BYTES = 256 * 1024 * 1024

type GitOutput = string | Uint8Array
type GitRunner = (args: string[], cwd: string) => GitOutput

const GIT_REPOSITORY_ENV = new Set([
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_COMMON_DIR',
  'GIT_DIR',
  'GIT_INDEX_FILE',
  'GIT_NAMESPACE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_PREFIX',
  'GIT_QUARANTINE_PATH',
  'GIT_WORK_TREE',
])

export interface Worktree {
  /** Absolute path to the checked-out worktree directory. */
  readonly path: string
  /** The branch the worktree is on (becomes the PR branch on promotion). */
  readonly branch: string
  /** The ref the worktree was forked from. */
  readonly baseRef: string
  /** Exact commit `baseRef` resolved to before the worktree was created. */
  readonly baseCommit: string
  /** Exact tree object for `baseCommit`. */
  readonly baseTree: string
}

export interface WorktreeAdapter {
  /** Create an isolated worktree on a fresh branch off `baseRef`. */
  create(opts: { baseRef: string; label: string }): Promise<Worktree>
  /** Commit pending changes, freeze the exact Git objects + binary patch, and
   *  verify the worktree still matches that identity. */
  finalize(worktree: Worktree, summary: string): Promise<CodeSurface>
  /** Remove the worktree (and its branch) — called for losing candidates. */
  discard(worktree: Worktree): Promise<void>
}

/** Typed failure from a `WorktreeAdapter` operation (create/finalize/discard) — wraps the underlying git error as `cause`. */
export class WorktreeAdapterError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message)
    this.name = 'WorktreeAdapterError'
  }
}

export interface GitWorktreeAdapterOptions {
  /** Repo root the worktrees fork from. */
  repoRoot: string
  /** Directory worktrees are created under. Default: `<repoRoot>/.worktrees`. */
  worktreeDir?: string
  /** Branch-name prefix. Default: `improve`. */
  branchPrefix?: string
  /** Test seam — defaults to a real `git` runner. The return value must contain
   *  stdout verbatim; trimming a binary diff changes candidate identity. */
  git?: GitRunner
}

function defaultGit(args: string[], cwd: string): Uint8Array {
  try {
    const env = { ...process.env }
    for (const key of Object.keys(env)) {
      if (GIT_REPOSITORY_ENV.has(key) || key === 'GIT_CONFIG' || key.startsWith('GIT_CONFIG_')) {
        delete env[key]
      }
    }
    return execFileSync('git', args, { cwd, env, maxBuffer: MAX_GIT_OUTPUT_BYTES })
  } catch (err) {
    const stderr =
      err && typeof err === 'object' && 'stderr' in err
        ? String((err as { stderr: unknown }).stderr)
        : ''
    throw new WorktreeAdapterError(`git ${args.join(' ')} failed: ${stderr || String(err)}`, err)
  }
}

function gitBytes(git: GitRunner, args: string[], cwd: string): Buffer {
  try {
    const output = git(args, cwd)
    return typeof output === 'string' ? Buffer.from(output, 'utf8') : Buffer.from(output)
  } catch (err) {
    if (err instanceof WorktreeAdapterError) throw err
    throw new WorktreeAdapterError(`git ${args.join(' ')} failed: ${String(err)}`, err)
  }
}

function gitText(git: GitRunner, args: string[], cwd: string): string {
  return gitBytes(git, args, cwd).toString('utf8').trim()
}

function sha256(bytes: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`
}

const PATCH_ARGS = [
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
] as const

function patchBytes(
  git: GitRunner,
  cwd: string,
  baseCommit: string,
  candidateCommit: string,
): Buffer {
  return gitBytes(git, [...PATCH_ARGS, baseCommit, candidateCommit, '--'], cwd)
}

function resolveCommit(git: GitRunner, cwd: string, ref: string): string {
  return gitText(git, ['rev-parse', '--verify', `${ref}^{commit}`], cwd)
}

function unresolvedWorktreePath(surface: CodeSurface, worktreeDir?: string): string {
  if (isAbsolute(surface.worktreeRef)) return surface.worktreeRef
  if (worktreeDir) return join(worktreeDir, basename(surface.worktreeRef))
  return surface.worktreeRef
}

export interface CodeSurfaceVerification {
  /** Verified worktree path. */
  path: string
  /** Git's canonical root for the verified checkout. */
  repoRoot: string
  /** Recomputed full content identity. */
  contentHash: `sha256:${string}`
  /** Exact verified binary-patch bytes. Candidate-bundle builders encode this
   *  directly instead of reproducing Git diff options. */
  patchBytes: Uint8Array
}

function verifyCodeSurfaceWithGit(
  surface: CodeSurface,
  path: string,
  git: GitRunner,
): CodeSurfaceVerification {
  assertCodeSurfaceIdentity(surface)
  if (!existsSync(path)) {
    throw new WorktreeAdapterError(`CodeSurface worktree does not exist: ${path}`)
  }

  const indexFlags = gitText(git, ['ls-files', '-v'], path)
    .split('\n')
    .filter((line) => line.length > 0 && (line.startsWith('S ') || /^[a-z]/.test(line)))
  if (indexFlags.length > 0) {
    throw new WorktreeAdapterError(
      `CodeSurface worktree uses hidden index entries that cannot be verified: ${path}\n${indexFlags.join('\n')}`,
    )
  }

  const status = gitText(
    git,
    [
      '-c',
      'core.fsmonitor=false',
      '-c',
      'core.untrackedCache=false',
      'status',
      '--porcelain=v1',
      '--untracked-files=all',
      '--ignored=matching',
      '--ignore-submodules=none',
    ],
    path,
  )
  if (status.length > 0) {
    throw new WorktreeAdapterError(
      `CodeSurface worktree changed after finalization: ${path}\n${status}`,
    )
  }

  const candidateCommit = resolveCommit(git, path, 'HEAD')
  if (candidateCommit !== surface.candidateCommit) {
    throw new WorktreeAdapterError(
      `CodeSurface candidate commit mismatch: expected ${surface.candidateCommit}, got ${candidateCommit}`,
    )
  }

  const baseCommit = resolveCommit(git, path, surface.baseCommit)
  if (baseCommit !== surface.baseCommit) {
    throw new WorktreeAdapterError(
      `CodeSurface base commit mismatch: expected ${surface.baseCommit}, got ${baseCommit}`,
    )
  }

  const baseTree = gitText(git, ['rev-parse', '--verify', `${surface.baseCommit}^{tree}`], path)
  if (baseTree !== surface.baseTree) {
    throw new WorktreeAdapterError(
      `CodeSurface base tree mismatch: expected ${surface.baseTree}, got ${baseTree}`,
    )
  }

  const candidateObject = resolveCommit(git, path, surface.candidateCommit)
  if (candidateObject !== surface.candidateCommit) {
    throw new WorktreeAdapterError(
      `CodeSurface candidate object mismatch: expected ${surface.candidateCommit}, got ${candidateObject}`,
    )
  }

  const candidateTree = gitText(
    git,
    ['rev-parse', '--verify', `${surface.candidateCommit}^{tree}`],
    path,
  )
  if (candidateTree !== surface.candidateTree) {
    throw new WorktreeAdapterError(
      `CodeSurface tree mismatch: expected ${surface.candidateTree}, got ${candidateTree}`,
    )
  }

  // Rebuild the index from the frozen commit before comparing it to the
  // filesystem. This clears cached stat data, so same-size/same-mtime edits
  // cannot hide behind Git's normal status shortcut.
  gitText(git, ['read-tree', '--reset', surface.candidateCommit], path)
  try {
    gitText(
      git,
      [
        '-c',
        'core.filemode=true',
        '-c',
        'core.symlinks=true',
        '-c',
        'core.fsmonitor=false',
        '-c',
        'core.ignorestat=false',
        'diff-files',
        '--no-ext-diff',
        '--no-textconv',
        '--quiet',
        '--',
      ],
      path,
    )
  } catch (err) {
    throw new WorktreeAdapterError(
      `CodeSurface tracked bytes changed after finalization: ${path}`,
      err,
    )
  }

  const mergeBase = gitText(git, ['merge-base', surface.baseCommit, surface.candidateCommit], path)
  if (mergeBase !== surface.baseCommit) {
    throw new WorktreeAdapterError(
      `CodeSurface candidate ${surface.candidateCommit} does not descend from base ${surface.baseCommit}`,
    )
  }

  const patch = patchBytes(git, path, surface.baseCommit, surface.candidateCommit)
  const actualPatchHash = sha256(patch)
  if (actualPatchHash !== surface.patch.sha256 || patch.byteLength !== surface.patch.byteLength) {
    throw new WorktreeAdapterError(
      `CodeSurface patch mismatch: expected ${surface.patch.sha256}/${surface.patch.byteLength} bytes, got ${actualPatchHash}/${patch.byteLength} bytes`,
    )
  }

  return {
    path,
    repoRoot: gitText(git, ['rev-parse', '--show-toplevel'], path),
    contentHash: surfaceContentHash(surface),
    patchBytes: new Uint8Array(patch),
  }
}

/** Slugify a label into a branch-safe segment. */
function slug(label: string): string {
  return (
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'candidate'
  )
}

/**
 * Git-backed `WorktreeAdapter`: creates isolated worktrees on fresh branches, commits agent changes, and discards losers.
 */
export function gitWorktreeAdapter(opts: GitWorktreeAdapterOptions): WorktreeAdapter {
  const git = opts.git ?? defaultGit
  const worktreeDir = opts.worktreeDir ?? join(opts.repoRoot, '.worktrees')
  const branchPrefix = opts.branchPrefix ?? 'improve'

  return {
    async create({ baseRef, label }) {
      const id = `${slug(label)}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
      const branch = `${branchPrefix}/${id}`
      const path = join(worktreeDir, id)
      const baseCommit = resolveCommit(git, opts.repoRoot, baseRef)
      const baseTree = gitText(
        git,
        ['rev-parse', '--verify', `${baseCommit}^{tree}`],
        opts.repoRoot,
      )
      gitText(git, ['worktree', 'add', '-b', branch, path, baseCommit], opts.repoRoot)
      return { path, branch, baseRef, baseCommit, baseTree }
    },

    async finalize(worktree, summary) {
      // Stage + commit any pending changes the agent left in the worktree.
      // A no-op commit is refused by git, so only commit when the tree is dirty.
      const status = gitText(
        git,
        ['status', '--porcelain=v1', '--untracked-files=all'],
        worktree.path,
      )
      if (status.length > 0) {
        gitText(git, ['add', '-A'], worktree.path)
        gitText(git, ['commit', '-m', summary], worktree.path)
      }
      const candidateCommit = resolveCommit(git, worktree.path, 'HEAD')
      const candidateTree = gitText(
        git,
        ['rev-parse', '--verify', `${candidateCommit}^{tree}`],
        worktree.path,
      )
      const patch = patchBytes(git, worktree.path, worktree.baseCommit, candidateCommit)
      const surface: CodeSurface = {
        kind: 'code',
        worktreeRef: worktree.path,
        baseRef: worktree.baseRef,
        baseCommit: worktree.baseCommit,
        baseTree: worktree.baseTree,
        candidateCommit,
        candidateTree,
        patch: {
          format: 'git-diff-binary',
          sha256: sha256(patch),
          byteLength: patch.byteLength,
        },
        summary,
      }
      verifyCodeSurfaceWithGit(surface, worktree.path, git)
      return surface
    },

    async discard(worktree) {
      // Remove the worktree, then delete its branch. Force-remove because the
      // worktree may hold uncommitted experiment state we're discarding.
      gitText(git, ['worktree', 'remove', '--force', worktree.path], opts.repoRoot)
      gitText(git, ['branch', '-D', worktree.branch], opts.repoRoot)
    },
  }
}

/** Verify a finalized code surface against its current checkout. This rejects
 *  dirty/ignored files, moved refs, missing Git objects, and byte mismatches. */
export function verifyCodeSurface(
  surface: CodeSurface,
  worktreeDir?: string,
): CodeSurfaceVerification {
  const path = unresolvedWorktreePath(surface, worktreeDir)
  return verifyCodeSurfaceWithGit(surface, path, defaultGit)
}

/** Resolve a code candidate for evaluation only after verifying its immutable
 *  identity against the checkout at `worktreeRef`. */
export function resolveWorktreePath(surface: CodeSurface, worktreeDir?: string): string {
  return verifyCodeSurface(surface, worktreeDir).path
}
