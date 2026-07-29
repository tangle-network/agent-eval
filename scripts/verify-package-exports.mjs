import { spawnSync } from 'node:child_process'
import {
  existsSync,
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
  const expectedDependencyCohort = {
    '@tangle-network/agent-core': '0.4.28',
    '@tangle-network/agent-interface': '0.39.0',
  }
  for (const [name, version] of Object.entries(expectedDependencyCohort)) {
    if (packageJson.dependencies?.[name] !== version) {
      throw new Error(
        `packed package dependency ${name} must be exactly ${version}, received ${packageJson.dependencies?.[name]}`,
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
    './analyst': ['import', 'types'],
    './campaign': ['import', 'types'],
    './contract': ['import', 'types'],
    './traces': ['import', 'types'],
    './trace-attributes': ['import', 'types'],
    './rl': ['import', 'types'],
    './meta-eval': ['import', 'types'],
    './hosted': ['import', 'types'],
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
  const readme = readFileSync(join(repoRoot, 'README.md'), 'utf8')
  const quickstart = readme.match(/## Evaluate An Agent[\s\S]*?```ts\n([\s\S]*?)\n```/)?.[1]
  if (!quickstart) throw new Error('README quickstart TypeScript block was not found')
  writeFileSync(join(appDir, 'quickstart.ts'), `${quickstart}\n`)
  writeFileSync(join(appDir, 'package.json'), JSON.stringify({ type: 'module' }))
  writeFileSync(
    join(appDir, 'index.ts'),
    `
      import {
        CostLedger,
        InMemoryTraceStore,
        type BenchmarkRunnerConfig,
        type ChatClient,
        type CostLedgerHandle as RootCostLedgerHandle,
        type ExecutorConfig,
        type JudgeFn,
        type LlmJudgeOptions as RootLlmJudgeOptions,
        type LlmClientOptions,
        type ReferenceEquivalenceJudgeOptions as RootReferenceEquivalenceJudgeOptions,
        type Run,
        type RunRecord,
        type RunTerminalOutcome,
        type Scenario,
        runTaskScore,
      } from '@tangle-network/agent-eval'
      import {
        RawAnalystFindingSchema,
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
        type CampaignStorage,
        type CompareOptimizationMethodsOptions,
        type LlmJudgeOptions as CampaignLlmJudgeOptions,
        type OptimizationMethodProvenance,
        type ReferenceEquivalenceJudgeOptions as CampaignReferenceEquivalenceJudgeOptions,
        type SurfaceProposer as CampaignSurfaceProposer,
      } from '@tangle-network/agent-eval/campaign'
      import {
        EvalRunEventSchema,
        IngestResponseSchema,
        type InsightReport as HostedInsightReport,
        TraceSpanEventSchema,
      } from '@tangle-network/agent-eval/hosted'
      import { stuckLoopView, type StuckLoopReport } from '@tangle-network/agent-eval/pipelines'
      import {
        LLM_REASONING_TOKENS,
        OtlpFileTraceStore,
        otlpToRunRecords,
        type ToolSpan,
        type ToolSpansToTraceAnalysisStoreOptions,
        type TraceAnalysisStore,
        ToolTraceMissingError,
        toolSpansToTraceAnalysisStore,
      } from '@tangle-network/agent-eval/traces'
      import {
        applyLlmSpanOtlpAttributes,
        firstNumberAttr,
        LLM_CONTEXT_TOKENS,
        LLM_INPUT_TOKEN_ATTR_KEYS,
        LLM_INPUT_TOKENS,
        contextInputTokens,
      } from '@tangle-network/agent-eval/trace-attributes'
      import {
        buildRlDataset,
        extractPreferences,
        toGrpoRows,
        toSftRows,
      } from '@tangle-network/agent-eval/rl'

      const store: TraceAnalysisStore = new OtlpFileTraceStore({ path: 'spans.jsonl' })
      const packedToolSpan: ToolSpan = {
        runId: 'packed-run',
        spanId: 'packed-span',
        kind: 'tool',
        name: 'tool.read',
        startedAt: 1,
        toolName: 'read',
        args: { path: 'README.md' },
      }
      const packedToolStoreOptions: ToolSpansToTraceAnalysisStoreOptions = {
        perCallByteCeiling: 10_000,
      }
      const packedToolStore: TraceAnalysisStore = toolSpansToTraceAnalysisStore(
        [packedToolSpan],
        packedToolStoreOptions,
      )
      const packedMissingTraceCode: string = new ToolTraceMissingError().code
      // @ts-expect-error provider SDK types are not part of the public API
      type RemovedProviderSdk = import('@tangle-network/agent-eval')[${JSON.stringify(removedSdkType)}]
      const removedProviderSdk: RemovedProviderSdk = {}
      // @ts-expect-error retry count belongs to ChatClient.maximumAttempts
      const removedBenchmarkRetry: BenchmarkRunnerConfig[${JSON.stringify(removedRetryField)}] = 1
      // @ts-expect-error retry count belongs to ChatClient.maximumAttempts
      const removedExecutorRetry: ExecutorConfig[${JSON.stringify(removedRetryField)}] = 1
      // @ts-expect-error LlmClientOptions uses total maximumAttempts
      type RemovedLlmMaxRetries = LlmClientOptions['maxRetries']
      // @ts-expect-error CostLedgerEntry was removed from the current-only API
      type RemovedCostLedgerEntry = import('@tangle-network/agent-eval').CostLedgerEntry
      // @ts-expect-error fixed-prompt judge factories were removed
      type RemovedCustomJudge = typeof import('@tangle-network/agent-eval').createCustomJudge
      // @ts-expect-error fixed-prompt judge factory collections were removed
      type RemovedDefaultJudges = typeof import('@tangle-network/agent-eval').defaultJudges
      // @ts-expect-error campaign cost is available only at aggregates.cost.totalCostUsd
      type RemovedCampaignCostAlias = import('@tangle-network/agent-eval/campaign').CampaignAggregates['totalCostUsd']
      // @ts-expect-error scalar off-policy qHat was removed
      type RemovedOffPolicyQHat = import('@tangle-network/agent-eval/rl').OffPolicyTrajectory['qHat']
      // @ts-expect-error scalar off-policy contribution counts were removed
      type RemovedScalarContribution = import('@tangle-network/agent-eval/rl').OffPolicyContributionCounts['legacyScalar']
      // @ts-expect-error reward components are the sole per-source aggregate
      type RemovedRewardBreakdown = import('@tangle-network/agent-eval/rl').VerifiableReward['breakdown']
      // @ts-expect-error rolloutReward was removed; use trainingReward or rolloutRewardFields
      type RemovedRolloutReward = typeof import('@tangle-network/agent-eval').rolloutReward
      // @ts-expect-error record-input rollout adapters were removed
      type RemovedTrainingRunSelection = import('@tangle-network/agent-eval/rl').TrainingRunSelectionOptions
      // @ts-expect-error duplicate line lookup type was folded into GrpoLookups
      type RemovedGrpoLineLookups = import('@tangle-network/agent-eval/rl').GrpoLineLookups
      // @ts-expect-error duplicate line lookup type was folded into SftLookups
      type RemovedSftLineLookups = import('@tangle-network/agent-eval/rl').SftLineLookups
      // @ts-expect-error duplicate preference options were folded into ExtractPreferencesOptions
      type RemovedLinePreferenceOptions = import('@tangle-network/agent-eval/rl').ExtractPreferencesFromLinesOptions
      // @ts-expect-error custom record rewards were removed with the record input
      type RemovedGrpoRewardHook = import('@tangle-network/agent-eval/rl').GrpoLookups['rewardOf']
      // @ts-expect-error preference split is named split on rollout lines
      type RemovedPreferenceSplitTag = import('@tangle-network/agent-eval/rl').ExtractPreferencesOptions['splitTag']
      // @ts-expect-error dataset stats expose one canonical split map
      type RemovedDuplicateSplitMap = import('@tangle-network/agent-eval/rl').RlDatasetStats['rolloutSplits']
      // @ts-expect-error analyst findings use one plural evidence field
      type RemovedSingularEvidence = RawAnalystFinding['evidence_uri']
      // @ts-expect-error the duplicate canonical finding type was removed
      type RemovedCanonicalFinding = import('@tangle-network/agent-eval/analyst').CanonicalRawAnalystFinding
      // @ts-expect-error the duplicate canonical finding schema was removed
      type RemovedCanonicalFindingSchema = typeof import('@tangle-network/agent-eval/analyst').CanonicalRawAnalystFindingSchema
      // @ts-expect-error analyst cost is reported through the usage receipt
      type RemovedAnalystCostAlias = import('@tangle-network/agent-eval').AnalystRunSummary['cost_usd']
      // @ts-expect-error recovery has one plural-evidence processRow callback
      type RemovedCanonicalProcessRow = import('@tangle-network/agent-eval/analyst').StructureFindingsOptions['processCanonicalRow']
      // @ts-expect-error comparison partitions use explicit train, selection, and test fields
      type RemovedComparisonHoldout = CompareOptimizationMethodsOptions<Scenario, unknown>['holdoutScenarios']
      // @ts-expect-error SurfaceProposer is the only candidate-proposal contract
      type RemovedOptimizationProposer = import('@tangle-network/agent-eval/campaign').OptimizationProposer
      // @ts-expect-error durable campaign storage must support atomic appends
      const removedReadOnlyStorage: CampaignStorage = {
        ensureDir() {},
        exists() { return false },
        read() { return undefined },
        write() {},
      }
      const removedRecordInputs = [] as RunRecord[]
      // @ts-expect-error GRPO accepts only MintedRolloutLine[]
      const removedGrpoRecordInput: Parameters<typeof toGrpoRows>[0] = removedRecordInputs
      // @ts-expect-error SFT accepts only MintedRolloutLine[]
      const removedSftRecordInput: Parameters<typeof toSftRows>[0] = removedRecordInputs
      // @ts-expect-error preference extraction accepts only MintedRolloutLine[]
      const removedPreferenceRecordInput: Parameters<typeof extractPreferences>[0] = removedRecordInputs
      // @ts-expect-error dataset packaging accepts only MintedRolloutLine[]
      const removedDatasetRecordInput: Parameters<typeof buildRlDataset>[0] = removedRecordInputs
      const canonicalChat = null as unknown as ChatClient
      const canonicalJudge = null as unknown as JudgeFn
      const rawFinding: RawAnalystFinding = RawAnalystFindingSchema.parse({
        severity: 'info',
        claim: 'current',
        evidence: [{ uri: 'artifact://current' }],
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
      const terminalOutcome: RunTerminalOutcome = 'succeeded'
      const taskScore: number | undefined = runs[0] ? runTaskScore(runs[0]) : undefined
      const failedTerminalRuns: number = report.execution.terminalOutcomes.failed
      const executionErrorEvents: number = report.execution.executionErrors.events
      const succeededWithErrors: number =
        report.execution.executionErrors.byTerminalOutcome.succeeded.withErrors
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
      const optimizationProvenance: OptimizationMethodProvenance = {
        source: {
          kind: 'package',
          evidence: 'observed',
          package: 'optimizer',
          version: '1.0.0',
        },
        optimizerModel: 'provider/model@2026-07-24',
        runId: 'run',
        resumed: false,
        evaluationCount: 1,
        artifactDir: '/tmp/optimizer',
      }
      const hostedInsight: HostedInsightReport = null as unknown as HostedInsightReport
      const hostedEventValid = EvalRunEventSchema.safeParse({
        runId: 'packed-run',
        runDir: '/tmp/packed-run',
        timestamp: '2026-07-24T00:00:00Z',
        status: 'finished',
        labels: {},
        generations: [],
        totalCostUsd: 0,
        totalDurationMs: 0,
      }).success
      if (!hostedEventValid) throw new Error('packed hosted eval-run schema rejected a valid event')
      const hostedTraceValid = TraceSpanEventSchema.safeParse({
        traceId: 'packed-trace',
        spanId: 'packed-span',
        name: 'dispatch',
        startTimeUnixNano: '1700000000000000000',
        endTimeUnixNano: '1700000000000000001',
        attributes: {},
      }).success
      if (!hostedTraceValid) throw new Error('packed hosted trace schema rejected a valid span')
      if (
        IngestResponseSchema.safeParse({
          accepted: -1,
          rejected: [{ index: 0, reason: '' }],
        }).success
      ) {
        throw new Error('packed hosted response schema accepted an invalid response')
      }
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
        packedToolStore,
        packedMissingTraceCode,
        removedProviderSdk,
        removedBenchmarkRetry,
        removedExecutorRetry,
        removedGrpoRecordInput,
        removedSftRecordInput,
        removedPreferenceRecordInput,
        removedDatasetRecordInput,
        canonicalChat,
        canonicalJudge,
        rawFinding,
        golden,
        report,
        terminalOutcome,
        taskScore,
        failedTerminalRuns,
        executionErrorEvents,
        succeededWithErrors,
        loop,
        runtimeRun,
        campaignRoundTrip,
        campaignLlmRoundTrip,
        contractLlmOptions,
        campaignReferenceRoundTrip,
        rootCostLedger,
        campaignCostLedger,
        contractCostLedger,
        optimizationProvenance,
        hostedInsight,
        hostedEventValid,
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
  if (!/\{ 'ticket-id': \{ mean: 0,/.test(plainQuickstartOutput)) {
    throw new Error(`README quickstart baseline output changed:\n${quickstartOutput}`)
  }
  if (!/\{ 'ticket-id': \{ mean: 1,/.test(plainQuickstartOutput)) {
    throw new Error(`README quickstart candidate output changed:\n${quickstartOutput}`)
  }
  run(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      `
        const root = await import('@tangle-network/agent-eval')
        const profileCell = await import('@tangle-network/agent-eval/profile-cell')
        const analyst = await import('@tangle-network/agent-eval/analyst')
        if (!('pairedSignTest' in root)) throw new Error('missing root export pairedSignTest')
        if ('rolloutReward' in root) throw new Error('obsolete root export rolloutReward')
        if (!('RawAnalystFindingSchema' in analyst)) throw new Error('missing analyst export RawAnalystFindingSchema')
        if ('CanonicalRawAnalystFindingSchema' in analyst) {
          throw new Error('obsolete analyst export CanonicalRawAnalystFindingSchema')
        }
        const signTest = root.pairedSignTest([1, 0.5], 'greater')
        if (signTest.pValue !== 0.25) throw new Error('invalid packed pairedSignTest result')
        const cell = await profileCell.buildAgentProfileCell({
          profileId: 'packed-profile',
          sourceProfile: {
            kind: 'packed',
            hash: '0'.repeat(64),
          },
        })
        if (!profileCell.validateAgentProfileCell(cell).cellId.startsWith('agent-profile-cell:sha256:')) {
          throw new Error('packed profile-cell entry rejected its generated cell')
        }
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
        if ('isTrainingRunEligible' in rl) {
          throw new Error('obsolete rl export isTrainingRunEligible')
        }
        const metaEval = await import('@tangle-network/agent-eval/meta-eval')
        if (!('InMemoryOutcomeStore' in metaEval)) throw new Error('missing meta-eval export InMemoryOutcomeStore')
        const wire = await import('@tangle-network/agent-eval/wire')
        if (!('dispatchRpc' in wire)) throw new Error('missing wire export dispatchRpc')
        const hosted = await import('@tangle-network/agent-eval/hosted')
        for (const name of [
          'HOSTED_WIRE_VERSION',
          'EvalRunEventSchema',
          'IngestResponseSchema',
          'InsightReportSchema',
          'TraceSpanEventSchema',
          'UnixNanoTimestampSchema',
        ]) {
          if (!(name in hosted)) throw new Error('missing hosted export ' + name)
        }
        const campaign = await import('@tangle-network/agent-eval/campaign')
        const contract = await import('@tangle-network/agent-eval/contract')
        for (const name of [
          'compareOptimizationMethods',
          'externalTextOptimizationMethod',
          'gepaOptimizationMethod',
          'skillOptOptimizationMethod',
        ]) {
          if (!(name in contract)) throw new Error('missing contract export ' + name)
        }
        for (const name of [
          'gitWorktreeAdapter',
          'verifyCodeSurface',
          'resolveWorktreePath',
          'assertCodeSurfaceIdentity',
          'codeSurfaceIdentityMaterial',
          'analyzeCrossSurfaceInteractions',
          'surfaceHash',
          'surfaceContentHash',
          'componentSurfaceIdentityMaterial',
          'compareOptimizationMethods',
          'externalTextOptimizationMethod',
          'gepaOptimizationMethod',
          'skillOptOptimizationMethod',
          'openSearchLedger',
          'FileSearchLedger',
          'SearchLedgerIntegrityError',
          'validateSearchLedgerEvent',
        ]) {
          if (!(name in campaign)) throw new Error('missing campaign export ' + name)
        }
        for (const removed of [
          'aceProposer',
          'fapoProposer',
          'gepaProposer',
          'skillOptProposer',
          'memoryCurationProposer',
          'evolutionaryProposer',
          'compositeProposer',
          'haloProposer',
          'traceAnalystProposer',
          'llmPolicyEditProposer',
          'policyEditProposer',
          'parameterSweepProposer',
          'runLineageLoop',
          'runLineage',
          'runSkillOpt',
        ]) {
          if (removed in campaign) throw new Error('obsolete campaign export ' + removed)
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

function verifyPackedDependencyCohort(tarball, appDir, expectedVersions) {
  writeFileSync(
    join(appDir, 'package.json'),
    JSON.stringify({
      private: true,
      type: 'module',
      dependencies: {
        '@tangle-network/agent-eval': `file:${tarball}`,
        '@tangle-network/agent-interface': expectedVersions['@tangle-network/agent-interface'],
      },
    }),
  )
  run(
    'npm',
    ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false'],
    appDir,
    { timeout: 180_000 },
  )

  for (const [name, expectedVersion] of Object.entries(expectedVersions)) {
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
    const installedVersion = JSON.parse(readFileSync(manifests[0], 'utf8')).version
    if (installedVersion !== expectedVersion) {
      throw new Error(
        `packed consumer installed ${name} ${installedVersion}, expected ${expectedVersion}`,
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
