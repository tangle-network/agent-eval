/**
 * Shipped policies for the exploration engine.
 *
 * `MutationProposer` is a plain function type — an agent running a generator skill
 * IS a proposer (`(ctx) => dispatchToSkill(ctx)`), no wrapper needed. `mutationProposer`
 * builds the deterministic, LLM-free one from mutation operators. Objectives are
 * interfaces because the engine reads `kind` + `threshold` off them.
 */

import type { AdversarialMutation } from '../rl/adversarial'
import type {
  Cell,
  Evaluation,
  MutationProposer,
  Objective,
  ObjectiveContext,
  ProposeContext,
} from './types'

const clamp01 = (x: number): number => Math.max(0, Math.min(1, x))

// ── proposers ─────────────────────────────────────────────────────────────────

/**
 * Perturbation-based search: apply the cell's mutation operators to the current
 * elites + seeds, deduping by id. Elites first — mutating the most interesting
 * scenario found so far is what makes the search deepen across rounds.
 */
export function mutationProposer<S>(opts: {
  mutationsFor: (cell: Cell) => AdversarialMutation<S>[]
  scenarioId: (s: S) => string
}): MutationProposer<S> {
  return async (ctx: ProposeContext<S>): Promise<S[]> => {
    const mutations = opts.mutationsFor(ctx.cell)
    const parents = [...ctx.elites, ...ctx.seeds]
    const seen = new Set(parents.map(opts.scenarioId))
    const out: S[] = []
    for (const parent of parents) {
      if (out.length >= ctx.count) break
      for (const m of mutations) {
        const children = await m.mutate(parent, ctx.rng)
        for (const child of children) {
          const id = opts.scenarioId(child)
          if (seen.has(id)) continue
          seen.add(id)
          out.push(child)
          if (out.length >= ctx.count) break
        }
        if (out.length >= ctx.count) break
      }
    }
    return out
  }
}

// ── objectives ────────────────────────────────────────────────────────────────

/** Adversarial: a low headline score is interesting — find where the agent fails. */
export function adversarialObjective(threshold = 0.5): Objective {
  return { kind: 'adversarial', threshold, interest: (ev) => clamp01(1 - ev.score) }
}

function hamming(
  a: Record<string, string> | undefined,
  b: Record<string, string> | undefined,
): number {
  if (!a || !b) return 1
  const keys = new Set([...Object.keys(a), ...Object.keys(b)])
  if (keys.size === 0) return 0
  let diff = 0
  for (const k of keys) if (a[k] !== b[k]) diff++
  return diff / keys.size
}

/**
 * Novelty: interesting when far from the archive in score AND measured behavior
 * descriptor — quality-diversity's diversity pressure; drives corpus growth
 * rather than re-finding the same hole.
 */
export function noveltyObjective(threshold = 0.3): Objective {
  return {
    kind: 'novelty',
    threshold,
    interest: (ev: Evaluation, ctx: ObjectiveContext) => {
      const scoreNovelty =
        ctx.archiveScores.length === 0
          ? 1
          : Math.min(...ctx.archiveScores.map((s) => Math.abs(s - ev.score)))
      const descNovelty =
        ctx.archiveDescriptors.length === 0
          ? 1
          : Math.min(...ctx.archiveDescriptors.map((d) => hamming(d, ev.descriptor)))
      return clamp01(0.5 * scoreNovelty + 0.5 * descNovelty)
    },
  }
}
