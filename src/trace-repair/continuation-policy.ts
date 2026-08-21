/**
 * The pinned continuation policy: given a container restored to the state
 * after step k, run the mini-swe-agent scaffold forward under one frozen
 * configuration and record everything it did.
 *
 * `Delta-repair = P(tests pass | intervention) - P(tests pass | no-fix control)`
 * only measures the intervention if the continuation is identical across arms.
 * That symmetry is structural here: arms differ by the container state handed
 * in, never by the policy. One code path serves all three, the arm is a label,
 * the seed derivation cannot see it, and `policyDigest` is recorded on every
 * rollout so a mismatch is caught in the data rather than argued about.
 */

import type { CostProvenance } from '../cost-ledger'
import { CaptureIntegrityError, ValidationError } from '../errors'
import type { RunTokenUsage } from '../run-record'
import { contentHash } from '../verdict-cache'
import type {
  ContinuationArm,
  ContinuationEnvironmentDescription,
  ContinuationExitStatus,
  ContinuationMessage,
  ContinuationModelCall,
  ContinuationRollout,
  ContinuationStepRecord,
  ContinuationUsageTotals,
} from './continuation-records'
import {
  MINI_SWE_SYSTEM_MESSAGE,
  parseAction,
  renderFormatErrorObservation,
  renderInstanceMessage,
  renderObservation,
  renderTimeoutObservation,
  submissionOf,
} from './mini-swe-scaffold'

/** A rollout ran outside the pinned policy, so its evidence cannot be used. */
export class ContinuationPolicyViolationError extends CaptureIntegrityError {}

/** Two arms did not run the same policy, so their difference is not the intervention. */
export class ContinuationSymmetryError extends CaptureIntegrityError {}

export interface PinnedContinuationPolicy {
  /** Stable name for the frozen configuration, recorded on every rollout. */
  readonly id: string
  /** Requested model id. The served id is recorded per call and can differ. */
  readonly model: string
  /** Seed root. Per-rollout seeds derive from it and never from the arm. */
  readonly seed: number
  /** Model calls allowed per rollout. */
  readonly stepBudget: number
  readonly temperature: number
  readonly maxTokens: number
  /** Per-command wall-clock limit inside the container. */
  readonly commandTimeoutSeconds: number
  /** Consecutive unparseable turns that end a rollout. */
  readonly maxConsecutiveFormatErrors: number
  /** The only admissible container network mode. */
  readonly networkMode: 'none'
  readonly scaffold: 'mini-swe-agent'
}

/**
 * Everything the policy fixes except the two a campaign must choose.
 *
 * `commandTimeoutSeconds` is 30 because the recorded runs used the scaffold's
 * own 30-second environment timeout; a longer limit would let the continuation
 * finish commands the recorded agent could not.
 */
const CONTINUATION_POLICY_DEFAULTS = {
  id: 'tb-repair-continuation-v1',
  stepBudget: 20,
  temperature: 0,
  maxTokens: 4096,
  commandTimeoutSeconds: 30,
  maxConsecutiveFormatErrors: 3,
  networkMode: 'none',
  scaffold: 'mini-swe-agent',
} as const satisfies Omit<PinnedContinuationPolicy, 'model' | 'seed'>

export interface DefineContinuationPolicyInput
  extends Partial<Omit<PinnedContinuationPolicy, 'networkMode' | 'scaffold'>> {
  /** Required: a campaign pins one model, and no default can stand in for it. */
  model: string
  /** Required: a default seed would make two campaigns silently share a draw. */
  seed: number
}

export function definePinnedContinuationPolicy(
  input: DefineContinuationPolicyInput,
): PinnedContinuationPolicy {
  const policy: PinnedContinuationPolicy = { ...CONTINUATION_POLICY_DEFAULTS, ...input }
  if (!policy.model.trim()) throw new ValidationError('continuation policy requires a model id')
  if (!Number.isInteger(policy.seed)) {
    throw new ValidationError(`continuation policy seed must be an integer, got ${policy.seed}`)
  }
  requirePositiveInteger(policy.stepBudget, 'stepBudget')
  requirePositiveInteger(policy.maxTokens, 'maxTokens')
  requirePositiveInteger(policy.commandTimeoutSeconds, 'commandTimeoutSeconds')
  requirePositiveInteger(policy.maxConsecutiveFormatErrors, 'maxConsecutiveFormatErrors')
  if (!Number.isFinite(policy.temperature) || policy.temperature < 0) {
    throw new ValidationError(
      `continuation policy temperature must be a non-negative number, got ${policy.temperature}`,
    )
  }
  return Object.freeze(policy)
}

function requirePositiveInteger(value: number, field: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new ValidationError(
      `continuation policy ${field} must be a positive integer, got ${value}`,
    )
  }
}

/**
 * Hash over the policy and the scaffold text it renders. A changed template
 * changes the digest, so rollouts recorded before and after an edit cannot be
 * pooled by accident.
 */
export function continuationPolicyDigest(policy: PinnedContinuationPolicy): string {
  return contentHash({
    policy: { ...policy },
    systemMessage: MINI_SWE_SYSTEM_MESSAGE,
    instanceMessage: renderInstanceMessage({ task: '<task>', systemInformation: '<system>' }),
    formatErrorObservation: renderFormatErrorObservation(0),
    timeoutObservation: renderTimeoutObservation('<command>', '<output>'),
    observation: renderObservation({ returncode: 0, output: '' }),
  })
}

/**
 * Per-rollout seed. It reads the policy seed, the row, and the rollout index —
 * deliberately not the arm, so paired rollouts across arms draw identically.
 */
export function continuationSeed(policySeed: number, rowId: string, rolloutIndex: number): number {
  const input = `${policySeed}:${rowId}:${rolloutIndex}`
  let hash = 0x811c9dc5
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash >>> 1
}

export interface ContinuationModelRequest {
  model: string
  messages: ContinuationMessage[]
  seed: number
  temperature: number
  maxTokens: number
}

export interface ContinuationModelResponse {
  content: string
  /** Model id the provider reported serving. */
  servedModel: string
  /** `null` when the provider omitted usage. Callers must not substitute zeros. */
  usage: RunTokenUsage | null
  /** `null` when no amount is available from the provider or local pricing. */
  costUsd: number | null
  finishReason?: string | null
}

export type ContinuationModel = (
  request: ContinuationModelRequest,
) => Promise<ContinuationModelResponse>

export interface ContinuationExecResult {
  output: string
  returncode: number
  /** True when the environment killed the command at the policy timeout. */
  timedOut: boolean
  /** Set when the environment itself failed rather than the command. */
  exceptionInfo?: string
}

export interface ContinuationEnvironment {
  /** Container id or equivalent handle, recorded for provenance. */
  containerRef: string
  describe(): Promise<ContinuationEnvironmentDescription>
  exec(command: string, options: { timeoutSeconds: number }): Promise<ContinuationExecResult>
  dispose(): Promise<void>
}

export interface ContinuationEnvironmentRequest {
  rowId: string
  arm: ContinuationArm
  rolloutIndex: number
}

export interface ContinuationEnvironmentFactory {
  id: string
  /**
   * A container restored to the post-step-k state for one rollout. The arm is
   * passed because the state under test differs by arm; the policy applied to
   * that state does not.
   */
  create(request: ContinuationEnvironmentRequest): Promise<ContinuationEnvironment>
}

export interface RunContinuationOptions {
  policy: PinnedContinuationPolicy
  arm: ContinuationArm
  /** Corpus row under repair. Pairs rollouts across arms. */
  rowId: string
  /**
   * Messages through step k, as the replay layer rebuilt them: the pinned
   * system and task messages, then every replayed turn with the observation
   * the replay itself produced.
   */
  prefix: readonly ContinuationMessage[]
  /** Rollouts to run for this arm. */
  rollouts: number
  /**
   * Global index of the first rollout this invocation produces. The per-rollout
   * seed derives from the global index, so a campaign that adds rollouts in
   * later passes must shift this base — an index that repeats is a rollout
   * that repeats. Defaults to 0.
   */
  rolloutBase?: number
  model: ContinuationModel
  environments: ContinuationEnvironmentFactory
  /** Epoch milliseconds. Injected so tests can assert on records without wall-clock noise. */
  clock?: () => number
}

/**
 * Run the scaffold forward for `rollouts` independent continuations.
 *
 * Each rollout gets its own environment from the factory, because a rollout
 * mutates the container it runs in and the next one must start from the same
 * state, not from the previous rollout's leftovers.
 */
export async function runContinuation(
  options: RunContinuationOptions,
): Promise<ContinuationRollout[]> {
  const { policy, arm, rowId, prefix, rollouts, model, environments } = options
  const clock = options.clock ?? Date.now
  const rolloutBase = options.rolloutBase ?? 0
  requirePositiveInteger(rollouts, 'rollouts')
  if (!Number.isInteger(rolloutBase) || rolloutBase < 0) {
    throw new ValidationError(
      `continuation policy rolloutBase must be a non-negative integer, got ${rolloutBase}`,
    )
  }
  assertPrefix(prefix)
  const policyDigest = continuationPolicyDigest(policy)

  const records: ContinuationRollout[] = []
  for (let offset = 0; offset < rollouts; offset += 1) {
    records.push(
      await runOneRollout({
        policy,
        policyDigest,
        arm,
        rowId,
        index: rolloutBase + offset,
        prefix,
        model,
        environments,
        clock,
      }),
    )
  }
  return records
}

function assertPrefix(prefix: readonly ContinuationMessage[]): void {
  if (prefix.length < 2) {
    throw new ValidationError('continuation prefix needs the system and task messages')
  }
  if (prefix[0]?.role !== 'system' || prefix[1]?.role !== 'user') {
    throw new ValidationError('continuation prefix must start with a system then a user message')
  }
  if (prefix[prefix.length - 1]?.role !== 'user') {
    throw new ValidationError(
      'continuation prefix must end on a user message; an assistant turn with no observation means the replay left an action unanswered',
    )
  }
}

interface RolloutInput {
  policy: PinnedContinuationPolicy
  policyDigest: string
  arm: ContinuationArm
  rowId: string
  index: number
  prefix: readonly ContinuationMessage[]
  model: ContinuationModel
  environments: ContinuationEnvironmentFactory
  clock: () => number
}

async function runOneRollout(input: RolloutInput): Promise<ContinuationRollout> {
  const { policy, arm, rowId, index, clock } = input
  const seed = continuationSeed(policy.seed, rowId, index)
  const startedMs = clock()
  const environment = await input.environments.create({ rowId, arm, rolloutIndex: index })
  try {
    const description = await environment.describe()
    if (description.networkMode !== policy.networkMode) {
      throw new ContinuationPolicyViolationError(
        `continuation requires network mode "${policy.networkMode}", container ${environment.containerRef} reports "${description.networkMode}"`,
      )
    }

    const messages: ContinuationMessage[] = [...input.prefix]
    const steps: ContinuationStepRecord[] = []
    let exitStatus: ContinuationExitStatus = 'step-budget-exhausted'
    let submission: string | null = null
    let terminalError: string | undefined
    let consecutiveFormatErrors = 0

    for (let step = 1; step <= policy.stepBudget; step += 1) {
      const callStartedMs = clock()
      let response: ContinuationModelResponse
      try {
        response = await input.model({
          model: policy.model,
          messages: [...messages],
          seed,
          temperature: policy.temperature,
          maxTokens: policy.maxTokens,
        })
      } catch (error) {
        exitStatus = 'model-error'
        terminalError = errorMessage(error)
        break
      }
      const call: ContinuationModelCall = {
        servedModel: response.servedModel,
        seed,
        latencyMs: clock() - callStartedMs,
        usage: response.usage,
        costUsd: response.costUsd,
        finishReason: response.finishReason ?? null,
        contentChars: response.content.length,
      }
      messages.push({ role: 'assistant', content: response.content })

      const parsed = parseAction(response.content)
      if (parsed.kind === 'format-error') {
        consecutiveFormatErrors += 1
        const observation = renderFormatErrorObservation(parsed.actionCount)
        messages.push({ role: 'user', content: observation })
        steps.push({
          step,
          assistantMessage: response.content,
          action: null,
          observation,
          execution: null,
          model: call,
        })
        if (consecutiveFormatErrors >= policy.maxConsecutiveFormatErrors) {
          exitStatus = 'repeated-format-error'
          break
        }
        continue
      }

      consecutiveFormatErrors = 0
      const execStartedMs = clock()
      let execution: ContinuationExecResult
      try {
        execution = await environment.exec(parsed.command, {
          timeoutSeconds: policy.commandTimeoutSeconds,
        })
      } catch (error) {
        exitStatus = 'environment-error'
        terminalError = errorMessage(error)
        steps.push({
          step,
          assistantMessage: response.content,
          action: parsed.command,
          observation: null,
          execution: null,
          model: call,
          error: errorMessage(error),
        })
        break
      }
      const execRecord = {
        command: parsed.command,
        returncode: execution.returncode,
        timedOut: execution.timedOut,
        outputChars: execution.output.length,
        durationMs: clock() - execStartedMs,
      }

      if (execution.timedOut) {
        const observation = renderTimeoutObservation(parsed.command, execution.output)
        messages.push({ role: 'user', content: observation })
        steps.push({
          step,
          assistantMessage: response.content,
          action: parsed.command,
          observation,
          execution: execRecord,
          model: call,
        })
        continue
      }

      const submitted = submissionOf(execution)
      if (submitted !== null) {
        exitStatus = 'submitted'
        submission = submitted
        // The recorded runs end here: the sentinel command gets no observation.
        steps.push({
          step,
          assistantMessage: response.content,
          action: parsed.command,
          observation: null,
          execution: execRecord,
          model: call,
        })
        break
      }

      const observation = renderObservation(execution)
      messages.push({ role: 'user', content: observation })
      steps.push({
        step,
        assistantMessage: response.content,
        action: parsed.command,
        observation,
        execution: execRecord,
        model: call,
      })
    }

    const endedMs = clock()
    const rollout: ContinuationRollout = {
      rolloutId: `${rowId}:${arm}:${index}`,
      arm,
      rowId,
      index,
      seed,
      policyDigest: input.policyDigest,
      environmentId: input.environments.id,
      containerRef: environment.containerRef,
      environment: description,
      steps,
      exitStatus,
      submission,
      usage: totalUsage(steps),
      costProvenance: totalCost(steps),
      wallMs: endedMs - startedMs,
      startedAt: new Date(startedMs).toISOString(),
      endedAt: new Date(endedMs).toISOString(),
    }
    return terminalError === undefined ? rollout : { ...rollout, terminalError }
  } finally {
    await environment.dispose()
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Sum only what the provider reported. A call with no usage raises
 * `callsWithUsage` short of `calls` and clears `captured`, so a partially
 * reported rollout can never read as a fully measured one.
 */
export function totalUsage(steps: readonly ContinuationStepRecord[]): ContinuationUsageTotals {
  let input = 0
  let output = 0
  let reasoning = 0
  let cached = 0
  let cacheWrite = 0
  let sawReasoning = false
  let sawCached = false
  let sawCacheWrite = false
  let callsWithUsage = 0
  for (const step of steps) {
    const usage = step.model.usage
    if (!usage) continue
    callsWithUsage += 1
    input += usage.input
    output += usage.output
    if (usage.reasoning !== undefined) {
      reasoning += usage.reasoning
      sawReasoning = true
    }
    if (usage.cached !== undefined) {
      cached += usage.cached
      sawCached = true
    }
    if (usage.cacheWrite !== undefined) {
      cacheWrite += usage.cacheWrite
      sawCacheWrite = true
    }
  }
  const totals: ContinuationUsageTotals = {
    calls: steps.length,
    callsWithUsage,
    captured: steps.length > 0 && callsWithUsage === steps.length,
    input,
    output,
  }
  if (sawReasoning) totals.reasoning = reasoning
  if (sawCached) totals.cached = cached
  if (sawCacheWrite) totals.cacheWrite = cacheWrite
  return totals
}

/**
 * One unpriced call makes the rollout's cost unknown. Summing the rest would
 * report a number smaller than what was spent.
 */
export function totalCost(steps: readonly ContinuationStepRecord[]): CostProvenance {
  if (steps.length === 0) return { kind: 'uncaptured', usd: null }
  let usd = 0
  for (const step of steps) {
    if (step.model.costUsd === null) return { kind: 'uncaptured', usd: null }
    usd += step.model.costUsd
  }
  return { kind: 'observed', usd }
}

/**
 * Prove the arms ran the same policy. Rollouts paired by row and index must
 * carry the same policy digest and the same seed; anything else means the
 * measured difference includes a policy change, not only the intervention.
 */
export function assertArmSymmetry(rollouts: readonly ContinuationRollout[]): void {
  const digests = new Set(rollouts.map((rollout) => rollout.policyDigest))
  if (digests.size > 1) {
    throw new ContinuationSymmetryError(
      `arms ran different policies: ${[...digests].sort().join(', ')}`,
    )
  }
  const seeds = new Map<string, { seed: number; arm: ContinuationArm }>()
  for (const rollout of rollouts) {
    const key = `${rollout.rowId}:${rollout.index}`
    const seen = seeds.get(key)
    if (!seen) {
      seeds.set(key, { seed: rollout.seed, arm: rollout.arm })
      continue
    }
    if (seen.seed !== rollout.seed) {
      throw new ContinuationSymmetryError(
        `paired rollouts ${key} drew different seeds: ${seen.arm}=${seen.seed}, ${rollout.arm}=${rollout.seed}`,
      )
    }
  }
}
