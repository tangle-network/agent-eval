import { spawnSync } from 'node:child_process'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
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
  const requiredExports = {
    '.': ['import', 'types'],
    './analyst': ['import', 'types'],
    './campaign': ['import', 'types'],
    './traces': ['import', 'types'],
    './trace-attributes': ['import', 'types'],
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
  const readme = readFileSync(join(repoRoot, 'README.md'), 'utf8')
  const quickstart = readme.match(/## Quickstart[\s\S]*?```ts\n([\s\S]*?)\n```/)?.[1]
  if (!quickstart) throw new Error('README quickstart TypeScript block was not found')
  writeFileSync(join(appDir, 'quickstart.ts'), `${quickstart}\n`)
  writeFileSync(join(appDir, 'package.json'), JSON.stringify({ type: 'module' }))
  writeFileSync(
    join(appDir, 'index.ts'),
    `
      import {
        CostLedger,
        InMemoryTraceStore,
        type CostLedgerHandle as RootCostLedgerHandle,
        type LlmJudgeOptions as RootLlmJudgeOptions,
        type ReferenceEquivalenceJudgeOptions as RootReferenceEquivalenceJudgeOptions,
        type Run,
        type RunRecord,
      } from '@tangle-network/agent-eval'
      import {
        CanonicalRawAnalystFindingSchema,
        RawAnalystFindingSchema,
        type CanonicalRawAnalystFinding,
        type RawAnalystFinding,
        type TraceAnalystGolden,
      } from '@tangle-network/agent-eval/analyst'
      import {
        type CostLedgerHandle as ContractCostLedgerHandle,
        type LlmJudgeOptions as ContractLlmJudgeOptions,
        type ReferenceEquivalenceJudgeOptions as ContractReferenceEquivalenceJudgeOptions,
        summarizeExecution,
        type ExecutionReport,
        type SurfaceProposer as ContractSurfaceProposer,
      } from '@tangle-network/agent-eval/contract'
      import {
        type CostLedgerHandle as CampaignCostLedgerHandle,
        type LlmJudgeOptions as CampaignLlmJudgeOptions,
        type ReferenceEquivalenceJudgeOptions as CampaignReferenceEquivalenceJudgeOptions,
        type SurfaceProposer as CampaignSurfaceProposer,
      } from '@tangle-network/agent-eval/campaign'
      import { stuckLoopView, type StuckLoopReport } from '@tangle-network/agent-eval/pipelines'
      import {
        LLM_REASONING_TOKENS,
        OtlpFileTraceStore,
        otlpToRunRecords,
        type TraceAnalysisStore,
      } from '@tangle-network/agent-eval/traces'
      import {
        applyLlmSpanOtlpAttributes,
        firstNumberAttr,
        LLM_CONTEXT_TOKENS,
        LLM_INPUT_TOKEN_ATTR_KEYS,
        LLM_INPUT_TOKENS,
        contextInputTokens,
      } from '@tangle-network/agent-eval/trace-attributes'

      const store: TraceAnalysisStore = new OtlpFileTraceStore({ path: 'spans.jsonl' })
      const legacyFinding: RawAnalystFinding = RawAnalystFindingSchema.parse({
        severity: 'info',
        claim: 'legacy',
        evidence_uri: 'artifact://legacy',
        confidence: 1,
      })
      const canonicalFinding: CanonicalRawAnalystFinding =
        CanonicalRawAnalystFindingSchema.parse({
          severity: 'info',
          claim: 'canonical',
          evidence: [{ uri: 'artifact://canonical' }],
          confidence: 1,
        })
      const golden: TraceAnalystGolden = {
        question: 'find corroborated failures',
        expected: [{
          severity: 'high',
          claim: 'failure',
          evidence: [
            { uri: 'span://primary' },
            { uri: 'span://corroborating' },
          ],
        }],
      }
      const runs: RunRecord[] = otlpToRunRecords('{}', {
        experimentId: 'consumer',
        candidateId: 'candidate',
      })
      const report: ExecutionReport = summarizeExecution({ runs })
      const loop: Promise<StuckLoopReport> = stuckLoopView(new InMemoryTraceStore())
      const runtimeRun: Run | undefined = undefined
      const campaignProposer = null as unknown as CampaignSurfaceProposer
      const contractProposer: ContractSurfaceProposer = campaignProposer
      const campaignRoundTrip: CampaignSurfaceProposer = contractProposer
      const campaignLlmOptions = null as unknown as CampaignLlmJudgeOptions<unknown>
      const rootLlmOptions: RootLlmJudgeOptions<unknown> = campaignLlmOptions
      const campaignLlmRoundTrip: CampaignLlmJudgeOptions<unknown> = rootLlmOptions
      const contractLlmOptions: ContractLlmJudgeOptions<unknown> = rootLlmOptions
      const campaignReferenceOptions = null as unknown as CampaignReferenceEquivalenceJudgeOptions
      const contractReferenceOptions: ContractReferenceEquivalenceJudgeOptions = campaignReferenceOptions
      const rootReferenceOptions: RootReferenceEquivalenceJudgeOptions = contractReferenceOptions
      const campaignReferenceRoundTrip: CampaignReferenceEquivalenceJudgeOptions = rootReferenceOptions
      const costLedger = new CostLedger()
      const rootCostLedger: RootCostLedgerHandle = costLedger
      const campaignCostLedger: CampaignCostLedgerHandle = costLedger
      const contractCostLedger: ContractCostLedgerHandle = costLedger
      const contextTokens = contextInputTokens({ inputTokens: 10, cachedTokens: 20 })
      const inputTokens = firstNumberAttr(
        { 'gen_ai.usage.input_tokens': '10' },
        LLM_INPUT_TOKEN_ATTR_KEYS,
      )
      const traceAttributes: Record<string, unknown> = {}
      applyLlmSpanOtlpAttributes(traceAttributes, {
        inputTokens: 10,
        cachedTokens: 20,
      })
      void [
        store,
        legacyFinding,
        canonicalFinding,
        golden,
        report,
        loop,
        runtimeRun,
        campaignRoundTrip,
        campaignLlmRoundTrip,
        contractLlmOptions,
        campaignReferenceRoundTrip,
        rootCostLedger,
        campaignCostLedger,
        contractCostLedger,
        LLM_INPUT_TOKENS,
        LLM_CONTEXT_TOKENS,
        contextTokens,
        inputTokens,
        traceAttributes,
        LLM_REASONING_TOKENS,
      ]
    `,
  )
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
      include: ['index.ts', 'quickstart.ts'],
    }),
  )
  run(join(repoRoot, 'node_modules', '.bin', 'tsc'), ['-p', 'tsconfig.json'], appDir)
  const quickstartOutput = run(process.execPath, [join(appDir, 'dist', 'quickstart.js')], appDir)
  const plainQuickstartOutput = quickstartOutput.replace(/\x1b\[[0-9;]*m/g, '')
  if (!/baseline:\s+\{ 'cites-ticket': \{ mean: 0,/.test(plainQuickstartOutput)) {
    throw new Error(`README quickstart baseline output changed:\n${quickstartOutput}`)
  }
  if (!/candidate:\s*\{ 'cites-ticket': \{ mean: 1,/.test(plainQuickstartOutput)) {
    throw new Error(`README quickstart candidate output changed:\n${quickstartOutput}`)
  }
  run(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      `
        const root = await import('@tangle-network/agent-eval')
        const analyst = await import('@tangle-network/agent-eval/analyst')
        if (!('pairedSignTest' in root)) throw new Error('missing root export pairedSignTest')
        if (!('CanonicalRawAnalystFindingSchema' in analyst)) {
          throw new Error('missing analyst export CanonicalRawAnalystFindingSchema')
        }
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
          'a-only': [false, false],
          'b-only': [false, false],
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
        if (
          interaction.selections.bestSingle !== null ||
          interaction.selections.naiveStack !== null ||
          interaction.selections.interactionAware.selectedCandidateId !== 'a-b'
        ) {
          throw new Error('packed cross-surface selector lost pure-synergy isolation')
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

function run(command, args, cwd, options = {}) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: options.timeout ?? 120_000,
  })
  if (result.status !== 0) {
    throw new Error(
      [
        `command failed: ${command} ${args.join(' ')}`,
        result.error?.message,
        String(result.stdout ?? '').trim(),
        String(result.stderr ?? '').trim(),
      ]
        .filter(Boolean)
        .join('\n'),
    )
  }
  return String(result.stdout ?? '')
}
