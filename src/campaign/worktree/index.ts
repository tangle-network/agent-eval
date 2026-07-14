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
import {
  closeSync,
  existsSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readlinkSync,
  readSync,
  realpathSync,
  rmSync,
} from 'node:fs'
import { devNull, tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { assertCodeSurfaceIdentity, surfaceContentHash } from '../surface-identity'
import type { CodeSurface } from '../types'

const MAX_GIT_OUTPUT_BYTES = 256 * 1024 * 1024
const FILE_HASH_CHUNK_BYTES = 1024 * 1024

type GitOutput = string | Uint8Array
type GitEnvironment = Readonly<Record<string, string>>
type GitRunner = (args: string[], cwd: string, env?: GitEnvironment) => GitOutput

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
  /** Idempotently remove the worktree and branch. Safe to retry after partial cleanup. */
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
   *  stdout verbatim, and runners that execute Git must forward the optional
   *  environment overrides used to isolate patch generation. */
  git?: GitRunner
}

function defaultGit(args: string[], cwd: string, overrides?: GitEnvironment): Uint8Array {
  try {
    const env = { ...process.env }
    for (const key of Object.keys(env)) {
      if (
        GIT_REPOSITORY_ENV.has(key) ||
        key === 'GIT_CONFIG' ||
        key.startsWith('GIT_CONFIG_') ||
        key.startsWith('GIT_ATTR_') ||
        key === 'GIT_DIFF_OPTS' ||
        key === 'GIT_EXTERNAL_DIFF'
      ) {
        delete env[key]
      }
    }
    Object.assign(env, overrides)
    env.GIT_NO_REPLACE_OBJECTS = '1'
    env.LC_ALL = 'C'
    env.LANG = 'C'
    return execFileSync('git', args, { cwd, env, maxBuffer: MAX_GIT_OUTPUT_BYTES })
  } catch (err) {
    const stderr =
      err && typeof err === 'object' && 'stderr' in err
        ? String((err as { stderr: unknown }).stderr)
        : ''
    throw new WorktreeAdapterError(`git ${args.join(' ')} failed: ${stderr || String(err)}`, err)
  }
}

function gitBytes(git: GitRunner, args: string[], cwd: string, env?: GitEnvironment): Buffer {
  try {
    const output = git(args, cwd, env)
    return typeof output === 'string' ? Buffer.from(output, 'utf8') : Buffer.from(output)
  } catch (err) {
    if (err instanceof WorktreeAdapterError) throw err
    throw new WorktreeAdapterError(`git ${args.join(' ')} failed: ${String(err)}`, err)
  }
}

function gitText(git: GitRunner, args: string[], cwd: string, env?: GitEnvironment): string {
  return gitBytes(git, args, cwd, env).toString('utf8').trim()
}

function hasRegisteredWorktree(git: GitRunner, repoRoot: string, path: string): boolean {
  const expected = Buffer.from(`worktree ${resolve(path)}`, 'utf8')
  const records = gitBytes(git, ['worktree', 'list', '--porcelain', '-z'], repoRoot)
  let start = 0
  while (start < records.length) {
    const end = records.indexOf(0, start)
    if (end < 0) {
      throw new WorktreeAdapterError('Git worktree list output was not NUL-terminated')
    }
    if (records.subarray(start, end).equals(expected)) return true
    start = end + 1
  }
  return false
}

function hasLocalBranch(git: GitRunner, repoRoot: string, branch: string): boolean {
  const ref = `refs/heads/${branch}`
  return gitText(git, ['for-each-ref', '--format=%(refname)', '--', ref], repoRoot)
    .split('\n')
    .some((candidate) => candidate === ref)
}

function reconcileAbsent(exists: () => boolean, remove: () => void): unknown | undefined {
  try {
    if (!exists()) return undefined
  } catch (err) {
    return err
  }

  try {
    remove()
    return undefined
  } catch (removeError) {
    try {
      // Git may complete the mutation before the caller observes a failure, or
      // another cleanup may win the race. The desired end state is what matters.
      if (!exists()) return undefined
    } catch (recheckError) {
      return new AggregateError(
        [removeError, recheckError],
        'Removal failed and the resulting resource state could not be checked',
      )
    }
    return removeError
  }
}

function sha256(bytes: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`
}

const PATCH_ARGS = [
  // Git binary patches embed a zlib stream. Pin no-compression at command
  // scope so repository/global config and compressor heuristics cannot change
  // the candidate identity for the same base and final tree.
  '-c',
  'core.compression=0',
  '-c',
  `core.attributesFile=${devNull}`,
  '-c',
  'core.quotePath=true',
  '-c',
  'diff.suppressBlankEmpty=false',
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
] as const

const CANONICAL_GIT_ENV: GitEnvironment = {
  GIT_ATTR_GLOBAL: devNull,
  GIT_ATTR_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: devNull,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_SYSTEM: devNull,
}

/** Render the transport patch from immutable objects through fresh Git metadata.
 *  Source-repository config, info attributes, templates, and caller environment
 *  therefore cannot alter bytes for the same two trees. */
function patchBytes(
  git: GitRunner,
  cwd: string,
  baseCommit: string,
  candidateCommit: string,
): Buffer {
  const scratch = mkdtempSync(join(tmpdir(), 'agent-eval-patch-'))
  const bareRepo = join(scratch, 'repo.git')
  const emptyTemplate = join(scratch, 'empty-template')
  mkdirSync(emptyTemplate)
  try {
    const objectFormat = gitObjectHashAlgorithm(candidateCommit)
    const sourceObjects = realpathSync(gitText(git, ['rev-parse', '--git-path', 'objects'], cwd))
    gitText(
      git,
      [
        'init',
        '--bare',
        '--quiet',
        ...(objectFormat === 'sha256' ? ['--object-format=sha256'] : []),
        `--template=${emptyTemplate}`,
        bareRepo,
      ],
      scratch,
      CANONICAL_GIT_ENV,
    )
    return gitBytes(
      git,
      [`--git-dir=${bareRepo}`, ...PATCH_ARGS, baseCommit, candidateCommit, '--'],
      scratch,
      {
        ...CANONICAL_GIT_ENV,
        GIT_ALTERNATE_OBJECT_DIRECTORIES: sourceObjects,
      },
    )
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

function resolveCommit(git: GitRunner, cwd: string, ref: string): string {
  return gitText(git, ['rev-parse', '--verify', `${ref}^{commit}`], cwd)
}

function unresolvedWorktreePath(surface: CodeSurface, worktreeDir?: string): string {
  if (isAbsolute(surface.worktreeRef)) return surface.worktreeRef
  if (worktreeDir) return join(worktreeDir, basename(surface.worktreeRef))
  return surface.worktreeRef
}

interface GitTreeEntry {
  mode: string
  objectId: string
  path: string
}

function displayGitPath(path: string): string {
  return JSON.stringify(path)
}

function parseGitTreeEntries(bytes: Uint8Array): GitTreeEntry[] {
  const input = Buffer.from(bytes)
  const entries: GitTreeEntry[] = []
  let start = 0
  while (start < input.length) {
    const end = input.indexOf(0, start)
    if (end < 0) throw new WorktreeAdapterError('Git tree output was not NUL-terminated')
    const record = input.subarray(start, end)
    start = end + 1
    if (record.length === 0) continue

    const tab = record.indexOf(0x09)
    if (tab < 0) throw new WorktreeAdapterError('Git tree entry did not contain a path')
    const metadata = record.subarray(0, tab).toString('ascii').split(' ')
    if (metadata.length !== 3) throw new WorktreeAdapterError('Git tree entry was malformed')
    const mode = metadata[0]
    const type = metadata[1]
    const objectId = metadata[2]
    if (!mode || !type || !objectId) {
      throw new WorktreeAdapterError('Git tree entry was malformed')
    }
    const pathBytes = record.subarray(tab + 1)
    const path = pathBytes.toString('utf8')
    if (!Buffer.from(path, 'utf8').equals(pathBytes)) {
      throw new WorktreeAdapterError('CodeSurface paths must be valid UTF-8')
    }
    if (type !== 'blob' && type !== 'commit') {
      throw new WorktreeAdapterError(
        `CodeSurface contains unsupported Git object type ${type} at ${displayGitPath(path)}`,
      )
    }
    entries.push({ mode, objectId, path })
  }
  return entries
}

function parseGitPathList(bytes: Uint8Array): string[] {
  const input = Buffer.from(bytes)
  const paths: string[] = []
  let start = 0
  while (start < input.length) {
    const end = input.indexOf(0, start)
    if (end < 0) throw new WorktreeAdapterError('Git path output was not NUL-terminated')
    const pathBytes = input.subarray(start, end)
    start = end + 1
    if (pathBytes.length === 0) continue
    const path = pathBytes.toString('utf8')
    if (!Buffer.from(path, 'utf8').equals(pathBytes)) {
      throw new WorktreeAdapterError('CodeSurface paths must be valid UTF-8')
    }
    paths.push(path)
  }
  return paths
}

function isWithinRoot(root: string, candidate: string): boolean {
  const rel = relative(root, candidate)
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`))
}

function assertSafeRelativePath(root: string, path: string): string {
  if (path.length === 0 || isAbsolute(path)) {
    throw new WorktreeAdapterError(`CodeSurface contains unsafe path ${displayGitPath(path)}`)
  }
  const absolutePath = resolve(root, path)
  if (!isWithinRoot(root, absolutePath) || absolutePath === root) {
    throw new WorktreeAdapterError(`CodeSurface path escapes its worktree: ${displayGitPath(path)}`)
  }

  const segments = path.split(/[\\/]/u)
  let parent = root
  for (const segment of segments.slice(0, -1)) {
    if (segment.length === 0 || segment === '.' || segment === '..') {
      throw new WorktreeAdapterError(`CodeSurface contains unsafe path ${displayGitPath(path)}`)
    }
    parent = join(parent, segment)
    const stat = lstatSync(parent)
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new WorktreeAdapterError(
        `CodeSurface path traverses a non-directory or symbolic link: ${displayGitPath(path)}`,
      )
    }
  }
  return absolutePath
}

function gitObjectHashAlgorithm(objectId: string): 'sha1' | 'sha256' {
  if (/^[a-f0-9]{40}$/.test(objectId)) return 'sha1'
  if (/^[a-f0-9]{64}$/.test(objectId)) return 'sha256'
  throw new WorktreeAdapterError(`Unsupported Git object id: ${objectId}`)
}

function hashGitBlobBytes(bytes: Uint8Array, objectId: string): string {
  const hash = createHash(gitObjectHashAlgorithm(objectId))
  hash.update(`blob ${bytes.byteLength}\0`)
  hash.update(bytes)
  return hash.digest('hex')
}

function hashGitBlobFile(path: string, objectId: string): { hash: string; executable: boolean } {
  const before = lstatSync(path)
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new WorktreeAdapterError(`CodeSurface expected a regular file at ${displayGitPath(path)}`)
  }

  const noFollow = process.platform === 'win32' ? 0 : fsConstants.O_NOFOLLOW
  const fd = openSync(path, fsConstants.O_RDONLY | noFollow)
  try {
    const opened = fstatSync(fd)
    if (
      !opened.isFile() ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.size !== before.size
    ) {
      throw new WorktreeAdapterError(
        `CodeSurface file changed while it was being verified: ${displayGitPath(path)}`,
      )
    }

    const hash = createHash(gitObjectHashAlgorithm(objectId))
    hash.update(`blob ${opened.size}\0`)
    const chunk = Buffer.allocUnsafe(FILE_HASH_CHUNK_BYTES)
    let total = 0
    while (true) {
      const count = readSync(fd, chunk, 0, chunk.length, null)
      if (count === 0) break
      total += count
      hash.update(chunk.subarray(0, count))
    }
    if (total !== opened.size) {
      throw new WorktreeAdapterError(
        `CodeSurface file changed while it was being verified: ${displayGitPath(path)}`,
      )
    }
    return { hash: hash.digest('hex'), executable: (opened.mode & 0o111) !== 0 }
  } finally {
    closeSync(fd)
  }
}

function assertSymlinkTargetIsBound(
  root: string,
  linkPath: string,
  trackedPaths: ReadonlySet<string>,
): void {
  const targetBytes = readlinkSync(linkPath, { encoding: 'buffer' })
  const target = targetBytes.toString('utf8')
  if (!Buffer.from(target, 'utf8').equals(targetBytes)) {
    throw new WorktreeAdapterError(
      `CodeSurface symbolic link has an unsafe target at ${displayGitPath(linkPath)}`,
    )
  }
  if (isAbsolute(target)) {
    throw new WorktreeAdapterError(
      `CodeSurface symbolic link escapes its worktree at ${displayGitPath(linkPath)}`,
    )
  }
  const lexicalTarget = resolve(dirname(linkPath), target)
  if (!isWithinRoot(root, lexicalTarget)) {
    throw new WorktreeAdapterError(
      `CodeSurface symbolic link escapes its worktree at ${displayGitPath(linkPath)}`,
    )
  }
  let resolvedTarget: string
  try {
    resolvedTarget = realpathSync(linkPath)
  } catch (err) {
    throw new WorktreeAdapterError(
      `CodeSurface symbolic link target is missing or cyclic at ${displayGitPath(linkPath)}`,
      err,
    )
  }
  if (!isWithinRoot(root, resolvedTarget)) {
    throw new WorktreeAdapterError(
      `CodeSurface symbolic link escapes its worktree at ${displayGitPath(linkPath)}`,
    )
  }

  const targetRelative = relative(root, resolvedTarget).split(sep).join('/')
  const targetIsTracked =
    trackedPaths.has(targetRelative) ||
    [...trackedPaths].some((trackedPath) => trackedPath.startsWith(`${targetRelative}/`))
  if (!targetIsTracked) {
    throw new WorktreeAdapterError(
      `CodeSurface symbolic link resolves to untracked content at ${displayGitPath(linkPath)}`,
    )
  }
}

function assertRawTreeMatchesWorktree(git: GitRunner, root: string, candidateCommit: string): void {
  const entries = parseGitTreeEntries(
    gitBytes(git, ['ls-tree', '-r', '-z', '--full-tree', candidateCommit], root),
  )
  const trackedPaths = new Set(entries.map((entry) => entry.path))

  for (const entry of entries) {
    const absolutePath = assertSafeRelativePath(root, entry.path)
    if (entry.mode === '160000' || entry.mode === '040000') {
      throw new WorktreeAdapterError(
        `CodeSurface contains a Git submodule whose executable bytes are not bound: ${displayGitPath(entry.path)}`,
      )
    }
    if (entry.mode === '120000') {
      const stat = lstatSync(absolutePath)
      if (!stat.isSymbolicLink()) {
        throw new WorktreeAdapterError(
          `CodeSurface expected a symbolic link at ${displayGitPath(entry.path)}`,
        )
      }
      const targetBytes = readlinkSync(absolutePath, { encoding: 'buffer' })
      const actualObjectId = hashGitBlobBytes(targetBytes, entry.objectId)
      if (actualObjectId !== entry.objectId) {
        throw new WorktreeAdapterError(
          `CodeSurface raw symbolic-link bytes differ from the candidate tree at ${displayGitPath(entry.path)}`,
        )
      }
      assertSymlinkTargetIsBound(root, absolutePath, trackedPaths)
      continue
    }
    if (entry.mode !== '100644' && entry.mode !== '100755') {
      throw new WorktreeAdapterError(
        `CodeSurface contains unsupported Git mode ${entry.mode} at ${displayGitPath(entry.path)}`,
      )
    }

    const actual = hashGitBlobFile(absolutePath, entry.objectId)
    if (actual.hash !== entry.objectId) {
      throw new WorktreeAdapterError(
        `CodeSurface raw tracked bytes differ from the candidate tree because the worktree changed after finalization at ${displayGitPath(entry.path)}`,
      )
    }
    if (process.platform !== 'win32' && actual.executable !== (entry.mode === '100755')) {
      throw new WorktreeAdapterError(
        `CodeSurface executable mode differs from the candidate tree at ${displayGitPath(entry.path)}`,
      )
    }
  }
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
  const lexicalRoot = resolve(path)
  const canonicalRoot = realpathSync(path)
  if (
    lstatSync(lexicalRoot).isSymbolicLink() ||
    (process.platform !== 'win32' && lexicalRoot !== canonicalRoot)
  ) {
    throw new WorktreeAdapterError(
      `CodeSurface worktree locator must not contain a symbolic link: ${path}`,
    )
  }
  const repoRoot = gitText(git, ['rev-parse', '--show-toplevel'], path)
  const canonicalRepoRoot = realpathSync(repoRoot)
  if (canonicalRepoRoot !== canonicalRoot) {
    throw new WorktreeAdapterError(
      `CodeSurface worktree locator is not the repository root: expected ${repoRoot}, got ${path}`,
    )
  }

  const indexFlags = gitText(git, ['ls-files', '-v'], path)
    .split('\n')
    .filter((line) => line.length > 0 && (line.startsWith('S ') || /^[a-z]/.test(line)))
  if (indexFlags.length > 0) {
    throw new WorktreeAdapterError(
      `CodeSurface worktree uses hidden index entries that cannot be verified: ${path}\n${indexFlags.join('\n')}`,
    )
  }

  const extraPaths = [
    ...parseGitPathList(gitBytes(git, ['ls-files', '--others', '--exclude-standard', '-z'], path)),
    ...parseGitPathList(
      gitBytes(git, ['ls-files', '--others', '--ignored', '--exclude-standard', '-z'], path),
    ),
  ]
  if (extraPaths.length > 0) {
    throw new WorktreeAdapterError(
      `CodeSurface worktree changed after finalization: ${path}\n${extraPaths.join('\n')}`,
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

  try {
    gitText(
      git,
      [
        'diff-index',
        '--cached',
        '--quiet',
        '--no-ext-diff',
        '--no-textconv',
        surface.candidateCommit,
        '--',
      ],
      path,
    )
  } catch (err) {
    throw new WorktreeAdapterError(
      `CodeSurface index differs from finalized candidate: ${path}`,
      err,
    )
  }

  try {
    assertRawTreeMatchesWorktree(git, canonicalRepoRoot, surface.candidateCommit)
  } catch (err) {
    if (err instanceof WorktreeAdapterError) throw err
    throw new WorktreeAdapterError(`CodeSurface raw tree verification failed: ${path}`, err)
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
    repoRoot: canonicalRepoRoot,
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
      // Reconcile both resources independently so a retry can finish cleanup
      // after either command succeeded alone. Force-remove because the worktree
      // may hold uncommitted experiment state we're discarding.
      const failures = [
        reconcileAbsent(
          () => hasRegisteredWorktree(git, opts.repoRoot, worktree.path),
          () => gitText(git, ['worktree', 'remove', '--force', '--', worktree.path], opts.repoRoot),
        ),
        reconcileAbsent(
          () => hasLocalBranch(git, opts.repoRoot, worktree.branch),
          () => gitText(git, ['branch', '-D', '--', worktree.branch], opts.repoRoot),
        ),
      ].filter((failure) => failure !== undefined)

      if (failures.length > 0) {
        const cause =
          failures.length === 1
            ? failures[0]
            : new AggregateError(failures, 'Multiple Git resources could not be removed')
        throw new WorktreeAdapterError(
          `Failed to discard worktree ${worktree.path} and branch ${worktree.branch}`,
          cause,
        )
      }
    },
  }
}

/** Verify a finalized code surface against its current checkout. This rejects
 *  dirty/ignored files, moved refs, missing Git objects, raw byte/mode
 *  mismatches, external symlinks, and submodules. */
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
