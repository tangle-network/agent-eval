/**
 * Records the continuation runner produces, and the projection back into the
 * shape the Terminal-Bench-2 trajectory corpus stores.
 *
 * The replay layer reads recorded trajectories as
 * `{ src, msg, tools, obs }` steps. A continuation that emitted a private
 * shape would need a second reader and would drift from it, so the rollout
 * projects into the same four fields.
 */

import type { CostProvenance } from '../cost-ledger'
import type { RunTokenUsage } from '../run-record'
import { contentHash } from '../verdict-cache'
import { parseAction } from './mini-swe-scaffold'

/** Which arm produced a rollout. The policy is identical across all three. */
export type ContinuationArm = 'intervention' | 'no-fix-control' | 'no-op-control'

/** Chat message in the scaffold's own vocabulary. */
export interface ContinuationMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

/** Why a rollout stopped. */
export type ContinuationExitStatus =
  | 'submitted'
  | 'step-budget-exhausted'
  | 'repeated-format-error'
  | 'model-error'
  | 'environment-error'

export interface ContinuationExecRecord {
  command: string
  returncode: number
  /** True when the environment killed the command at the policy timeout. */
  timedOut: boolean
  outputChars: number
  durationMs: number
}

export interface ContinuationModelCall {
  /** Model id the provider reported serving, which can differ from the requested id. */
  servedModel: string
  seed: number
  latencyMs: number
  /** `null` when the provider reported no usage. Never a zero-filled stand-in. */
  usage: RunTokenUsage | null
  /** `null` when neither the provider nor local pricing produced an amount. */
  costUsd: number | null
  finishReason: string | null
  contentChars: number
}

export interface ContinuationStepRecord {
  /** 1-based index within the continuation, not within the whole trajectory. */
  step: number
  assistantMessage: string
  /** `null` when the turn held zero or several bash blocks. */
  action: string | null
  /**
   * `null` when the command that ran ended the rollout: the submission
   * sentinel gets no observation, which is how the corpus records a finished
   * run, and a failed environment call produces none either.
   */
  observation: string | null
  /** `null` when no command ran, so a format error is never read as an exit-0 command. */
  execution: ContinuationExecRecord | null
  model: ContinuationModelCall
  /** Environment failure that ended the rollout at this step. */
  error?: string
}

export interface ContinuationUsageTotals {
  /**
   * Recorded model calls. A call that threw produced no step, so it is absent
   * here and named in `terminalError` instead.
   */
  calls: number
  /** Calls that carried usage. Below `calls` means the totals cover part of the rollout. */
  callsWithUsage: number
  /** True only when every call reported usage. */
  captured: boolean
  input: number
  output: number
  reasoning?: number
  cached?: number
  cacheWrite?: number
}

export interface ContinuationEnvironmentDescription {
  /** Docker network mode of the container. The policy admits `none` only. */
  networkMode: string
  image?: string
}

export interface ContinuationRollout {
  rolloutId: string
  arm: ContinuationArm
  /** Corpus row the continuation belongs to. Pairs rollouts across arms. */
  rowId: string
  /** 0-based rollout index within the arm. */
  index: number
  /** Seed handed to the model for every call in this rollout. */
  seed: number
  /** Hash over the policy and scaffold templates. Equal across arms by construction. */
  policyDigest: string
  environmentId: string
  containerRef: string
  environment: ContinuationEnvironmentDescription
  steps: ContinuationStepRecord[]
  exitStatus: ContinuationExitStatus
  /** Text after the sentinel line, present only on `submitted`. */
  submission: string | null
  usage: ContinuationUsageTotals
  costProvenance: CostProvenance
  wallMs: number
  startedAt: string
  endedAt: string
  /** Message from the model or environment failure that ended the rollout. */
  terminalError?: string
}

/** A tool call in corpus shape. */
export interface RecordedToolCall {
  fn: 'bash_command'
  cmd: string
}

/** One trajectory step in corpus shape. */
export interface RecordedStep {
  src: 'system' | 'user' | 'agent'
  msg: string
  tools: RecordedToolCall[] | null
  obs: string | null
}

/**
 * Project a full message list into corpus steps: the system and task messages
 * become their own steps, and every assistant turn carries the command it
 * requested plus the observation that answered it. A trailing assistant turn
 * with no answer keeps `obs: null`, which is how the corpus records a run that
 * ended on its last command.
 */
export function toRecordedSteps(messages: readonly ContinuationMessage[]): RecordedStep[] {
  const steps: RecordedStep[] = []
  for (let i = 0; i < messages.length; i += 1) {
    const message = messages[i]
    if (!message) continue
    if (message.role === 'assistant') {
      const parsed = parseAction(message.content)
      const next = messages[i + 1]
      steps.push({
        src: 'agent',
        msg: message.content,
        tools: parsed.kind === 'action' ? [{ fn: 'bash_command', cmd: parsed.command }] : null,
        obs: next && next.role === 'user' ? next.content : null,
      })
      continue
    }
    if (message.role === 'system') {
      steps.push({ src: 'system', msg: message.content, tools: null, obs: null })
      continue
    }
    // A user message that answers an assistant turn is that turn's observation,
    // already attached above. Only the leading task message stands alone.
    const previous = messages[i - 1]
    if (!previous || previous.role === 'system') {
      steps.push({ src: 'user', msg: message.content, tools: null, obs: null })
    }
  }
  return steps
}

/** Corpus steps for the continuation alone, excluding the prefix it inherited. */
export function rolloutRecordedSteps(rollout: ContinuationRollout): RecordedStep[] {
  return rollout.steps.map((step) => ({
    src: 'agent',
    msg: step.assistantMessage,
    tools: step.action === null ? null : [{ fn: 'bash_command', cmd: step.action }],
    obs: step.observation,
  }))
}

/**
 * Hash over everything the policy determines: the actions taken, the
 * observations they produced, the seeds, the exit, and the usage.
 *
 * Wall-clock fields are excluded because they vary between identical runs;
 * two rollouts with the same digest did the same work, whatever they cost in
 * seconds. Use it to assert determinism, never to assert equal latency.
 */
export function rolloutDigest(rollout: ContinuationRollout): string {
  return contentHash({
    arm: rollout.arm,
    rowId: rollout.rowId,
    index: rollout.index,
    seed: rollout.seed,
    policyDigest: rollout.policyDigest,
    exitStatus: rollout.exitStatus,
    submission: rollout.submission,
    usage: rollout.usage,
    costUsd: rollout.costProvenance.usd,
    costKind: rollout.costProvenance.kind,
    steps: rollout.steps.map((step) => ({
      step: step.step,
      assistantMessage: step.assistantMessage,
      action: step.action,
      observation: step.observation,
      returncode: step.execution?.returncode ?? null,
      timedOut: step.execution?.timedOut ?? null,
      seed: step.model.seed,
      servedModel: step.model.servedModel,
      usage: step.model.usage,
      costUsd: step.model.costUsd,
    })),
  })
}
