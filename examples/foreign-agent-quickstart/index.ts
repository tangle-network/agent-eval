/**
 * Wrap an existing agent, evaluate it, and improve its prompt with a
 * caller-owned SurfaceProposer.
 *
 * Run: pnpm tsx examples/foreign-agent-quickstart/index.ts
 */

// IN-REPO: relative imports so the example typechecks against the workspace.
// COPY-PASTE INTO YOUR OWN PROJECT: change this to
//   import { ... } from '@tangle-network/agent-eval/contract'
// The public subpath exposes these names with the same shapes.
import {
  type Dispatch,
  defaultProductionGate,
  inMemoryCampaignStorage,
  type JudgeConfig,
  type MutableSurface,
  runEval,
  runImprovementLoop,
  type Scenario,
  type SurfaceProposer,
} from '../../src/contract'

// 1. Representative cases.

interface MarketingScenario extends Scenario {
  blurb: string
  surface: 'landing-hero' | 'tweet' | 'email-subject'
  audience: string
}

const scenarios: MarketingScenario[] = [
  {
    id: 's1',
    kind: 'marketing-rewrite',
    blurb: 'We help teams ship software faster with AI.',
    surface: 'landing-hero',
    audience: 'engineering leaders',
    tags: ['saas', 'developer-tools'],
  },
  {
    id: 's2',
    kind: 'marketing-rewrite',
    blurb: 'Our note-taking app uses machine learning to organize your thoughts.',
    surface: 'tweet',
    audience: 'consumer prosumers',
    tags: ['consumer', 'productivity'],
  },
  {
    id: 's3',
    kind: 'marketing-rewrite',
    blurb: 'Track expenses, file taxes, get refunds. Powered by AI.',
    surface: 'email-subject',
    audience: 'small-business owners',
    tags: ['fintech', 'tax'],
  },
  {
    id: 's4',
    kind: 'marketing-rewrite',
    blurb: 'Generate marketing copy with our AI agent, faster and on-brand.',
    surface: 'landing-hero',
    audience: 'marketing teams',
    tags: ['meta', 'marketing-tools'],
  },
]

// ── 2. Your agent, wrapped as a Dispatch ────────────────────────────

interface MarketingArtifact {
  rewrite: string
  modelUsed: string
}

const apiKey = process.env.OPENAI_API_KEY
const baseUrl = process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1'
const modelId = process.env.MODEL_ID ?? 'gpt-4o-mini'

const baselineSystemPrompt = `You are a senior copywriter. Rewrite the given product blurb for the surface (landing-hero / tweet / email-subject) and audience. One sentence for tweets and email subjects, two for landing hero. Be concrete, not generic; no AI slop ("revolutionary", "powerful", "seamless"). Lead with the value, not the technology.`

const customProposer: SurfaceProposer = {
  kind: 'marketing-constraints',
  async propose({ currentSurface, populationSize }) {
    const current = String(currentSurface)
    return [
      {
        surface: `${current}\nName the audience in the opening phrase.`,
        label: 'name-audience',
        rationale: 'Training outputs did not make the audience explicit.',
      },
      {
        surface: `${current}\nEnd with one explicit next step.`,
        label: 'explicit-next-step',
        rationale: 'Training outputs lacked a clear action.',
      },
    ].slice(0, populationSize)
  },
}

async function callLLM(system: string, user: string, signal: AbortSignal): Promise<string> {
  if (!apiKey) {
    const audience = /Audience: ([^\n]+)/.exec(user)?.[1] ?? 'reader'
    const blurb = /Blurb: ([^\n]+)/.exec(user)?.[1] ?? user
    const prefix = system.includes('Name the audience') ? `For ${audience}: ` : ''
    const suffix = system.includes('explicit next step') ? ' Try it today.' : ''
    return `${prefix}${blurb}${suffix}`
  }
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: modelId,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      temperature: 0.7,
    }),
    signal,
  })
  if (!res.ok) throw new Error(`LLM call failed: ${res.status} ${await res.text()}`)
  const data = (await res.json()) as { choices: { message: { content: string } }[] }
  return data.choices[0]?.message?.content ?? ''
}

function buildDispatch(systemPrompt: string): Dispatch<MarketingScenario, MarketingArtifact> {
  return async (scenario, ctx) => {
    const user = `Surface: ${scenario.surface}\nAudience: ${scenario.audience}\nBlurb: ${scenario.blurb}`
    const rewrite = await callLLM(systemPrompt, user, ctx.signal)
    return { rewrite: rewrite.trim(), modelUsed: apiKey ? modelId : 'stub' }
  }
}

// 3. The scoring rule.

const judge: JudgeConfig<MarketingArtifact, MarketingScenario> = {
  name: 'marketing-quality',
  dimensions: [
    {
      key: 'hook_strength',
      description: 'Opens with a concrete value claim, not a category description.',
    },
    {
      key: 'voice_match',
      description:
        'Avoids AI slop ("revolutionary", "powerful", "seamless"); reads like a human wrote it.',
    },
    { key: 'cta_clarity', description: 'Makes the next step obvious for the named audience.' },
    {
      key: 'factual_grounding',
      description:
        'Claims only what the blurb says or what is obviously true. No invented features.',
    },
  ],
  async score({ artifact, scenario, signal }) {
    if (!apiKey) {
      // Heuristic judge so the wiring is verifiable without an LLM key.
      const text = artifact.rewrite.toLowerCase()
      const slop = ['revolutionary', 'powerful', 'seamless', 'cutting-edge', 'next-gen'].filter(
        (w) => text.includes(w),
      )
      const surfaceTargets: Record<MarketingScenario['surface'], [number, number]> = {
        'landing-hero': [60, 180],
        tweet: [40, 140],
        'email-subject': [20, 80],
      }
      const [lo, hi] = surfaceTargets[scenario.surface]
      const lenOk = artifact.rewrite.length >= lo && artifact.rewrite.length <= hi
      const audienceHit = text.includes(scenario.audience.split(' ')[0]?.toLowerCase() ?? '')
      const base = 0.5
      const slopPenalty = slop.length * 0.1
      const lenBonus = lenOk ? 0.2 : 0
      const audienceBonus = audienceHit ? 0.15 : 0
      const hook = Math.max(0, Math.min(1, base - slopPenalty + lenBonus + audienceBonus))
      const voice = Math.max(0, 1 - slopPenalty * 2)
      const cta = audienceBonus > 0 ? 0.7 : 0.4
      const grounding = 0.7
      const dims = {
        hook_strength: hook,
        voice_match: voice,
        cta_clarity: cta,
        factual_grounding: grounding,
      }
      const composite = (hook + voice + cta + grounding) / 4
      return {
        dimensions: dims,
        composite,
        notes: `heuristic: slop=${slop.length} lenOk=${lenOk} audience=${audienceHit}`,
      }
    }
    const judgePrompt = `Score the rewrite below on 4 dimensions, 0.0 to 1.0. Return strict JSON:
{"hook_strength": n, "voice_match": n, "cta_clarity": n, "factual_grounding": n, "notes": "one sentence"}

Dimensions:
- hook_strength: Opens with a concrete value claim, not a category description.
- voice_match: Avoids AI slop; human-sounding.
- cta_clarity: Makes the next step obvious for the named audience.
- factual_grounding: Claims only what the blurb says or what is obviously true.

Surface: ${scenario.surface}
Audience: ${scenario.audience}
Original: ${scenario.blurb}
Rewrite: ${artifact.rewrite}`
    const raw = await callLLM(
      'You are a strict copywriting judge. Respond with only JSON.',
      judgePrompt,
      signal,
    )
    const match = raw.match(/\{[\s\S]*\}/)
    if (!match) throw new Error(`Judge returned non-JSON: ${raw.slice(0, 200)}`)
    const parsed = JSON.parse(match[0]) as {
      hook_strength: number
      voice_match: number
      cta_clarity: number
      factual_grounding: number
      notes?: string
    }
    const dims = {
      hook_strength: parsed.hook_strength,
      voice_match: parsed.voice_match,
      cta_clarity: parsed.cta_clarity,
      factual_grounding: parsed.factual_grounding,
    }
    const composite =
      (dims.hook_strength + dims.voice_match + dims.cta_clarity + dims.factual_grounding) / 4
    return { dimensions: dims, composite, notes: parsed.notes ?? '' }
  },
}

// 4. Helpers.

function meanComposite<TA, TS extends Scenario>(result: {
  aggregates: { byScenario: Record<string, { meanComposite: number }> }
}): number {
  const vs = Object.values(result.aggregates.byScenario).map((s) => s.meanComposite)
  return vs.length === 0 ? 0 : vs.reduce((a, b) => a + b, 0) / vs.length
}

// 5. Run the baseline and improvement loop.

async function main() {
  const storage = inMemoryCampaignStorage()
  const runDir = `mem://quickstart-${Date.now()}`

  console.log('Baseline evaluation')
  const baseline = await runEval<MarketingScenario, MarketingArtifact>({
    scenarios,
    dispatch: buildDispatch(baselineSystemPrompt),
    judges: [judge],
    storage,
    runDir,
    dispatchRef: 'foreign-agent-baseline',
  })
  const baselineScore = meanComposite(baseline)
  console.log(`Baseline composite mean: ${baselineScore.toFixed(3)}`)
  console.log(
    `Cells executed: ${baseline.aggregates.cellsExecuted}, cost: $${baseline.aggregates.totalCostUsd.toFixed(4)}`,
  )

  console.log('\nImprovement loop with a custom candidate generator')
  const holdout = scenarios.slice(0, 2)
  const train = scenarios.slice(2)

  const result = await runImprovementLoop<MarketingScenario, MarketingArtifact>({
    scenarios: train,
    baselineSurface: baselineSystemPrompt,
    dispatchWithSurface: async (surface, scenario, ctx) => {
      const prompt = typeof surface === 'string' ? surface : JSON.stringify(surface)
      return buildDispatch(prompt)(scenario, ctx)
    },
    proposer: customProposer,
    judges: [judge],
    populationSize: 2,
    maxGenerations: 1,
    holdoutScenarios: holdout,
    gate: defaultProductionGate({
      holdoutScenarios: holdout,
      deltaThreshold: 0.05,
    }),
    autoOnPromote: 'none',
    storage,
    runDir: `${runDir}/improve`,
    dispatchRef: 'foreign-agent-with-surface',
  })

  const winnerScore = meanComposite(result.winnerOnHoldout)
  const baselineHoldoutScore = meanComposite(result.baselineOnHoldout)
  const lift = winnerScore - baselineHoldoutScore
  console.log(`Generations explored: ${result.generations.length}`)
  console.log(`Gate decision:        ${result.gateResult.decision}`)
  console.log(`Holdout baseline:     ${baselineHoldoutScore.toFixed(3)}`)
  console.log(
    `Holdout winner:       ${winnerScore.toFixed(3)} (lift ${lift >= 0 ? '+' : ''}${lift.toFixed(3)})`,
  )

  const shipped: MutableSurface | null =
    result.gateResult.decision === 'ship' ? result.winnerSurface : null
  if (shipped) {
    const prompt = typeof shipped === 'string' ? shipped : JSON.stringify(shipped, null, 2)
    console.log(`\n--- Shipped prompt ---\n${prompt}\n`)
  } else {
    console.log(
      `\nThe release rule returned ${result.gateResult.decision}. Revise the candidate logic or threshold before promotion.`,
    )
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
