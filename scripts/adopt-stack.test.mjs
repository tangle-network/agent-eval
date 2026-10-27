import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'
import { mergeWhenApproved, plan, prepareBranch, satisfies, writePlan } from './adopt-stack.mjs'
import { installedVersion, resolvedVersions } from './adopt-stack-workspace.mjs'

// Recorded package.json files: agent-knowledge at b18171b08fb3 and agent-app at
// 56dc110cfff7, the two manifests whose peer ranges parked deliveries on
// 2026-10-21. The plan runs against the real npm registry, so every assertion
// is relative to the latest version fetched here, never a hard-coded one.
const here = dirname(fileURLToPath(import.meta.url))
const fixtures = join(here, '..', 'tests', 'fixtures', 'adopt-stack')
const script = join(here, 'adopt-stack.mjs')

async function latest(name) {
  const response = await fetch(`https://registry.npmjs.org/${name.replace('/', '%2f')}/latest`)
  expect(response.ok, `npm answered ${response.status} for ${name}`).toBe(true)
  return (await response.json()).version
}

// The tool widens a 0.x peer range to the 0.m.x release it pinned, and refuses a
// range that excludes a new major release, leaving it to a person. The recorded
// manifests hold 0.x peer ranges, so each package that reaches 1.0 turns that
// peer's widening case into the refusal. The registry decides which case a run
// is in: a refusal must be explained by a peer whose latest release is a major
// its range excludes, and any other run must produce the plan.
async function excludedMajorPeer(pkg) {
  for (const [name, range] of Object.entries(pkg.peerDependencies ?? {})) {
    if (!name.startsWith('@tangle-network/')) continue
    const version = await latest(name)
    if (Number(version.split('.')[0]) > 0 && !satisfies(version, range)) return { name, version }
  }
  return undefined
}

async function dryRun(fixture, name, ...extra) {
  const manifest = join(fixtures, fixture, 'package.json')
  const before = readFileSync(manifest, 'utf8')
  const pkg = JSON.parse(before)
  const result = spawnSync(process.execPath, [script, '--dir', join(fixtures, fixture), '--dry-run', '--json', ...extra], { encoding: 'utf8' })
  expect(readFileSync(manifest, 'utf8')).toBe(before)
  if (result.status !== 0) {
    expect(result.stderr).toMatch(/excludes \d+\.\d+\.\d+, a new major release; widen it by hand/)
    expect(result.stdout).not.toMatch(/dry run: would open/)
    expect(await excludedMajorPeer(pkg), `${result.stderr}`).toBeDefined()
    return { pkg, refused: true }
  }
  return { version: await latest(name), pkg, plan: JSON.parse(result.stdout) }
}

function expectAdopted(plan, pkg, name, version) {
  const pin = plan.edits.find((edit) => edit.name === name && edit.section === 'devDependencies')
  expect(pin?.from).toBe(pkg.devDependencies[name])
  const held = plan.packages.find((entry) => entry.name === name)
  // The pin reaches npm latest unless another adopted release's peer range holds it.
  expect(pin?.to).toBe(held.target)
  if (held.target !== version) expect(held.why).toMatch(/^held by peer ranges: /)

  // The peer widens to the version pinned, so it never claims more than the gate ran.
  const peer = plan.edits.find((edit) => edit.name === name && edit.section === 'peerDependencies')
  const before = pkg.peerDependencies[name]
  expect(satisfies(held.target, before)).toBe(false)
  expect(peer?.from).toBe(before)
  expect(satisfies(held.target, peer.to)).toBe(true)
  // Only the last alternative's upper bound moves, to <0.(m+1).0; every lower bound stays.
  const alternatives = before.split('||').map((part) => part.trim())
  const lower = /^>=(\S+)/.exec(alternatives.at(-1))[1]
  const minor = Number(held.target.split('.')[1])
  expect(peer.to).toBe([...alternatives.slice(0, -1), `>=${lower} <0.${minor + 1}.0`].join(' || '))
}

describe('adopt-stack --dry-run against npm', () => {
  test('agent-knowledge adopts agent-eval latest and widens its agent-eval peer', async () => {
    const { version, plan, pkg, refused } = await dryRun('agent-knowledge', '@tangle-network/agent-eval')
    if (!refused) expectAdopted(plan, pkg, '@tangle-network/agent-eval', version)
  }, 60_000)

  test('agent-app adopts agent-runtime latest and widens its agent-runtime peer', async () => {
    const { version, plan, pkg, refused } = await dryRun('agent-app', '@tangle-network/agent-runtime')
    if (refused) return
    expectAdopted(plan, pkg, '@tangle-network/agent-runtime', version)
    // Alias pins such as agent-eval-0204 (npm:@tangle-network/agent-eval@0.204.0) stay as written.
    expect(plan.edits.some((edit) => !edit.name.startsWith('@tangle-network/'))).toBe(false)
  }, 60_000)

  // These two run on a manifest with no 0.x peer, so the plan builds whatever the
  // registry's latest majors are.
  test('a post-pin command sees the pinned manifest and its second file joins the plan', async () => {
    const brand = '@tangle-network/brand'
    // Like agent-app's template pins: a second file derived from the adopted pins.
    const sync = `node -e "const p = require('./package.json'); require('node:fs').mkdirSync('template', { recursive: true }); require('node:fs').writeFileSync('template/_package.json', JSON.stringify(p.devDependencies))"`
    const { version, plan } = await dryRun('stable', brand, '--post-pin', sync)
    expect(plan.edits.find((edit) => edit.name === brand && edit.section === 'devDependencies')?.to).toBe(version)
    expect(plan.postPin).toEqual({ command: sync, changed: ['template/_package.json'] })
    expect(existsSync(join(fixtures, 'stable', 'template'))).toBe(false)
  }, 60_000)

  test('a failing post-pin command fails the run with its output', () => {
    const result = spawnSync(process.execPath, [script, '--dir', join(fixtures, 'stable'), '--dry-run', '--post-pin', 'echo peer floors stale >&2; exit 3'], { encoding: 'utf8' })
    expect(result.status).toBe(1)
    expect(result.stderr).toMatch(/post-pin `echo peer floors stale >&2; exit 3` exited 3; nothing was committed:\npeer floors stale/)
    expect(result.stdout).not.toMatch(/dry run: would open/)
  }, 60_000)

  test('the human plan names the pull request and changes nothing', async () => {
    const result = spawnSync(process.execPath, [script, '--dir', join(fixtures, 'agent-knowledge'), '--dry-run'], { encoding: 'utf8' })
    if (result.status !== 0) {
      expect(result.stderr).toMatch(/a new major release; widen it by hand/)
      expect(await excludedMajorPeer(JSON.parse(readFileSync(join(fixtures, 'agent-knowledge', 'package.json'), 'utf8')))).toBeDefined()
      return
    }
    expect(result.stdout).toMatch(/peerDependencies @tangle-network\/agent-eval: >=0\.213\.0 <0\.216\.0 -> >=0\.213\.0 </)
    expect(result.stdout).toMatch(/dry run: would open "chore\(deps\): adopt .+" \(plan [0-9a-f]{16}\); nothing was changed/)
  }, 60_000)
})

// Real registry artifacts, workspace installs and local Git histories. No gh,
// registry, filesystem or package-manager stand-ins participate in this proof.
describe('adopt-stack effective workspace delivery', () => {
  test.each(['package.json', 'pnpm-workspace.yaml'])('reconciles %s overrides and rejects installed drift', async (overrideFile) => {
    const brand = '@tangle-network/brand'
    const current = await latest(brand)
    const old = '1.25.0'
    const local = '@tangle-network/adopt-unpublished-integration'
    expect(current).not.toBe(old)
    const root = mkdtempSync(join(tmpdir(), 'adopt-effective-'))
    const save = (file, value) => {
      mkdirSync(dirname(join(root, file)), { recursive: true })
      writeFileSync(join(root, file), typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`)
    }
    const pnpm = (...args) => execFileSync('pnpm', args, { cwd: root, stdio: 'pipe' })
    try {
      const packageManager = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8')).packageManager
      const pkg = { name: 'adopt-effective-integration', private: true, packageManager, dependencies: { [brand]: old, [local]: 'workspace:*', react: '19.3.0' }, pnpm: { minimumReleaseAgeExclude: [`${brand}@${old}`] } }
      if (overrideFile === 'package.json') pkg.pnpm.overrides = { react: '$react', [brand]: old, [`fixture-parent>${brand}`]: `$${brand}` }
      save('package.json', pkg)
      save('pnpm-workspace.yaml', `packages:\n  - 'apps/*'\nautoInstallPeers: false\nminimumReleaseAgeExclude:\n  - '${brand}@${old}'\n${overrideFile === 'pnpm-workspace.yaml' ? `overrides:\n  react: '$react'\n  '${brand}': '${old}'\n  'fixture-parent>${brand}': '$${brand}'\n` : ''}`)
      save('apps/toolkit/package.json', { name: local, version: '1.0.0', private: true })
      save('apps/web/package.json', { name: 'adopt-web', private: true, dependencies: { [brand]: old } })
      save('apps/server/package.json', { name: 'adopt-server', private: true, dependencies: { [brand]: old } })
      pnpm('install', '--ignore-scripts')
      // Seed real installed drift without relying on legacy settings current pnpm ignores.
      pkg.dependencies[brand] = current
      save('package.json', pkg)
      // Tax's false-green calibration: root says latest, actual install is old.
      const staleLock = readFileSync(join(root, 'pnpm-lock.yaml'), 'utf8')
      expect(installedVersion(root, 'package.json', brand)).toBe(old)
      expect(() => resolvedVersions(root, new Map([[brand, current]]))).toThrow(/effective resolution differs/)
      const result = await plan(root)
      expect(result.packages.some(({ name }) => name === local)).toBe(false)
      expect(result.unmanaged).toContainEqual({ name: local, verified: false, reason: 'caller-owned protocol retained; no registry target' })
      for (const file of ['apps/web/package.json', 'apps/server/package.json']) expect(result.edits.some((edit) => edit.file === file && edit.name === brand && edit.to === current)).toBe(true)
      writePlan(root, result)
      pnpm('install', '--no-frozen-lockfile', '--ignore-scripts')
      pnpm('install', '--frozen-lockfile', '--ignore-scripts')
      const rows = resolvedVersions(root, new Map(result.expected))
      expect(rows).toHaveLength(3)
      for (const row of rows) expect({ locked: row.locked, installed: row.installed, verified: row.verified }).toEqual({ locked: current, installed: current, verified: true })
      expect(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).pnpm.minimumReleaseAgeExclude).toEqual([`${brand}@${current}`])
      expect(readFileSync(join(root, 'pnpm-workspace.yaml'), 'utf8')).toContain(`'${brand}@${current}'`)
      expect((await plan(root, [brand])).edits).toEqual([])
      const coherentLock = readFileSync(join(root, 'pnpm-lock.yaml'), 'utf8')
      save('pnpm-lock.yaml', staleLock)
      const stale = await plan(root, [brand])
      expect(stale.edits).toEqual([])
      expect(stale.installRequired).toBe(true)
      const preview = spawnSync(process.execPath, [script, '--dir', root, '--packages', brand, '--dry-run'], { encoding: 'utf8' })
      expect(preview.status, preview.stderr).toBe(0)
      expect(preview.stdout).toContain('verify the existing adoption')
      save('pnpm-lock.yaml', coherentLock)
      if (overrideFile === 'package.json') {
        // An old proposal + independently advanced default retain both histories.
        save('.gitignore', 'node_modules/\n')
        const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_ALLOW_TEST_IDENTITY: '1', GIT_AUTHOR_NAME: 'adopt-test', GIT_AUTHOR_EMAIL: 'adopt-test@example.invalid', GIT_COMMITTER_NAME: 'adopt-test', GIT_COMMITTER_EMAIL: 'adopt-test@example.invalid' } }).trim()
        const remote = mkdtempSync(join(tmpdir(), 'adopt-effective-remote-'))
        const caller = mkdtempSync(join(tmpdir(), 'adopt-effective-caller-'))
        const fresh = mkdtempSync(join(tmpdir(), 'adopt-effective-fresh-'))
        try {
          git(root, 'init', '-q', '-b', 'main')
          git(remote, 'init', '-q', '--bare', '-b', 'main')
          git(root, 'add', '.')
          git(root, 'commit', '-qm', 'Seed installed workspace')
          git(root, 'remote', 'add', 'origin', remote)
          git(root, 'push', '-q', 'origin', 'main')
          git(root, 'switch', '-c', 'chore/adopt-stack')
          save('proposal.txt', 'retained proposal\n')
          git(root, 'add', 'proposal.txt')
          git(root, 'commit', '-qm', 'Retain owned proposal')
          const previous = git(root, 'rev-parse', 'HEAD')
          git(root, 'push', '-q', 'origin', 'chore/adopt-stack')
          git(root, 'switch', 'main')
          save('default.txt', 'advanced default\n')
          git(root, 'add', 'default.txt')
          git(root, 'commit', '-qm', 'Advance default independently')
          const base = git(root, 'rev-parse', 'HEAD')
          git(root, 'push', '-q', 'origin', 'main')
          git(root, 'clone', '-q', '--depth', '1', `file://${remote}`, caller)
          expect(git(caller, 'rev-parse', '--is-shallow-repository')).toBe('true')
          const prepared = prepareBranch(caller, 'main')
          expect(prepared).toEqual({ base, proposal: true, replaces: '' })
          expect(git(caller, 'rev-parse', '--is-shallow-repository')).toBe('false')
          git(caller, 'merge-base', '--is-ancestor', previous, 'HEAD')
          git(caller, 'merge-base', '--is-ancestor', base, 'HEAD')
          const recovered = await plan(caller, [brand])
          expect(recovered.edits).toEqual([])
          expect(recovered.installRequired).toBe(false)
          // Ordinary push accepts this retained ancestry; no forced update.
          git(caller, 'push', '-q', 'origin', 'HEAD:refs/heads/chore/adopt-stack')
          const pushed = git(root, 'ls-remote', 'origin', 'refs/heads/chore/adopt-stack').split(/\s/)[0]
          expect(pushed).toBe(git(caller, 'rev-parse', 'HEAD'))
          save('default.txt', 'default moved after gate\n')
          git(root, 'add', 'default.txt')
          git(root, 'commit', '-qm', 'Move default after captured gate base')
          git(root, 'push', '-q', 'origin', 'main')
          const moved = git(root, 'rev-parse', 'HEAD')
          // This returns before any GitHub command: the actual remote is the gate.
          expect(await mergeWhenApproved(caller, 1, pushed, prepared.base, 'main')).toEqual({ moved })
          // With no open PR the branch is a leftover of someone else's squash merge: start from the default.
          git(root, 'clone', '-q', `file://${remote}`, fresh)
          expect(prepareBranch(fresh, 'main', false)).toEqual({ base: moved, proposal: false, replaces: pushed })
          expect(git(fresh, 'rev-parse', 'HEAD')).toBe(moved)
          // An open proposal that no longer merges restarts only when this updater wrote all of it.
          // Branches are pushed while they still merge, then the default moves; push hooks refuse conflicting pushes.
          git(root, 'switch', '-C', 'chore/adopt-stack', moved)
          save('lock.txt', 'updater pin\n')
          git(root, 'add', 'lock.txt')
          git(root, 'commit', '-qm', 'Updater-only proposal', '--author', 'github-actions[bot] <41898282+github-actions[bot]@users.noreply.github.com>')
          const updaterOnly = git(root, 'rev-parse', 'HEAD')
          git(root, 'commit', '-q', '--allow-empty', '-m', 'A person adds to the proposal')
          git(root, 'push', '-q', '-f', 'origin', 'chore/adopt-stack')
          git(root, 'switch', 'main')
          save('lock.txt', 'default pin\n')
          git(root, 'add', 'lock.txt')
          git(root, 'commit', '-qm', 'Default pins differently')
          git(root, 'push', '-q', 'origin', 'main')
          const conflicted = git(root, 'rev-parse', 'HEAD')
          rmSync(fresh, { recursive: true, force: true })
          git(root, 'clone', '-q', `file://${remote}`, fresh)
          expect(() => prepareBranch(fresh, 'main')).toThrow(/no history was rewritten/)
          git(remote, 'update-ref', 'refs/heads/chore/adopt-stack', updaterOnly)
          rmSync(fresh, { recursive: true, force: true })
          git(root, 'clone', '-q', `file://${remote}`, fresh)
          expect(prepareBranch(fresh, 'main')).toEqual({ base: conflicted, proposal: false, replaces: updaterOnly })
          expect(git(fresh, 'rev-parse', 'HEAD')).toBe(conflicted)
        } finally {
          rmSync(remote, { recursive: true, force: true })
          rmSync(caller, { recursive: true, force: true })
          rmSync(fresh, { recursive: true, force: true })
        }
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }, 180_000)
})
