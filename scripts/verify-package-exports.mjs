import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const tempRoot = mkdtempSync(join(repoRoot, '.tmp-package-exports-'))

try {
  verifyVersionLock()
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
        const root = await import('@tangle-network/agent-eval')
        if (!('pairedSignTest' in root)) throw new Error('missing root export pairedSignTest')
        const signTest = root.pairedSignTest([1, 0.5], 'greater')
        if (signTest.pValue !== 0.25) throw new Error('invalid packed pairedSignTest result')
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
        for (const name of [
          'compositeProposer',
          'gitWorktreeAdapter',
          'verifyCodeSurface',
          'resolveWorktreePath',
          'assertCodeSurfaceIdentity',
          'codeSurfaceIdentityMaterial',
          'analyzeCrossSurfaceInteractions',
          'surfaceHash',
          'surfaceContentHash',
          'openSearchLedger',
          'FileSearchLedger',
          'SearchLedgerIntegrityError',
          'validateSearchLedgerEvent',
        ]) {
          if (!(name in campaign)) throw new Error('missing campaign export ' + name)
        }
        const ledger = campaign.openSearchLedger({
          path: './packed-search-ledger.jsonl',
          campaignId: 'packed-consumer',
        })
        await ledger.append({
          kind: 'search-planned',
          eventId: 'packed:plan',
          occurredAt: '2026-07-11T00:00:00.000Z',
          artifacts: [{
            role: 'manifest',
            uri: 'artifact://packed-manifest',
            sha256: 'sha256:' + '0'.repeat(64),
            byteLength: 1,
          }],
          plan: {
            candidateSlots: [{
              slotId: 'slot-0',
              generationOperationId: 'proposal-0',
            }],
            tasks: [{
              taskId: 'task-0',
              source: { uri: 'git://task', revision: '1'.repeat(40) },
              benchmark: { uri: 'git://benchmark', revision: '2'.repeat(40) },
              maxAttempts: 1,
            }],
            operations: [{ operationId: 'proposal-0', kind: 'candidate-generation' }],
          },
        })
        const replay = await ledger.replay()
        if (replay.audit.eventCount !== 1 || replay.audit.expected.missingCandidateSlots[0] !== 'slot-0') {
          throw new Error('packed search ledger lost its declared denominator')
        }
        const components = [
          { componentId: 'a', surfaceId: 'profile', bestSingleEligible: true },
          { componentId: 'b', surfaceId: 'code', bestSingleEligible: true },
        ]
        const candidates = [
          { candidateId: 'fixed', componentIds: [], contentHash: '0', artifactBytes: 0 },
          { candidateId: 'a-only', componentIds: ['a'], contentHash: '1', artifactBytes: 1 },
          { candidateId: 'b-only', componentIds: ['b'], contentHash: '2', artifactBytes: 1 },
          { candidateId: 'a-b', componentIds: ['a', 'b'], contentHash: '3', artifactBytes: 2 },
        ]
        const outcomes = {
          fixed: [false, false],
          'a-only': [true, false],
          'b-only': [false, true],
          'a-b': [true, true],
        }
        const rows = candidates.flatMap((candidate) =>
          ['t1', 't2'].map((taskId, index) => ({
            taskId,
            candidateId: candidate.candidateId,
            componentIds: candidate.componentIds,
            completeness: 'complete',
            pass: outcomes[candidate.candidateId][index],
            score: Number(outcomes[candidate.candidateId][index]),
            cost: { usd: candidate.componentIds.length === 0 ? 1 : 1.1 },
            componentEvidence: candidate.componentIds.map((componentId) => ({
              componentId,
              fired: true,
              effectObserved: true,
            })),
            rejectReason: null,
          })),
        )
        const interaction = campaign.analyzeCrossSurfaceInteractions({
          components,
          candidates,
          rows,
          baselineCandidateId: 'fixed',
          taskOrder: ['t1', 't2'],
          componentOrder: ['a', 'b'],
          candidateOrder: ['fixed', 'a-only', 'b-only', 'a-b'],
          costMetricOrder: ['usd'],
          bootstrap: { seed: 7, resamples: 20, confidence: 0.95 },
          selection: {
            minimumFiringTasks: 1,
            minimumEffectTasks: 1,
            requireObservedFiring: true,
            requireObservedEffect: true,
            maximumMedianCostRatioToBaseline: { usd: 1.5 },
            minimumBundleComponents: 2,
          },
        })
        if (interaction.selections.interactionAware.selectedCandidateId !== 'a-b') {
          throw new Error('invalid packed cross-surface selection')
        }
      `,
    ],
    appDir,
  )
} finally {
  rmSync(tempRoot, { recursive: true, force: true })
}

function verifyVersionLock() {
  const npmVersion = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')).version
  const pyproject = readFileSync(join(repoRoot, 'clients/python/pyproject.toml'), 'utf8')
  const pythonSource = readFileSync(
    join(repoRoot, 'clients/python/src/agent_eval_rpc/__init__.py'),
    'utf8',
  )
  const uvLock = readFileSync(join(repoRoot, 'clients/python/uv.lock'), 'utf8')
  const pythonPackageVersion = matchVersion(
    pyproject,
    /^version\s*=\s*"([^"]+)"$/m,
    'clients/python/pyproject.toml',
  )
  const pythonFallbackVersion = matchVersion(
    pythonSource,
    /except PackageNotFoundError:\s*\n\s*__version__ = "([^"]+)"/,
    'clients/python/src/agent_eval_rpc/__init__.py',
  )
  const uvRootVersion = matchVersion(
    uvLock,
    /\[\[package\]\]\s*\nname = "agent-eval-rpc"\s*\nversion = "([^"]+)"/,
    'clients/python/uv.lock',
  )
  const versions = {
    npm: npmVersion,
    pythonPackage: pythonPackageVersion,
    pythonFallback: pythonFallbackVersion,
    uvRoot: uvRootVersion,
  }
  const mismatched = Object.entries(versions).filter(([, version]) => version !== npmVersion)
  if (mismatched.length > 0) {
    throw new Error(
      `release version mismatch: ${Object.entries(versions)
        .map(([name, version]) => `${name}=${version}`)
        .join(', ')}`,
    )
  }
}

function matchVersion(source, pattern, path) {
  const match = source.match(pattern)
  if (!match?.[1]) throw new Error(`could not read release version from ${path}`)
  return match[1]
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
