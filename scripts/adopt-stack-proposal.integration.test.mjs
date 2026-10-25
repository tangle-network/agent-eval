import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { afterEach, describe, expect, test } from 'vitest'
import { ADOPTION_BRANCH as owned, isManuallyHeldDraft, mergeWhenApproved, readPushedProposal, UPDATER_DRAFT_MARKER } from './adopt-stack.mjs'

const active = []
// Only fixture Git children opt into the supported test identity; normal hooks stay enabled.
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_ALLOW_TEST_IDENTITY: '1', GIT_AUTHOR_NAME: 'adopt-test', GIT_AUTHOR_EMAIL: 'adopt-test@example.invalid', GIT_COMMITTER_NAME: 'adopt-test', GIT_COMMITTER_EMAIL: 'adopt-test@example.invalid' } }).trim()

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'adopt-proposal-http-'))
  const remote = join(root, 'remote.git')
  const author = join(root, 'author')
  const caller = join(root, 'caller')
  mkdirSync(author)
  git(root, 'init', '-q', '--bare', '-b', 'main', remote)
  git(author, 'init', '-q', '-b', 'main')
  // Disposable commits retain the declared fixture identity and normal hooks.
  writeFileSync(join(author, 'source.txt'), 'captured default\n')
  git(author, 'add', '.')
  git(author, 'commit', '-qm', 'test: seed captured default')
  git(author, 'remote', 'add', 'origin', remote)
  git(author, 'push', '-q', 'origin', 'main')
  const base = git(author, 'rev-parse', 'HEAD')
  git(author, 'switch', '-qc', owned)
  writeFileSync(join(author, 'proposal.txt'), 'gated bytes\n')
  git(author, 'add', '.')
  git(author, 'commit', '-qm', 'test: retain gated proposal')
  git(author, 'push', '-q', 'origin', owned)
  const head = git(author, 'rev-parse', 'HEAD')
  git(root, 'clone', '-q', '--branch', owned, remote, caller)
  const requests = []
  const state = { head, draft: false, body: '', onRead: undefined }
  const payload = (sha = state.head) => ({ state: 'open', head: { sha, ref: owned }, base: { ref: 'main' }, draft: state.draft, body: state.body })
  const server = createServer(async (req, res) => {
    requests.push({ method: req.method, url: req.url })
    if (req.method !== 'GET' || req.url !== '/repos/fixture/app/pulls/7') { res.writeHead(405).end(); return }
    const value = state.onRead ? await state.onRead(requests.length) : payload()
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(value))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${server.address().port}/repos/fixture/app/pulls/7`
  const read = async ({ signal } = {}) => {
    const response = await fetch(url, { signal })
    expect(response.status).toBe(200)
    return response.json()
  }
  const advance = (branch = owned) => {
    git(author, 'switch', '-q', branch)
    writeFileSync(join(author, branch === owned ? 'proposal.txt' : 'source.txt'), 'competing bytes\n')
    git(author, 'add', '.')
    git(author, 'commit', '-qm', 'test: advance independent writer')
    git(author, 'push', '-q', 'origin', branch)
    return git(author, 'rev-parse', 'HEAD')
  }
  const f = { root, remote, author, caller, base, head, requests, state, payload, read, advance, server }
  active.push(f)
  return f
}

afterEach(async () => {
  for (const f of active.splice(0)) {
    f.server.closeAllConnections()
    await new Promise((resolve) => f.server.close(resolve))
    rmSync(f.root, { recursive: true, force: true })
  }
})

describe('adopt-stack pushed head across real Git and HTTP PR reads', () => {
  test('a lagging PR view settles only while the authoritative pushed branch remains exact', async () => {
    const f = await fixture()
    f.state.onRead = (n) => f.payload(n < 3 ? f.base : f.head)
    // Optional incident calibration executes the retained pre-fix guard, not a rewritten imitation.
    // The same real Git ref and HTTP sample then exercise the fixed maintained seam.
    if (process.env.ADOPT_STACK_BASELINE_REF) {
      const source = git(process.cwd(), 'show', `${process.env.ADOPT_STACK_BASELINE_REF}:scripts/adopt-stack.mjs`)
      const guard = source.split('\n').find((line) => line.includes('if (previous && previous.headRefOid !== head) throw'))
      expect(guard).toBeTruthy()
      const raw = await f.read()
      const remote = git(f.caller, 'ls-remote', 'origin', `refs/heads/${owned}`).split(/\s/)[0]
      expect(remote).toBe(f.head)
      expect(() => runInNewContext(guard, { previous: { headRefOid: raw.head.sha }, head: f.head, open: { number: 7 } }, { timeout: 1000 })).toThrow('moved after the gate')
      console.log(`BASELINE_RED stableRemote=${remote} prHead=${raw.head.sha}`)
    }
    const proposal = await readPushedProposal(f.caller, 7, f.head, 'main', f.read)
    expect(proposal.headRefOid).toBe(f.head)
    expect(git(f.caller, 'rev-parse', 'HEAD')).toBe(f.head)
    expect(git(f.caller, 'show', 'HEAD:proposal.txt')).toBe('gated bytes')
    expect(f.requests.every((r) => r.method === 'GET')).toBe(true)
    console.log(`FIXED_GREEN stableRemote=${f.head} settledPr=${proposal.headRefOid} reads=${f.requests.length}`)
  }, 30_000)

  test('true branch movement before or during an API read refuses without metadata writes', async () => {
    const f = await fixture()
    const moved = f.advance()
    await expect(readPushedProposal(f.caller, 7, f.head, 'main', f.read)).rejects.toThrow(`observed ${moved}`)
    expect(f.requests).toHaveLength(0)
    // A second independently pushed generation moves while its PR response is in flight.
    const expected = moved
    let competing
    f.state.onRead = () => { competing = f.advance(); return f.payload(expected) }
    // Make the second commit distinct from the first without changing the captured caller.
    writeFileSync(join(f.author, 'concurrent.txt'), 'independent live writer\n')
    await expect(readPushedProposal(f.caller, 7, expected, 'main', f.read)).rejects.toThrow('authoritative branch expected')
    expect(competing).not.toBe(expected)
    expect(f.requests).toHaveLength(1)
    expect(f.requests[0].method).toBe('GET')
    expect(git(f.caller, 'rev-parse', 'HEAD')).toBe(f.head)
  }, 30_000)

  test('missing remote ref refuses as unknown rather than settling an API value', async () => {
    const f = await fixture()
    git(f.author, 'push', '-q', 'origin', '--delete', owned)
    await expect(readPushedProposal(f.caller, 7, f.head, 'main', f.read)).rejects.toThrow('authoritative proposal ref is unknown')
    expect(f.requests).toHaveLength(0)
  }, 30_000)

  test('unsettled PR state exhausts the bounded reads and never mutates it', async () => {
    const f = await fixture()
    f.state.head = f.base
    const started = Date.now()
    await expect(readPushedProposal(f.caller, 7, f.head, 'main', f.read)).rejects.toThrow(`last PR ${f.base}`)
    expect(f.requests).toHaveLength(6)
    expect(Date.now() - started).toBeLessThan(30_000)
    expect(f.requests.every((r) => r.method === 'GET')).toBe(true)
  }, 35_000)

  test('legacy and newly manual draft holds survive the HTTP settlement; explicit updater ownership remains distinct', async () => {
    const f = await fixture()
    f.state.draft = true
    f.state.body = '<!-- adopt-stack:plan=legacy result=gate-fail -->'
    const legacy = await readPushedProposal(f.caller, 7, f.head, 'main', f.read)
    expect(isManuallyHeldDraft(legacy, legacy)).toBe(true)
    const ownedDraft = { isDraft: true, body: UPDATER_DRAFT_MARKER }
    f.state.body = UPDATER_DRAFT_MARKER
    const ownedRead = await readPushedProposal(f.caller, 7, f.head, 'main', f.read)
    expect(isManuallyHeldDraft(ownedDraft, ownedRead)).toBe(false)
    f.state.body = 'Maintainer hold: current acceptance remains pending.'
    const manual = await readPushedProposal(f.caller, 7, f.head, 'main', f.read)
    expect(isManuallyHeldDraft(ownedDraft, manual)).toBe(true)
    expect(isManuallyHeldDraft({ isDraft: false, body: '' }, manual)).toBe(true)
    expect(f.requests.every((r) => r.method === 'GET')).toBe(true)
    expect(f.state.draft).toBe(true)
    expect(f.state.body).toContain('Maintainer hold')
  }, 30_000)

  test('a changed captured default still refuses before any merge API command', async () => {
    const f = await fixture()
    await readPushedProposal(f.caller, 7, f.head, 'main', f.read)
    const moved = f.advance('main')
    expect(await mergeWhenApproved(f.caller, 7, f.head, f.base, 'main')).toEqual({ moved })
    expect(git(f.caller, 'rev-parse', 'HEAD')).toBe(f.head)
    expect(git(f.caller, 'show', 'HEAD:source.txt')).toBe('captured default')
    expect(f.requests).toHaveLength(1)
    expect(f.requests[0].method).toBe('GET')
  }, 30_000)
})
