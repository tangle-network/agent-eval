/**
 * VCS-pluggable worktree adapter. One improvement = one worktree, PR-like
 * (multiple commits allowed). A code-tier proposer's `propose()` creates a
 * worktree, an agent commits the change into it, and `finalize()` returns a
 * `CodeSurface{ worktreeRef }` the measurement checks out to run the worker
 * against the changed code. On promotion the worktree becomes the PR branch.
 *
 * The interface is VCS-agnostic so a future `jj` ([jj-vcs](https://github.com/jj-vcs/jj))
 * adapter can slot in without touching proposer code. Only the git adapter
 * ships today. See `docs/design/self-improvement-engine.md`.
 */

import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { basename, isAbsolute, join } from 'node:path'
import type { CodeSurface } from '../types'

export interface Worktree {
  /** Absolute path to the checked-out worktree directory. */
  path: string
  /** The branch the worktree is on (becomes the PR branch on promotion). */
  branch: string
  /** The ref the worktree was forked from. */
  baseRef: string
}

export interface WorktreeAdapter {
  /** Create an isolated worktree on a fresh branch off `baseRef`. */
  create(opts: { baseRef: string; label: string }): Promise<Worktree>
  /** Commit any pending changes in the worktree, then return a CodeSurface
   *  pointing at it. The agent has already written its change into
   *  `worktree.path` by the time this is called. */
  finalize(worktree: Worktree, summary: string): Promise<CodeSurface>
  /** Remove the worktree (and its branch) — called for losing candidates. */
  discard(worktree: Worktree): Promise<void>
}

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
  /** Test seam — defaults to a real `git` runner. */
  git?: (args: string[], cwd: string) => string
}

function defaultGit(args: string[], cwd: string): string {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
  } catch (err) {
    const stderr =
      err && typeof err === 'object' && 'stderr' in err
        ? String((err as { stderr: unknown }).stderr)
        : ''
    throw new WorktreeAdapterError(`git ${args.join(' ')} failed: ${stderr || String(err)}`, err)
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

export function gitWorktreeAdapter(opts: GitWorktreeAdapterOptions): WorktreeAdapter {
  const git = opts.git ?? defaultGit
  const worktreeDir = opts.worktreeDir ?? join(opts.repoRoot, '.worktrees')
  const branchPrefix = opts.branchPrefix ?? 'improve'

  return {
    async create({ baseRef, label }) {
      const id = `${slug(label)}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
      const branch = `${branchPrefix}/${id}`
      const path = join(worktreeDir, id)
      git(['worktree', 'add', '-b', branch, path, baseRef], opts.repoRoot)
      return { path, branch, baseRef }
    },

    async finalize(worktree, summary) {
      // Stage + commit any pending changes the agent left in the worktree.
      // A no-op commit is refused by git, so only commit when the tree is dirty.
      const status = git(['status', '--porcelain'], worktree.path)
      if (status.length > 0) {
        git(['add', '-A'], worktree.path)
        git(['commit', '-m', summary], worktree.path)
      }
      return {
        kind: 'code',
        worktreeRef: worktree.path,
        baseRef: worktree.baseRef,
        summary,
      }
    },

    async discard(worktree) {
      // Remove the worktree, then delete its branch. Force-remove because the
      // worktree may hold uncommitted experiment state we're discarding.
      git(['worktree', 'remove', '--force', worktree.path], opts.repoRoot)
      git(['branch', '-D', worktree.branch], opts.repoRoot)
    },
  }
}

/** Resolve a `CodeSurface`'s worktreeRef to a directory the measurement can
 *  run the worker in. A path ref is returned as-is; anything else is treated
 *  as a ref under the adapter's worktree dir. */
export function resolveWorktreePath(surface: CodeSurface, worktreeDir?: string): string {
  if (isAbsolute(surface.worktreeRef) && existsSync(surface.worktreeRef)) return surface.worktreeRef
  if (worktreeDir) return join(worktreeDir, basename(surface.worktreeRef))
  return surface.worktreeRef
}
