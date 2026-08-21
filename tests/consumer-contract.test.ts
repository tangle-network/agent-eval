import { describe, expect, it } from 'vitest'
import type {
  ChatCallOpts,
  ChatTransport,
  CustomTransportOpts,
  SandboxSdkTransportOpts,
} from '../src/analyst/chat-client'
import * as builderEval from '../src/builder-eval/index'
import * as campaign from '../src/campaign/index'
import * as contract from '../src/contract/index'
import type {
  ChatClient,
  ChatRequest,
  ChatResponse,
  CounterfactualContext,
  CounterfactualRunner,
  CreateChatClientOpts,
  ErrorCluster,
  JudgeScoresRecord,
  MockTransportOpts,
  ProposalFinding,
  RunOutcome,
  RuntimeTrajectoryHookEvent,
} from '../src/index'
import * as agentEval from '../src/index'
import * as rl from '../src/rl/index'
import * as testing from '../src/testing'

/**
 * Public-surface contract for `@tangle-network/agent-eval`.
 *
 * Pins the symbols the five product-agent consumers (tax/creative/legal/gtm/agent-builder)
 * import from this package. A failure here means a consumer would silently break on the
 * next version bump — fix the export (preferred) or coordinate the rename across all
 * consumers before changing this list.
 *
 * Sourced by scanning `import ... from '@tangle-network/agent-eval'` across the
 * consumer repos on 2026-08-11. Update this list when consumers adopt new exports.
 */

const ROOT_ERROR_CLASSES = [
  // Runtime error constructors. Type-only exports like `AgentEvalErrorCode`
  // (a string-literal union) are validated by the namespace import compiling.
  'AgentEvalError',
  'BudgetBreachError',
  'ConfigError',
  'JudgeError',
  'NotFoundError',
  'ValidationError',
] as const

const ROOT_RUNTIME_SYMBOLS = [
  // Trace storage
  'FileSystemTraceStore',
  'InMemoryTraceStore',
  'isJudgeSpan',
  // agent-runtime supervise surface imports these from the root
  'isToolSpan',
  'OUTPUT_VALUE',
  // Caller-owned model transport + retry
  'withJudgeRetry',
  'createChatClient',
  // Verifier / review / campaign
  'MultiLayerVerifier',
  'runEvalCampaign',
  'HeldOutGate',
  'runCanaries',
  // Counterfactual replay (traces imports these from the root)
  'runCounterfactual',
  // Propose/review loop (discovery-lab tools/propose-v9.mjs imports these from the root)
  'runProposeReviewAsControlLoop',
  'createLlmReviewer',
  'jsonlReviewStore',
  'makeProposalFinding',
  // Product benchmark packaging (creative-agent eval/research-package.ts)
  'assertProductBenchmarkRun',
  'exportProductBenchmark',
  'exportProductBenchmarkRuns',
  'productBenchmarkRepoIdentity',
  'readProductBenchmarkManifest',
  // Budget guard (creative-agent scripts/evals/run-driver-soak.ts)
  'BudgetGuard',
  // Paired statistics (gtm-agent eval/matrix/report.ts, agent-dev-container intelligence)
  'pairedDeltaTest',
  'pairRunRecords',
  // Runtime trajectory + knowledge readiness (agent-dev-container platform/intelligence)
  'projectRuntimeTrajectoryEvidence',
  'knowledgeReadinessTracePayload',
  // Substrate primitives
  'discoverPersonas',
  'scoreKnowledgeReadiness',
  // Stats helpers
  'estimateCost',
  'estimateTokens',
  'iqr',
  'pairedEvalueSequence',
  'corpusInterRaterAgreement',
  'corpusInterRaterAgreementFromJudgeScores',
  // Preference memory rendering
  'renderPreferenceMemoryMarkdown',
  'summarizePreferenceMemory',
] as const

const RL_SYMBOLS = ['campaignToRunRecords', 'verificationReportToRunRecord'] as const
describe('public-surface contract for consumers', () => {
  it('exports every load-bearing runtime symbol from the root entry', () => {
    const missing = ROOT_RUNTIME_SYMBOLS.filter(
      (name) => (agentEval as Record<string, unknown>)[name] === undefined,
    )
    expect(missing, `removed/renamed symbols would break consumers: ${missing.join(', ')}`).toEqual(
      [],
    )
  })

  it('exports every error class from the root entry', () => {
    const missing = ROOT_ERROR_CLASSES.filter(
      (name) => (agentEval as Record<string, unknown>)[name] === undefined,
    )
    expect(missing, `missing error exports: ${missing.join(', ')}`).toEqual([])
  })

  it('exports the rl subpath surface consumers depend on', () => {
    const missing = RL_SYMBOLS.filter((name) => (rl as Record<string, unknown>)[name] === undefined)
    expect(missing, `missing rl subpath exports: ${missing.join(', ')}`).toEqual([])
    expect(typeof (rl as Record<string, unknown>).toSftRows).toBe('function')
    expect(typeof (rl as Record<string, unknown>).runRLCampaign).toBe('function')
  })

  it('exposes testing-only helpers only through the testing subpath', () => {
    expect((agentEval as Record<string, unknown>).resetLockedAppendersForTesting).toBeUndefined()
    expect(typeof testing.resetLockedAppendersForTesting).toBe('function')
  })

  it('exposes a builder-eval subpath used by agent-builder', () => {
    expect(builderEval, 'builder-eval subpath must resolve').toBeDefined()
    expect(
      Object.keys(builderEval).length,
      'builder-eval must export at least one symbol',
    ).toBeGreaterThan(0)
  })

  it('every error class constructor is a function (consumers can `instanceof` them)', () => {
    for (const name of ROOT_ERROR_CLASSES) {
      const sym = (agentEval as Record<string, unknown>)[name]
      expect(typeof sym, `${name} must be a class constructor`).toBe('function')
      const proto = (sym as { prototype?: unknown }).prototype
      expect(proto, `${name}.prototype must exist`).toBeDefined()
      expect(proto instanceof Error, `${name} must extend Error`).toBe(true)
    }
  })

  it('exposes JudgeScoresRecord as the canonical ensemble shape on RunOutcome', () => {
    // Type-level pin: a `JudgeScoresRecord` is assignable to
    // `RunOutcome.judgeScores`. If the interface gets renamed or the
    // field gets dropped from `RunOutcome`, this stops compiling — the
    // contract that protects forge-chat / multi-judge consumers.
    const judgeScores: JudgeScoresRecord = {
      perJudge: { 'kimi-k2.6': { helpfulness: 0.8, clarity: 0.7 } },
      perDimMean: { helpfulness: 0.8, clarity: 0.7 },
      composite: 0.75,
    }
    const outcome: RunOutcome = {
      holdoutScore: 0.75,
      raw: {},
      judgeScores,
    }
    expect(outcome.judgeScores).toBe(judgeScores)
    expect(outcome.judgeScores?.composite).toBe(0.75)
  })

  it('exposes the trace-analysis types agent-dev-container imports from the root', () => {
    // Documents the consumed shape; the packed-tarball consumer typecheck is
    // the compile-time guard (tests/ are outside tsc's include).
    const cluster: ErrorCluster = {
      signature: 'timeout',
      status_message_sample: 'deploy timed out after 30s',
      span_name: 'tool:deploy',
      tool_name: 'deploy',
      trace_count: 2,
      span_count: 2,
      prevalence: 0.5,
      exemplar_trace_ids: ['t1'],
      exemplar_span_ids: ['s1'],
    }
    const hookEvent: RuntimeTrajectoryHookEvent = {
      id: 'e1',
      runId: 'r1',
      target: 'tool:deploy',
      phase: 'post',
      timestamp: 1,
    }
    expect(cluster.trace_count).toBe(2)
    expect(hookEvent.runId).toBe('r1')
  })

  it('exposes the counterfactual replay surface traces imports from the root', () => {
    expect(typeof agentEval.runCounterfactual).toBe('function')
    // Type-level pin: traces implements CounterfactualRunner and builds a
    // CounterfactualContext; a rename or field drop stops compiling here.
    const runner: CounterfactualRunner = {
      executeFrom: async (ctx: CounterfactualContext) => {
        void ctx.originalRunId
        void ctx.prefix
        void ctx.mutatedStep
      },
    }
    expect(typeof runner.executeFrom).toBe('function')
  })

  it('exposes root ChatClient API types used by consumers', async () => {
    const transport: ChatTransport = 'mock'
    const request: ChatRequest = { messages: [{ role: 'user', content: 'ping' }] }
    const response: ChatResponse = {
      content: 'pong',
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      costUsd: 0,
      model: 'test-model',
      durationMs: 1,
      raw: {},
    }
    const callOpts: ChatCallOpts = { correlationId: 'consumer-contract' }

    const mockOpts: MockTransportOpts = {
      transport,
      defaultModel: 'test-model',
      handler: async () => response,
    }
    const createOpts: CreateChatClientOpts = mockOpts
    const client: ChatClient = agentEval.createChatClient(createOpts)

    const sandboxSdkOpts: SandboxSdkTransportOpts = {
      transport: 'sandbox-sdk',
      chat: async () => response,
    }
    const customOpts: CustomTransportOpts = {
      transport: 'custom',
      defaultModel: 'test-model',
      maximumAttempts: 2,
      chat: async () => response,
    }
    const custom = agentEval.createChatClient(customOpts)

    expect(sandboxSdkOpts.transport).toBe('sandbox-sdk')
    expect(await client.chat(request, callOpts)).toBe(response)
    expect(await custom.chat(request, callOpts)).toBe(response)
    expect(custom.maximumAttempts).toBe(2)
  })

  it('exposes the proposal finding contract', () => {
    const finding: ProposalFinding = {
      schema_version: '1.0.0',
      finding_id: 'finding-1',
      analyst_id: 'trace-analysis',
      produced_at: '2026-07-28T00:00:00.000Z',
      severity: 'medium',
      area: 'tool-use',
      claim: 'The worker retried the same failed call.',
      evidence_refs: [],
      confidence: 1,
      derived_from_judge: false,
      proposal_origin: 'search',
    }
    expect(finding.proposal_origin).toBe('search')
    expect(typeof campaign.makeProposalFinding).toBe('function')
    expect(campaign.makeProposalFinding).toBe(contract.makeProposalFinding)
  })
})
