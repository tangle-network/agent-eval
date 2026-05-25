/**
 * Traced mutator wrapper — instruments reflective-mutation LLM calls.
 *
 * The reflective mutator (used by production-loop + multi-shot-optimization)
 * builds a prompt via `buildReflectionPrompt` and calls an LLM to produce
 * candidate mutations. This wrapper emits a span around each mutation call
 * so OTEL sinks observe:
 *   - Model used for mutation
 *   - Input context (target, trial count, child count)
 *   - Output (proposal count, labels)
 *   - Duration + cost if available
 */

import type {
  EvolvableVariant,
  MutateAdapter,
  TrialResult,
  VariantAggregate,
} from './prompt-evolution'
import type { TraceEmitter } from './trace/emitter'

export interface TracedMutatorOptions {
  /** TraceEmitter for span emission. */
  emitter: TraceEmitter
  /** Parent span id. If omitted, uses emitter stack. */
  parentSpanId?: string
}

/**
 * Wrap a MutateAdapter so every mutate() call emits a span.
 */
export function traceMutator<P>(
  adapter: MutateAdapter<P>,
  opts: TracedMutatorOptions,
): MutateAdapter<P> {
  return {
    async mutate(args: {
      parent: EvolvableVariant<P>
      parentAggregate: VariantAggregate
      topTrials: TrialResult[]
      bottomTrials: TrialResult[]
      childCount: number
      generation: number
    }): Promise<EvolvableVariant<P>[]> {
      const span = await opts.emitter.span({
        kind: 'llm',
        name: `mutator:gen-${args.generation}`,
        parentSpanId: opts.parentSpanId,
        attributes: {
          'mutator.parent_id': args.parent.id,
          'mutator.generation': args.generation,
          'mutator.child_count': args.childCount,
          'mutator.top_trials': args.topTrials.length,
          'mutator.bottom_trials': args.bottomTrials.length,
          'mutator.parent_score': args.parentAggregate.meanScore,
          'eval.phase': 'mutator',
        },
      })
      try {
        const children = await adapter.mutate(args)
        await span.end({
          attributes: {
            'mutator.parent_id': args.parent.id,
            'mutator.generation': args.generation,
            'mutator.child_count': args.childCount,
            'mutator.top_trials': args.topTrials.length,
            'mutator.bottom_trials': args.bottomTrials.length,
            'mutator.parent_score': args.parentAggregate.meanScore,
            'mutator.produced_count': children.length,
            'mutator.child_ids': children.map((c: EvolvableVariant<P>) => c.id).join(','),
            'eval.phase': 'mutator',
          },
        } as Record<string, unknown>)
        return children
      } catch (err) {
        await span.fail(err instanceof Error ? err : String(err))
        throw err
      }
    },
  }
}
