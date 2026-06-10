/**
 * Coverage-guided agentic fuzzing — the loop.
 *
 * `fuzzAgent` tiles the behavior hypercube, then repeatedly: allocates a search
 * budget across cells (variance-steered, with a coverage floor), runs an
 * adversarial mutation search inside each allocated cell, keeps the hardest
 * scenario per cell as a MAP-Elites elite, and verifies + minimizes the failures
 * it surfaces through the validity gates. The result is a `CapsuleData` artifact.
 *
 * It is a composition: `varianceBasedCurriculum` allocates, `adversarialScenarioSearch`
 * mutates, the gates certify, the cube projects coverage, the capsule renders.
 * The only new logic here is the outer steering loop + the gate/minimize wiring.
 */

import type { CellObservation } from '../rl/active-curriculum'
import { varianceBasedCurriculum } from '../rl/active-curriculum'
import type { AdversarialScenario } from '../rl/adversarial'
import { adversarialScenarioSearch } from '../rl/adversarial'
import { buildCapsule } from './capsule'
import { enumerateCells } from './cube'
import type { FuzzAgentOptions, FuzzAgentResult, FuzzRunOutcome, VerifiedFailure } from './types'

export async function fuzzAgent<S>(opts: FuzzAgentOptions<S>): Promise<FuzzAgentResult<S>> {
  const failureThreshold = opts.failureThreshold ?? 0.5
  const roundsPerCell = opts.roundsPerCell ?? 2
  const floorPerCell = opts.floorPerCell ?? 2

  const cells = enumerateCells(opts.cube)
  if (cells.length === 0)
    throw new Error('fuzzAgent: cube has no cells — every axis must have at least one value')
  const cellById = new Map(cells.map((c) => [c.id, c]))
  const candidateCells = cells.map((c) => ({ variantId: c.id, scenarioId: '*' }))

  const observations: CellObservation[] = []
  const archive = new Map<string, AdversarialScenario<S>>()
  const lastOutcome = new Map<string, FuzzRunOutcome>()
  const failures: VerifiedFailure<S>[] = []
  let runsUsed = 0
  let candidateFailures = 0

  // Each cell gets at least `floorPerCell` runs (cold-start coverage); the rest
  // is steered by score variance toward the cells whose robustness is least certain.
  const perRoundBudget = Math.max(cells.length * floorPerCell, Math.ceil(opts.budget / 4))

  while (runsUsed < opts.budget) {
    const remaining = opts.budget - runsUsed
    const roundBudget = Math.min(perRoundBudget, remaining)
    const allocations = varianceBasedCurriculum(observations, candidateCells, {
      budget: roundBudget,
      floorPerCell,
    })
    const runsAtRoundStart = runsUsed

    for (const alloc of allocations) {
      if (runsUsed >= opts.budget) break
      const cell = cellById.get(alloc.variantId)
      if (!cell) continue
      const cellBudget = Math.min(alloc.count, opts.budget - runsUsed)
      if (cellBudget <= 0) continue

      const seeds = await opts.generator.seedsFor(cell)
      if (seeds.length === 0) continue
      const mutations = opts.generator.mutationsFor(cell)

      const report = await adversarialScenarioSearch<S>({
        seeds,
        mutateScenarioId: opts.scenarioId,
        mutations,
        scoreFn: async (scenario) => {
          const outcome = await opts.runner.run(scenario, cell)
          runsUsed++
          observations.push({
            variantId: cell.id,
            scenarioId: opts.scenarioId(scenario),
            score: outcome.score,
            pass: outcome.passed,
          })
          lastOutcome.set(opts.scenarioId(scenario), outcome)
          return outcome.score
        },
        failureThreshold,
        rounds: roundsPerCell,
        budget: cellBudget,
        seed: opts.seed,
      })

      // MAP-Elites elite: keep the lowest-scoring (hardest) scenario found in this cell.
      for (const sc of report.scenarios) {
        if (sc.score == null) continue
        const cur = archive.get(cell.id)
        if (!cur || cur.score == null || sc.score < cur.score) archive.set(cell.id, sc)
      }

      // Verify + minimize the failures this cell surfaced.
      for (const f of report.failures) {
        candidateFailures++
        const key = opts.scenarioId(f.scenario)
        const outcome = lastOutcome.get(key) ?? { score: f.score ?? 0, passed: false }

        if (opts.gates?.isValid && !(await opts.gates.isValid(f.scenario, outcome, cell))) continue
        if (
          opts.gates?.isUncontaminated &&
          !(await opts.gates.isUncontaminated(f.scenario, outcome, cell))
        )
          continue

        const minimized = opts.minimize
          ? await opts.minimize(f.scenario, opts.runner, cell)
          : f.scenario
        const score = f.score ?? outcome.score
        failures.push({
          id: f.id,
          cell,
          scenario: f.scenario,
          minimized,
          text: opts.scenarioText?.(minimized),
          score,
          severity: Math.max(0, Math.min(1, 1 - score)),
          failureClass: outcome.failureClass,
        })
      }
    }

    // No cell could run this round (all seeds empty) — stop rather than spin.
    if (runsUsed === runsAtRoundStart) break
  }

  const capsule = buildCapsule({
    target: opts.target,
    cells,
    observations,
    archive,
    failures,
    candidateFailures,
    runsUsed,
  })
  return { capsule }
}
