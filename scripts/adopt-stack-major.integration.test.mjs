import { execFile, execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { createServer as createTlsServer } from 'node:https'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterEach, expect, test } from 'vitest'
import { ADOPTION_BRANCH, satisfies, UPDATER_DRAFT_MARKER } from './adopt-stack.mjs'

const execute = promisify(execFile)
const script = join(dirname(fileURLToPath(import.meta.url)), 'adopt-stack.mjs')
const name = '@tangle-network/adopt-major-integration'
const target = '3.2.1'
const active = []
const identity = { GIT_ALLOW_TEST_IDENTITY: '1', GIT_AUTHOR_NAME: 'adopt-test', GIT_AUTHOR_EMAIL: 'adopt-test@example.invalid', GIT_COMMITTER_NAME: 'adopt-test', GIT_COMMITTER_EMAIL: 'adopt-test@example.invalid' }
const git = (cwd, ...args) => execFileSync('git', args, { cwd, env: { ...process.env, ...identity }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const save = (root, file, value) => { const path = join(root, file); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n') }
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const close = server => new Promise(resolve => { server.closeAllConnections(); server.close(resolve) })

// Native gh's typed decoder requires the GraphQL response selection, including aliases/fragments.
function selectedReply(query, data) {
  const tokens = query.match(/\.\.\.|"(?:\\.|[^"\\])*"|[_A-Za-z][_0-9A-Za-z]*|[{}():@]/g) ?? []
  const fragments = new Map()
  let at = 0
  const modifiers = () => {
    while (tokens[at] === '(' || tokens[at] === '@') {
      if (tokens[at] === '@') at += 2
      if (tokens[at] !== '(') continue
      let depth = 1; at++
      while (at < tokens.length && depth) { const token = tokens[at++]; depth += token === '(' ? 1 : token === ')' ? -1 : 0 }
    }
  }
  const selection = () => {
    at++
    const fields = []
    while (at < tokens.length && tokens[at] !== '}') {
      let field = tokens[at++], response = field
      if (field === '...') {
        const spread = tokens[at++]
        if (spread === 'on') { at++; modifiers(); fields.push({ children: selection() }) }
        else { modifiers(); fields.push({ spread }) }
        continue
      }
      if (tokens[at] === ':') { at++; field = tokens[at++] }
      modifiers()
      fields.push({ field, response, children: tokens[at] === '{' ? selection() : undefined })
    }
    at++
    return fields
  }
  let fields = []
  while (at < tokens.length) {
    if (tokens[at] === 'fragment') {
      at++; const name = tokens[at++]; at += 2; modifiers(); fragments.set(name, selection())
    } else {
      if (tokens[at] !== '{') { at++; if (tokens[at] !== '(' && tokens[at] !== '{') at++; modifiers() }
      fields = selection()
    }
  }
  const project = (fields, value) => {
    if (value == null) return null
    if (Array.isArray(value)) return value.map(row => project(fields, row))
    const result = {}
    for (const { field, response, children, spread } of fields) {
      if (spread || !field) Object.assign(result, project(spread ? fragments.get(spread) ?? [] : children, value))
      else result[response] = children ? project(children, value[field]) : value[field] ?? null
    }
    return result
  }
  return { data: project(fields, data) }
}

async function fixture(acceptsMajor, peerOnly, manager = 'npm', alreadyAdmits = false) {
  const root = mkdtempSync(join(tmpdir(), 'adopt-major-cli-'))
  const author = join(root, 'author'), caller = join(root, 'caller'), remote = join(root, 'remote.git')
  mkdirSync(author)
  const cleanup = { root, servers: [], sockets: [] }; active.push(cleanup)
  const requests = [], tarballs = new Map()
  for (const version of ['1.0.0', target]) {
    const source = join(root, version)
    save(source, 'package.json', { name, version, type: 'module', exports: './index.js' })
    const api = version === '1.0.0' ? "export const oldApi = () => 'old';\n" : `export const candidateApi = () => '${target}';\n`
    save(source, 'index.js', api + "export const stableApi = () => 'compatible';\n")
    const packed = JSON.parse(execFileSync('npm', ['pack', '--json'], { cwd: source, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }))[0]
    tarballs.set(version, readFileSync(join(source, packed.filename)))
  }
  let registryUrl
  const registry = createServer((req, res) => {
    const path = decodeURIComponent(new URL(req.url, 'http://fixture').pathname)
    const tar = /^\/tar\/(.+)\.tgz$/.exec(path)
    if (tar) { requests.push({ kind: 'tarball', version: tar[1] }); res.writeHead(200).end(tarballs.get(tar[1])); return }
    if (req.method === 'POST') { res.writeHead(200, { 'content-type': 'application/json' }).end('{}'); return }
    if (path !== `/${name}`) { res.writeHead(404).end(); return }
    requests.push({ kind: 'registry' })
    const versions = Object.fromEntries([...tarballs].map(([version, bytes]) => [version, { name, version, dist: { tarball: `${registryUrl}/tar/${version}.tgz`, integrity: 'sha512-' + createHash('sha512').update(bytes).digest('base64') } }]))
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ name, 'dist-tags': { latest: target }, versions }))
  })
  cleanup.servers.push(registry)
  await listen(registry)
  registryUrl = `http://127.0.0.1:${registry.address().port}`
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(root, 'key.pem'), '-out', join(root, 'cert.pem'), '-days', '1', '-subj', '/CN=fixture.test', '-addext', 'subjectAltName=DNS:fixture.test'], { stdio: 'ignore' })
  git(root, 'init', '-q', '--bare', '-b', 'main', remote)
  git(remote, 'config', 'http.receivepack', 'true')
  git(author, 'init', '-q', '-b', 'main')
  save(author, '.npmrc', `registry=${registryUrl}\n@tangle-network:registry=${registryUrl}\naudit=false\nfund=false\n`)
  save(author, '.gitignore', 'node_modules/\ngate-receipt.json\n')
  save(author, 'package.json', { name: 'major-caller', private: true, type: 'module', ...(!peerOnly ? { devDependencies: { [name]: '^1.0.0' } } : {}), peerDependencies: { [name]: '^1.0.0' } })
  save(author, 'tests/check.mjs', `import { ${peerOnly ? 'stableApi' : acceptsMajor ? 'candidateApi' : 'oldApi'} as api } from '${name}'; import { writeFileSync } from 'node:fs'; import { execFileSync } from 'node:child_process'; import assert from 'node:assert/strict'; execFileSync('git', ['diff', '--quiet', 'HEAD', '--']); const actual=api(); assert.equal(actual, '${peerOnly ? 'compatible' : target}'); writeFileSync('gate-receipt.json', JSON.stringify({ actual }));\n`)
  save(author, 'tests/sync.mjs', "import {readFileSync,writeFileSync}from'node:fs';writeFileSync('synced.json',JSON.stringify((p=>p.devDependencies??p.peerDependencies)(JSON.parse(readFileSync('package.json','utf8')))));\n")
  await execute(manager, ['install', manager === 'npm' ? '--package-lock-only' : '--lockfile-only'], { cwd: author, env: { ...process.env, npm_config_registry: registryUrl, npm_config_audit: 'false', npm_config_fund: 'false' } })
  if (alreadyAdmits) { const pkg = JSON.parse(readFileSync(join(author, 'package.json'), 'utf8')); pkg.peerDependencies[name] += ` || ^${target}`; save(author, 'package.json', pkg); await execute(manager, ['install', manager === 'npm' ? '--package-lock-only' : '--lockfile-only'], { cwd: author }) }
  git(author, 'add', '.')
  git(author, 'commit', '-qm', 'test: seed captured caller')
  git(author, 'remote', 'add', 'origin', remote)
  git(author, 'push', '-q', 'origin', 'main')
  const base = git(author, 'rev-parse', 'HEAD')
  git(root, 'clone', '-q', remote, caller)
  let host
  const state = { pr: undefined, comments: [], merged: false, mergeHead: undefined }
  const head = () => state.merged ? state.mergeHead : git(remote, 'rev-parse', `refs/heads/${ADOPTION_BRANCH}`)
  const graphPr = () => state.pr && {
    ...state.pr, id: 'PR_7', number: 7, url: `https://${host}/fixture/app/pull/7`,
    headRefOid: head(), headRefName: ADOPTION_BRANCH, baseRefName: 'main', baseRefOid: base,
    state: state.merged ? 'MERGED' : 'OPEN', isCrossRepository: false,
    reviewDecision: 'APPROVED', mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN',
    headRepositoryOwner: { login: 'fixture' },
    headRepository: { name: 'app', nameWithOwner: 'fixture/app', owner: { login: 'fixture' } },
    mergeCommit: state.merged ? { oid: git(remote, 'rev-parse', 'refs/heads/main') } : null,
    mergedAt: state.mergedAt ?? null,
  }
  const merge = expected => {
    if (expected !== head()) throw new Error('merge did not carry the exact gated head')
    state.mergeHead = expected
    git(author, 'fetch', '-q', 'origin', ADOPTION_BRANCH)
    git(author, 'merge', '--squash', 'FETCH_HEAD')
    git(author, 'commit', '-qm', 'test: accept gated major candidate')
    git(author, 'push', '-q', 'origin', 'main')
    state.merged = true
    state.mergedAt = new Date().toISOString()
  }
  const deleteBranch = () => git(author, 'push', '-q', 'origin', '--delete', ADOPTION_BRANCH)
  const github = createTlsServer({ key: readFileSync(join(root, 'key.pem')), cert: readFileSync(join(root, 'cert.pem')) }, async (req, res) => {
    try {
      const chunks = []; for await (const chunk of req) chunks.push(chunk)
      const raw = Buffer.concat(chunks)
      if (req.url.startsWith('/fixture/app.git/')) {
        const url = new URL(req.url, 'https://fixture')
        const child = spawn('git', ['http-backend'], { stdio: [raw.length ? 'pipe' : 'ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_PROJECT_ROOT: root, GIT_HTTP_EXPORT_ALL: '1', PATH_INFO: '/remote.git' + url.pathname.slice('/fixture/app.git'.length), QUERY_STRING: url.search.slice(1), REQUEST_METHOD: req.method, CONTENT_TYPE: req.headers['content-type'] ?? '', CONTENT_LENGTH: String(raw.length), HTTP_CONTENT_ENCODING: req.headers['content-encoding'] ?? '', REMOTE_USER: 'fixture' } })
        const output = []; let stderr = ''
        child.stdout.on('data', chunk => output.push(chunk)); child.stderr.on('data', chunk => { stderr += chunk })
        const ended = new Promise((resolve, reject) => { child.once('error', reject); child.stdin?.once('error', reject); child.once('close', code => code ? reject(new Error(stderr)) : resolve()) })
        child.stdin?.end(raw); await ended
        const bytes = Buffer.concat(output), split = bytes.indexOf('\r\n\r\n')
        if (split < 0) throw new Error('git http-backend omitted CGI headers')
        const headers = Object.fromEntries(bytes.subarray(0, split).toString().split('\r\n').map(line => { const colon = line.indexOf(':'); return [line.slice(0, colon).toLowerCase(), line.slice(colon + 1).trim()] }))
        const status = Number(headers.status?.split(' ')[0] ?? 200); delete headers.status
        res.writeHead(status, headers).end(bytes.subarray(split + 4)); return
      }
      const body = raw.length ? JSON.parse(raw.toString()) : {}
      const reply = value => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(value))
      if (/\/pulls\/7$/.test(req.url)) {
        requests.push({ kind: 'pull-read' })
        return reply({ state: 'open', head: { sha: head(), ref: ADOPTION_BRANCH }, base: { ref: 'main' }, draft: state.pr.isDraft, body: state.pr.body })
      }
      if (req.method === 'DELETE' && req.url.includes('/git/refs/heads/')) { deleteBranch(); res.writeHead(204).end(); return }
      const query = body.query ?? '', input = body.variables?.input ?? {}
      requests.push({ kind: 'graphql', operation: body.operationName ?? query.match(/(?:query|mutation)\s+(\w+)/)?.[1], query, merge: query.includes('mergePullRequest') })
      let mutation = {}
      if (query.includes('createPullRequest(')) { if (input.repositoryId !== 'REPO_fixture' || input.baseRefName !== 'main' || input.headRefName.replace(/^fixture:/, '') !== ADOPTION_BRANCH) throw new Error('proposal escaped its owned repository/head/base'); state.pr = { title: input.title, body: input.body, isDraft: input.draft ?? false }; mutation = { createPullRequest: { pullRequest: graphPr() } } }
      else if (query.includes('updatePullRequest(')) { Object.assign(state.pr, input); mutation = { updatePullRequest: { pullRequest: graphPr() } } }
      else if (query.includes('markPullRequestReadyForReview(')) { state.pr.isDraft = false; mutation = { markPullRequestReadyForReview: { pullRequest: graphPr() } } }
      else if (query.includes('convertPullRequestToDraft(')) { state.pr.isDraft = true; mutation = { convertPullRequestToDraft: { pullRequest: graphPr() } } }
      else if (query.includes('addComment(')) { state.comments.push(input.body); mutation = { addComment: { subject: { id: 'PR_7' }, commentEdge: { node: { url: `https://${host}/fixture/app/pull/7#comment` } } } } }
      else if (query.includes('mergePullRequest(')) { merge(input.expectedHeadOid); mutation = { mergePullRequest: { clientMutationId: input.clientMutationId ?? null } } }
      else if (query.includes('deleteRef(')) { deleteBranch(); mutation = { deleteRef: { clientMutationId: null } } }
      const pr = graphPr()
      reply(selectedReply(query, {
        viewer: { login: 'fixture' },
        repository: {
          id: 'REPO_fixture', databaseId: 1, sshUrl: `file://${remote}`, description: 'Offline fixture', hasWikiEnabled: false, parent: null, name: 'app', nameWithOwner: 'fixture/app', owner: { login: 'fixture' },
          url: `https://${host}/fixture/app`, isPrivate: true, defaultBranchRef: { name: 'main' },
          ref: { id: 'REF_owned', name: ADOPTION_BRANCH }, viewerPermission: 'ADMIN', hasIssuesEnabled: true,
          squashMergeAllowed: true, mergeCommitAllowed: true, rebaseMergeAllowed: true,
          pullRequests: { totalCount: pr ? 1 : 0, nodes: pr ? [pr] : [], pageInfo: { hasNextPage: false } }, pullRequest: pr,
        }, ...mutation,
      }))
    } catch (error) { requests.push({ kind: 'peer-failure', error: String(error) }); res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ message: String(error) })) }
  })
  cleanup.servers.push(github)
  await listen(github)
  host = 'fixture.test'
  // gh normalizes remote URLs with Hostname(), so the API identity must omit the ephemeral port.
  const proxy = createServer((req, res) => res.writeHead(502).end())
  proxy.on('connect', (req, client, head) => {
    if (req.url !== `${host}:443`) { client.destroy(); return }
    const upstream = connect(github.address().port, '127.0.0.1', () => { client.write('HTTP/1.1 200 Connection Established\r\n\r\n'); if (head.length) upstream.write(head); client.pipe(upstream); upstream.pipe(client) })
    cleanup.sockets.push(client, upstream)
    client.on('error', () => upstream.destroy()); upstream.on('error', () => client.destroy())
    client.on('close', () => upstream.destroy()); upstream.on('close', () => client.destroy())
  })
  cleanup.servers.push(proxy); await listen(proxy)
  const proxyUrl = `http://127.0.0.1:${proxy.address().port}`
  git(caller, 'remote', 'set-url', 'origin', `https://${host}/fixture/app.git`)
  const bin = join(root, 'bin'); mkdirSync(bin)
  // Native gh speaks the real TLS protocol; no command-response shim is involved.
  symlinkSync('/usr/bin/gh', join(bin, 'gh'))
  const env = { ...identity, PATH: `${bin}:${process.env.PATH}`, HOME: process.env.HOME, LANG: 'C.UTF-8', GIT_ALLOW_TEST_IDENTITY: '1', GH_CONFIG_DIR: join(root, 'gh-config'), GH_HOST: host, GH_REPO: 'fixture/app', GH_TOKEN: 'offline-not-a-secret', GH_ENTERPRISE_TOKEN: 'offline-not-a-secret', SSL_CERT_FILE: join(root, 'cert.pem'), GIT_SSL_CAINFO: join(root, 'cert.pem'), GIT_TERMINAL_PROMPT: '0', HTTPS_PROXY: proxyUrl, https_proxy: proxyUrl, NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost', npm_config_registry: registryUrl, npm_config_audit: 'false', npm_config_fund: 'false', NO_COLOR: '1' }
  return { root, caller, remote, base, state, requests, env, run: async () => execute(process.execPath, [script, '--dir', caller, '--packages', name, '--gate', 'node tests/check.mjs', '--post-pin', 'node tests/sync.mjs', '--merge'], { env, timeout: 30_000, maxBuffer: 2 * 1024 * 1024 }).then(value => ({ code: 0, ...value }), error => ({ code: error.code, stdout: error.stdout, stderr: error.stderr })) }
}

afterEach(async () => {
  for (const f of active.splice(0)) {
    for (const socket of f.sockets) socket.destroy()
    for (const server of f.servers.reverse()) if (server.listening) await close(server)
    rmSync(f.root, { recursive: true, force: true })
  }
})

test.each([[true, false, 'npm', false], [false, false, 'npm', false], [true, true, 'npm', false], [true, true, 'pnpm', false], [true, true, 'npm', true]])('stable major candidate follows the real caller gate and PR outcome (gate accepts: %s, peer only: %s, manager: %s, already admits: %s)', async (acceptsMajor, peerOnly, manager, alreadyAdmits) => {
  const f = await fixture(acceptsMajor, peerOnly, manager, alreadyAdmits)
    const result = await f.run()
    expect(result.stderr).not.toContain('widen it by hand')
    if (result.code !== (acceptsMajor ? 0 : 1) || !f.state.pr) console.log('ADOPT_MAJOR_HTTP=' + JSON.stringify({requests:f.requests,comments:f.state.comments,merged:f.state.merged}))
    expect(result.code, result.stdout + result.stderr).toBe(acceptsMajor ? 0 : 1)
    if (!acceptsMajor) expect(result.stderr).toContain('failed its gate')
    expect(f.requests.some(row => row.kind === 'peer-failure'), JSON.stringify(f.requests)).toBe(false)
    expect(f.state.pr, 'the locked candidate must reach the caller gate and owned proposal').toBeDefined()
    const proposal = f.state.mergeHead ?? git(f.remote, 'rev-parse', `refs/heads/${ADOPTION_BRANCH}`)
    const pkg = JSON.parse(git(f.remote, 'show', `${proposal}:package.json`))
    expect(pkg.devDependencies?.[name]).toBe(peerOnly ? undefined : `^${target}`)
    expect(pkg.peerDependencies[name]).toBe(`^1.0.0 || ^${target}`)
    expect(satisfies('2.0.0', pkg.peerDependencies[name])).toBe(false)
    expect(satisfies('3.0.0', pkg.peerDependencies[name])).toBe(false)
    expect(JSON.parse(readFileSync(join(f.caller, 'node_modules', name, 'package.json'), 'utf8')).version).toBe(target)
    expect(JSON.parse(git(f.remote, 'show', `${proposal}:synced.json`))[name]).toBe(peerOnly ? `^1.0.0 || ^${target}` : `^${target}`)
    expect(f.state.pr.body).toContain(acceptsMajor ? 'result=pass' : 'result=gate-fail')
    expect(f.state.pr.body).toContain(proposal.slice(0, 12))
    if (acceptsMajor) {
      expect(f.state.merged).toBe(true)
      expect(f.state.mergeHead).toBe(proposal)
      expect(JSON.parse(readFileSync(join(f.caller, 'gate-receipt.json'), 'utf8'))).toEqual({ actual: peerOnly ? 'compatible' : target })
      expect(git(f.remote, 'rev-parse', 'refs/heads/main^{tree}')).toBe(git(f.remote, 'rev-parse', `${proposal}^{tree}`))
      expect(f.state.pr.isDraft).toBe(false)
    } else {
      expect(f.state.pr.isDraft).toBe(true)
      expect(f.state.pr.body).toContain(UPDATER_DRAFT_MARKER)
      expect(f.state.comments.some(comment => comment.includes('failed'))).toBe(true)
      expect(f.state.merged).toBe(false)
      expect(git(f.remote, 'rev-parse', 'refs/heads/main')).toBe(f.base)
      expect(existsSync(join(f.caller, 'gate-receipt.json'))).toBe(false)
    }
}, 60_000)
