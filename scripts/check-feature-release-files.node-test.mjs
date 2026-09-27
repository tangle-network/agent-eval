import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const guard = fileURLToPath(new URL('./check-feature-release-files.mjs', import.meta.url))
const prepare = fileURLToPath(new URL('./prepare-release.mjs', import.meta.url))
const python = 'clients/python/pyproject.toml'
const runtime = 'clients/python/src/agent_eval_rpc/__init__.py'

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'agent-eval-release-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
  const write = (path, text) => {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), text)
  }
  const versions = (version) => {
    write('package.json', JSON.stringify({ name: 'release-fixture', version }, null, 2) + '\n')
    write(python, '[project]\nversion = "' + version + '"\n')
    write(
      runtime,
      'try:\n    __version__ = version("agent-eval-rpc")\n' +
        'except PackageNotFoundError:\n    __version__ = "' + version + '"\n',
    )
  }
  const commit = (subject) => {
    git('add', '.')
    const tree = git('write-tree')
    const parent = spawnSync('git', ['rev-parse', '--verify', 'HEAD'], {
      cwd: root,
      encoding: 'utf8',
    })
    const object =
      'tree ' + tree + '\n' +
      (parent.status === 0 ? 'parent ' + parent.stdout.trim() + '\n' : '') +
      'author Fixture <fixture@example.invalid> 0 +0000\n' +
      'committer Fixture <fixture@example.invalid> 0 +0000\n\n' +
      subject + '\n'
    const oid = execFileSync('git', ['hash-object', '-t', 'commit', '-w', '--stdin'], {
      cwd: root,
      input: object,
      encoding: 'utf8',
    }).trim()
    git('update-ref', 'HEAD', oid)
  }

  git('init', '-q', '--initial-branch=main')
  versions('1.2.3')
  write('CHANGELOG.md', '# Changelog\n\n---\n\n## Unreleased\n')
  write(
    'clients/python/uv.lock',
    'version = 1\n\n[[package]]\nname = "agent-eval-rpc"\nversion = "1.2.3"\n',
  )
  commit('chore(release): 1.2.3')
  git('tag', 'v1.2.3')
  write('source.txt', 'feature\n')
  commit('feat(core): merged feature')
  git('update-ref', 'refs/remotes/origin/main', 'HEAD')

  const check = (branch, options = {}) =>
    spawnSync(process.execPath, [guard], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        GITHUB_BASE_REF: 'main',
        GITHUB_HEAD_REF: branch,
        GITHUB_EVENT_NAME: 'pull_request',
        GITHUB_ACTOR: options.actor || 'tangletools',
        PR_AUTHOR_LOGIN: options.author || 'tangletools',
      },
    })

  return { root, git, write, versions, commit, check }
}

test('feature PRs accept source changes and reject version or changelog changes', (t) => {
  const f = fixture(t)
  f.git('switch', '-qc', 'feature/example')
  f.write('source.txt', 'next feature\n')
  f.commit('feat(core): next feature')
  assert.equal(f.check('feature/example').status, 0)

  const changelog = readFileSync(join(f.root, 'CHANGELOG.md'), 'utf8')
  f.write('CHANGELOG.md', changelog + '\n## [1.2.4]\n')
  f.commit('docs: unauthorized changelog edit')
  assert.notEqual(f.check('feature/example').status, 0)

  f.write('CHANGELOG.md', changelog)
  f.commit('docs: restore changelog')
  assert.equal(f.check('feature/example').status, 0)

  f.versions('1.2.4')
  f.commit('feat(core): unauthorized version bump')
  assert.notEqual(f.check('feature/example').status, 0)
})

test('Prepare Release output is accepted only from the GitHub bot', (t) => {
  const f = fixture(t)
  f.git('switch', '-qc', 'release/v1.2.4')
  execFileSync(process.execPath, [prepare, '1.2.4'], { cwd: f.root })
  f.commit('chore(release): 1.2.4')

  assert.equal(
    f.check('release/v1.2.4', {
      actor: 'github-actions[bot]',
      author: 'github-actions[bot]',
    }).status,
    0,
  )
  assert.notEqual(
    f.check('release/v1.2.4', {
      actor: 'tangletools',
      author: 'tangletools',
    }).status,
    0,
  )
  assert.notEqual(
    f.check('release/v1.2.4', {
      actor: 'github-actions[bot]',
      author: 'tangletools',
    }).status,
    0,
  )

  f.write(python, '[project]\nversion = "1.2.5"\n')
  f.commit('chore(release): mismatched Python metadata')
  assert.notEqual(
    f.check('release/v1.2.4', {
      actor: 'github-actions[bot]',
      author: 'github-actions[bot]',
    }).status,
    0,
  )
})

test('a feature branch named like a release cannot bypass the guard', (t) => {
  const f = fixture(t)
  f.git('switch', '-qc', 'release/v1.2.4')
  f.versions('1.2.4')
  f.write('CHANGELOG.md', '# Changelog\n\n---\n\n## [1.2.4]\n')
  f.commit('feat(core): spoof release branch')
  assert.notEqual(f.check('release/v1.2.4').status, 0)
})

test('a release on the target branch does not reject an unchanged feature branch', (t) => {
  const f = fixture(t)
  f.git('switch', '-qc', 'feature/example')
  f.write('source.txt', 'next feature\n')
  f.commit('feat(core): next feature')

  f.git('switch', '-q', 'main')
  f.versions('1.2.4')
  f.commit('chore(release): 1.2.4')
  f.git('update-ref', 'refs/remotes/origin/main', 'HEAD')
  f.git('switch', '-q', 'feature/example')

  assert.equal(f.check('feature/example').status, 0)
})
