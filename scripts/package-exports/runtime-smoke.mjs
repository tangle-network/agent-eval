import { run } from './process.mjs'

export function verifyRuntimeImports(appDir) {
  run(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      `
        const root = await import('@tangle-network/agent-eval')
        const profileCell = await import('@tangle-network/agent-eval/profile-cell')
        const analyst = await import('@tangle-network/agent-eval/analyst')
        const traces = await import('@tangle-network/agent-eval/traces')
        if (!('pairedSignTest' in root)) throw new Error('missing root export pairedSignTest')
        if (!('attest' in root)) throw new Error('missing root export attest')
        if (!('verifyAttestation' in root)) throw new Error('missing root export verifyAttestation')
        const campaign = await import('@tangle-network/agent-eval/campaign')
        if (!('buildCellSchedule' in campaign)) throw new Error('missing campaign export buildCellSchedule')
        if ('rolloutReward' in root) throw new Error('obsolete root export rolloutReward')
        if (!('RawAnalystFindingSchema' in analyst)) throw new Error('missing analyst export RawAnalystFindingSchema')
        for (const name of [
          'runAnalystBenchmarkCommand',
          'readAnalystBenchmarkArtifact',
          'ANALYST_BENCHMARK_MANIFEST_FILE',
          'ANALYST_BENCHMARK_OBSERVATIONS_FILE',
          'ANALYST_BENCHMARK_LOCAL_RECEIPT_FILE',
          'ANALYST_BENCHMARK_COST_LEDGER_FILE',
          'publicBenchmarkProtocolSha256',
        ]) {
          if (!(name in analyst)) throw new Error('missing analyst benchmark export ' + name)
        }
        if ('CanonicalRawAnalystFindingSchema' in analyst) {
          throw new Error('obsolete analyst export CanonicalRawAnalystFindingSchema')
        }
        const supervisorRun = await import('@tangle-network/agent-eval/supervisor-run')
        const integrityInput = { rootId: null, nodes: [], gaps: [] }
        const integrityReport = supervisorRun.analyzeSupervisorRunIntegrity(integrityInput)
        const integrityFindings = analyst.emitControlIntegrityFindings(
          integrityInput,
          '2026-07-29T00:00:00.000Z',
        )
        const integrityCodes = new Set(
          integrityFindings.map((finding) => finding.metadata?.integrity_code),
        )
        if (
          integrityReport.input !== 'tree' ||
          !integrityCodes.has('root-unavailable') ||
          !integrityCodes.has('source-checks-unavailable')
        ) {
          throw new Error('packed control-integrity runtime exports returned an invalid result')
        }
        for (const name of [
          'buildTraceAnalysisToolDescriptors',
          'createBoundedTraceAnalysisStore',
          'TRACE_ANALYSIS_LIMITS',
          'TraceAnalysisValidationError',
          'TraceAnalysisLimitError',
          'TraceAnalysisStoreContractError',
          'TraceNotFoundError',
          'TraceFileTooLargeError',
        ]) {
          if (!(name in traces)) throw new Error('missing traces export ' + name)
        }
        const descriptors = traces.buildTraceAnalysisToolDescriptors({ store: {} })
        if (descriptors.length !== 7 || descriptors.some((tool) => tool.namespace !== 'traces')) {
          throw new Error('packed trace descriptors lost their canonical shape')
        }
        const querySchema = descriptors.find((tool) => tool.name === 'queryTraces')?.parameters
        if (
          querySchema?.properties?.limit?.type !== 'integer' ||
          querySchema.properties.limit.maximum !== 200 ||
          querySchema.additionalProperties !== false
        ) {
          throw new Error('packed queryTraces schema lost its exact limit contract')
        }
        const overviewSchema = descriptors.find(
          (tool) => tool.name === 'getDatasetOverview',
        )?.parameters
        if (
          overviewSchema?.properties?.filters?.properties?.has_errors?.type !== 'boolean' ||
          overviewSchema.properties.filters.additionalProperties !== false
        ) {
          throw new Error('packed trace filter schema is not exact')
        }
        const invalid = await descriptors
          .find((tool) => tool.name === 'queryTraces')
          .handler({ limit: 0 })
          .catch((error) => error)
        if (!(invalid instanceof traces.TraceAnalysisValidationError) || invalid.code !== 'validation') {
          throw new Error('packed trace validation error lost its stable code')
        }
        const storeContractError = new traces.TraceAnalysisStoreContractError(
          'packed-read',
          'invalid result',
        )
        if (storeContractError.code !== 'backend_integrity') {
          throw new Error('packed trace store error lost its stable code')
        }
        const traceNotFoundError = new traces.TraceNotFoundError('missing-trace')
        if (traceNotFoundError.code !== 'not_found') {
          throw new Error('packed trace not-found error lost its stable code')
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
        if (!profileCell.validateAgentProfileCell(cell).cellId.startsWith('agent-profile-cell:sha256-rfc8785:')) {
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
        for (const name of [
          'InMemoryOutcomeStore', 'OutcomeStoreError', 'auditEvaluator', 'calibrateJudge',
          'calibrationFromPairs', 'calibrateJudgeContinuous', 'continuousAgreement', 'positionalBias',
          'selfPreference', 'verbosityBias', 'rubricPredictiveValidity', 'brierScore',
        ]) {
          if (!(name in metaEval)) throw new Error('missing meta-eval export ' + name)
        }
        const systemOneProtocol = await import('@tangle-network/agent-eval/systemone/protocol')
        const systemOne = await import('@tangle-network/agent-eval/systemone')
        for (const name of [
          'normalizeSystemOneResult', 'systemOneConfidence', 'parseSystemOneRequest',
          'parseSystemOneRecordedRequest', 'parseSystemOneResult', 'systemOneUsage',
          'SystemOneResponseError',
        ]) {
          if (!(name in systemOneProtocol)) throw new Error('missing systemone/protocol export ' + name)
          if (!(name in systemOne)) throw new Error('missing systemone export ' + name)
        }
        for (const name of [
          'systemOneEvaluator', 'systemOneJudge', 'systemOneAnalyst', 'normalizedSystemOneScore',
          'prepareSystemOneReview', 'assessSystemOneReview', 'systemOneReviewFindings',
        ]) {
          if (!(name in systemOne)) throw new Error('missing systemone export ' + name)
        }
        const probabilities = { a: 0.5143, b: 0.3188, c: 0.1669 }
        const confidence = systemOneProtocol.systemOneConfidence({ type: 'choice', probabilities })
        if (Math.abs(confidence - (0.5143 - 1 / 3) / (2 / 3)) > 1e-12) {
          throw new Error('packed systemOneConfidence changed its definition')
        }
        const wire = await import('@tangle-network/agent-eval/wire')
        if (!('dispatchRpc' in wire)) throw new Error('missing wire export dispatchRpc')
        const hosted = await import('@tangle-network/agent-eval/hosted')
        for (const name of [
          'HOSTED_WIRE_VERSION',
          'IngestResponseSchema',
          'IngestSearchLedgerRequestSchema',
          'SearchLedgerHeadSchema',
          'SearchLedgerConflictSchema',
          'SearchBlobPutResponseSchema',
          'admitSearchLedgerBatch',
          'shipSearchLedger',
          'startSearchShipper',
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
          'decodeExternalTextCandidate',
          'readExternalOptimizerObservationArtifact',
          'readGepaCandidatePopulationArtifact',
          'openSearchLedger',
          'FileSearchLedger',
          'SearchLedgerIntegrityError',
          'validateSearchLedgerEvent',
          'SearchRecorder',
          'SearchState',
          'searchTaskSetDigest',
          'importGepaPopulation',
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
          'recordCandidatePopulationSearch',
          'assertSearchHistoryMatchesReplay',
        ]) {
          if (removed in campaign) throw new Error('obsolete campaign export ' + removed)
        }
        const ledger = campaign.openSearchLedger({
          path: './packed-search-ledger.jsonl',
          searchId: 'packed-consumer',
        })
        const packedSource = { uri: 'git://benchmark', revision: '2'.repeat(40) }
        const packedTasks = [{ taskId: 'task-0', unitId: 'unit-0', source: { uri: 'git://task', revision: '1'.repeat(40) } }]
        const noTasks = { taskSetDigest: campaign.searchTaskSetDigest([]), tasks: [] }
        await ledger.append({
          kind: 'search-opened',
          eventId: 'packed:open',
          occurredAt: '2026-07-11T00:00:00.000Z',
          artifacts: [],
          subject: 'packed',
          process: { name: 'packed', executionRef: packedSource },
          artifactKind: 'prompt',
          objective: {
            metric: 'score',
            direction: 'maximize',
            judge: { unknown: 'packed consumer' },
            claim: {
              use: 'development',
              population: { id: 'packed', description: 'packed consumer' },
              samplingFrame: 'one task',
              independentUnit: 'unitId',
              generalization: 'fixed-roster',
            },
          },
          splits: {
            train: { taskSetDigest: campaign.searchTaskSetDigest(packedTasks), tasks: packedTasks },
            selection: noTasks,
            test: noTasks,
            heldOutUnits: true,
          },
          policy: { expansion: 'incumbent', allocation: 'uniform', seed: 1 },
          budget: { maxUsd: null, maxCells: null, maxNodes: null, deadline: null, maxConcurrency: null, reservedClaimUsd: 0 },
          containment: null,
          derivedFrom: null,
          identity: { model: { provider: 'p', snapshot: 'm-2026-01-01' }, agent: packedSource, benchmark: packedSource },
        })
        const state = await ledger.state()
        if (state.audit.eventCount !== 1 || state.completion.complete || state.completion.reasons[0] !== 'search is open') {
          throw new Error('packed search ledger lost its open search')
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
}
