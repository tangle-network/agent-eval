import type { TCloud } from '@tangle-network/tcloud'
import { executeScenario } from './executor'
import type { BenchmarkReport, BenchmarkRunnerConfig, Scenario, ScenarioResult } from './types'

/**
 * BenchmarkRunner — orchestrates scenarios, executor, judges, and scoring.
 *
 * Domain-agnostic. Each agent provides its own scenarios, judges, and system prompt.
 */
export class BenchmarkRunner {
  private tc: TCloud
  private config: BenchmarkRunnerConfig

  constructor(tc: TCloud, config: BenchmarkRunnerConfig) {
    this.tc = tc
    this.config = config
  }

  async run(scenarios?: Scenario[]): Promise<BenchmarkReport> {
    const toRun = scenarios ?? this.config.scenarios
    const passThreshold = this.config.passThreshold ?? 6.0

    console.log('='.repeat(70))
    console.log(' AGENT EVAL — BENCHMARK')
    console.log(' Multi-turn scenarios x Multi-judge panel')
    console.log('='.repeat(70))
    console.log(`Scenarios: ${toRun.length}`)
    console.log(`Judges: ${this.config.judges.length}`)
    console.log(`Model: ${this.config.model ?? 'gpt-4o'}`)
    console.log()

    const results: ScenarioResult[] = []

    for (let i = 0; i < toRun.length; i++) {
      const scenario = toRun[i]
      console.log(`[${i + 1}/${toRun.length}] ${scenario.id} (${scenario.persona})`)
      console.log(`  thesis: ${scenario.thesis}`)
      console.log(`  turns: ${scenario.turns.length}`)

      const result = await executeScenario(this.tc, scenario, {
        systemPrompt: this.config.systemPrompt,
        model: this.config.model,
        judges: this.config.judges,
      })
      results.push(result)

      // Print turn summaries
      for (const turn of result.turns) {
        const codeIcon = turn.containsCode ? '[code]' : ''
        const toolIcon = turn.containsToolCall ? '[tool]' : ''
        const blockCount = turn.blocksExtracted.length
        const blockIcon = blockCount > 0 ? `[blocks:${blockCount}]` : ''
        console.log(
          `  turn ${turn.turnIndex + 1}: ${(turn.durationMs / 1000).toFixed(1)}s ${codeIcon} ${toolIcon} ${blockIcon} (${turn.agentResponse.length} chars)`,
        )
      }

      // Print artifact results
      for (const ar of result.artifactResults) {
        const icon = ar.passed ? '+' : 'X'
        console.log(`  artifact: [${icon}] ${ar.check.description} — ${ar.detail}`)
      }

      // Print judge scores
      console.log(`  judges:`)
      const byJudge: Record<string, { scores: number[]; dimensions: string[] }> = {}
      for (const js of result.judgeScores) {
        if (!byJudge[js.judgeName]) byJudge[js.judgeName] = { scores: [], dimensions: [] }
        byJudge[js.judgeName].scores.push(js.score)
        byJudge[js.judgeName].dimensions.push(`${js.dimension}=${js.score}`)
      }
      for (const [name, data] of Object.entries(byJudge)) {
        const avg = (data.scores.reduce((a, b) => a + b, 0) / data.scores.length).toFixed(1)
        console.log(`    ${name.padEnd(16)} avg=${avg}  [${data.dimensions.join(', ')}]`)
      }

      console.log(
        `  OVERALL: ${result.overallScore.toFixed(1)}/10 (${(result.totalDurationMs / 1000).toFixed(0)}s)`,
      )
      console.log()
    }

    // Build summary
    const byPersona: Record<string, { avg: number; passed: number; total: number }> = {}
    const byDimension: Record<string, { avg: number; scores: number[] }> = {}

    for (const r of results) {
      if (!byPersona[r.persona]) byPersona[r.persona] = { avg: 0, passed: 0, total: 0 }
      byPersona[r.persona].total++
      byPersona[r.persona].avg += r.overallScore
      if (r.overallScore >= passThreshold) byPersona[r.persona].passed++

      for (const js of r.judgeScores) {
        if (!byDimension[js.dimension]) byDimension[js.dimension] = { avg: 0, scores: [] }
        byDimension[js.dimension].scores.push(js.score)
      }
    }

    for (const p of Object.values(byPersona)) {
      p.avg = p.total > 0 ? p.avg / p.total : 0
    }
    for (const d of Object.values(byDimension)) {
      d.avg = d.scores.length > 0 ? d.scores.reduce((a, b) => a + b, 0) / d.scores.length : 0
    }

    const sorted = [...results].sort((a, b) => a.overallScore - b.overallScore)
    const weakest = sorted.slice(0, 3).map((r) => ({
      scenario: r.scenarioId,
      score: r.overallScore,
      reason:
        r.judgeScores
          .filter((s) => s.score < passThreshold)
          .map((s) => `${s.dimension}=${s.score}`)
          .join(', ') || 'close to threshold',
    }))
    const strongest = sorted
      .slice(-3)
      .reverse()
      .map((r) => ({
        scenario: r.scenarioId,
        score: r.overallScore,
        reason:
          r.judgeScores
            .filter((s) => s.score >= 9)
            .map((s) => `${s.dimension}=${s.score}`)
            .join(', ') || 'consistently strong',
      }))

    // Print final summary
    console.log('='.repeat(70))
    console.log(' RESULTS')
    console.log('='.repeat(70))

    const overallAvg =
      results.length > 0 ? results.reduce((s, r) => s + r.overallScore, 0) / results.length : 0

    console.log(`Overall: ${overallAvg.toFixed(1)}/10`)
    console.log()

    console.log('By persona:')
    for (const [name, data] of Object.entries(byPersona)) {
      console.log(
        `  ${name.padEnd(20)} ${data.avg.toFixed(1)}/10  (${data.passed}/${data.total} passed)`,
      )
    }
    console.log()

    console.log('By dimension:')
    const dimEntries = Object.entries(byDimension).sort((a, b) => a[1].avg - b[1].avg)
    for (const [name, data] of dimEntries) {
      const min = Math.min(...data.scores)
      const max = Math.max(...data.scores)
      console.log(
        `  ${name.padEnd(24)} avg=${data.avg.toFixed(1)}  range=[${min}-${max}]  n=${data.scores.length}`,
      )
    }
    console.log()

    if (weakest.length > 0) {
      console.log('Weakest:')
      for (const w of weakest) {
        console.log(`  ${w.scenario}: ${w.score.toFixed(1)} — ${w.reason}`)
      }
      console.log()
    }

    return {
      timestamp: new Date().toISOString(),
      generation: this.config.generation ?? 1,
      promptVersion: this.config.promptVersion ?? 'v1',
      scenarioCount: toRun.length,
      results,
      summary: { overallAvg, byPersona, byDimension, weakest, strongest },
    }
  }
}
