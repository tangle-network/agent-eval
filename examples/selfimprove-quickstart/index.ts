/**
 * defineAgentEval() quickstart — closed-loop improvement with a decision packet.
 *
 * Run with: pnpm tsx examples/selfimprove-quickstart/index.ts
 *
 * Everything in this file is synthetic so the example works offline. The
 * dispatch + judge are deterministic-with-noise stand-ins; replace them
 * with your real agent + your real judge to point the loop at production.
 */

import { defineAgentEval, type Scenario, type SurfaceProposer } from '../../src/contract'

interface CopyScenario extends Scenario {
  brief: string
}

const scenarios: CopyScenario[] = [
  { id: 'launch', kind: 'copy', brief: 'announce a new pricing tier' },
  { id: 'feature', kind: 'copy', brief: 'highlight a new collaboration feature' },
  { id: 'event', kind: 'copy', brief: 'invite to a customer roundtable' },
  { id: 'renewal', kind: 'copy', brief: 'remind a customer about renewal' },
  { id: 'webinar', kind: 'copy', brief: 'invite a prospect to a product webinar' },
  { id: 'churn', kind: 'copy', brief: 'win back an inactive account' },
  { id: 'case-study', kind: 'copy', brief: 'promote a customer case study' },
  { id: 'security', kind: 'copy', brief: 'explain a new security feature' },
]

// Synthetic agent: better surfaces produce higher-quality artifacts.
async function dispatch({
  scenario,
  systemPrompt,
}: {
  scenario: CopyScenario
  systemPrompt: string
}): Promise<{ text: string; quality: number }> {
  const tightnessBonus = systemPrompt.includes('tight') ? 0.38 : 0
  const specificBonus = systemPrompt.includes('specific') ? 0.28 : 0
  const noise = hash(scenario.id + systemPrompt)
  const quality = Math.min(1, 0.4 + tightnessBonus + specificBonus + 0.2 * noise)
  return {
    text: `[${scenario.id}] ${systemPrompt.slice(0, 40)}…`,
    quality,
  }
}

function hash(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) >>> 0
  }
  return h / 0xffffffff
}

// Synthetic judge: scores 'clarity' and 'concision' as dimensions; their
// mean is the composite the gate sees.
async function judge({ artifact }: { artifact: { text: string; quality: number } }) {
  const clarity = clamp(artifact.quality + 0.03 * (hash(`${artifact.text}:clarity`) - 0.5))
  const concision = clamp(artifact.quality - 0.02 * (hash(`${artifact.text}:concision`) - 0.5))
  const composite = (clarity + concision) / 2
  return {
    dimensions: { clarity, concision },
    composite,
    notes: '',
  }
}

function clamp(x: number): number {
  return Math.max(0, Math.min(1, x))
}

// Synthetic proposer: deterministically proposes two variants per generation —
// one adds 'tight,', the other adds 'specific,'. Lets the example run offline.
// In real use, you'd use the default `gepaProposer` (reflective LLM mutation)
// from `/contract`.
const syntheticProposer: SurfaceProposer = {
  kind: 'synthetic-quickstart',
  async propose({ currentSurface, populationSize }) {
    const current = String(currentSurface)
    const additions = ['tight,', 'specific,', 'punchy,', 'concrete,']
    return additions.slice(0, populationSize).map((kw) => ({
      surface: `${current} Write ${kw} engaging copy.`,
      label: `add-${kw.replace(',', '')}`,
      rationale: `Add a ${kw.replace(',', '')} writing constraint.`,
    }))
  },
}

async function main() {
  const evalKit = defineAgentEval({
    scenarios,
    agent: async (surface, scenario) =>
      dispatch({
        scenario,
        systemPrompt: String(surface),
      }),
    judge: {
      name: 'rubric',
      dimensions: [
        { key: 'clarity', weight: 1 },
        { key: 'concision', weight: 1 },
      ],
      score: judge,
    },
    baselineSurface: 'You write marketing copy. Keep it short.',
    proposer: syntheticProposer,
    budget: { generations: 1, populationSize: 2, holdoutFraction: 0.5 },
    expectUsage: 'off',
  })

  const result = await evalKit.improve()

  const i = result.insight
  console.log('═══ selfImprove() decision packet ═══')
  console.log()
  console.log(`Gate decision:        ${result.gateDecision}`)
  console.log(`Raw lift:             ${signed(result.lift)}`)
  console.log(`Generations explored: ${result.generationsExplored}`)
  console.log(`Total cost:           $${result.totalCostUsd.toFixed(3)}`)
  console.log()

  if (i.lift) {
    console.log(`── Statistical lift (paired bootstrap, n=${i.lift.n}) ──`)
    console.log(`delta:    ${signed(i.lift.delta)}`)
    console.log(`CI95:     [${i.lift.ci95[0].toFixed(3)}, ${i.lift.ci95[1].toFixed(3)}]`)
    console.log(`pValue:   ${i.lift.pValue.toFixed(4)}`)
    console.log(`Cohen's d: ${i.lift.cohensD.toFixed(2)}`)
    console.log(`MDE @ 80% power: ${i.lift.mde.toFixed(3)}`)
    console.log(`required n at observed effect: ${i.lift.requiredN}`)
    console.log()
  }

  console.log(`── Composite distribution (n=${i.composite.n} cells) ──`)
  console.log(
    `mean: ${i.composite.mean.toFixed(3)}, ` +
      `p50: ${i.composite.p50.toFixed(3)}, ` +
      `p95: ${i.composite.p95.toFixed(3)}, ` +
      `stddev: ${i.composite.stddev.toFixed(3)}`,
  )
  console.log()

  console.log('── Cost-quality Pareto ──')
  console.log(
    `${i.costQuality.pareto.points.length} candidates plotted; ` +
      `${i.costQuality.pareto.points.filter((p) => p.onFrontier).length} on the frontier`,
  )
  console.log()

  if (Object.keys(i.judges).length > 0) {
    console.log('── Per-judge mean scores ──')
    for (const [name, j] of Object.entries(i.judges)) {
      console.log(`  ${name}: ${j.meanScore.toFixed(3)} (n=${j.n})`)
    }
    console.log()
  }

  console.log('── Recommendations ──')
  for (const r of i.recommendations) {
    console.log(`[${r.priority}] ${r.kind} — ${r.title}`)
    console.log(`  ${r.detail}`)
  }
  console.log()
  console.log('═══ end ═══')
}

function signed(n: number): string {
  return `${n >= 0 ? '+' : ''}${n.toFixed(3)}`
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
