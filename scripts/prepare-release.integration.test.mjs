import { execFile, execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, expect, test } from 'vitest'

const roots = []
const servers = []
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const name = '@tangle-network/agent-eval'
const versionFiles = [
  'package.json',
  'clients/python/pyproject.toml',
  'clients/python/src/agent_eval_rpc/__init__.py',
  'clients/python/uv.lock',
]
const git = (root, ...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
const write = (root, path, text) => {
  mkdirSync(dirname(join(root, path)), { recursive: true })
  writeFileSync(join(root, path), text)
}
const commit = (root, subject) => {
  git(root, 'add', '.')
  git(root, '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', subject)
  return git(root, 'rev-parse', 'HEAD')
}
const changelog = (version) => `# Changelog\n\n---\n\n## Unreleased\n\n- Keep hand-written notes.\n\n## [${version}] — 2026-11-01\n\n- Prior release.\n`
function cohort(root, version) {
  write(root, versionFiles[0], `${JSON.stringify({ name, version }, null, 2)}\n`)
  write(root, versionFiles[1], `[project]\nname = "agent-eval-rpc"\nversion = "${version}"\n`)
  write(root, versionFiles[2], `try:\n    __version__ = metadata.version("agent-eval-rpc")\nexcept metadata.PackageNotFoundError:\n    __version__ = "${version}"\n`)
  write(root, versionFiles[3], `version = 1\nrevision = 3\n\n[[package]]\nname = "agent-eval-rpc"\nversion = "${version}"\n\n[[package]]\nname = "untouched-dependency"\nversion = "9.8.7"\n`)
}
function repository() {
  const root = mkdtempSync(join(tmpdir(), 'eval-prepare-release-'))
  roots.push(root)
  git(root, 'init', '--quiet', '--initial-branch=main')
  git(root, 'config', 'user.name', 'Release integration')
  git(root, 'config', 'user.email', 'release-integration@example.invalid')
  mkdirSync(join(root, 'scripts'))
  for (const file of ['prepare-release.mjs', 'release-version-fields.mjs']) {
    copyFileSync(new URL(file, import.meta.url), join(root, 'scripts', file))
  }
  cohort(root, '0.9.0')
  write(root, 'CHANGELOG.md', changelog('0.9.0'))
  const old = commit(root, 'chore(release): 0.9.0')
  git(root, 'tag', 'v0.9.0')
  cohort(root, '1.0.0')
  write(root, 'CHANGELOG.md', changelog('1.0.0'))
  const release = commit(root, 'chore(release): 1.0.0')
  write(root, 'already-shipped.txt', 'Included by manual publication after the release commit.\n')
  const published = commit(root, 'fix: already shipped after release preparation')
  write(root, 'new-change.txt', 'Only this change is new.\n')
  const head = commit(root, 'fix: new after publication')
  return { root, old, release, published, head }
}
async function registry(metadata, status = 200) {
  const requests = []
  const server = createServer((request, response) => {
    requests.push(request.url)
    if (request.url !== `/${encodeURIComponent(name)}/1.0.0`) {
      response.writeHead(404).end()
      return
    }
    response.writeHead(status, { 'content-type': 'application/json' })
    response.end(JSON.stringify(metadata))
  })
  servers.push(server)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { origin: `http://127.0.0.1:${server.address().port}`, requests }
}
async function prepare(root, origin) {
  return new Promise((resolve) => {
    execFile(process.execPath, ['--max-old-space-size=64', 'scripts/prepare-release.mjs', '1.0.1'], {
      cwd: root,
      env: { ...process.env, npm_config_registry: origin, NPM_CONFIG_REGISTRY: origin },
      timeout: 15_000,
      maxBuffer: 256 * 1024,
    }, (error, stdout, stderr) => resolve({ code: error?.code ?? 0, stdout, stderr }))
  })
}
function snapshot(root) {
  return {
    files: [...versionFiles, 'CHANGELOG.md'].map((path) => readFileSync(join(root, path), 'utf8')),
    diff: git(root, 'diff', '--binary', 'HEAD'),
    status: git(root, 'status', '--porcelain'),
  }
}

test.each([false, true])('uses actual published source beyond the release commit (exact tag present: %s)', async (tagged) => {
  const { root, release, published } = repository()
  if (tagged) git(root, 'tag', 'v1.0.0', release)
  const { origin, requests } = await registry({ name, version: '1.0.0', gitHead: published })
  const result = await prepare(root, origin)
  expect(result.code, result.stderr).toBe(0)
  expect(requests).toEqual([`/${encodeURIComponent(name)}/1.0.0`])
  const text = readFileSync(join(root, 'CHANGELOG.md'), 'utf8')
  expect(text).toMatch(/^## \[1\.0\.1\] — \d{4}-\d{2}-\d{2}$/m)
  expect(text).toContain('- fix: new after publication')
  expect(text).toContain('- Keep hand-written notes.')
  expect(text).not.toContain('already shipped after release preparation')
  expect(text).not.toContain('chore(release):')
  expect(JSON.parse(readFileSync(join(root, versionFiles[0]), 'utf8')).version).toBe('1.0.1')
  expect(readFileSync(join(root, versionFiles[1]), 'utf8')).toContain('version = "1.0.1"')
  expect(readFileSync(join(root, versionFiles[2]), 'utf8')).toContain('    __version__ = "1.0.1"')
  const lock = readFileSync(join(root, versionFiles[3]), 'utf8')
  expect(lock).toContain('name = "agent-eval-rpc"\nversion = "1.0.1"')
  expect(lock).toContain('name = "untouched-dependency"\nversion = "9.8.7"')
  expect(lock).toMatch(/^version = 1\nrevision = 3\n/)
})

test('uses the exact annotated release tag only when published gitHead is absent', async () => {
  const { root, published } = repository()
  git(root, '-c', 'tag.gpgsign=false', 'tag', '-a', 'v1.0.0', published, '-m', 'Exact published release')
  write(root, 'CHANGELOG.md', changelog('1.0.0').replace('## Unreleased\n\n', ''))
  const { origin } = await registry({ name, version: '1.0.0' })
  const result = await prepare(root, origin)
  expect(result.code, result.stderr).toBe(0)
  const text = readFileSync(join(root, 'CHANGELOG.md'), 'utf8')
  expect(text).toContain('---\n\n## [1.0.1]')
  expect(text).toContain('- fix: new after publication')
  expect(text).toContain('- Keep hand-written notes.')
  expect(text).not.toContain('already shipped after release preparation')
})

test.each([
  ['missing last own-version field', (fixture) => write(fixture.root, versionFiles[3], 'version = 1\n'), /own version field not found/],
  ['inconsistent version cohort', (fixture) => write(fixture.root, versionFiles[1], '[project]\nversion = "1.0.9"\n'), /own version does not match/],
  ['missing changelog insertion point', (fixture) => write(fixture.root, 'CHANGELOG.md', '# Changelog\n'), /needs one Unreleased/],
  ['ambiguous Unreleased headings', (fixture) => write(fixture.root, 'CHANGELOG.md', `${changelog('1.0.0')}\n## Unreleased\n`), /needs one Unreleased/],
  ['already prepared target', (fixture) => write(fixture.root, 'CHANGELOG.md', `${changelog('1.0.0')}\n## [1.0.1] — 2026-11-02\n`), /already contains 1\.0\.1/],
])('does not modify any release file when %s', async (_reason, change, expected) => {
  const fixture = repository()
  change(fixture)
  const before = snapshot(fixture.root)
  const { origin } = await registry({ name, version: '1.0.0', gitHead: fixture.published })
  const result = await prepare(fixture.root, origin)
  expect(result.code).not.toBe(0)
  expect(result.stderr).toMatch(expected)
  expect(snapshot(fixture.root)).toEqual(before)
})

test.each([
  ['registry unavailable despite a tag', (fixture) => ({ metadata: {}, status: 503 }), /registry answered 503/],
  ['registry identity mismatch', (fixture) => ({ metadata: { name, version: '0.9.0', gitHead: fixture.published } }), /registry identity does not match/],
  ['invalid gitHead despite a tag', () => ({ metadata: { name, version: '1.0.0', gitHead: 'HEAD' } }), /invalid gitHead/],
  ['published source version mismatch', (fixture) => ({ metadata: { name, version: '1.0.0', gitHead: fixture.old } }), /does not contain/],
  ['no commits after publication', (fixture) => ({ metadata: { name, version: '1.0.0', gitHead: fixture.head } }), /no commits since published/],
])('refuses %s before any release edit', async (_reason, publication, expected) => {
  const fixture = repository()
  git(fixture.root, 'tag', 'v1.0.0', fixture.published)
  const before = snapshot(fixture.root)
  const { metadata, status } = publication(fixture)
  const { origin } = await registry(metadata, status)
  const result = await prepare(fixture.root, origin)
  expect(result.code).not.toBe(0)
  expect(result.stderr).toMatch(expected)
  expect(snapshot(fixture.root)).toEqual(before)
})

test('refuses a stale tag when publication has no exact source identity', async () => {
  const { root } = repository()
  const before = snapshot(root)
  const { origin } = await registry({ name, version: '1.0.0' })
  const result = await prepare(root, origin)
  expect(result.code).not.toBe(0)
  expect(result.stderr).toContain('refs/tags/v1.0.0')
  expect(snapshot(root)).toEqual(before)
})

test('refuses published source from another branch instead of ranging from an older tag', async () => {
  const { root, release, published } = repository()
  git(root, 'checkout', '--quiet', '-b', 'different-publication', release)
  write(root, 'other-branch.txt', 'Not part of main.\n')
  const different = commit(root, 'fix: published from another branch')
  git(root, 'checkout', '--quiet', 'main')
  git(root, 'tag', 'v1.0.0', published)
  const before = snapshot(root)
  const { origin } = await registry({ name, version: '1.0.0', gitHead: different })
  const result = await prepare(root, origin)
  expect(result.code).not.toBe(0)
  expect(result.stderr).toContain('merge-base --is-ancestor')
  expect(snapshot(root)).toEqual(before)
})
