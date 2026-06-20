/**
 * `evolutionaryProposer` — adapts a stateless `Mutator` (population mutation:
 * GEPA / AxGEPA / reflective-mutation) into a `SurfaceProposer`. This is
 * the evolutionary strategy: each generation, mutate the current best surface
 * into N candidates, measure, select. No generation memory beyond the current
 * surface; the loop body handles ranking + promotion.
 *
 * The reflective alternative is agent-runtime's runtime proposer with a
 * `reflectiveGenerator` / `agenticGenerator`: it reasons over the report +
 * trace findings to propose targeted edits rather than blind mutations. Both
 * conform to `SurfaceProposer`; the improvement loop is identical either way.
 */

import type { Mutator, SurfaceProposer } from '../types'

export interface EvolutionaryProposerOptions<TFindings = unknown> {
  mutator: Mutator<TFindings>
  /** External findings fed to the mutator each generation. Default: []. */
  findings?: TFindings[]
}

export function evolutionaryProposer<TFindings = unknown>(
  opts: EvolutionaryProposerOptions<TFindings>,
): SurfaceProposer<TFindings> {
  return {
    kind: `evolutionary:${opts.mutator.kind}`,
    async propose({ currentSurface, findings, populationSize, signal }) {
      return opts.mutator.mutate({
        findings: findings.length > 0 ? findings : (opts.findings ?? []),
        currentSurface,
        populationSize,
        signal,
      })
    },
  }
}
