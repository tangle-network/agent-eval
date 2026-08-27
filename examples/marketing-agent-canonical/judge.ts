/**
 * Marketing-quality judge - 6 dimensions calibrated to real copywriting
 * practice. Treat these dimensions as the product quality bar for the demo:
 * replace them when your agent has a different definition of "better".
 *
 * Each dimension scored 0.0 - 1.0. Composite = simple mean.
 *
 * The judge uses the same LLM endpoint as the agent (same baseUrl /
 * apiKey / model) so the example runs with one API key. In production,
 * you would typically use a stronger model for the judge than the agent.
 */

import type { JudgeConfig } from '../../src/contract'
import type { MarketingArtifact } from './agent'
import type { MarketingScenario } from './scenarios'

export interface MarketingJudgeConfig {
  apiKey: string | undefined
  baseUrl: string
  model: string
}

export const MARKETING_JUDGE_DIMENSIONS = [
  {
    key: 'hook_strength',
    description:
      'Opens with a concrete user outcome or specific number — not the product category or a generic positioning claim.',
  },
  {
    key: 'voice_match',
    description:
      'Reads like a human wrote it. No AI slop: "revolutionary", "powerful", "seamless", "cutting-edge", "next-gen". Specific verbs and nouns over generic adjectives.',
  },
  {
    key: 'cta_clarity',
    description:
      'The next step is unambiguous to the named audience. The CTA matches the medium (button copy is short; email subjects invite a reply; H1s invite scrolling).',
  },
  {
    key: 'factual_grounding',
    description:
      'Only claims things the brief actually supports — uses the proofPoints; honors hedging on uncertain claims. No invented features, no exaggerated numbers.',
  },
  {
    key: 'surface_fit',
    description:
      'Length and register correct for the medium: tweet ≤ 240 chars, button = 2-4 words, push-notification ≤ 100 chars, etc. Reads like the medium it lives on.',
  },
  {
    key: 'audience_specificity',
    description:
      'Uses vocabulary the named audience actually responds to. A LinkedIn enterprise post is different from a Product Hunt tagline; both are different from a sales follow-up.',
  },
] as const

const heuristicSurfaceTargets: Record<MarketingScenario['surface'], [number, number]> = {
  'landing-hero': [60, 240],
  'landing-h1': [40, 120],
  tweet: [40, 240],
  'email-subject': [20, 60],
  'cold-outreach-subject': [20, 70],
  'product-hunt-tagline': [20, 60],
  'linkedin-post': [200, 1300],
  'push-notification': [30, 100],
  'app-store-short': [10, 30],
  'banner-ad': [10, 80],
  'newsletter-subject': [20, 60],
  'onboarding-empty-state': [40, 200],
  'pricing-hero': [40, 200],
  'demo-cta-button': [4, 30],
  'sales-followup-subject': [20, 70],
}

const SLOP_TOKENS = [
  'revolutionary',
  'powerful',
  'seamless',
  'cutting-edge',
  'cutting edge',
  'next-gen',
  'next gen',
  'unlock',
  'leverage',
  'synergy',
  'transform your',
  'game-changing',
  'game changing',
]

interface JudgeJsonResponse {
  hook_strength: number
  voice_match: number
  cta_clarity: number
  factual_grounding: number
  surface_fit: number
  audience_specificity: number
  notes?: string
}

function heuristicScore(
  artifact: MarketingArtifact,
  scenario: MarketingScenario,
): JudgeJsonResponse {
  const text = artifact.rewrite.toLowerCase()
  const sloppy = SLOP_TOKENS.filter((s) => text.includes(s))
  const [lo, hi] = heuristicSurfaceTargets[scenario.surface]
  const lenOk = artifact.rewrite.length >= lo && artifact.rewrite.length <= hi
  const audienceFirstWord = scenario.audience.split(/\s+/)[0]?.toLowerCase() ?? ''
  const audienceHit = audienceFirstWord.length > 2 && text.includes(audienceFirstWord)
  const proofHit = scenario.proofPoints.some((p) => {
    const tok = p.split(/\s+/)[0]?.toLowerCase()
    return tok ? text.includes(tok) : false
  })

  const slopPenalty = Math.min(1, sloppy.length * 0.25)
  return {
    hook_strength: lenOk ? 0.55 : 0.35,
    voice_match: Math.max(0, 1 - slopPenalty),
    cta_clarity: audienceHit ? 0.7 : 0.45,
    factual_grounding: proofHit ? 0.75 : 0.5,
    surface_fit: lenOk ? 0.85 : 0.3,
    audience_specificity: audienceHit ? 0.75 : 0.45,
    notes: `heuristic: slop=${sloppy.length} lenOk=${lenOk} audienceMention=${audienceHit} proofHit=${proofHit}`,
  }
}

async function llmJudge(
  cfg: MarketingJudgeConfig,
  artifact: MarketingArtifact,
  scenario: MarketingScenario,
  signal: AbortSignal,
): Promise<JudgeJsonResponse> {
  const dimensionsBlock = MARKETING_JUDGE_DIMENSIONS.map(
    (d) => `- ${d.key}: ${d.description}`,
  ).join('\n')
  const prompt = `Score this copy rewrite on 6 dimensions, each 0.0 - 1.0. Return strict JSON, nothing else:
{"hook_strength": n, "voice_match": n, "cta_clarity": n, "factual_grounding": n, "surface_fit": n, "audience_specificity": n, "notes": "one-line summary"}

Dimensions:
${dimensionsBlock}

Brief:
Surface: ${scenario.surface}
Audience: ${scenario.audience}
Original blurb: ${scenario.blurb}
Voice constraints: ${scenario.voiceConstraints.join(' / ')}
Proof points available: ${scenario.proofPoints.join(' / ')}

Rewrite to score:
${artifact.rewrite}

Score strictly. A perfect 1.0 is a piece of copy you'd ship to production unchanged. A 0.5 is mediocre. A 0.0 is unusable.`

  const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey ?? ''}` },
    body: JSON.stringify({
      model: cfg.model,
      messages: [
        { role: 'system', content: 'You are a strict copywriting judge. Respond with JSON only.' },
        { role: 'user', content: prompt },
      ],
      temperature: 0.2,
    }),
    signal,
  })
  if (!res.ok) throw new Error(`Judge LLM call failed (${res.status}): ${await res.text()}`)
  const data = (await res.json()) as { choices: Array<{ message: { content: string | null } }> }
  const raw = data.choices[0]?.message?.content ?? ''
  const match = raw.match(/\{[\s\S]*\}/)
  if (!match) throw new Error(`Judge returned non-JSON: ${raw.slice(0, 200)}`)
  return JSON.parse(match[0]) as JudgeJsonResponse
}

export function buildMarketingJudge(
  cfg: MarketingJudgeConfig,
): JudgeConfig<MarketingArtifact, MarketingScenario> {
  return {
    name: 'marketing-quality',
    dimensions: MARKETING_JUDGE_DIMENSIONS.map((d) => ({ key: d.key, description: d.description })),
    async score({ artifact, scenario, signal }) {
      const result = cfg.apiKey
        ? await llmJudge(cfg, artifact, scenario, signal)
        : heuristicScore(artifact, scenario)

      const dims = {
        hook_strength: result.hook_strength,
        voice_match: result.voice_match,
        cta_clarity: result.cta_clarity,
        factual_grounding: result.factual_grounding,
        surface_fit: result.surface_fit,
        audience_specificity: result.audience_specificity,
      }
      const composite =
        (dims.hook_strength +
          dims.voice_match +
          dims.cta_clarity +
          dims.factual_grounding +
          dims.surface_fit +
          dims.audience_specificity) /
        6

      return { dimensions: dims, composite, notes: result.notes ?? '' }
    },
  }
}
