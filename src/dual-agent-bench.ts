/**
 * Dual-agent convergence bench.
 *
 * Pattern lifted from dual-worker review loops: two agents take turns until
 * they converge on a consensus artifact. One proposes, the other critiques;
 * the proposer revises; repeat until a score threshold is hit or max rounds.
 *
 * Generalized so any two "agents" (gateways, local functions, anything with
 * `propose` + `critique`) compose in. Returns convergence rounds per
 * scenario + whether convergence happened.
 */

export interface DualAgentScenario {
  id: string
  initialPrompt: string
  /** Optional context the agents can read (e.g. source documents). */
  context?: Record<string, unknown>
}

export interface DualAgentRound {
  roundIndex: number
  proposal: string
  critique: string
  convergenceScore: number // 0..1 — how close to convergence
}

export interface DualAgentScenarioResult {
  scenarioId: string
  converged: boolean
  roundsToConverge: number | null
  finalProposal: string
  history: DualAgentRound[]
  finalScore: number
}

export interface DualAgentBenchConfig {
  scenarios: DualAgentScenario[]
  maxRounds?: number
  /** Convergence threshold in 0..1 (default 0.85). */
  convergenceThreshold?: number
  /**
   * Propose an answer given the scenario + the critic's prior critique (if any).
   * Returns the proposal string.
   */
  propose: (args: {
    scenario: DualAgentScenario
    roundIndex: number
    priorProposal?: string
    priorCritique?: string
  }) => Promise<string>
  /**
   * Critique the proposer's current output. Returns a structured critique
   * (free text) plus a convergence score: how close the proposal is to
   * acceptable. 1.0 = accept, 0.0 = totally off.
   */
  critique: (args: {
    scenario: DualAgentScenario
    roundIndex: number
    proposal: string
  }) => Promise<{ critique: string; convergenceScore: number }>
  /** Optional per-round hook for progress + tracing. */
  onRoundComplete?: (info: {
    scenarioId: string
    round: DualAgentRound
  }) => void
}

export interface DualAgentReport {
  scenarios: DualAgentScenarioResult[]
  aggregate: {
    convergenceRate: number // fraction of scenarios that converged within maxRounds
    avgRoundsToConverge: number | null // over scenarios that DID converge
    avgFinalScore: number
  }
  config: {
    maxRounds: number
    convergenceThreshold: number
  }
}

export class DualAgentBench {
  async run(config: DualAgentBenchConfig): Promise<DualAgentReport> {
    const maxRounds = config.maxRounds ?? 5
    const threshold = config.convergenceThreshold ?? 0.85

    if (config.scenarios.length === 0) {
      throw new Error('DualAgentBench requires at least 1 scenario')
    }

    const results: DualAgentScenarioResult[] = []

    for (const scenario of config.scenarios) {
      const history: DualAgentRound[] = []
      let converged = false
      let roundsToConverge: number | null = null
      let finalProposal = ''
      let lastScore = 0
      let priorCritique: string | undefined

      for (let r = 0; r < maxRounds; r++) {
        const priorProposal = history[history.length - 1]?.proposal
        const proposal = await config.propose({
          scenario,
          roundIndex: r,
          priorProposal,
          priorCritique,
        })
        const { critique, convergenceScore } = await config.critique({
          scenario,
          roundIndex: r,
          proposal,
        })

        if (!Number.isFinite(convergenceScore) || convergenceScore < 0 || convergenceScore > 1) {
          throw new Error(
            `critique must return convergenceScore in [0,1]; got ${convergenceScore} for scenario ${scenario.id} round ${r}`,
          )
        }

        const round: DualAgentRound = {
          roundIndex: r,
          proposal,
          critique,
          convergenceScore,
        }
        history.push(round)
        config.onRoundComplete?.({ scenarioId: scenario.id, round })

        finalProposal = proposal
        lastScore = convergenceScore
        priorCritique = critique

        if (convergenceScore >= threshold) {
          converged = true
          roundsToConverge = r + 1
          break
        }
      }

      results.push({
        scenarioId: scenario.id,
        converged,
        roundsToConverge,
        finalProposal,
        history,
        finalScore: lastScore,
      })
    }

    const convergedResults = results.filter((r) => r.converged)
    const convergenceRate = results.length ? convergedResults.length / results.length : 0
    const avgRoundsToConverge = convergedResults.length
      ? convergedResults.reduce((acc, r) => acc + (r.roundsToConverge ?? 0), 0) / convergedResults.length
      : null
    const avgFinalScore = results.length
      ? results.reduce((acc, r) => acc + r.finalScore, 0) / results.length
      : 0

    return {
      scenarios: results,
      aggregate: { convergenceRate, avgRoundsToConverge, avgFinalScore },
      config: { maxRounds, convergenceThreshold: threshold },
    }
  }
}
