import { describe, expect, it } from 'vitest'
import * as builderEval from '../src/builder-eval/index'
import * as agentEval from '../src/index'
import * as rl from '../src/rl/index'
import type { JudgeScoresRecord, RunOutcome } from '../src/index'

/**
 * Public-surface contract for `@tangle-network/agent-eval`.
 *
 * Pins the symbols the five product-agent consumers (tax/creative/legal/gtm/agent-builder)
 * import from this package. A failure here means a consumer would silently break on the
 * next version bump — fix the export (preferred) or coordinate the rename across all
 * consumers before changing this list.
 *
 * Sourced by scanning `import ... from '@tangle-network/agent-eval'` across all five
 * consumer repos on 2026-05-17. Update this list when consumers adopt new exports.
 */

const ROOT_ERROR_CLASSES = [
  // Runtime error constructors. Type-only exports like `AgentEvalErrorCode`
  // (a string-literal union) are validated by the namespace import compiling.
  'AgentEvalError',
  'CaptureIntegrityError',
  'ConfigError',
  'JudgeError',
  'NotFoundError',
  'ReplayError',
  'ValidationError',
  'VerificationError',
] as const

const ROOT_RUNTIME_SYMBOLS = [
  // Trace storage
  'FileSystemTraceStore',
  'InMemoryTraceStore',
  'isJudgeSpan',
  // LLM client + retry
  'LlmClient',
  'callLlmJson',
  'withJudgeRetry',
  'createLlmReviewer',
  // Multi-shot optimization (runtime entry; the runner/scorer/adapter types
  // consumers also import are validated by the compile-time namespace import.)
  'runMultiShotOptimization',
  // Verifier / review / campaign
  'MultiLayerVerifier',
  'runProposeReview',
  'runEvalCampaign',
  'HeldOutGate',
  'runCanaries',
  // Substrate primitives
  'discoverPersonas',
  'aggregateTrialsByMode',
  'scoreKnowledgeReadiness',
  // Muffled-gate scanner
  'scanForMuffledGates',
  'DEFAULT_FINDERS',
  // Privacy
  'redactValue',
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

const RL_SYMBOLS = ['analyzeOptimizationResult'] as const

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
})
