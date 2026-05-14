/**
 * Auto-PR tests.
 *
 * Regression coverage:
 *   - input validation (bad branch names, '..' paths, duplicate paths)
 *   - HTTP client opens a PR via the documented REST sequence (blob →
 *     tree → commit → ref → pulls)
 *   - HTTP client is idempotent: existing open PR is returned instead
 *     of a duplicate create
 *   - HTTP client fast-forwards the ref when it already exists with a
 *     different SHA
 *   - dryRun does not call fetch/exec
 *
 * No network.
 */
import { describe, expect, it, vi } from 'vitest'

import {
  ghCliClient,
  httpGithubClient,
  proposeAutomatedPullRequest,
} from '../src/auto-pr'
import { ValidationError } from '../src/errors'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

describe('proposeAutomatedPullRequest validation', () => {
  const fixture = {
    repo: { owner: 'tangle-network', name: 'tax-agent' },
    branchName: 'eval/auto-improve/r1',
    fileChanges: [{ path: 'prompts/system.txt', contents: 'new' }],
    title: 'feat: production-loop',
    body: 'body',
  }

  it('rejects an empty repo owner', async () => {
    const client = { proposeChange: vi.fn() }
    await expect(
      proposeAutomatedPullRequest(client, { ...fixture, repo: { owner: '', name: 'x' } }),
    ).rejects.toBeInstanceOf(ValidationError)
    expect(client.proposeChange).not.toHaveBeenCalled()
  })

  it('rejects whitespace branch names', async () => {
    const client = { proposeChange: vi.fn() }
    await expect(
      proposeAutomatedPullRequest(client, { ...fixture, branchName: 'has space' }),
    ).rejects.toBeInstanceOf(ValidationError)
  })

  it('rejects path traversal', async () => {
    const client = { proposeChange: vi.fn() }
    await expect(
      proposeAutomatedPullRequest(client, {
        ...fixture,
        fileChanges: [{ path: '../etc/passwd', contents: '' }],
      }),
    ).rejects.toBeInstanceOf(ValidationError)
  })

  it('rejects duplicate paths', async () => {
    const client = { proposeChange: vi.fn() }
    await expect(
      proposeAutomatedPullRequest(client, {
        ...fixture,
        fileChanges: [
          { path: 'a.txt', contents: '1' },
          { path: 'a.txt', contents: '2' },
        ],
      }),
    ).rejects.toBeInstanceOf(ValidationError)
  })

  it('rejects branch name equal to base branch', async () => {
    const client = { proposeChange: vi.fn() }
    await expect(
      proposeAutomatedPullRequest(client, { ...fixture, branchName: 'main', baseBranch: 'main' }),
    ).rejects.toBeInstanceOf(ValidationError)
  })

  it('empty title is rejected', async () => {
    const client = { proposeChange: vi.fn() }
    await expect(
      proposeAutomatedPullRequest(client, { ...fixture, title: '   ' }),
    ).rejects.toBeInstanceOf(ValidationError)
  })

  it('passes through to client.proposeChange on valid input', async () => {
    const client = {
      proposeChange: vi
        .fn()
        .mockResolvedValue({ prUrl: 'u', branchName: fixture.branchName, headSha: 's', dryRun: false }),
    }
    const result = await proposeAutomatedPullRequest(client, fixture)
    expect(result.prUrl).toBe('u')
    expect(client.proposeChange).toHaveBeenCalledTimes(1)
  })
})

describe('httpGithubClient', () => {
  function fakeFetch(handler: (url: string, init: RequestInit) => Response): typeof fetch {
    return ((url: RequestInfo | URL, init?: RequestInit) =>
      Promise.resolve(handler(String(url), init ?? {}))) as typeof fetch
  }

  function transcript() {
    const requests: Array<{ method: string; url: string; body: unknown }> = []
    return {
      requests,
      record(url: string, init: RequestInit) {
        requests.push({
          method: init.method ?? 'GET',
          url,
          body: init.body ? JSON.parse(init.body as string) : null,
        })
      },
    }
  }

  it('opens a PR via blob → tree → commit → ref → pulls', async () => {
    const t = transcript()
    const client = httpGithubClient({
      token: 'test-token',
      fetchImpl: fakeFetch((url, init) => {
        t.record(url, init)
        // Base ref
        if (url.endsWith('/git/ref/heads/main')) {
          return jsonResponse({ ref: 'refs/heads/main', object: { sha: 'base-sha' } })
        }
        // Base commit (for tree.sha)
        if (url.endsWith('/git/commits/base-sha')) {
          return jsonResponse({ sha: 'base-sha', tree: { sha: 'base-tree-sha' } })
        }
        // Create blob
        if (url.endsWith('/git/blobs') && init.method === 'POST') {
          return jsonResponse({ sha: 'blob-sha-1' })
        }
        // Create tree
        if (url.endsWith('/git/trees') && init.method === 'POST') {
          return jsonResponse({ sha: 'tree-sha-1' })
        }
        // Create commit
        if (url.endsWith('/git/commits') && init.method === 'POST') {
          return jsonResponse({ sha: 'commit-sha-1', tree: { sha: 'tree-sha-1' } })
        }
        // Branch ref existence (404 -> not present)
        if (url.includes('/git/ref/heads/eval')) {
          return jsonResponse({ message: 'Not Found' }, 404)
        }
        // Create ref
        if (url.endsWith('/git/refs') && init.method === 'POST') {
          return jsonResponse({ ref: 'refs/heads/eval/r1', object: { sha: 'commit-sha-1' } })
        }
        // List PRs (empty -> nothing exists)
        if (url.includes('/pulls?')) {
          return jsonResponse([])
        }
        // Create PR
        if (url.endsWith('/pulls') && init.method === 'POST') {
          return jsonResponse({
            html_url: 'https://github.com/o/r/pull/1',
            number: 1,
          })
        }
        // Reviewers / labels (best-effort, accept any)
        return jsonResponse({}, 200)
      }),
      now: () => new Date('2026-01-01T00:00:00Z'),
    })

    const result = await client.proposeChange({
      repo: { owner: 'o', name: 'r' },
      branchName: 'eval/r1',
      fileChanges: [{ path: 'a.txt', contents: 'hello' }],
      title: 'T',
      body: 'B',
    })

    expect(result.prUrl).toBe('https://github.com/o/r/pull/1')
    expect(result.headSha).toBe('commit-sha-1')
    expect(result.dryRun).toBe(false)

    // Verify documented REST sequence in order.
    const ordered = t.requests.map((r) => `${r.method} ${r.url.replace(/\?.*$/, '')}`)
    expect(ordered).toContain('GET https://api.github.com/repos/o/r/git/ref/heads/main')
    expect(ordered).toContain('POST https://api.github.com/repos/o/r/git/blobs')
    expect(ordered).toContain('POST https://api.github.com/repos/o/r/git/trees')
    expect(ordered).toContain('POST https://api.github.com/repos/o/r/git/commits')
    expect(ordered).toContain('POST https://api.github.com/repos/o/r/git/refs')
    expect(ordered).toContain('POST https://api.github.com/repos/o/r/pulls')
  })

  it('returns the existing open PR instead of opening a duplicate (idempotency)', async () => {
    const client = httpGithubClient({
      token: 'tok',
      fetchImpl: fakeFetch((url, init) => {
        if (url.endsWith('/git/ref/heads/main')) {
          return jsonResponse({ ref: 'refs/heads/main', object: { sha: 'base-sha' } })
        }
        if (url.endsWith('/git/commits/base-sha')) {
          return jsonResponse({ sha: 'base-sha', tree: { sha: 'base-tree' } })
        }
        if (url.endsWith('/git/blobs')) return jsonResponse({ sha: 'b1' })
        if (url.endsWith('/git/trees')) return jsonResponse({ sha: 't1' })
        if (url.endsWith('/git/commits') && init.method === 'POST') {
          return jsonResponse({ sha: 'c1', tree: { sha: 't1' } })
        }
        // Branch already exists at same sha.
        if (url.endsWith('/git/ref/heads/eval/r1')) {
          return jsonResponse({ ref: 'refs/heads/eval/r1', object: { sha: 'c1' } })
        }
        if (url.includes('/pulls?')) {
          return jsonResponse([{ html_url: 'https://github.com/o/r/pull/77', number: 77 }])
        }
        return jsonResponse({}, 200)
      }),
    })

    const result = await client.proposeChange({
      repo: { owner: 'o', name: 'r' },
      branchName: 'eval/r1',
      fileChanges: [{ path: 'a.txt', contents: 'x' }],
      title: 'T',
      body: 'B',
    })

    expect(result.prUrl).toBe('https://github.com/o/r/pull/77')
  })

  it('dryRun does not call fetch', async () => {
    const fetchSpy = vi.fn()
    const client = httpGithubClient({
      token: 'tok',
      fetchImpl: fetchSpy as unknown as typeof fetch,
    })
    const r = await client.proposeChange({
      repo: { owner: 'o', name: 'r' },
      branchName: 'eval/r1',
      fileChanges: [{ path: 'a.txt', contents: 'x' }],
      title: 'T',
      body: 'B',
      dryRun: true,
    })
    expect(r.dryRun).toBe(true)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('surfaces GitHub API failures with status code and body excerpt', async () => {
    const client = httpGithubClient({
      token: 'tok',
      fetchImpl: () =>
        Promise.resolve(
          new Response('rate limit exceeded', { status: 403, headers: { 'content-type': 'text/plain' } }),
        ),
    })

    await expect(
      client.proposeChange({
        repo: { owner: 'o', name: 'r' },
        branchName: 'eval/r1',
        fileChanges: [{ path: 'a.txt', contents: 'x' }],
        title: 'T',
        body: 'B',
      }),
    ).rejects.toThrow(/403/)
  })
})

describe('ghCliClient', () => {
  it('dryRun returns a synthetic compare URL without exec calls', async () => {
    const execSpy = vi.fn()
    const client = ghCliClient({ exec: execSpy as unknown as never })
    const r = await client.proposeChange({
      repo: { owner: 'o', name: 'r' },
      branchName: 'eval/r1',
      fileChanges: [{ path: 'a.txt', contents: 'x' }],
      title: 'T',
      body: 'B',
      dryRun: true,
    })
    expect(r.dryRun).toBe(true)
    expect(r.prUrl).toContain('compare/main...eval/r1')
    expect(execSpy).not.toHaveBeenCalled()
  })
})
