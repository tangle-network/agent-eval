import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
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

function dryRun(fixture) {
  const manifest = join(fixtures, fixture, 'package.json')
  const before = readFileSync(manifest, 'utf8')
  const result = spawnSync(process.execPath, [script, '--dir', join(fixtures, fixture), '--dry-run', '--json'], { encoding: 'utf8' })
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

  const peer = plan.edits.find((edit) => edit.name === name && edit.section === 'peerDependencies')
  const before = pkg.peerDependencies[name]
  expect(satisfies(version, before)).toBe(false)
  expect(peer?.from).toBe(before)
  expect(satisfies(version, peer.to)).toBe(true)
  // Only the last alternative's upper bound moves; every lower bound stays.
  const alternatives = before.split('||').map((part) => part.trim())
  const lower = /^>=(\S+)/.exec(alternatives.at(-1))[1]
  expect(peer.to).toBe([...alternatives.slice(0, -1), `>=${lower} <${upperFor(version)}`].join(' || '))
}

const upperFor = (version) => {
  const [major, minor] = version.split('.').map(Number)
  return major > 0 ? `${major + 1}.0.0` : `0.${minor + 1}.0`
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

  test('the human plan names the pull request and changes nothing', () => {
    const result = spawnSync(process.execPath, [script, '--dir', join(fixtures, 'agent-knowledge'), '--dry-run'], { encoding: 'utf8' })
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toMatch(/peerDependencies @tangle-network\/agent-eval: >=0\.213\.0 <0\.216\.0 -> >=0\.213\.0 </)
    expect(result.stdout).toMatch(/dry run: would open "chore\(deps\): adopt .+"; nothing was changed/)
  }, 60_000)
})
