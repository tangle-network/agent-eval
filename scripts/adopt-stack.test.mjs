import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'
import { lockedVersions, mergeWhenApproved, plan, prepareBranch, satisfies, writePlan } from './adopt-stack.mjs'
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

function dryRun(fixture, ...extra) {
  const manifest = join(fixtures, fixture, 'package.json')
  const before = readFileSync(manifest, 'utf8')
  const result = spawnSync(process.execPath, [script, '--dir', join(fixtures, fixture), '--dry-run', '--json', ...extra], { encoding: 'utf8' })
  expect(result.status, result.stderr).toBe(0)
  expect(readFileSync(manifest, 'utf8')).toBe(before)
  return { plan: JSON.parse(result.stdout), pkg: JSON.parse(before) }
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
    const version = await latest('@tangle-network/agent-eval')
    const { plan, pkg } = dryRun('agent-knowledge')
    expectAdopted(plan, pkg, '@tangle-network/agent-eval', version)
  }, 60_000)

  test('agent-app adopts agent-runtime latest and widens its agent-runtime peer', async () => {
    const version = await latest('@tangle-network/agent-runtime')
    const { plan, pkg } = dryRun('agent-app')
    expectAdopted(plan, pkg, '@tangle-network/agent-runtime', version)
    // Alias pins such as agent-eval-0204 (npm:@tangle-network/agent-eval@0.204.0) stay as written.
    expect(plan.edits.some((edit) => !edit.name.startsWith('@tangle-network/'))).toBe(false)
  }, 60_000)

  test('a post-pin command sees the pinned manifest and its second file joins the plan', async () => {
    const version = await latest('@tangle-network/agent-eval')
    // Like agent-app's template pins: a second file derived from the adopted pins.
    const sync = `node -e "const p = require('./package.json'); require('node:fs').mkdirSync('template', { recursive: true }); require('node:fs').writeFileSync('template/_package.json', JSON.stringify(p.devDependencies))"`
    const { plan, pkg } = dryRun('agent-knowledge', '--post-pin', sync)
    expectAdopted(plan, pkg, '@tangle-network/agent-eval', version)
    expect(plan.postPin).toEqual({ command: sync, changed: ['template/_package.json'] })
    expect(existsSync(join(fixtures, 'agent-knowledge', 'template'))).toBe(false)
  }, 60_000)

  test('a failing post-pin command fails the run with its output', () => {
    const result = spawnSync(process.execPath, [script, '--dir', join(fixtures, 'agent-knowledge'), '--dry-run', '--post-pin', 'echo peer floors stale >&2; exit 3'], { encoding: 'utf8' })
    expect(result.status).toBe(1)
    expect(result.stderr).toMatch(/post-pin `echo peer floors stale >&2; exit 3` exited 3; nothing was committed:\npeer floors stale/)
    expect(result.stdout).not.toMatch(/dry run: would open/)
  }, 60_000)

  // agent-runtime at c54e6810e0ce (package.json sections, pnpm-workspace.yaml,
  // the lockfile's catalogs and root importer, release/cohort.json): #1946 left
  // agent-knowledge locked at 22.0.3 under `^22.0.3`, whose agent-eval peer
  // excludes the adopted agent-eval, and left release/cohort.json behind.
  // Assertions hold for whatever npm latest is: they check the plan against the
  // lockfile it leaves, not against fixed versions.
  test.each([
    ['agent-eval only', ['--packages', '@tangle-network/agent-eval']],
    ['every package', []],
  ])('agent-runtime (%s): the lockfile it leaves admits its peers, and the release cohort follows it', async (_label, extra) => {
    const knowledge = '@tangle-network/agent-knowledge'
    const evalName = '@tangle-network/agent-eval'
    const dir = join(fixtures, 'agent-runtime')
    const { plan, pkg } = dryRun('agent-runtime', ...extra)
    const locked = lockedVersions(dir).importer
    const manifest = async (name, version) => (await fetch(`https://registry.npmjs.org/${name.replace('/', '%2f')}/${version}`)).json()
    // What the root importer holds after the plan's package.json edit, if any.
    const holds = (name) => {
      const edit = plan.edits.find((entry) => entry.name === name && entry.file === 'package.json' && entry.section !== 'peerDependencies')
      if (!edit) return locked.get(name)
      return /^\d+\.\d+\.\d+$/.test(edit.to) || !satisfies(locked.get(name), edit.to) ? edit.version : locked.get(name)
    }

    for (const edit of plan.edits.filter((entry) => entry.file !== 'release/cohort.json' && entry.section !== 'peerDependencies')) {
      const lock = (edit.file === 'package.json' ? locked : lockedVersions(dir).catalog).get(edit.name)
      expect(satisfies(edit.version, edit.to), `${edit.name} ${edit.to}`).toBe(true)
      if (!lock || /^\d/.test(edit.from)) continue
      // A locked range is never only widened: an edit moves the lock, so the range never admits an untested version.
      expect(satisfies(lock, edit.to), `${edit.name} ${edit.from} -> ${edit.to} keeps ${lock}`).toBe(false)
      // It moves inside the range as written, for a peer, or (a catalog entry) to the root pin.
      expect(satisfies(edit.version, edit.from) || /^raised by peer range: /.test(edit.why) || (edit.file === 'pnpm-workspace.yaml' && holds(edit.name) === edit.version), `${edit.name} ${edit.from} -> ${edit.to}`).toBe(true)
    }

    // Workspace importers that resolve through the catalog (bench) end on the root's version.
    for (const [name, lock] of lockedVersions(dir).catalog) {
      if (!pkg.devDependencies[name] && !pkg.dependencies[name]) continue
      const edit = plan.edits.find((entry) => entry.name === name && entry.file === 'pnpm-workspace.yaml')
      const catalogHolds = edit && !satisfies(lock, edit.to) ? edit.version : lock
      expect(catalogHolds, `${name}: catalog ${edit?.to ?? 'unchanged'} vs root ${holds(name)}`).toBe(holds(name))
    }

    // The agent-knowledge the lockfile keeps admits the agent-eval it gets: 22.0.3
    // peers agent-eval <0.216.0, so it rises whenever agent-eval moves past that.
    const evalAt = holds(evalName)
    const knowledgeAt = holds(knowledge)
    expect(satisfies(evalAt, (await manifest(knowledge, knowledgeAt)).peerDependencies[evalName]), `${knowledge}@${knowledgeAt} with ${evalName}@${evalAt}`).toBe(true)
    if (knowledgeAt !== locked.get(knowledge)) {
      for (const section of ['package.json dependencies', 'pnpm-workspace.yaml catalog line 31']) {
        const edit = plan.edits.find((entry) => entry.name === knowledge && `${entry.file} ${entry.section}` === section)
        expect(satisfies(knowledgeAt, edit?.to ?? '') && !satisfies('22.0.3', edit.to), section).toBe(true)
      }
    }

    // agent-eval's own dependency ranges cap the siblings it would otherwise duplicate (agent-core ^0.12.0).
    for (const [name, range] of Object.entries((await manifest(evalName, evalAt)).dependencies ?? {})) {
      if (pkg.dependencies[name] && locked.get(name) && satisfies(locked.get(name), range)) expect(satisfies(holds(name), range), `${name}@${holds(name)} under ${range}`).toBe(true)
    }

    // Each cohort entry follows the version its lock will hold, with npm's gitHead for it.
    const cohort = JSON.parse(readFileSync(join(dir, 'release', 'cohort.json'), 'utf8')).packages
    for (const [key, name] of [['agentEval', evalName], ['agentKnowledge', knowledge]]) {
      const edit = plan.edits.find((entry) => entry.file === 'release/cohort.json' && entry.section === `packages.${key}`)
      if (holds(name) === cohort[key].version) {
        expect(edit).toBeUndefined()
        continue
      }
      expect(edit?.from).toBe(`${cohort[key].version} ${cohort[key].ref}`)
      expect(edit.to).toBe(`${holds(name)} ${(await manifest(name, holds(name))).gitHead}`)
    }
  }, 60_000)

  test('the human plan names the pull request and changes nothing', () => {
    const result = spawnSync(process.execPath, [script, '--dir', join(fixtures, 'agent-knowledge'), '--dry-run'], { encoding: 'utf8' })
    expect(result.status, result.stderr).toBe(0)
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
        const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'adopt-test', GIT_AUTHOR_EMAIL: 'adopt-test@example.invalid', GIT_COMMITTER_NAME: 'adopt-test', GIT_COMMITTER_EMAIL: 'adopt-test@example.invalid' } }).trim()
        const remote = mkdtempSync(join(tmpdir(), 'adopt-effective-remote-'))
        const caller = mkdtempSync(join(tmpdir(), 'adopt-effective-caller-'))
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
          expect(prepared).toEqual({ base, proposal: true })
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
        } finally {
          rmSync(remote, { recursive: true, force: true })
          rmSync(caller, { recursive: true, force: true })
        }
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }, 180_000)
})
