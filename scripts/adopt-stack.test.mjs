import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'
import { satisfies } from './adopt-stack.mjs'

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

  test('the human plan names the pull request and changes nothing', () => {
    const result = spawnSync(process.execPath, [script, '--dir', join(fixtures, 'agent-knowledge'), '--dry-run'], { encoding: 'utf8' })
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toMatch(/peerDependencies @tangle-network\/agent-eval: >=0\.213\.0 <0\.216\.0 -> >=0\.213\.0 </)
    expect(result.stdout).toMatch(/dry run: would open "chore\(deps\): adopt .+" \(plan [0-9a-f]{16}\); nothing was changed/)
  }, 60_000)
})

// The delivery path against a real local git remote, real pnpm and real npm.
// Only `gh` is a stand-in: it keeps pull requests in a JSON file and answers the
// `pr list --json number,body` fields the script reads (checked against
// `gh pr list --help`), so this proves the script's model of the GitHub API,
// not GitHub itself.
const GH_STUB = `#!/usr/bin/env node
const fs = require('node:fs')
const file = process.env.GH_STUB_STATE
const state = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { prs: [] }
const [, sub, ...rest] = process.argv.slice(2)
const flag = (name) => (rest.includes(name) ? rest[rest.indexOf(name) + 1] : undefined)
const pr = state.prs.find((entry) => String(entry.number) === rest[0])
if (sub === 'list') {
  const open = state.prs.filter((entry) => entry.state === 'open' && entry.head === flag('--head') && entry.base === flag('--base'))
  const fields = flag('--json').split(',')
  console.log(JSON.stringify(open.map((entry) => Object.fromEntries(fields.map((field) => [field, entry[field]])))))
} else if (sub === 'create') {
  const number = state.prs.length + 1
  state.prs.push({ number, state: 'open', head: flag('--head'), base: flag('--base'), title: flag('--title'), body: fs.readFileSync(flag('--body-file'), 'utf8'), comments: [] })
  console.log('https://github.com/example/caller/pull/' + number)
} else if (sub === 'edit') {
  if (flag('--title')) pr.title = flag('--title')
  if (flag('--body-file')) pr.body = fs.readFileSync(flag('--body-file'), 'utf8')
} else if (sub === 'comment') pr.comments.push(flag('--body'))
else if (sub === 'close') pr.state = 'closed'
else if (sub === 'merge') Object.assign(pr, { state: 'merged', mergedHead: flag('--match-head-commit') })
else { console.error('gh stub: unsupported ' + process.argv.slice(2).join(' ')); process.exit(1) }
fs.writeFileSync(file, JSON.stringify(state))
`

describe('adopt-stack delivery through git, pnpm and a gh stand-in', () => {
  test('re-gates only a changed plan or a failed gate, and merges when asked', async () => {
    const brand = '@tangle-network/brand'
    const latestBrand = await latest(brand)
    for (const old of ['1.25.0', '1.26.0']) expect(latestBrand).not.toBe(old)

    const root = mkdtempSync(join(tmpdir(), 'adopt-stack-delivery-'))
    const bin = join(root, 'bin')
    mkdirSync(bin)
    writeFileSync(join(bin, 'gh'), GH_STUB)
    chmodSync(join(bin, 'gh'), 0o755)
    writeFileSync(join(root, 'gitconfig'), '')
    const ghState = join(root, 'gh.json')
    const gateLog = join(root, 'gates.log')
    const env = {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      // An empty global config keeps machine hooks and identities out of the run.
      GIT_CONFIG_GLOBAL: join(root, 'gitconfig'),
      GIT_CONFIG_NOSYSTEM: '1',
      GH_STUB_STATE: ghState,
      GATE_LOG: gateLog,
    }
    const git = (cwd, ...argv) => execFileSync('git', argv, { cwd, env, encoding: 'utf8' }).trim()
    const seedCommit = (cwd, message) => git(cwd, '-c', 'user.name=seed', '-c', 'user.email=seed@example.com', 'commit', '-qam', message)
    const remote = join(root, 'remote.git')
    const seed = join(root, 'seed')
    const pinBrand = (version) => writeFileSync(join(seed, 'package.json'), `${JSON.stringify({ name: 'adopt-stack-delivery-fixture', private: true, devDependencies: { [brand]: version } }, null, 2)}\n`)
    const gates = () => readFileSync(gateLog, 'utf8').split('\n').filter(Boolean).length
    const prs = () => JSON.parse(readFileSync(ghState, 'utf8')).prs
    const marker = () => /adopt-stack:plan=(\w+) result=([\w-]+)/.exec(prs()[0].body).slice(1)
    const branchHead = () => git(root, 'ls-remote', remote, 'refs/heads/chore/adopt-stack').split(/\s/)[0]
    let runs = 0
    const adopt = (gate, ...extra) => {
      const work = join(root, `work-${++runs}`)
      git(root, 'clone', '-q', remote, work)
      return { work, ...spawnSync(process.execPath, [script, '--gate', gate, '--default-branch', 'main', ...extra], { cwd: work, env, encoding: 'utf8' }) }
    }
    const pass = 'echo gate >> "$GATE_LOG"'
    const fail = 'echo gate >> "$GATE_LOG"; exit 1'

    try {
      git(root, 'init', '-q', '--bare', '-b', 'main', remote)
      git(root, 'init', '-q', '-b', 'main', seed)
      pinBrand('1.25.0')
      // A tracked file the post-pin command rewrites, like agent-app's peer floors.
      writeFileSync(join(seed, 'floors.json'), '{}\n')
      writeFileSync(join(seed, 'pnpm-workspace.yaml'), 'autoInstallPeers: false\nminimumReleaseAgeExclude:\n  - "@tangle-network/*"\n')
      execFileSync('pnpm', ['install', '--lockfile-only'], { cwd: seed, env, stdio: 'pipe' })
      git(seed, 'add', '.')
      seedCommit(seed, 'seed')
      git(seed, 'remote', 'add', 'origin', remote)
      git(seed, 'push', '-q', 'origin', 'main')

      const first = adopt(pass)
      expect(first.status, first.stderr).toBe(0)
      expect(prs()).toHaveLength(1)
      expect(prs()[0].title).toBe(`chore(deps): adopt ${brand} ${latestBrand}`)
      const [firstPlan, firstResult] = marker()
      expect(firstResult).toBe('pass')
      const firstHead = branchHead()
      expect(gates()).toBe(1)

      const same = adopt(pass)
      expect(same.status, same.stderr).toBe(0)
      expect(same.stdout).toContain(`already proposes plan ${firstPlan}`)
      expect([gates(), branchHead()]).toEqual([1, firstHead])

      // One version changes on the default branch, so the plan and the head
      // change; this run's gate fails.
      pinBrand('1.26.0')
      seedCommit(seed, 'pin brand 1.26.0')
      git(seed, 'push', '-q', 'origin', 'main')
      const failed = adopt(fail)
      expect(failed.status).toBe(1)
      expect(gates()).toBe(2)
      expect(branchHead()).not.toBe(firstHead)
      const [changedPlan, failedResult] = marker()
      expect([changedPlan === firstPlan, failedResult]).toEqual([false, 'gate-fail'])
      expect(prs()).toHaveLength(1)

      // The recorded gate failure is retried on the same plan.
      const retried = adopt(pass)
      expect(retried.status, retried.stderr).toBe(0)
      expect(marker()).toEqual([changedPlan, 'pass'])
      expect(gates()).toBe(3)
      const retriedHead = branchHead()

      // A failing post-pin command fails the run with its output before the
      // gate, the branch switch or any commit; the proposal stays as it was.
      const mainHead = git(root, 'ls-remote', remote, 'refs/heads/main').split(/\s/)[0]
      const refused = adopt(pass, '--post-pin', 'echo peer floors stale >&2; exit 3')
      expect(refused.status).toBe(1)
      expect(refused.stderr).toMatch(/post-pin `echo peer floors stale >&2; exit 3` exited 3; nothing was committed:\npeer floors stale/)
      expect([gates(), branchHead(), marker()]).toEqual([3, retriedHead, [changedPlan, 'pass']])
      expect([git(refused.work, 'branch', '--show-current'), git(refused.work, 'rev-parse', 'HEAD')]).toEqual(['main', mainHead])

      // A post-pin command is part of the plan, so it re-gates; the files it
      // creates or edits join the adoption commit and the pull request body.
      const sync = `node -e "const fs = require('node:fs'), pins = JSON.stringify(require('./package.json').devDependencies); fs.writeFileSync('template.json', pins); fs.writeFileSync('floors.json', pins)"`
      const merged = adopt(pass, '--merge', '--post-pin', sync)
      expect(merged.status, merged.stderr).toBe(0)
      expect(gates()).toBe(4)
      expect(prs()[0]).toMatchObject({ state: 'merged', mergedHead: branchHead() })
      expect(prs()[0].body).toContain(`Post-pin: \`${sync}\` changed \`floors.json\`, \`template.json\`.`)
      const adopted = JSON.parse(git(remote, 'show', `${branchHead()}:package.json`))
      expect(adopted.devDependencies[brand]).toBe(latestBrand)
      for (const file of ['template.json', 'floors.json']) expect(JSON.parse(git(remote, 'show', `${branchHead()}:${file}`))[brand]).toBe(latestBrand)
      expect(git(remote, 'log', '-1', '--format=%an', branchHead())).toBe('github-actions[bot]')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }, 180_000)
})
