import { repoRoot } from './package-exports/repository.mjs'
import { run } from './package-exports/process.mjs'
import { writePublicTypeFixtures } from './package-exports/type-fixtures.mjs'
import { verifyRuntimeImports } from './package-exports/runtime-smoke.mjs'
import { verifyDistTypeRuntimeAgreement } from './package-exports/type-runtime-agreement.mjs'
import { readDependencyCohort, verifyPackedDependencyCohort } from './package-exports/dependency-cohort.mjs'
import { verifyVersionLock } from './package-exports/version-lock.mjs'

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'

const tempRoot = mkdtempSync(join(repoRoot, '.tmp-package-exports-'))
const removedSdkPackage = ['@tangle-network', 'tcloud'].join('/')
const removedSdkType = ['T', 'Cloud'].join('')
const removedRetryField = ['tcloud', 'MaximumAttempts'].join('')

try {
  verifyVersionLock()
  const packDir = join(tempRoot, 'pack')
  const unpackDir = join(tempRoot, 'unpack')
  const appDir = join(tempRoot, 'app')
  const cohortAppDir = join(tempRoot, 'cohort-app')
  mkdirSync(packDir, { recursive: true })
  mkdirSync(unpackDir, { recursive: true })
  mkdirSync(join(appDir, 'node_modules', '@tangle-network'), { recursive: true })
  mkdirSync(cohortAppDir, { recursive: true })

  // Verify the same archive implementation used by the release workflow.
  run('npm', ['pack', '--pack-destination', packDir], repoRoot)
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
  if (packageJson.dependencies?.[removedSdkPackage]) {
    throw new Error(`packed package retains removed dependency ${removedSdkPackage}`)
  }
  // Read the declared range from the packed manifest and the tested version
  // from the installed tree. This keeps the check free of version literals.
  const expectedDependencyCohort = readDependencyCohort([
    '@tangle-network/agent-core',
    '@tangle-network/agent-interface',
  ])
  for (const [name, { range }] of Object.entries(expectedDependencyCohort)) {
    if (packageJson.dependencies?.[name] !== range) {
      throw new Error(
        `packed package dependency ${name} must be exactly ${range}, received ${packageJson.dependencies?.[name]}`,
      )
    }
  }
  const packedCodeFiles = run(
    'find',
    [
      join(packageDir, 'dist'),
      '-type',
      'f',
      '(',
      '-name',
      '*.js',
      '-o',
      '-name',
      '*.d.ts',
      ')',
      '-print',
    ],
    repoRoot,
  )
    .trim()
    .split('\n')
    .filter(Boolean)
  for (const file of packedCodeFiles) {
    const source = readFileSync(file, 'utf8')
    for (const removed of [removedSdkPackage, removedSdkType, removedRetryField]) {
      if (source.includes(removed)) {
        throw new Error(`packed output ${file} retains removed API ${removed}`)
      }
    }
  }
  const requiredExports = {
    '.': ['import', 'types'],
    './profile-cell': ['import', 'types'],
    './evaluation': ['import', 'types'],
    './systemone': ['import', 'types'],
    './systemone/protocol': ['import', 'types'],
    './analyst': ['import', 'types'],
    './campaign': ['import', 'types'],
    './search': ['import', 'types'],
    './contract': ['import', 'types'],
    './traces': ['import', 'types'],
    './trace-attributes': ['import', 'types'],
    './rl': ['import', 'types'],
    './meta-eval': ['import', 'types'],
    './hosted': ['import', 'types'],
    './experiment': ['import', 'types'],
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
  if (packageJson.exports?.['./jev'] || packageJson.exports?.['./jev/protocol']) {
    throw new Error('packed package retains the renamed ./jev exports')
  }
  if (packageJson.exports?.['./belief-state']) {
    throw new Error('packed package retains removed belief-state export')
  }
  if (existsSync(join(packageDir, 'dist', 'belief-state'))) {
    throw new Error('packed package retains removed belief-state files')
  }

  verifyPackedDependencyCohort(tarballs[0], cohortAppDir, expectedDependencyCohort)

  const profileCellTarget = packageJson.exports['./profile-cell'].import
  const profileCellSource = readFileSync(join(packageDir, profileCellTarget), 'utf8')
  for (const nodeOnlyModule of ['node:module', 'node:sqlite', 'opencode-sqlite', 'claude-jsonl']) {
    if (profileCellSource.includes(nodeOnlyModule)) {
      throw new Error(`packed profile-cell entry imports Node-only rollout code: ${nodeOnlyModule}`)
    }
  }

  const packedCli = join(packageDir, 'dist', 'cli.js')
  const cliHelp = run(process.execPath, [packedCli, '--help'], appDir, { timeout: 5_000 })
  if (!cliHelp.includes('agent-eval: evaluation RPC and HTTP server.')) {
    throw new Error(`packed CLI help was incomplete:\n${cliHelp}`)
  }
  const serveHelp = run(process.execPath, [packedCli, 'serve', '--help'], appDir, {
    timeout: 5_000,
  })
  if (!serveHelp.includes('serve [--port 5005]')) {
    throw new Error(`packed CLI serve help was incomplete:\n${serveHelp}`)
  }
  const cliVersion = run(process.execPath, [packedCli, '--version'], appDir, { timeout: 5_000 })
  if (cliVersion.trim() !== packageJson.version) {
    throw new Error(`packed CLI version mismatch: ${cliVersion.trim()} != ${packageJson.version}`)
  }

  symlinkSync(packageDir, join(appDir, 'node_modules', '@tangle-network', 'agent-eval'), 'dir')
  verifyDistTypeRuntimeAgreement(packageJson, appDir)
  const readme = readFileSync(join(repoRoot, 'README.md'), 'utf8')
  const quickstart = readme.match(/## Quickstart[\s\S]*?```ts\n([\s\S]*?)\n```/)?.[1]
  if (!quickstart) throw new Error('README quickstart TypeScript block was not found')
  writeFileSync(join(appDir, 'quickstart.ts'), `${quickstart}
    for (const [result, expected] of [[baseline, 0], [candidate, 1]] as const) {
      const distribution = result.aggregates.byJudge['ticket-id']?.distribution
      if (
        !distribution || distribution.n !== 3 || distribution.sum !== expected * 3 ||
        distribution.min !== expected || distribution.p50 !== expected ||
        distribution.p90 !== expected || distribution.max !== expected
      ) {
        throw new Error('README quickstart lost its complete score distribution')
      }
    }
  `)
  writeFileSync(join(appDir, 'package.json'), JSON.stringify({ type: 'module' }))
  writePublicTypeFixtures(appDir, removedSdkType)
  writeFileSync(
    join(appDir, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        target: 'ES2022',
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        strict: true,
        skipLibCheck: true,
        outDir: 'dist',
      },
      include: ['index.ts', 'quickstart.ts', 'integrity-imports.ts', 'canary-import.ts'],
    }),
  )
  run(join(repoRoot, 'node_modules', '.bin', 'tsc'), ['-p', 'tsconfig.json'], appDir)
  run(process.execPath, [join(appDir, 'dist', 'integrity-imports.js')], appDir)
  run(process.execPath, [join(appDir, 'dist', 'canary-import.js')], appDir)
  const quickstartOutput = run(process.execPath, [join(appDir, 'dist', 'quickstart.js')], appDir)
  const plainQuickstartOutput = quickstartOutput.replace(/\x1b\[[0-9;]*m/g, '')
  const expectedQuickstartOutput = readme.match(/## Quickstart[\s\S]*?```text\n([\s\S]*?)\n```/)?.[1]
  if (!expectedQuickstartOutput || plainQuickstartOutput.trim() !== expectedQuickstartOutput.trim()) {
    throw new Error(`README quickstart output differs from its documented output:\n${quickstartOutput}`)
  }
  verifyRuntimeImports(appDir)
} finally {
  rmSync(tempRoot, { recursive: true, force: true })
}
