/**
 * createSandboxCodeMutator — `MutateAdapter<P>` that runs a coding agent
 * inside a SandboxPool slot to produce code-channel variants.
 *
 * Composable shape (matches `reflective-mutation.ts`'s separation of
 * "build the prompt" from "run the model"):
 *
 *   pool      → where mutations execute (any SlotFactory)
 *   runner    → consumer-supplied: invokes the coding agent in a slot,
 *               returns the diff/branch/whatever as `CodeMutationOutcome`s
 *   toVariantPayload → maps outcome → P (consumer encodes the diff their
 *                      way — patch string, branch ref, file map, etc)
 *
 * What this primitive owns (so consumers don't reinvent it every time):
 *   - Pool checkout / release with reset between attempts
 *   - Per-attempt mutex so a single slot can't be invoked concurrently
 *   - Telemetry write-through (mutations.jsonl, lineage.json,
 *     cost-ledger.json) when sinks are passed
 *   - Stable child-id generation
 *   - Failure capture (every attempt produces either a successful child
 *     or a recorded failure with reason — never a silent drop)
 *
 * Consumers stay focused on the actual interesting parts: building the
 * agent prompt, running the agent, capturing the diff.
 */

import type { CostLedger, LineageRecorder, MutationTelemetry } from './evolution-telemetry'
import type {
  EvolvableVariant,
  MutateAdapter,
  TrialResult,
  VariantAggregate,
} from './prompt-evolution'
import type { PoolSlot, SandboxPool } from './sandbox-pool'

/**
 * Result of one coding-agent invocation. The runner produces 1..N of
 * these per `runner` call (a single agent session can sometimes
 * produce multiple sibling diffs cheaply — runner decides).
 */
export interface CodeMutationOutcome {
  ok: boolean
  /** Stable id for the child variant if `ok`. The mutator falls back to
   *  a generated id when omitted. */
  childId?: string
  /** Free-form one-liner: "tightened tool descriptions in forge-tools.ts". */
  description?: string
  /** What the runner was trying to fix (carried into EvolvableVariant.rationale). */
  rationale?: string
  /** Caller-defined diff payload. Mapped into the variant's payload by
   *  `toVariantPayload`; agent-eval treats it as opaque. */
  artifact?: unknown
  /** When ok === false. Free-form: 'parse_failure' / 'agent_error' /
   *  'no_changes' / 'commit_failed' / etc. */
  failureReason?: string
  /** Telemetry stats. */
  diffBytes?: number
  filesTouched?: number
  agentSteps?: number
  costUsd?: number
  latencyMs: number
}

export type CodeMutationRunner<T, P> = (args: {
  slot: PoolSlot<T>
  parent: EvolvableVariant<P>
  parentAggregate: VariantAggregate
  topTrials: TrialResult[]
  bottomTrials: TrialResult[]
  childCount: number
  generation: number
}) => Promise<CodeMutationOutcome[]>

export interface CreateSandboxCodeMutatorOpts<T, P> {
  pool: SandboxPool<T>
  runner: CodeMutationRunner<T, P>
  /**
   * Map an outcome into the variant payload `P`. Lets the consumer
   * encode the diff however they want (file map, patch string, branch
   * ref, snapshot id) without agent-eval taking a stance.
   */
  toVariantPayload(outcome: CodeMutationOutcome, parent: EvolvableVariant<P>): P
  /** Optional telemetry sinks. */
  mutationTelemetry?: MutationTelemetry
  costLedger?: CostLedger
  lineage?: LineageRecorder<P>
  /** Override id generation. Default: `${parent.id}.g${generation}.code.${i}`. */
  childIdFor?(parent: EvolvableVariant<P>, generation: number, index: number): string
  /** Default label for the variant (visible in reports). */
  labelFor?(
    outcome: CodeMutationOutcome,
    parent: EvolvableVariant<P>,
    generation: number,
    index: number,
  ): string
}

export function createSandboxCodeMutator<T, P>(
  opts: CreateSandboxCodeMutatorOpts<T, P>,
): MutateAdapter<P> {
  const childIdFor =
    opts.childIdFor ??
    ((parent: EvolvableVariant<P>, generation: number, index: number) =>
      `${parent.id}.g${generation}.code.${index}`)
  const labelFor =
    opts.labelFor ??
    ((
      outcome: CodeMutationOutcome,
      parent: EvolvableVariant<P>,
      _generation: number,
      index: number,
    ) => outcome.description?.slice(0, 80) ?? `${parent.label} → code.${index}`)

  return {
    async mutate(args) {
      const { parent, parentAggregate, topTrials, bottomTrials, childCount, generation } = args
      const startedAt = Date.now()

      // One pool slot per mutate() call. The runner decides whether to
      // produce 1 or N siblings within that slot — typically agents do 1
      // pass and produce 1 diff, but a "make 3 variant rewrites" runner
      // can squeeze N out of one checkout.
      const outcomes = await opts.pool.withSlot(async (slot) => {
        try {
          return await opts.runner({
            slot,
            parent,
            parentAggregate,
            topTrials,
            bottomTrials,
            childCount,
            generation,
          })
        } catch (err) {
          // Runner threw — record a single failure attempt so the
          // generation log still has provenance.
          return [
            {
              ok: false,
              failureReason: 'runner_error',
              description: err instanceof Error ? err.message : String(err),
              latencyMs: Date.now() - startedAt,
            },
          ] satisfies CodeMutationOutcome[]
        }
      })

      const variants: EvolvableVariant<P>[] = []
      let index = 0
      for (const outcome of outcomes) {
        const childId = outcome.childId ?? childIdFor(parent, generation, index)

        // Telemetry: every attempt — success or failure — gets recorded.
        if (opts.mutationTelemetry) {
          await opts.mutationTelemetry.record({
            ts: Date.now(),
            channel: 'code',
            generation,
            parentId: parent.id,
            childId: outcome.ok ? childId : null,
            ok: outcome.ok,
            failureReason: outcome.failureReason,
            description: outcome.description,
            latencyMs: outcome.latencyMs,
            diffBytes: outcome.diffBytes,
            filesTouched: outcome.filesTouched,
            agentSteps: outcome.agentSteps,
            costUsd: outcome.costUsd,
          })
        }
        if (opts.costLedger && outcome.costUsd !== undefined) {
          await opts.costLedger.addMutation('code', outcome.costUsd, { generation })
        }

        if (outcome.ok) {
          const variant: EvolvableVariant<P> = {
            id: childId,
            payload: opts.toVariantPayload(outcome, parent),
            generation,
            parentId: parent.id,
            label: labelFor(outcome, parent, generation, index),
            ...(outcome.rationale ? { rationale: outcome.rationale } : {}),
          }
          variants.push(variant)
          if (opts.lineage) {
            // Bypass the kindOf heuristic — we KNOW this is a code-channel
            // mutation. Calling upsertVariant would route through the
            // payload-shape sniff in defaultKindOf, which only matches when
            // the consumer's payload happens to use a `codeMutation` field.
            await opts.lineage.upsert({
              id: variant.id,
              parentId: variant.parentId ?? null,
              generation: variant.generation,
              kind: 'code',
              ...(variant.rationale ? { rationale: variant.rationale } : {}),
            })
          }
        }

        index++
      }

      // Pool utilization — fold into the cost ledger if both are present
      // so the consumer's snapshot ends up with poolBusyMs / utilization.
      if (opts.costLedger) {
        const u = opts.pool.utilization()
        await opts.costLedger.setPoolUtilization(u.busyMs, u.totalMs)
      }

      return variants
    },
  }
}
