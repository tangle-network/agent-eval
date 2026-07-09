import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const tempRoot = mkdtempSync(join(repoRoot, '.tmp-package-exports-'))

try {
  const packDir = join(tempRoot, 'pack')
  const unpackDir = join(tempRoot, 'unpack')
  const appDir = join(tempRoot, 'app')
  mkdirSync(packDir, { recursive: true })
  mkdirSync(unpackDir, { recursive: true })
  mkdirSync(join(appDir, 'node_modules', '@tangle-network'), { recursive: true })

  run('pnpm', ['pack', '--pack-destination', packDir], repoRoot)
  const tarballs = run('find', [packDir, '-maxdepth', '1', '-name', '*.tgz', '-print'], repoRoot)
    .trim()
    .split('\n')
    .filter(Boolean)
  if (tarballs.length !== 1) {
    throw new Error(`expected exactly one packed tarball, found ${tarballs.length}`)
  }

  run('tar', ['-xzf', tarballs[0], '-C', unpackDir], repoRoot)
  const packageDir = join(unpackDir, 'package')
  const packageJson = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'))
  const requiredExports = {
    '.': ['import', 'types'],
    './campaign': ['import', 'types'],
    './traces': ['import', 'types'],
    './rl': ['import', 'types'],
    './meta-eval': ['import', 'types'],
    './belief-state': ['import', 'types'],
    './wire': ['import', 'types'],
    './openapi.json': ['default'],
  }

  for (const [subpath, fields] of Object.entries(requiredExports)) {
    const exportTarget = packageJson.exports?.[subpath]
    if (!exportTarget) throw new Error(`missing package export ${subpath}`)
    for (const field of fields) {
      const relativeTarget = exportTarget[field]
      if (typeof relativeTarget !== 'string') {
        throw new Error(`missing ${field} target for package export ${subpath}`)
      }
      run('test', ['-f', join(packageDir, relativeTarget)], repoRoot)
    }
  }

  symlinkSync(packageDir, join(appDir, 'node_modules', '@tangle-network', 'agent-eval'), 'dir')
  run(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      `
      `,
    ],
    appDir,
  )
  run(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      `
        const rl = await import('@tangle-network/agent-eval/rl')
        for (const name of ['campaignToRunRecords', 'extractPreferences', 'buildRlDataset', 'toSftRows', 'runRLCampaign']) {
          if (!(name in rl)) throw new Error('missing rl export ' + name)
        }
        const metaEval = await import('@tangle-network/agent-eval/meta-eval')
        if (!('InMemoryOutcomeStore' in metaEval)) throw new Error('missing meta-eval export InMemoryOutcomeStore')
        const wire = await import('@tangle-network/agent-eval/wire')
        if (!('dispatchRpc' in wire)) throw new Error('missing wire export dispatchRpc')
        const beliefState = await import('@tangle-network/agent-eval/belief-state')
        if (!('analyzeBeliefPolicy' in beliefState)) {
          throw new Error('missing belief-state export analyzeBeliefPolicy')
        }
        const campaign = await import('@tangle-network/agent-eval/campaign')
        if (!('compositeProposer' in campaign)) {
          throw new Error('missing campaign export compositeProposer')
        }
      `,
    ],
    appDir,
  )
} finally {
  rmSync(tempRoot, { recursive: true, force: true })
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (result.status !== 0) {
    throw new Error(
      [
        `command failed: ${command} ${args.join(' ')}`,
        result.stdout.trim(),
        result.stderr.trim(),
      ]
        .filter(Boolean)
        .join('\n'),
    )
  }
  return result.stdout
}
