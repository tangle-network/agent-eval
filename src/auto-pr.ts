/**
 * Automated pull request opener for the production loop.
 *
 * `runProductionLoop` produces a `promotedPrompt` string and a release
 * scorecard. To close the eval → prod → eval cycle the framework needs
 * to land that prompt as a reviewable code change. This module does
 * exactly that:
 *
 *   1. Stage a branch off `baseBranch`.
 *   2. Write each `fileChange` into the worktree.
 *   3. Commit + push.
 *   4. Open a PR via the GitHub API.
 *
 * Two transports ship in core:
 *
 *   - `ghCliClient(opts)` — shells out to the `gh` CLI. No extra deps,
 *     re-uses the developer machine's `gh auth` state, works with both
 *     github.com and GitHub Enterprise. This is the recommended default.
 *   - `httpGithubClient(opts)` — direct `fetch` against `api.github.com`
 *     with a bearer token. Useful in CI where `gh` may not be installed.
 *
 * Both implement the small `AutoPrClient` interface, so tests substitute
 * a fake without spinning a process or network.
 *
 * @experimental — surface may evolve as consumers wire it into CI workflows.
 */

import { ConfigError, ValidationError } from './errors'

export interface FileChange {
  /** Repo-relative path. Forward slashes; no `..`. */
  path: string
  /** New file contents. UTF-8. */
  contents: string
  /** Optional explanatory comment shown in the commit body. */
  rationale?: string
}

export interface RepoRef {
  owner: string
  name: string
}

export interface ProposeAutomatedPullRequestInput {
  repo: RepoRef
  /** Branch to base the PR on. Default `'main'`. */
  baseBranch?: string
  /** New branch name. Use a prefix + a short stable id; no spaces. */
  branchName: string
  fileChanges: FileChange[]
  title: string
  body: string
  /** Optional GitHub usernames to request review from. */
  reviewers?: string[]
  /** Optional labels to apply. */
  labels?: string[]
  /** Commit author name. Default: derived from the GitHub client. */
  authorName?: string
  /** Commit author email. Default: derived from the GitHub client. */
  authorEmail?: string
  /** Dry-run — do not push or open a PR; just return the would-be plan. */
  dryRun?: boolean
}

export interface ProposeAutomatedPullRequestResult {
  prUrl: string
  branchName: string
  headSha: string
  dryRun: boolean
}

/** Pluggable transport for the auto-PR pipeline. */
export interface AutoPrClient {
  /**
   * Create a branch from `baseBranch`, write file changes, commit, push,
   * and open a PR. Returns the PR's HTML url and head SHA.
   *
   * Implementations must be idempotent on `branchName`: if the branch
   * already exists with the same head SHA as the would-be commit, return
   * the existing PR rather than failing. This makes the production loop
   * safe to retry on transient errors.
   */
  proposeChange(input: ProposeAutomatedPullRequestInput): Promise<ProposeAutomatedPullRequestResult>
}

export async function proposeAutomatedPullRequest(
  client: AutoPrClient,
  input: ProposeAutomatedPullRequestInput,
): Promise<ProposeAutomatedPullRequestResult> {
  validate(input)
  return client.proposeChange(input)
}

function validate(input: ProposeAutomatedPullRequestInput): void {
  if (!input.repo.owner.trim() || !input.repo.name.trim()) {
    throw new ValidationError('proposeAutomatedPullRequest: repo.owner and repo.name required')
  }
  if (!input.branchName.trim() || /\s/.test(input.branchName)) {
    throw new ValidationError(
      'proposeAutomatedPullRequest: branchName must be non-empty and contain no whitespace',
    )
  }
  if (input.branchName === (input.baseBranch ?? 'main')) {
    throw new ValidationError('proposeAutomatedPullRequest: branchName must differ from baseBranch')
  }
  if (input.fileChanges.length === 0) {
    throw new ValidationError('proposeAutomatedPullRequest: fileChanges must not be empty')
  }
  const seenPaths = new Set<string>()
  for (const change of input.fileChanges) {
    if (!change.path.trim() || change.path.includes('..') || change.path.startsWith('/')) {
      throw new ValidationError(
        `proposeAutomatedPullRequest: invalid file path "${change.path}" (no '..' or leading '/')`,
      )
    }
    if (seenPaths.has(change.path)) {
      throw new ValidationError(`proposeAutomatedPullRequest: duplicate file path "${change.path}"`)
    }
    seenPaths.add(change.path)
  }
  if (!input.title.trim()) {
    throw new ValidationError('proposeAutomatedPullRequest: title must not be empty')
  }
}

// ── HTTP transport (uses `fetch` against api.github.com) ─────────────

export interface HttpGithubClientOptions {
  /** Personal access token, GitHub App token, or `GITHUB_TOKEN` from Actions. */
  token: string
  /** Override for GitHub Enterprise. Default `'https://api.github.com'`. */
  apiBase?: string
  /** Test seam — defaults to global `fetch`. */
  fetchImpl?: typeof fetch
  /** Test seam — clock for commit timestamps. */
  now?: () => Date
}

interface GhRef {
  ref: string
  object: { sha: string }
}

interface GhCommit {
  sha: string
  tree: { sha: string }
}

interface GhBlob {
  sha: string
}

interface GhTree {
  sha: string
}

interface GhPullRequest {
  html_url: string
  number: number
}

/**
 * Direct REST-API GitHub client. No external deps.
 *
 * Idempotency strategy: before creating refs/commits/PRs, check whether
 * the branch already exists at the desired tree. If so, return the
 * existing PR (or open one if missing). Errors from concurrent runs
 * (`Reference already exists`) are caught and treated as success.
 */
export function httpGithubClient(opts: HttpGithubClientOptions): AutoPrClient {
  const fetchImpl = opts.fetchImpl ?? fetch
  const apiBase = (opts.apiBase ?? 'https://api.github.com').replace(/\/+$/, '')
  const now = opts.now ?? (() => new Date())

  async function api<T>(
    method: string,
    path: string,
    body?: unknown,
    accept404 = false,
  ): Promise<T | null> {
    const res = await fetchImpl(`${apiBase}${path}`, {
      method,
      headers: {
        accept: 'application/vnd.github+json',
        'content-type': 'application/json',
        authorization: `Bearer ${opts.token}`,
        'x-github-api-version': '2022-11-28',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    if (accept404 && res.status === 404) return null
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new ConfigError(
        `proposeAutomatedPullRequest: GitHub ${method} ${path} → ${res.status} ${text.slice(0, 400)}`,
      )
    }
    return (await res.json()) as T
  }

  return {
    async proposeChange(input) {
      const baseBranch = input.baseBranch ?? 'main'
      const repoPath = `/repos/${input.repo.owner}/${input.repo.name}`

      if (input.dryRun) {
        return {
          prUrl: `https://github.com/${input.repo.owner}/${input.repo.name}/compare/${baseBranch}...${input.branchName}`,
          branchName: input.branchName,
          headSha: 'dry-run',
          dryRun: true,
        }
      }

      // 1. Find base SHA
      const baseRef = await api<GhRef>('GET', `${repoPath}/git/ref/heads/${baseBranch}`)
      if (!baseRef) {
        throw new ConfigError(`proposeAutomatedPullRequest: base branch "${baseBranch}" not found`)
      }
      const baseSha = baseRef.object.sha
      const baseCommit = await api<GhCommit>('GET', `${repoPath}/git/commits/${baseSha}`)
      if (!baseCommit) {
        throw new ConfigError(
          `proposeAutomatedPullRequest: base commit ${baseSha} not found (race condition?)`,
        )
      }

      // 2. Create blobs for each file
      const treeEntries = []
      for (const change of input.fileChanges) {
        const blob = await api<GhBlob>('POST', `${repoPath}/git/blobs`, {
          content: change.contents,
          encoding: 'utf-8',
        })
        if (!blob) throw new ConfigError('proposeAutomatedPullRequest: blob creation returned null')
        treeEntries.push({
          path: change.path,
          mode: '100644',
          type: 'blob',
          sha: blob.sha,
        })
      }

      // 3. Create tree
      const tree = await api<GhTree>('POST', `${repoPath}/git/trees`, {
        base_tree: baseCommit.tree.sha,
        tree: treeEntries,
      })
      if (!tree) throw new ConfigError('proposeAutomatedPullRequest: tree creation returned null')

      // 4. Create commit
      const author =
        input.authorName && input.authorEmail
          ? { name: input.authorName, email: input.authorEmail, date: now().toISOString() }
          : undefined
      const commitMessage = renderCommitMessage(input)
      const commit = await api<GhCommit>('POST', `${repoPath}/git/commits`, {
        message: commitMessage,
        tree: tree.sha,
        parents: [baseSha],
        ...(author ? { author, committer: author } : {}),
      })
      if (!commit)
        throw new ConfigError('proposeAutomatedPullRequest: commit creation returned null')

      // 5. Create or fast-forward branch ref (idempotent on existing branch).
      const existing = await api<GhRef>(
        'GET',
        `${repoPath}/git/ref/heads/${input.branchName}`,
        undefined,
        true,
      )
      if (!existing) {
        await api('POST', `${repoPath}/git/refs`, {
          ref: `refs/heads/${input.branchName}`,
          sha: commit.sha,
        })
      } else if (existing.object.sha !== commit.sha) {
        await api('PATCH', `${repoPath}/git/refs/heads/${input.branchName}`, {
          sha: commit.sha,
          force: true,
        })
      }

      // 6. Open PR (or find an existing open one for the same branch).
      const openPrs = await api<GhPullRequest[]>(
        'GET',
        `${repoPath}/pulls?state=open&head=${encodeURIComponent(`${input.repo.owner}:${input.branchName}`)}`,
      )
      let pr: GhPullRequest
      if (openPrs && openPrs.length > 0) {
        pr = openPrs[0] as GhPullRequest
      } else {
        const created = await api<GhPullRequest>('POST', `${repoPath}/pulls`, {
          title: input.title,
          body: input.body,
          head: input.branchName,
          base: baseBranch,
        })
        if (!created)
          throw new ConfigError('proposeAutomatedPullRequest: PR creation returned null')
        pr = created
      }

      if (input.reviewers && input.reviewers.length > 0) {
        await api(
          'POST',
          `${repoPath}/pulls/${pr.number}/requested_reviewers`,
          { reviewers: input.reviewers },
          true,
        ).catch(() => {
          /* reviewer assignment is best-effort */
        })
      }
      if (input.labels && input.labels.length > 0) {
        await api(
          'POST',
          `${repoPath}/issues/${pr.number}/labels`,
          { labels: input.labels },
          true,
        ).catch(() => {
          /* label assignment is best-effort */
        })
      }

      return {
        prUrl: pr.html_url,
        branchName: input.branchName,
        headSha: commit.sha,
        dryRun: false,
      }
    },
  }
}

// ── gh CLI transport (no fetch needed, re-uses developer auth) ──────

export interface GhCliClientOptions {
  /** Override the CLI binary (`gh`). For testing. */
  bin?: string
  /** Working directory containing a clone of `repo`. Default: process cwd. */
  cwd?: string
  /** Test seam: process spawner. Default: node:child_process spawn. */
  exec?: (
    bin: string,
    args: string[],
    opts: { cwd: string; stdin?: string },
  ) => Promise<{ stdout: string; stderr: string; exitCode: number }>
}

/**
 * `gh` CLI transport. Requires:
 *   - `gh` installed and authenticated (`gh auth status`).
 *   - A local clone of the repo with a clean working tree.
 *   - `git` on PATH.
 *
 * Uses `gh api` for repo metadata and `gh pr create` for the PR. The
 * actual commit lands via `git`, which keeps `gh`'s footprint minimal.
 */
export function ghCliClient(opts: GhCliClientOptions = {}): AutoPrClient {
  const bin = opts.bin ?? 'gh'
  const cwd = opts.cwd ?? process.cwd()
  const exec = opts.exec ?? defaultExec

  async function run(
    cmd: string,
    args: string[],
    stdin?: string,
  ): Promise<{ stdout: string; stderr: string }> {
    const r = await exec(cmd, args, { cwd, stdin })
    if (r.exitCode !== 0) {
      throw new ConfigError(
        `proposeAutomatedPullRequest: ${cmd} ${args.join(' ')} failed (${r.exitCode}): ${r.stderr.trim() || r.stdout.trim()}`,
      )
    }
    return r
  }

  return {
    async proposeChange(input) {
      const baseBranch = input.baseBranch ?? 'main'
      if (input.dryRun) {
        return {
          prUrl: `https://github.com/${input.repo.owner}/${input.repo.name}/compare/${baseBranch}...${input.branchName}`,
          branchName: input.branchName,
          headSha: 'dry-run',
          dryRun: true,
        }
      }

      // Ensure we're working in a clean tree on the base branch.
      await run('git', ['fetch', 'origin', baseBranch])
      await run('git', ['checkout', baseBranch])
      await run('git', ['reset', '--hard', `origin/${baseBranch}`])

      // Branch (idempotent: delete if exists, then re-create from base).
      await exec('git', ['branch', '-D', input.branchName], { cwd })
      await run('git', ['checkout', '-b', input.branchName])

      // Write file changes.
      const { mkdir, writeFile } = await import('node:fs/promises')
      const { dirname, join, resolve } = await import('node:path')
      for (const change of input.fileChanges) {
        const abs = resolve(cwd, change.path)
        await mkdir(dirname(abs), { recursive: true })
        await writeFile(abs, change.contents, 'utf8')
        await run('git', ['add', join(change.path)])
      }

      // Commit.
      const env: Record<string, string> = {}
      if (input.authorName) env.GIT_AUTHOR_NAME = input.authorName
      if (input.authorEmail) env.GIT_AUTHOR_EMAIL = input.authorEmail
      if (input.authorName) env.GIT_COMMITTER_NAME = input.authorName
      if (input.authorEmail) env.GIT_COMMITTER_EMAIL = input.authorEmail
      const message = renderCommitMessage(input)
      await run('git', ['commit', '-m', message])

      const headRes = await run('git', ['rev-parse', 'HEAD'])
      const headSha = headRes.stdout.trim()

      // Push.
      await run('git', ['push', '-f', 'origin', input.branchName])

      // Open PR (idempotent: `gh pr create` errors if one exists).
      const existing = await exec(
        bin,
        [
          'pr',
          'list',
          '--state',
          'open',
          '--head',
          input.branchName,
          '--json',
          'url,number',
          '--limit',
          '1',
        ],
        { cwd },
      )
      let prUrl = ''
      if (existing.exitCode === 0 && existing.stdout.trim()) {
        const parsed = JSON.parse(existing.stdout) as Array<{ url: string }>
        if (parsed.length > 0 && parsed[0]) prUrl = parsed[0].url
      }
      if (!prUrl) {
        const args = [
          'pr',
          'create',
          '--title',
          input.title,
          '--body',
          input.body,
          '--base',
          baseBranch,
        ]
        if (input.reviewers && input.reviewers.length > 0) {
          args.push('--reviewer', input.reviewers.join(','))
        }
        if (input.labels && input.labels.length > 0) {
          args.push('--label', input.labels.join(','))
        }
        const r = await run(bin, args)
        const match = r.stdout.match(/https?:\/\/\S+/)
        prUrl = match ? match[0] : r.stdout.trim()
      }

      return { prUrl, branchName: input.branchName, headSha, dryRun: false }
    },
  }
}

async function defaultExec(
  bin: string,
  args: string[],
  opts: { cwd: string; stdin?: string },
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const { spawn } = await import('node:child_process')
  return new Promise((resolveExec) => {
    const child = spawn(bin, args, { cwd: opts.cwd })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => {
      stdout += d.toString()
    })
    child.stderr.on('data', (d) => {
      stderr += d.toString()
    })
    if (opts.stdin) child.stdin.end(opts.stdin)
    child.on('error', (err) => {
      resolveExec({ stdout, stderr: `${stderr}${err.message}`, exitCode: 1 })
    })
    child.on('close', (code) => {
      resolveExec({ stdout, stderr, exitCode: code ?? 1 })
    })
  })
}

function renderCommitMessage(input: ProposeAutomatedPullRequestInput): string {
  const lines = [input.title, '']
  for (const change of input.fileChanges) {
    if (change.rationale) lines.push(`- ${change.path}: ${change.rationale}`)
  }
  if (lines[lines.length - 1] !== '') lines.push('')
  lines.push(input.body.trim())
  return lines.join('\n').trim()
}
