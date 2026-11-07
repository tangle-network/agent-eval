import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'
import { mergeWhenApproved, plan, prepareBranch, satisfies, install, writePlan } from './adopt-stack.mjs'
import { installedVersion, resolvedVersions } from './adopt-stack-workspace.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const fixtures = join(here, '..', 'tests', 'fixtures', 'adopt-stack')
const script = join(here, 'adopt-stack.mjs')

async function latest(name) {
  const response = await fetch(`https://registry.npmjs.org/${name.replace('/', '%2f')}/latest`)
  expect(response.ok, `npm answered ${response.status} for ${name}`).toBe(true)
  return (await response.json()).version
}

async function dryRun(fixture, name, ...extra) {
  const manifest = join(fixtures, fixture, 'package.json')
  const before = readFileSync(manifest, 'utf8')
  const result = spawnSync(process.execPath, [script, '--dir', join(fixtures, fixture), '--dry-run', '--json', ...extra], { encoding: 'utf8' })
  expect(readFileSync(manifest, 'utf8')).toBe(before)
  expect(result.status, result.stderr).toBe(0)
  return { version: await latest(name), plan: JSON.parse(result.stdout) }
}

describe('adopt-stack --dry-run against npm', () => {
  test('a post-pin command sees the pinned manifest and its second file joins the plan', async () => {
    const brand = '@tangle-network/brand'
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

  // Historical failed runs may expire; absence must continue to hold the real CLI's draft.
  test('a requested Runtime release adopts only when its current tag evidence passed', () => {
    const root = mkdtempSync(join(tmpdir(), 'adopt-evidence-'))
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'adopt-evidence', private: true, devDependencies: { '@tangle-network/agent-runtime': '6.0.2' } }))
    try {
      for (const version of ['6.0.1', '6.0.3', '6.0.4']) {
        const args = [script, '--dir', root, '--dry-run', '--merge', '--packages', `@tangle-network/agent-runtime@${version}`]
        const preview = spawnSync(process.execPath, [...args, '--json'], { encoding: 'utf8' })
        expect(preview.status, preview.stderr).toBe(0)
        const evidence = JSON.parse(preview.stdout).evidence.find(entry => entry.name === '@tangle-network/agent-runtime' && entry.version === version)
        expect(evidence).toBeDefined()
        if (version !== '6.0.4') expect(evidence.refused).toMatch(/concluded failure|never started or was deleted/)
        const result = spawnSync(process.execPath, args, { encoding: 'utf8' })
        expect(result.status, result.stderr).toBe(0)
        expect(result.stdout).toContain(`\`@tangle-network/agent-runtime@${version}\` release evidence${evidence.run ? ` ${evidence.run}` : ''}: ${evidence.refused ? `refused, ${evidence.refused}` : 'passed'}`)
        expect(result.stdout).toContain(evidence.refused ? 'as a draft held by its release evidence' : 'and merge it when green')
        if (evidence.refused) expect(result.stdout).not.toContain('and merge it when green')
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }, 60_000)

  // Lab's package.json before #3121: Runtime 6.0.1 depends on agent-trace-contract ^2.2.2 and Lab pins 2.2.1 exactly.
  test('an exact pin below a dependency floor of the adopted release rises with it', () => {
    const root = mkdtempSync(join(tmpdir(), 'adopt-floor-'))
    const contract = '@tangle-network/agent-trace-contract'
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'adopt-floor', private: true, dependencies: { '@tangle-network/agent-runtime': '5.0.0', [contract]: '2.2.1' } }))
    try {
      const result = spawnSync(process.execPath, [script, '--dir', root, '--dry-run', '--json', '--packages', '@tangle-network/agent-runtime@6.0.1'], { encoding: 'utf8' })
      expect(result.status, result.stderr).toBe(0)
      const raised = JSON.parse(result.stdout).edits.find((edit) => edit.name === contract)
      expect(raised?.from).toBe('2.2.1')
      expect(satisfies(raised.to, '^2.2.2')).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }, 60_000)
})

test('published App UI peers stage unchanged admitted siblings before the first strict install', async () => {
  const root = mkdtempSync(join(tmpdir(), 'adopt-app-ui-peers-'))
  const names = ['ui', 'brand', 'charts', 'sandbox-ui'].map(name => `@tangle-network/${name}`)
  const old = ['11.51.2', '1.31.2', '1.0.0', '1.1.10']
  const targets = ['11.51.17', '1.31.4', '4.0.21', '7.0.6']
  const save = (file, value) => writeFileSync(join(root, file), typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n')
  const pnpm = (...args) => execFileSync('pnpm', args, { cwd: root, stdio: 'pipe' })
  try {
    const pkg = { name: 'adopt-published-app-ui', private: true, packageManager: JSON.parse(readFileSync(join(here, '..', 'package.json'))).packageManager,
      dependencies: { ...Object.fromEntries(names.map((name, i) => [name, old[i]])), react: '19.3.0', 'react-dom': '19.3.0', picocolors: '1.0.0' } }
    save('package.json', pkg)
    save('pnpm-workspace.yaml', 'packages: []\nstrictPeerDependencies: true\n')
    pnpm('install', '--no-frozen-lockfile')
    for (const [i, name] of names.entries()) pkg.dependencies[name] = `^${old[i]}`
    save('package.json', pkg)
    const stale = old.reduce((text, version, i) => text.replace(`'${names[i]}':\n        specifier: ${version}\n`, `'${names[i]}':\n        specifier: ^${version}\n`), readFileSync(join(root, 'pnpm-lock.yaml'), 'utf8'))
    save('pnpm-lock.yaml', stale)
    pnpm('install', '--frozen-lockfile')
    const result = await plan(root, names.map((name, i) => `${name}@${targets[i]}`))
    expect(result.edits.some(edit => names.slice(0, 2).includes(edit.name))).toBe(false)
    writePlan(root, result)
    const baselineRef = process.env.ADOPT_STACK_INSTALL_BASELINE_REF
    if (baselineRef) {
      save('retained-adopt-stack.mjs', execFileSync('git', ['show', `${baselineRef}:scripts/adopt-stack.mjs`], { cwd: join(here, '..'), encoding: 'utf8' }))
      save('adopt-stack-workspace.mjs', readFileSync(join(here, 'adopt-stack-workspace.mjs'), 'utf8'))
      save('plan.json', result)
      const red = spawnSync(process.execPath, ['--input-type=module', '-e', "import {install} from './retained-adopt-stack.mjs';import{readFileSync}from'node:fs';install(process.cwd(),JSON.parse(readFileSync('plan.json')))"], { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
      expect(red.status, red.stdout + red.stderr).not.toBe(0)
      expect(red.stdout + red.stderr).toMatch(/ERR_PNPM_PEER_DEP_ISSUES/)
      for (const version of old.slice(0, 2)) expect(red.stdout + red.stderr).toContain(version)
      console.log('APP_UI_BASELINE_RED=' + JSON.stringify({ ref: baselineRef, exit: red.status, peers: names.slice(0, 2), stderr: red.stderr, stdout: red.stdout }))
      save('pnpm-lock.yaml', stale)
      writePlan(root, result, true)
    }
    install(root, result)
    pnpm('install', '--frozen-lockfile')
    const rows = resolvedVersions(root, new Map(result.expected))
    for (const [i, name] of names.entries()) expect(rows.find(row => row.name === name)).toMatchObject({ locked: targets[i], installed: targets[i], verified: true })
    const after = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
    for (const name of names.slice(0, 2)) expect(after.dependencies[name]).toBe(pkg.dependencies[name])
    expect(after.dependencies.picocolors).toBe('1.0.0')
    expect(JSON.parse(readFileSync(join(root, 'node_modules/picocolors/package.json'))).version).toBe('1.0.0')
    console.log('APP_UI_PATCH_GREEN=' + JSON.stringify(rows))
  } finally { rmSync(root, { recursive: true, force: true }) }
}, 240_000)

process.env.GIT_ALLOW_TEST_IDENTITY = '1' // This worker owns only disposable Git fixtures.
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
        const clone = (...args) => git(root, 'clone', '-q', '-c', 'user.name=adopt-test', '-c', 'user.email=adopt-test@example.invalid', ...args)
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
          clone('--depth', '1', `file://${remote}`, caller)
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
          clone(`file://${remote}`, fresh)
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
          clone(`file://${remote}`, fresh)
          expect(() => prepareBranch(fresh, 'main')).toThrow(/no history was rewritten/)
          git(remote, 'update-ref', 'refs/heads/chore/adopt-stack', updaterOnly)
          rmSync(fresh, { recursive: true, force: true })
          clone(`file://${remote}`, fresh)
          expect(prepareBranch(fresh, 'main')).toEqual({ base: conflicted, proposal: false, replaces: updaterOnly })
          expect(git(fresh, 'rev-parse', 'HEAD')).toBe(conflicted)
        } finally {
          for (const directory of [remote, caller, fresh]) rmSync(directory, { recursive: true, force: true })
        }
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }, 180_000)
})
