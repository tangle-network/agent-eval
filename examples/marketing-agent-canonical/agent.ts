/**
 * Canonical multi-step marketing agent - what we wrap as `Dispatch` for
 * the self-improvement demo. The shape is intentionally non-trivial so the
 * `gepaProposer` reflection has real behavior to optimize:
 *
 *   1. Research — extract the value claim and audience signals from the brief.
 *   2. Outline — choose the structure (lead with outcome / quote / proof).
 *   3. Draft — produce the first cut at the target surface length.
 *   4. Critique — find the AI-slop tokens, generic adjectives, vague claims.
 *   5. Final — produce the revised output addressing the critique.
 *
 * The substrate optimizes the **system prompt for the final step**
 * (everything else stays fixed). That's the highest-leverage seam — the
 * reflective LLM has clear signal: improve the final-pass prompt and
 * the agent gets better across all 15 scenarios.
 *
 * All LLM calls go through any OpenAI-compatible endpoint. Set
 * `OPENAI_BASE_URL=https://router.tangle.tools/v1` (or any other OpenAI-
 * compat endpoint) + `OPENAI_API_KEY` to point it at Tangle Router /
 * OpenRouter / OpenAI direct.
 */

import type { MarketingScenario } from './scenarios'

export interface MarketingArtifact {
  /** The final, polished copy. */
  rewrite: string
  /** Intermediate steps captured for trace + judge inspection. */
  research: string
  outline: string
  firstDraft: string
  critique: string
  /** Which model emitted each step (useful for cost attribution). */
  modelUsed: string
  /** Approx total tokens charged (sum of all 5 calls). */
  tokensUsed: number
}

export interface AgentConfig {
  apiKey: string | undefined
  baseUrl: string
  model: string
  /** The mutable prompt — the system prompt for the final-pass rewrite.
   *  This is what `gepaProposer` swaps each generation. */
  finalPassSystemPrompt: string
}

export const DEFAULT_FINAL_PASS_SYSTEM_PROMPT = `You are a senior marketing copywriter. Given a brief, a critique, and a first draft, produce the FINAL piece of copy.

Hard rules:
- Output ONLY the final copy. No headers, no explanations, no markdown fences.
- Respect the surface's length constraint exactly (tweet ≤ 240 chars, button = 2-4 words, etc.).
- Lead with the specific user outcome, not the category.
- Use the voiceConstraints in the brief as hard requirements, not suggestions.
- Cite only the proofPoints actually given in the brief. Do not invent features.`

const STEP_PROMPTS = {
  research: `You are doing fast pre-writing research. Given the brief, extract:
1. The CORE VALUE CLAIM (one sentence — what does the user gain that they don't have today?)
2. The AUDIENCE SIGNALS (3-5 concrete characteristics — what they care about, vocabulary they use, surfaces they read)
3. The PROOF available (which proofPoints are quotable; which need hedging)
Return as a tight 4-6 line bullet list. No fluff.`,
  outline: `You are choosing the structural approach. Given the brief and the research notes, output ONE LINE indicating which structural pattern fits this surface + audience:
- "lead with outcome" — start with the user's after-state
- "lead with proof" — start with a concrete number or fact
- "lead with friction" — start with the problem they're feeling now
- "lead with category" — when the audience needs orientation first
Return only the chosen pattern + a 1-sentence why.`,
  draft: `You are writing the first cut. Given the brief, research notes, and chosen pattern, produce ONE first-draft of the copy. Honor the surface length. No commentary, just the copy.`,
  critique: `You are a strict editor. Given the brief and the first draft, find every problem. Be specific:
- AI-slop tokens used ("revolutionary", "powerful", "seamless", "cutting-edge", "next-gen")
- Generic adjectives that could be replaced with specific verbs/numbers
- Claims not backed by the brief's proofPoints
- Surface-fit issues (wrong length, wrong register, wrong vocabulary for audience)
- Missing CTA clarity
Return a 4-8 line bulleted critique. If the draft is genuinely good, say so plainly — don't invent issues.`,
}

interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

interface ChatCompletionResponse {
  choices: Array<{ message: { content: string | null } }>
  usage?: { total_tokens?: number }
}

async function chatCompletion(
  cfg: AgentConfig,
  messages: ChatMessage[],
  signal: AbortSignal,
): Promise<{ content: string; tokens: number }> {
  if (!cfg.apiKey) {
    // Deterministic stub so the demo runs in CI without a key.
    const tailUser = messages.filter((m) => m.role === 'user').at(-1)?.content ?? ''
    return { content: `[stub] ${tailUser.slice(0, 80)}`, tokens: 0 }
  }
  const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
    body: JSON.stringify({
      model: cfg.model,
      messages,
      temperature: 0.7,
    }),
    signal,
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`LLM call failed (${res.status}): ${text.slice(0, 200)}`)
  }
  const data = (await res.json()) as ChatCompletionResponse
  return {
    content: (data.choices[0]?.message?.content ?? '').trim(),
    tokens: data.usage?.total_tokens ?? 0,
  }
}

function briefBlob(s: MarketingScenario): string {
  return [
    `Surface: ${s.surface}`,
    `Audience: ${s.audience}`,
    `Blurb: ${s.blurb}`,
    `Voice constraints:`,
    ...s.voiceConstraints.map((c) => `- ${c}`),
    `Proof points available:`,
    ...s.proofPoints.map((p) => `- ${p}`),
  ].join('\n')
}

/**
 * Run the full 5-step marketing agent against one scenario.
 * `cfg.finalPassSystemPrompt` is the only prompt the improvement loop
 * mutates — every other step uses the fixed STEP_PROMPTS above.
 */
export async function runMarketingAgent(
  scenario: MarketingScenario,
  cfg: AgentConfig,
  signal: AbortSignal,
): Promise<MarketingArtifact> {
  const brief = briefBlob(scenario)
  let totalTokens = 0

  const research = await chatCompletion(
    cfg,
    [
      { role: 'system', content: STEP_PROMPTS.research },
      { role: 'user', content: brief },
    ],
    signal,
  )
  totalTokens += research.tokens

  const outline = await chatCompletion(
    cfg,
    [
      { role: 'system', content: STEP_PROMPTS.outline },
      { role: 'user', content: `Brief:\n${brief}\n\nResearch notes:\n${research.content}` },
    ],
    signal,
  )
  totalTokens += outline.tokens

  const firstDraft = await chatCompletion(
    cfg,
    [
      { role: 'system', content: STEP_PROMPTS.draft },
      {
        role: 'user',
        content: `Brief:\n${brief}\n\nResearch:\n${research.content}\n\nPattern:\n${outline.content}`,
      },
    ],
    signal,
  )
  totalTokens += firstDraft.tokens

  const critique = await chatCompletion(
    cfg,
    [
      { role: 'system', content: STEP_PROMPTS.critique },
      { role: 'user', content: `Brief:\n${brief}\n\nFirst draft:\n${firstDraft.content}` },
    ],
    signal,
  )
  totalTokens += critique.tokens

  // The optimizable step — uses cfg.finalPassSystemPrompt (mutated by gepaProposer).
  const finalPass = await chatCompletion(
    cfg,
    [
      { role: 'system', content: cfg.finalPassSystemPrompt },
      {
        role: 'user',
        content: `Brief:\n${brief}\n\nFirst draft:\n${firstDraft.content}\n\nCritique to address:\n${critique.content}`,
      },
    ],
    signal,
  )
  totalTokens += finalPass.tokens

  return {
    rewrite: finalPass.content,
    research: research.content,
    outline: outline.content,
    firstDraft: firstDraft.content,
    critique: critique.content,
    modelUsed: cfg.apiKey ? cfg.model : 'stub',
    tokensUsed: totalTokens,
  }
}
