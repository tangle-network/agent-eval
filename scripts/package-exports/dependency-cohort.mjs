import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { repoRoot } from './repository.mjs'
import { run } from './process.mjs'

// npm caret admission, which is what the consumer's own resolver applies to the
// declared range. The compatible segment is the leftmost non-zero one.
function caretAdmits(range, version) {
  const floor = /^\^(\d+)\.(\d+)\.(\d+)$/.exec(range)
  const found = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(version)
  if (floor === null || found === null) return false
  const [floorMajor, floorMinor, floorPatch] = floor.slice(1).map(Number)
  const [major, minor, patch] = found.slice(1).map(Number)
  if (major !== floorMajor) return false
  if (floorMajor === 0 && minor !== floorMinor) return false
  if (floorMajor === 0 && floorMinor === 0) return patch === floorPatch
  return minor * 1_000_000 + patch >= floorMinor * 1_000_000 + floorPatch
}

// Reads the cohort expectation from the two manifests that already state it,
// so no release can leave a stale copy of the answer behind in this file.
export function readDependencyCohort(names) {
  const sourceManifest = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'))
  const cohort = {}
  for (const name of names) {
    const range = sourceManifest.dependencies?.[name]
    if (typeof range !== 'string') {
      throw new Error(`source manifest does not declare ${name} as a dependency`)
    }
    const installedManifest = join(repoRoot, 'node_modules', name, 'package.json')
    if (!existsSync(installedManifest)) {
      throw new Error(`${name} is declared but not installed; run pnpm install before verifying`)
    }
    const version = JSON.parse(readFileSync(installedManifest, 'utf8')).version
    // The declaration must be the caret range of the copy this repository was
    // built against. An exact pin duplicates the copy in a consumer that also
    // depends on the package, and a lower floor lets a consumer resolve a copy
    // older than the one the packed dist was compiled and tested against.
    if (range !== `^${version}`) {
      throw new Error(
        `${name} is declared as ${range} but installed as ${version}; declare ^${version} so the packed floor is the tested copy`,
      )
    }
    cohort[name] = { range, version }
  }
  return cohort
}

export function verifyPackedDependencyCohort(tarball, appDir, expectedVersions) {
  writeFileSync(
    join(appDir, 'package.json'),
    JSON.stringify({
      private: true,
      type: 'module',
      dependencies: {
        '@tangle-network/agent-eval': `file:${tarball}`,
        '@tangle-network/agent-interface':
          expectedVersions['@tangle-network/agent-interface'].range,
      },
    }),
  )
  run(
    'npm',
    ['install', '--strict-peer-deps', '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false'],
    appDir,
    { timeout: 180_000 },
  )

  for (const [name, { range: expectedRange }] of Object.entries(expectedVersions)) {
    const manifests = run(
      'find',
      [
        join(appDir, 'node_modules'),
        '-type',
        'f',
        '-path',
        `*/${name}/package.json`,
        '-print',
      ],
      repoRoot,
    )
      .trim()
      .split('\n')
      .filter(Boolean)
    if (manifests.length !== 1) {
      throw new Error(
        `packed consumer must install one ${name} copy, found ${manifests.length}: ${manifests.join(', ')}`,
      )
    }
    // The consumer resolves a caret range against the live registry, so it
    // reads the newest release inside that range, not the copy this repository
    // happens to hold. Admission by the range is therefore the only assertion
    // this probe can make about the resolved version; the assertions that the
    // resolved copy actually works are the single-copy check above and the
    // schema round-trip below. Exact equality would reject a valid release
    // inside the declared range.
    const installedVersion = JSON.parse(readFileSync(manifests[0], 'utf8')).version
    if (!caretAdmits(expectedRange, installedVersion)) {
      throw new Error(
        `packed consumer installed ${name} ${installedVersion}, outside the declared range ${expectedRange}`,
      )
    }
  }

  run(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      `
        const contract = await import('@tangle-network/agent-eval/contract')
        const agentInterface = await import('@tangle-network/agent-interface')
        if (typeof contract.sealAgentProfileImprovementExperiment !== 'function') {
          throw new Error('packed contract is missing profile experiment sealing')
        }
        const sha = (digit) => 'sha256:' + digit.repeat(64)
        const source = agentInterface.agentImprovementSourceSchema.parse({
          kind: 'public-agent-resource',
          sourceIdentity: 'github:example/research-agents/reviewer.md',
          sourceDigest: sha('2'),
          sourceRevision: '8d3b3f5',
          license: { kind: 'spdx', expression: 'Apache-2.0' },
          attribution: ['Copyright Example Research contributors'],
          notices: ['Adapted for the packed-consumer probe.'],
          transformations: [{
            kind: 'normalization',
            identity: 'line-ending-normalizer',
            revision: 1,
            procedureDigest: sha('3'),
            inputDigest: sha('1'),
            outputDigest: sha('2'),
          }],
        })
        if (source.license?.kind !== 'spdx' || source.transformations?.length !== 1) {
          throw new Error('packed Interface lost rich source evidence')
        }
      `,
    ],
    appDir,
  )
}
