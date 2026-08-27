/**
 * # Foreign-agent quickstart — 15-minute end-to-end.
 *
 * The promise: wire your agent behind a `Dispatch`, define a few
 * scenarios + a judge, and run a real self-improvement loop in 15
 * minutes — no Tangle sandbox, no Tangle account, no hosting.
 *
 * What this file demonstrates with a runnable example:
 *
 *   1. A toy "marketing copy critique" agent calling any OpenAI-compatible
 *      endpoint via fetch (uses OPENAI_API_KEY + OPENAI_BASE_URL).
 *   2. 4 scenarios — short product blurbs that need a punchier rewrite.
 *   3. A 4-dimension LLM judge scoring hook strength, voice match, CTA
 *      clarity, factual grounding.
 *   4. `runEval` for a baseline score.
 *   5. `runImprovementLoop` with `gepaProposer` (reflective LLM mutation)
 *      + `defaultProductionGate` (held-out promotion guard) — the
 *      closed self-improvement loop.
 *
 * Without OPENAI_API_KEY the example still runs end-to-end against a
 * deterministic stub agent + heuristic judge so the wiring is verifiable
 * in CI; you just don't get a real lift. Set the env vars to see actual
 * gepa-driven improvement.
 *
 * Run: `pnpm tsx examples/foreign-agent-quickstart/index.ts`
 */

// IN-REPO: relative imports so the example typechecks against the workspace.
// COPY-PASTE INTO YOUR OWN PROJECT: change this to
//   import { ... } from '@tangle-network/agent-eval/contract'
// — the public subpath exposes exactly these names with the same shapes.
import {
  type Dispatch,
  type JudgeConfig,
  type MutableSurface,
  type Scenario,
  defaultProductionGate,
  gepaProposer,
  inMemoryCampaignStorage,
  runEval,
  runImprovementLoop,
} from '../../src/contract'

// ── 1. Your scenarios — what the agent gets evaluated on ────────────

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
    blurb: 'Generate marketing copy with our AI agent — faster, on-brand, every time.',
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

async function callLLM(system: string, user: string, signal: AbortSignal): Promise<string> {
  if (!apiKey) {
    // Deterministic stub so the example runs in CI without an API key.
    return `[stub] ${user.slice(0, 120)}`
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

// ── 3. Your judge — what "good" means ───────────────────────────────

const judge: JudgeConfig<MarketingArtifact, MarketingScenario> = {
  name: 'marketing-quality',
  dimensions: [
    { key: 'hook_strength', description: 'Opens with a concrete value claim, not a category description.' },
    { key: 'voice_match', description: 'Avoids AI slop ("revolutionary", "powerful", "seamless"); reads like a human wrote it.' },
    { key: 'cta_clarity', description: 'Makes the next step obvious for the named audience.' },
    { key: 'factual_grounding', description: 'Claims only what the blurb says or what is obviously true. No invented features.' },
  ],
  async score({ artifact, scenario, signal }) {
    if (!apiKey) {
      // Heuristic judge so the wiring is verifiable without an LLM key.
      const text = artifact.rewrite.toLowerCase()
      const slop = ['revolutionary', 'powerful', 'seamless', 'cutting-edge', 'next-gen'].filter((w) => text.includes(w))
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
      const dims = { hook_strength: hook, voice_match: voice, cta_clarity: cta, factual_grounding: grounding }
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
    const raw = await callLLM('You are a strict copywriting judge. Respond with only JSON.', judgePrompt, signal)
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
    const composite = (dims.hook_strength + dims.voice_match + dims.cta_clarity + dims.factual_grounding) / 4
    return { dimensions: dims, composite, notes: parsed.notes ?? '' }
  },
}

// ── 4. Helpers ──────────────────────────────────────────────────────

function meanComposite<TA, TS extends Scenario>(result: { aggregates: { byScenario: Record<string, { meanComposite: number }> } }): number {
  const vs = Object.values(result.aggregates.byScenario).map((s) => s.meanComposite)
  return vs.length === 0 ? 0 : vs.reduce((a, b) => a + b, 0) / vs.length
}

// ── 5. Main ─────────────────────────────────────────────────────────

async function main() {
  const storage = inMemoryCampaignStorage()
  const runDir = `mem://quickstart-${Date.now()}`

  // ── Baseline ────────────────────────────────────────────────────
  console.log('═══ Baseline eval ═══')
  const baseline = await runEval<MarketingScenario, MarketingArtifact>({
    scenarios,
    dispatch: buildDispatch(baselineSystemPrompt),
    judges: [judge],
    storage,
    runDir,
  })
  const baselineScore = meanComposite(baseline)
  console.log(`Baseline composite mean: ${baselineScore.toFixed(3)}`)
  console.log(`Cells executed: ${baseline.aggregates.cellsExecuted}, cost: $${baseline.aggregates.totalCostUsd.toFixed(4)}`)

  if (!apiKey) {
    console.log('\nNo OPENAI_API_KEY set — stopping after baseline. Set OPENAI_API_KEY (+ optional OPENAI_BASE_URL, MODEL_ID) and re-run to see the gepaProposer self-improvement loop with real lift.')
    return
  }

  // ── Self-improvement loop ───────────────────────────────────────
  //
  // gepaProposer proposes the next system prompt via reflective LLM
  // mutation (it reads the failures, writes a refined prompt).
  // defaultProductionGate enforces held-out improvement before any
  // candidate is allowed to ship.

  console.log('\n═══ Self-improvement loop (gepaProposer + defaultProductionGate) ═══')
  const holdout = scenarios.slice(0, 2)
  const train = scenarios.slice(2)

  const result = await runImprovementLoop<MarketingScenario, MarketingArtifact>({
    scenarios: train,
    baselineSurface: baselineSystemPrompt,
    dispatchWithSurface: async (surface, scenario, ctx) => {
      const prompt = typeof surface === 'string' ? surface : JSON.stringify(surface)
      return buildDispatch(prompt)(scenario, ctx)
    },
    proposer: gepaProposer({
      llm: { apiKey, baseUrl },
      model: modelId,
      target: 'marketing copywriting system prompt',
      mutationPrimitives: [
        'Tighten the hook: lead with the concrete user outcome.',
        'Replace generic adjectives with specific verbs.',
        'Anchor every claim in something the blurb literally says.',
      ],
    }),
    judges: [judge],
    populationSize: 2,
    maxGenerations: 3,
    holdoutScenarios: holdout,
    gate: defaultProductionGate({
      holdoutScenarios: holdout,
      deltaThreshold: 0.05,
    }),
    autoOnPromote: 'none',
    storage,
    runDir: `${runDir}/improve`,
  })

  const winnerScore = meanComposite(result.winnerOnHoldout)
  const baselineHoldoutScore = meanComposite(result.baselineOnHoldout)
  const lift = winnerScore - baselineHoldoutScore
  console.log(`Generations explored: ${result.generations.length}`)
  console.log(`Gate decision:        ${result.gateResult.decision}`)
  console.log(`Holdout baseline:     ${baselineHoldoutScore.toFixed(3)}`)
  console.log(`Holdout winner:       ${winnerScore.toFixed(3)} (Δ ${lift >= 0 ? '+' : ''}${lift.toFixed(3)})`)

  const shipped: MutableSurface | null = result.gateResult.decision === 'ship' ? result.winnerSurface : null
  if (shipped) {
    const prompt = typeof shipped === 'string' ? shipped : JSON.stringify(shipped, null, 2)
    console.log(`\n--- Shipped prompt ---\n${prompt}\n`)
  } else {
    console.log(`\nGate did not ship (${result.gateResult.decision}). Either raise maxGenerations, lower deltaThreshold, or revise the mutation primitives.`)
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
