/**
 * createCompositeMutator — combines two `MutateAdapter<P>`s under a policy.
 *
 *   prompt-only — every generation runs `primary` (typical: a reflective
 *                 prompt mutator). The default.
 *   secondary-only — every generation runs `secondary` (typical: a coding
 *                    agent that edits the harness itself). Slow + expensive.
 *   alternate    — even gens run `primary`, odd gens run `secondary`.
 *   plateau      — start with `primary`; switch to a 50/50 split between
 *                  `primary` and `secondary` after K gens with less than
 *                  Δ improvement (auto-detect when prompt evolution has
 *                  hit a structural ceiling).
 *
 * Naming is generic: the original audit-bench version called the channels
 * "prompt" and "code" — those are the canonical use cases, but the
 * primitive doesn't care what each mutator actually does.
 */

import type {
  EvolvableVariant,
  MutateAdapter,
  TrialResult,
  VariantAggregate,
} from './prompt-evolution'

export type CompositePolicy = 'primary-only' | 'secondary-only' | 'alternate' | 'plateau'

export interface CreateCompositeMutatorOpts<P> {
  primary: MutateAdapter<P>
  secondary?: MutateAdapter<P>
  policy: CompositePolicy
  /** For 'plateau': minimum improvement (Δ meanScore) to count as progress. Default 0.02. */
  plateauThreshold?: number
  /** For 'plateau': consecutive gens without progress that trigger split mode. Default 2. */
  plateauPatience?: number
  /** Optional progress hook. */
  onPolicyDecision?: (info: {
    generation: number
    chose: 'primary' | 'secondary' | 'split'
    reason: string
  }) => void
}

interface MutateArgs<P> {
  parent: EvolvableVariant<P>
  parentAggregate: VariantAggregate
  topTrials: TrialResult[]
  bottomTrials: TrialResult[]
  childCount: number
  generation: number
}

export function createCompositeMutator<P>(opts: CreateCompositeMutatorOpts<P>): MutateAdapter<P> {
  const recentScores: number[] = []
  const plateauThreshold = opts.plateauThreshold ?? 0.02
  const plateauPatience = opts.plateauPatience ?? 2

  function pickMode(args: MutateArgs<P>): {
    mode: 'primary' | 'secondary' | 'split'
    reason: string
  } {
    recentScores.push(args.parentAggregate.meanScore)
    switch (opts.policy) {
      case 'primary-only':
        return { mode: 'primary', reason: 'policy=primary-only' }
      case 'secondary-only':
        if (!opts.secondary)
          return {
            mode: 'primary',
            reason: 'secondary-only requested but no secondary mutator wired',
          }
        return { mode: 'secondary', reason: 'policy=secondary-only' }
      case 'alternate':
        if (!opts.secondary)
          return { mode: 'primary', reason: 'alternate requested but no secondary mutator wired' }
        return args.generation % 2 === 1
          ? { mode: 'secondary', reason: `alternate: gen${args.generation} odd → secondary` }
          : { mode: 'primary', reason: `alternate: gen${args.generation} even → primary` }
      case 'plateau': {
        if (!opts.secondary)
          return { mode: 'primary', reason: 'plateau requested but no secondary mutator wired' }
        if (recentScores.length <= plateauPatience) {
          return { mode: 'primary', reason: 'plateau: warming up with primary mutations' }
        }
        const window = recentScores.slice(-plateauPatience - 1)
        const deltas = window.slice(1).map((v, i) => v - window[i])
        const stagnant = deltas.every((d) => d < plateauThreshold)
        if (stagnant) {
          return {
            mode: 'split',
            reason: `plateau detected (${deltas.map((d) => d.toFixed(3)).join(', ')}) → split`,
          }
        }
        return {
          mode: 'primary',
          reason: `plateau: still improving (${deltas[deltas.length - 1].toFixed(3)})`,
        }
      }
    }
  }

  return {
    async mutate(args: MutateArgs<P>): Promise<EvolvableVariant<P>[]> {
      const { mode, reason } = pickMode(args)
      opts.onPolicyDecision?.({ generation: args.generation, chose: mode, reason })

      if (mode === 'primary') return opts.primary.mutate(args)
      if (mode === 'secondary' && opts.secondary) return opts.secondary.mutate(args)

      if (mode === 'split' && opts.secondary) {
        const secondaryShare = Math.ceil(args.childCount / 2)
        const primaryShare = args.childCount - secondaryShare
        const [primaryChildren, secondaryChildren] = await Promise.all([
          opts.primary.mutate({ ...args, childCount: primaryShare }),
          opts.secondary.mutate({ ...args, childCount: secondaryShare }),
        ])
        return [...primaryChildren, ...secondaryChildren]
      }
      return opts.primary.mutate(args)
    },
  }
}
