import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

export function writePublicTypeFixtures(appDir, removedSdkType) {
  writeFileSync(
    join(appDir, 'index.ts'),
    `
      import {
        CostLedger,
        AnalystRegistry as RootAnalystRegistry,
        InMemoryTraceStore,
        attest,
        makeFinding,
        type AnalystRunResult,
        type ChatClient,
        type CostLedgerHandle as RootCostLedgerHandle,
        type ExactRegistryRunOpts as RootExactRegistryRunOpts,
        type LlmJudgeOptions as RootLlmJudgeOptions,
        type Run,
        type RunRecord,
        type RunTokenUsage,
        type RunTerminalOutcome,
        type Scenario,
        runTaskScore,
        verifyAttestation,
        type AttestedReport,
        type DefaultVerdict,
      } from '@tangle-network/agent-eval'
      import {
        CONTROL_INTEGRITY_ANALYST,
        ControlIntegrityAnalyst,
        AnalystRegistry as AnalystSubpathRegistry,
        RawAnalystFindingSchema,
        agentRxBenchmarkCase,
        agentRxPredictionsToFindings,
        codeTraceBenchCase,
        codeTracerPredictionsToFindings,
        emitControlIntegrityFindings,
        traceStoreEvidenceResolver,
        type AnalystBenchmarkCase,
        type ExactExecutionComponentIdentity as AnalystExactExecutionComponentIdentity,
        type ExactRegistryRunOpts as AnalystExactRegistryRunOpts,
        type RawAnalystFinding,
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
        buildCellSchedule,
        type CampaignStorage,
        type CellScheduleSlot,
        type CompareOptimizationMethodsOptions,
        decodeExternalTextCandidate,
        type ExternalOptimizerSubmittedCandidate,
        type GepaCandidatePopulationArtifact,
        type LlmJudgeOptions as CampaignLlmJudgeOptions,
        type OptimizationMethodProvenance,
        type ReferenceEquivalenceJudgeOptions as CampaignReferenceEquivalenceJudgeOptions,
        readExternalOptimizerObservationArtifact,
        readGepaCandidatePopulationArtifact,
        type Scenario as CampaignScenario,
        type SeriesDistribution as CampaignSeriesDistribution,
        type JudgeAggregate as CampaignJudgeAggregate,
        type SurfaceProposer as CampaignSurfaceProposer,
      } from '@tangle-network/agent-eval/campaign'
      import {
        IngestResponseSchema,
        IngestSearchLedgerRequestSchema,
        type SearchLedgerHead,
        TraceSpanEventSchema,
      } from '@tangle-network/agent-eval/hosted'
      import { stuckLoopView, type StuckLoopReport } from '@tangle-network/agent-eval/pipelines'
      import {
        buildTraceAnalysisToolDescriptors,
        createBoundedTraceAnalysisStore,
        LLM_REASONING_TOKENS,
        OtlpFileTraceStore,
        otlpToRunRecords,
        TRACE_ANALYSIS_LIMITS,
        TraceAnalysisLimitError,
        TraceAnalysisStoreContractError,
        TraceAnalysisValidationError,
        TraceNotFoundError,
        type TraceAnalysisToolDescriptor,
        type ToolSpan,
        type ToolSpansToTraceAnalysisStoreOptions,
        type TraceAnalysisStore,
        TRACE_ANALYST_TOOL_NAMESPACE,
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
        toSftRowsWithLookups,
        type VerifiableRewardSource,
      } from '@tangle-network/agent-eval/rl'
      import {
        analyzeSupervisorRunIntegrity,
        type SupervisorRunIntegrityReport,
        type SupervisorRunSources,
        type SupervisorRunTree,
        type SupervisorRunTreeGap,
      } from '@tangle-network/agent-eval/supervisor-run'

      const store: TraceAnalysisStore = new OtlpFileTraceStore({ path: 'spans.jsonl' })
      const traceToolDescriptors: TraceAnalysisToolDescriptor[] =
        buildTraceAnalysisToolDescriptors({ store })
      const traceToolNamespace: 'traces' = TRACE_ANALYST_TOOL_NAMESPACE
      const boundedStore: TraceAnalysisStore = createBoundedTraceAnalysisStore(store)
      const traceValidationCode: 'validation' = new TraceAnalysisValidationError('bad input').code
      const traceLimitCode: 'limit_exceeded' = new TraceAnalysisLimitError(
        'packed-read',
        2,
        1,
      ).code
      const traceStoreCode: 'backend_integrity' = new TraceAnalysisStoreContractError(
        'packed-read',
        'invalid result',
      ).code
      const traceNotFoundCode: 'not_found' = new TraceNotFoundError('missing-trace').code
      const tracePageLimit: 200 = TRACE_ANALYSIS_LIMITS.queryTraces
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
      // @ts-expect-error the credential-bearing transport left the public API (#539)
      type RemovedLlmClientOptions = import('@tangle-network/agent-eval').LlmClientOptions
      // @ts-expect-error agent-eval executes no paid model: callLlm left the public API (#539)
      type RemovedCallLlm = typeof import('@tangle-network/agent-eval').callLlm
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
      // @ts-expect-error one-shot finding structuring was removed; use a recursive analysis engine
      type RemovedStructureFindingsOptions = import('@tangle-network/agent-eval/analyst').StructureFindingsOptions
      // @ts-expect-error trace analysts run through an analysis engine, not an Ax client
      type RemovedCreateAnalystAi = typeof import('@tangle-network/agent-eval/analyst').createAnalystAi
      // @ts-expect-error trace analysts run through an analysis engine, not an Ax client
      type RemovedCreateAnalystAiConfig = import('@tangle-network/agent-eval/analyst').CreateAnalystAiConfig
      // @ts-expect-error trace analysts are created from TraceAnalystDefinition via createTraceAnalyst
      type RemovedCreateTraceAnalystKind = typeof import('@tangle-network/agent-eval/analyst').createTraceAnalystKind
      // @ts-expect-error TraceAnalystDefinition is the one analyst definition contract
      type RemovedTraceAnalystKindSpec = import('@tangle-network/agent-eval/analyst').TraceAnalystKindSpec
      // @ts-expect-error TraceAnalystDefinition is the one analyst definition contract
      type RemovedCreateTraceAnalystKindOpts = import('@tangle-network/agent-eval/analyst').CreateTraceAnalystKindOpts
      // @ts-expect-error steering optimization is pairwise-only
      type RemovedAxGepaSteeringOptimizer = typeof import('@tangle-network/agent-eval').AxGepaSteeringOptimizer
      // @ts-expect-error steering optimization is pairwise-only
      type RemovedAxSteeringOptimizerConfig = import('@tangle-network/agent-eval').AxSteeringOptimizerConfig
      // @ts-expect-error trace analysis reports engine iterations, not per-turn snapshots
      type RemovedAnalyzeTracesTurnSnapshot = import('@tangle-network/agent-eval/traces').AnalyzeTracesTurnSnapshot
      // @ts-expect-error the direct one-shot runner is the explicit baseline, not the model runner
      type RemovedCreatePublicBenchmarkModelRunner = typeof import('@tangle-network/agent-eval/analyst').createPublicBenchmarkModelRunner
      // @ts-expect-error trace tools are built from transport-neutral descriptors
      type RemovedBuildTraceAnalystTools = typeof import('@tangle-network/agent-eval/traces').buildTraceAnalystTools
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
      const removedSftRecordInput: Parameters<typeof toSftRowsWithLookups>[0] = removedRecordInputs
      // @ts-expect-error preference extraction accepts only MintedRolloutLine[]
      const removedPreferenceRecordInput: Parameters<typeof extractPreferences>[0] = removedRecordInputs
      // @ts-expect-error dataset packaging accepts only MintedRolloutLine[]
      const removedDatasetRecordInput: Parameters<typeof buildRlDataset>[0] = removedRecordInputs
      const canonicalChat = null as unknown as ChatClient
      const exactComponentIdentity: AnalystExactExecutionComponentIdentity = {
        id: 'package-check',
        version: '1.0.0',
        config: { mode: 'compile-check' },
      }
      const exactRunOptions: RootExactRegistryRunOpts = {
        analystIds: ['package-check'],
        budget: null,
        totalTimeoutMs: null,
        signal: null,
        costLedger: null,
        costLedgerIdentity: null,
        costPhase: null,
        tags: null,
        priorFindings: null,
        chainFindings: false,
        missingInputMode: 'abort',
        applyRegistryHooks: false,
        useRegistryChat: false,
      }
      const analystExactRunOptions: AnalystExactRegistryRunOpts = exactRunOptions
      const rootExactRegistry = new RootAnalystRegistry()
      const analystExactRegistry = new AnalystSubpathRegistry()
      const controlIntegrityAnalyst: ControlIntegrityAnalyst = CONTROL_INTEGRITY_ANALYST
      const controlIntegrityInput = undefined as SupervisorRunSources | SupervisorRunTree | undefined
      const controlIntegrityReport = undefined as SupervisorRunIntegrityReport | undefined
      const controlTreeGap: SupervisorRunTreeGap = {
        code: 'journal-unavailable',
        message: 'not captured',
      }
      // Verdict certification is additive: the bare pre-certification shape
      // must stay assignable, and the certified shape must keep its
      // structural certification field.
      const packedUncertifiedVerdict: DefaultVerdict = { valid: true, score: 0.5 }
      const packedCertifiedVerdict: DefaultVerdict = {
        ...packedUncertifiedVerdict,
        certification: {
          strategy: 'proof-kernel',
          checker: { name: 'lean4', version: '4.33.0', pins: { mathlib: 'db584cd6d46c' } },
          assumptions: ['diagonal embedding argued in prose'],
          evidenceDigest: 'sha256:package-check',
        },
      }
      const packedOpenRewardSources: VerifiableRewardSource[] = [
        'test',
        'proof-kernel',
        'invariant',
        'replication',
        'agreement',
      ]
      const rawFinding: RawAnalystFinding = RawAnalystFindingSchema.parse({
        severity: 'info',
        claim: 'current',
        evidence: [{ uri: 'artifact://current' }],
        confidence: 1,
      })
      const reviewedFinding = makeFinding({
        analyst_id: 'package-check',
        area: 'package',
        claim: 'The finding factory is exported.',
        severity: 'info',
        confidence: 1,
        evidence_refs: [{ kind: 'artifact', uri: 'artifact://package-check' }],
      })
      const reviewedRun: AnalystRunResult = {
        run_id: 'package-check-run',
        correlation_id: 'package-check-correlation',
        started_at: '2026-07-29T00:00:00.000Z',
        ended_at: '2026-07-29T00:00:01.000Z',
        findings: [reviewedFinding],
        per_analyst: [],
        total_cost_usd: 0,
        total_cost_provenance: { kind: 'observed', usd: 0 },
      }
      const analystCase: AnalystBenchmarkCase<string> = {
        id: 'corroborated-failure',
        clusterId: 'corroborated-failure',
        labelState: 'positive',
        input: 'trace://failure',
        expectedIssues: [{
          id: 'failure',
          evidence: [{ uri: 'span://primary' }, { uri: 'span://corroborating' }],
          evidenceMode: 'all',
          criticalEvidence: [{ uri: 'span://primary' }],
        }],
        labeledEvidence: [{ uri: 'span://primary' }, { uri: 'span://corroborating' }],
      }
      const agentRxCase = agentRxBenchmarkCase({
        trajectory_id: 'agent-rx',
        failures: [{
          failure_id: 'failure-1',
          step_number: 1,
          step_reason: 'failed',
          failure_category: 'System Failure',
        }],
        root_cause_failure_id: 'failure-1',
      }, 'trajectory')
      const codeTraceCase = codeTraceBenchCase({
        traj_id: 'code-trace',
        agent: 'agent',
        model: 'model',
        task_name: 'task',
        step_count: 1,
        incorrect_stages: [{ stage_id: 1, incorrect_step_ids: [1] }],
      }, 'trajectory')
      const agentRxFindings = agentRxPredictionsToFindings('agent-rx', {
        failure_case: 9,
        step_number: 1,
      })
      const codeTraceFindings = codeTracerPredictionsToFindings('code-trace', [{
        stage_id: 1,
        incorrect_step_ids: [1],
      }])
      const evidenceResolver = traceStoreEvidenceResolver<{ traceStore: TraceAnalysisStore }>(
        (input) => input.traceStore,
      )
      const runs: RunRecord[] = otlpToRunRecords('{}', {
        experimentId: 'consumer',
        candidateId: 'candidate',
      })
      const incompleteTokenUsage: RunTokenUsage = {
        input: 7,
        output: 3,
        tokensKnown: false,
      }
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
      const campaignReferenceRoundTrip: CampaignReferenceEquivalenceJudgeOptions = contractReferenceOptions
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
      const submittedCandidate = null as unknown as ExternalOptimizerSubmittedCandidate
      const gepaPopulation = null as unknown as GepaCandidatePopulationArtifact
      const hostedHead: SearchLedgerHead = { searchId: 'packed', nextSequence: 0, headHash: null }
      const hostedBatchValid = IngestSearchLedgerRequestSchema.safeParse({
        wireVersion: '2026-07-24.v1',
        searchId: 'packed',
        runKind: 'optimization',
        fromSequence: 0,
        lines: ['{}'],
      }).success
      if (!hostedBatchValid) throw new Error('packed hosted search-ledger schema rejected a valid batch')
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
      // The cell grid is readable without a run directory: no filesystem, no
      // throwaway path.
      const packedSchedule: CellScheduleSlot<CampaignScenario>[] = buildCellSchedule(
        [{ id: 'packed-scenario', kind: 'packed' }],
        42,
        2,
      )
      const packedCellIds: string[] = packedSchedule.map((slot) => slot.cellId)
      // A campaign aggregate carries the package's one distribution shape.
      const packedDistribution: CampaignSeriesDistribution | undefined = (
        undefined as CampaignJudgeAggregate | undefined
      )?.distribution
      // Evidence receipts: content-address a report and bind it to provenance.
      const packedAttestation: AttestedReport = attest(
        { claim: 'packed' },
        { modelVersions: {}, codeSha: 'packed', createdAt: '2026-07-24T00:00:00.000Z' },
      )
      const packedAttestationValid: boolean = verifyAttestation(
        { claim: 'packed' },
        packedAttestation,
      ).valid
      if (!packedAttestationValid) throw new Error('packed attestation failed to verify')
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
        traceToolDescriptors,
        traceToolNamespace,
        boundedStore,
        traceValidationCode,
        traceLimitCode,
        traceStoreCode,
        traceNotFoundCode,
        tracePageLimit,
        packedToolStore,
        packedMissingTraceCode,
        removedProviderSdk,
        removedGrpoRecordInput,
        removedSftRecordInput,
        removedPreferenceRecordInput,
        removedDatasetRecordInput,
        canonicalChat,
        exactComponentIdentity,
        exactRunOptions,
        analystExactRunOptions,
        rootExactRegistry,
        analystExactRegistry,
        controlIntegrityAnalyst,
        controlIntegrityInput,
        controlIntegrityReport,
        controlTreeGap,
        analyzeSupervisorRunIntegrity,
        emitControlIntegrityFindings,
        rawFinding,
        reviewedRun,
        analystCase,
        agentRxCase,
        agentRxFindings,
        codeTraceCase,
        codeTraceFindings,
        evidenceResolver,
        report,
        incompleteTokenUsage,
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
        submittedCandidate,
        gepaPopulation,
        decodeExternalTextCandidate,
        readExternalOptimizerObservationArtifact,
        readGepaCandidatePopulationArtifact,
        hostedHead,
        hostedBatchValid,
        LLM_INPUT_TOKENS,
        LLM_CONTEXT_TOKENS,
        contextTokens,
        inputTokens,
        traceAttributes,
        LLM_REASONING_TOKENS,
        packedCellIds,
        packedDistribution,
        packedAttestation,
      ]
    `,
  )
  writeFileSync(
    join(appDir, 'integrity-imports.ts'),
    `
      import type {
        Scenario as RootScenario,
        JudgeScore as RootJudgeScore,
        GateDecision as RootGateDecision,
        ProductScenario,
        DimensionJudgeScore,
        HeldOutGate,
        HeldOutGateDecision,
        JudgeFn,
        JudgeInput,
      } from '@tangle-network/agent-eval'
      import type {
        Scenario,
        JudgeScore,
        GateDecision,
        FinalEvidencePolicy,
      } from '@tangle-network/agent-eval/contract'
      import {
        searchEstimateMethod,
        type SearchEstimateMethod,
      } from '@tangle-network/agent-eval/campaign'
      import {
        defineEvaluationClaim,
        summarizeEvaluationUnits,
        openFinalEvidenceLedger,
        FinalEvidenceError,
        FinalEvidenceConflictError,
      } from '@tangle-network/agent-eval/experiment'
      import {
        auditEvaluator,
        calibrationFromPairs,
        calibrateJudgeContinuous,
        positionalBias,
        selfPreference,
        OutcomeStoreError,
        type EvaluatorAuditInput,
        type OutcomeMetricSpec,
        type RubricOutcomeExclusion,
      } from '@tangle-network/agent-eval/meta-eval'

      type Equal<A, B> =
        (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false
      const scenarioMatches: Equal<RootScenario, Scenario> = true
      const scoreMatches: Equal<RootJudgeScore, JudgeScore> = true
      const decisionMatches: Equal<RootGateDecision, GateDecision> = true
      const productMatches: Equal<JudgeInput['scenario'], ProductScenario> = true
      const dimensionMatches: Equal<Awaited<ReturnType<JudgeFn>>, DimensionJudgeScore[]> = true
      const heldoutMatches: Equal<ReturnType<HeldOutGate['evaluate']>, HeldOutGateDecision> = true
      const searchEstimateMethodMatches: Equal<ReturnType<typeof searchEstimateMethod>, SearchEstimateMethod> = true

      const searchEstimateCases: [number, SearchEstimateMethod][] = [
        [0, 'none'],
        [1, 'none'],
        [2, 'insufficient'],
        [5, 'insufficient'],
        [6, 'descriptive'],
        [19, 'descriptive'],
        [20, 'bootstrap'],
        [100, 'bootstrap'],
      ]
      for (const [pairs, expected] of searchEstimateCases) {
        const method = searchEstimateMethod(pairs)
        if (method !== expected) {
          throw new Error('packed search estimate method for ' + pairs + ': expected ' + expected + ', received ' + method)
        }
      }

      const claim = defineEvaluationClaim({
        use: 'comparison',
        population: { id: 'support', description: 'Support incidents.' },
        samplingFrame: 'A queue sample before optimization.',
        independentUnit: 'incidentId',
        generalization: 'new-units',
        minimumEffect: 0.05,
      })
      const units = summarizeEvaluationUnits(claim, [
        { incidentId: 'same-incident' }, { incidentId: 'same-incident' },
      ])
      const finalEvidence: FinalEvidencePolicy = {
        ledger: openFinalEvidenceLedger({ path: 'final-evidence.jsonl' }),
        requestId: 'comparison-1',
        evaluatorDigest: 'sha256:1111111111111111111111111111111111111111111111111111111111111111',
      }
      const outcome: OutcomeMetricSpec = { id: 'failure-rate', direction: 'lower-is-better' }
      const exclusion: RubricOutcomeExclusion = {
        rubric: 'correctness', outcome: outcome.id, outcomeDirection: outcome.direction,
        n: 0, reason: 'insufficient_samples',
      }
      const audit: EvaluatorAuditInput = {
        evaluatorDigest: finalEvidence.evaluatorDigest,
        population: 'Support outputs.',
        samplingFrame: 'Independent held-back incidents.',
        authority: {
          evaluatorAuthorId: 'author', auditorId: 'auditor',
          independenceEvidenceRef: 'artifact://audit-policy',
        },
        policy: {
          confidence: 0.95, maxFalseAcceptanceRate: 0.1, maxFalseRejectionRate: 0.1,
        },
        observations: [{
          id: 'unknown', independentUnitId: 'incident-1', evidenceRef: 'artifact://unknown',
          expected: 'reject', observed: 'unknown', exposure: 'fresh',
        }],
      }
      const calibration = calibrationFromPairs([
        { evalScore: 1, outcome: 0 }, { evalScore: 1, outcome: 0 },
      ], 'confidence', 'success')
      if (calibration?.n !== 2 || calibration.ece !== 1) {
        throw new Error('packed calibration lost direct observations')
      }
      const report = auditEvaluator(audit)
      if (units.independentUnits !== 1 || units.observations !== 2) {
        throw new Error('packed claim conflated observations and independent units')
      }
      if (report.verdict !== 'inconclusive' || report.coverage.unknownCases !== 1) {
        throw new Error('packed evaluator audit lost unknown evidence')
      }
      void [
        scenarioMatches, scoreMatches, decisionMatches, productMatches, dimensionMatches,
        heldoutMatches, searchEstimateMethodMatches, exclusion, calibrateJudgeContinuous, positionalBias, selfPreference,
        OutcomeStoreError, FinalEvidenceError, FinalEvidenceConflictError,
      ]
    `,
  )
  writeFileSync(
    join(appDir, 'canary-import.ts'),
    `
      import {
        decideRandomizedCanary,
        randomizedCanaryObservationDigest,
        randomizedCanaryRosterDigest,
        sealRandomizedCanaryRule,
        type CanaryObservation,
      } from '@tangle-network/agent-eval/experiment'

      const rows: CanaryObservation[] = ['control', 'candidate'].map((arm, i) => ({
        assignmentId: String(i), assignmentSourceId: 'assignment:' + i,
        clusterId: String(i), arm: arm as 'control' | 'candidate',
        checkedOutcome: i as 0 | 1, outcomeSourceId: 'checker:' + i,
        billedCostUsd: 0, billingSourceId: 'billing:' + i,
        traceSourceId: 'trace:' + i, noExecutionSourceId: null, turns: 1,
        servedProfileDigest: arm === 'control' ? 'control' : 'candidate',
        servedCodeRevisionDigest: 'served-revision',
        outcomeCheckerDigest: 'checker-revision',
      }))
      const sealed = sealRandomizedCanaryRule({
        experimentId: 'packed-canary', populationId: 'packed-test',
        eligibilityRuleDigest: 'eligibility', randomizationSourceId: 'packed-randomizer',
        assignmentLedgerAuthorityId: 'packed-ledger',
        controlProfileDigest: 'control', candidateProfileDigest: 'candidate',
        servedCodeRevisionDigest: 'served-revision', outcomeCheckerDigest: 'checker-revision',
        confirmatoryFamilyId: 'packed-family', confirmatoryFamilySize: 1,
        confirmatoryIndex: 1, familyReservationSourceId: 'packed-family-slot',
        assignmentUnit: 'session', clusterUnit: 'session',
        stoppingRule: 'fixed-time', analysisCutoff: '2026-09-25T06:00:00Z',
        outcomeMaturityMs: 120_000, minimumLift: 0, minimumClusters: 40,
      })
      const cohort = {
        protocolDigest: sealed.digest,
        assignmentRosterDigest: randomizedCanaryRosterDigest(rows),
        assignmentCount: 2, assignmentLedgerSourceId: 'packed-assignments',
        assignmentLedgerTipDigest: 'sha256:' + 'a'.repeat(64),
        outcomeLedgerSourceId: 'packed-outcomes', billingLedgerSourceId: 'packed-billing',
        observationSnapshotDigest: randomizedCanaryObservationDigest(rows),
        observationFrozenAt: '2026-09-25T06:02:00Z',
        authorityId: 'packed-ledger', attestationSourceId: 'packed-attestation',
        closedAt: '2026-09-25T06:01:00Z', attestedAt: '2026-09-25T06:03:00Z',
      }
      const decision = decideRandomizedCanary(sealed, cohort, rows, (receipt) => ({
        verified: true, authorityId: receipt.authorityId,
        protocolWitnessedBeforeTraffic: true,
        familySlotReservedBeforeTraffic: true,
        eligibilityAndDispositionVerified: true,
        randomizationVerified: true,
        rosterCompleteAtCutoff: true,
        outcomeAndBillingSnapshotFrozen: true,
        sourceJoinsVerified: true,
        armIsolationVerified: true,
      }))
      if (decision.refusal !== 'insufficient-clusters' ||
          decision.coverage.control.checkedOutcomes !== 1 ||
          decision.controlBilledCostUsd !== 0) {
        throw new Error('packed canary decision lost refusal or receipt coverage')
      }
    `,
  )
}
