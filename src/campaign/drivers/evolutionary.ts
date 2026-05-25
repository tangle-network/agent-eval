/**
 * @experimental
 *
 * `evolutionaryDriver` — adapts a stateless `Mutator` (population mutation:
 * GEPA / AxGEPA / reflective-mutation) into an `ImprovementDriver`. This is
 * the evolutionary strategy: each generation, mutate the current best surface
 * into N candidates, measure, select. No generation memory beyond the current
 * surface; the loop body handles ranking + promotion.
 *
 * The reflective alternative is agent-runtime's `improvementDriver` with a
 * `reflectiveGenerator` / `agenticGenerator`: it reasons over the report +
 * trace findings to propose targeted edits rather than blind mutations. Both
 * conform to `ImprovementDriver`; the improvement loop is identical regardless
 * of which drives it.
 */

import type { ImprovementDriver, Mutator } from '../types'

export interface EvolutionaryDriverOptions<TFindings = unknown> {
  mutator: Mutator<TFindings>
  /** External findings fed to the mutator each generation. Default: []. */
  findings?: TFindings[]
}

export function evolutionaryDriver<TFindings = unknown>(
  opts: EvolutionaryDriverOptions<TFindings>,
): ImprovementDriver<TFindings> {
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
