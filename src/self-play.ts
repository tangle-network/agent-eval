/**
 * Self-play scenario evolution — agents generate adversarial scenarios
 * against each other; survivors become part of the eval corpus.
 *
 * Framework-agnostic about how scenarios are generated. Caller supplies:
 *   - `propose`: asks a "proposer" agent for candidate scenarios
 *   - `scoreAgainst`: runs a target agent against a scenario and returns
 *     its score
 *
 * A scenario *survives* if it reveals a meaningful score difference
 * between two target agents (or between a target agent and itself on
 * different runs). Survivors are promoted to a Dataset; the caller
 * decides what to do with them (hold-out, training, regression set).
 *
 * Guard rails: minimum absolute score delta to consider a scenario
 * informative; floor on absolute target score so degenerate break-all
 * scenarios (noise, gibberish) don't flood the corpus.
 */

import { Dataset, type DatasetScenario } from './dataset'

export interface CandidateScenario {
  id: string
  payload: unknown
  /** Free-form tags (domain, generation, parent). */
  tags?: Record<string, string>
}

export interface ScoredTarget {
  targetId: string
  score: number
}

export interface EvolutionRound {
  round: number
  proposed: CandidateScenario[]
  survived: CandidateScenario[]
  rejected: Array<{ candidate: CandidateScenario; reason: string }>
  scoredBreakdown: Array<{ candidate: CandidateScenario; scores: ScoredTarget[]; spread: number }>
}

export interface SelfPlayOptions {
  /** Minimum score spread across targets for a scenario to survive. Default 0.1. */
  minSpread?: number
  /** Minimum floor score across targets — keeps degenerate break-all scenarios
   *  out. Default 0.1 (if every target scores below this, discard). */
  minAbsoluteFloor?: number
  /** Hard cap on survivors per round. Default 50. */
  maxSurvivors?: number
  /** Rounds to run. Default 1. Each round's survivors can be fed back into
   *  `propose` to compound. */
  rounds?: number
  /** Seed for scenario id generation if proposer doesn't provide one. */
  seed?: number
}

export interface SelfPlayProposer {
  propose(round: number, priorSurvivors: CandidateScenario[]): Promise<CandidateScenario[]>
}

export interface SelfPlayScorer {
  /** Score one candidate against every target; returns parallel array. */
  scoreCandidate(candidate: CandidateScenario, targets: string[]): Promise<ScoredTarget[]>
}

export async function runSelfPlay(
  proposer: SelfPlayProposer,
  scorer: SelfPlayScorer,
  targets: string[],
  options: SelfPlayOptions = {},
): Promise<{ rounds: EvolutionRound[]; dataset: Dataset }> {
  if (targets.length < 2) throw new Error('runSelfPlay: at least 2 targets required (need a difference to measure)')
  const minSpread = options.minSpread ?? 0.1
  const floor = options.minAbsoluteFloor ?? 0.1
  const maxSurvivors = options.maxSurvivors ?? 50
  const totalRounds = options.rounds ?? 1

  const allRounds: EvolutionRound[] = []
  let priorSurvivors: CandidateScenario[] = []
  const datasetScenarios: DatasetScenario[] = []

  for (let r = 0; r < totalRounds; r++) {
    const proposed = await proposer.propose(r, priorSurvivors)
    const scored: EvolutionRound['scoredBreakdown'] = []
    const rejected: EvolutionRound['rejected'] = []
    const surviving: CandidateScenario[] = []
    for (const candidate of proposed) {
      const scores = await scorer.scoreCandidate(candidate, targets)
      if (scores.length < 2) {
        rejected.push({ candidate, reason: 'scorer returned <2 results' })
        continue
      }
      const values = scores.map((s) => s.score)
      const spread = Math.max(...values) - Math.min(...values)
      const maxScore = Math.max(...values)
      scored.push({ candidate, scores, spread })
      if (maxScore < floor) {
        rejected.push({ candidate, reason: `every target below floor (max=${maxScore.toFixed(3)} < ${floor})` })
        continue
      }
      if (spread < minSpread) {
        rejected.push({ candidate, reason: `spread below threshold (${spread.toFixed(3)} < ${minSpread})` })
        continue
      }
      surviving.push(candidate)
    }

    // Rank by spread descending, cap at maxSurvivors
    surviving.sort((a, b) => {
      const sa = scored.find((s) => s.candidate.id === a.id)?.spread ?? 0
      const sb = scored.find((s) => s.candidate.id === b.id)?.spread ?? 0
      return sb - sa
    })
    const capped = surviving.slice(0, maxSurvivors)

    for (const s of capped) {
      datasetScenarios.push({
        id: s.id,
        payload: s.payload,
        split: 'test',
        tags: { ...s.tags, evolutionRound: String(r), origin: 'self-play' },
      })
    }

    allRounds.push({ round: r, proposed, survived: capped, rejected, scoredBreakdown: scored })
    priorSurvivors = capped
  }

  const dataset = new Dataset({
    name: 'self-play-survivors',
    provenance: {
      version: '1.0.0',
      createdAt: new Date().toISOString(),
      contributor: 'self-play',
      description: `Evolved across ${totalRounds} round(s), ${allRounds.reduce((a, r) => a + r.survived.length, 0)} survivors`,
    },
    scenarios: datasetScenarios,
  })
  return { rounds: allRounds, dataset }
}
