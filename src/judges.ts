import type { TCloud } from '@tangle-network/tcloud'
import { JudgeError } from './errors'
import type { LlmCallMetadata } from './llm-client'
import type { JudgeFn, JudgeInput, JudgeScore } from './types'

type JudgeParseErrorOptions = { cause?: unknown; llmCall?: LlmCallMetadata }

/**
 * A judge's LLM response could not be parsed into scored dimensions.
 * Thrown instead of fabricating a `{ dimension: 'parse_error', score: 0 }`
 * row — a synthetic zero is indistinguishable from a real low score
 * downstream. Carries the raw response for forensics. Callers (executor,
 * ensemble wrappers) catch this per-judge and record a failed judge.
 */
export class JudgeParseError extends JudgeError {
  /** Name of the judge whose response failed to parse. */
  readonly judgeName: string
  /** The raw (truncated) model response that failed to parse. */
  readonly raw: string
  /** Paid-call metadata remains available even when the verdict is unusable. */
  readonly llmCall?: LlmCallMetadata

  constructor(judgeName: string, raw: string, options?: JudgeParseErrorOptions) {
    super(`judge '${judgeName}' returned an unparseable response: ${raw.slice(0, 200)}`, options)
    this.judgeName = judgeName
    this.raw = raw
    this.llmCall = options?.llmCall
  }
}

/**
 * Create a domain expert judge with a configurable domain.
 *
 * The judge evaluates professional accuracy and depth.
 *
 * @deprecated Legacy `JudgeFn` factory tied to the fixed gpt-4o prompt shape.
 * Build judges as campaign `JudgeConfig`s (src/campaign/types.ts) — or
 * multi-model panels via `ensembleJudge` (src/judge-panel.ts) — which are
 * pluggable, fail-loud, and drive the campaign/improvement-loop engines.
 */
export function createDomainExpertJudge(domain: string): JudgeFn {
  return async (
    tc: TCloud,
    { scenario, turns }: Pick<JudgeInput, 'scenario' | 'turns'>,
  ): Promise<JudgeScore[]> => {
    const conversation = turns
      .map(
        (t, i) =>
          `Turn ${i + 1}:\nUser: ${t.userMessage}\nAgent: ${t.agentResponse.slice(0, 2000)}`,
      )
      .join('\n\n---\n\n')

    const resp = await tc.chat({
      model: 'gpt-4o',
      messages: [
        {
          role: 'system',
          content: `You are a senior ${domain} professional with 20+ years of experience. You are evaluating an AI agent's responses for professional accuracy and depth.

Score STRICTLY. A 5 means "a junior professional could do this." An 8 means "solid mid-career work." A 10 means "I would hire this agent."

Evaluate:
1. **domain_accuracy** (0-10): Are the technical terms correct? Are the recommendations what you'd actually do? Would this advice cause problems if followed?
2. **professional_depth** (0-10): Does it go beyond surface-level? Does it consider practical constraints, edge cases, industry standards? Or is it generic textbook advice?

Respond with JSON only: [{"dimension":"domain_accuracy","score":N,"reasoning":"...","evidence":"quote from response"},{"dimension":"professional_depth","score":N,"reasoning":"...","evidence":"quote"}]`,
        },
        {
          role: 'user',
          content: `Persona: ${scenario.persona} (${scenario.label})\nScenario: ${scenario.thesis}\n\n${conversation}`,
        },
      ],
      temperature: 0.1,
      maxTokens: 800,
    })

    return parseJudgeResponse('domain_expert', resp)
  }
}

/**
 * Code execution judge — evaluates whether code blocks are valid and runnable.
 *
 * @deprecated Legacy `JudgeFn` factory tied to the fixed gpt-4o prompt shape.
 * Build judges as campaign `JudgeConfig`s (src/campaign/types.ts) — or
 * multi-model panels via `ensembleJudge` (src/judge-panel.ts).
 */
export const codeExecutionJudge: JudgeFn = async (tc, { scenario, artifacts }) => {
  const codeBlocks = artifacts.codeBlocks
  if (codeBlocks.length === 0) {
    return [
      {
        judgeName: 'code_execution',
        dimension: 'code_execution',
        score: 0,
        reasoning: 'No code blocks found in agent response.',
      },
    ]
  }

  const codeText = codeBlocks
    .map(
      (b, i) =>
        `Block ${i + 1} (${b.language}):\n\`\`\`${b.language}\n${b.code.slice(0, 3000)}\n\`\`\``,
    )
    .join('\n\n')

  const resp = await tc.chat({
    model: 'gpt-4o',
    messages: [
      {
        role: 'system',
        content: `You are a principal software engineer reviewing code written by an AI agent.

Score STRICTLY:
1. **executability** (0-10): Would this code run without errors? Check: import errors, undefined variables, missing deps, syntax errors. A 5 means "would run with minor fixes." A 10 means "copy-paste and it works."
2. **completeness** (0-10): Does it handle the FULL task, or just the happy path? A 5 means "handles the main case." A 10 means "production-ready."
3. **reusability** (0-10): Could this be saved as a tool and reused? A 5 means "works for this case." A 10 means "general-purpose tool."

Respond with JSON only: [{"dimension":"executability","score":N,"reasoning":"...","evidence":"specific line/issue"},{"dimension":"completeness","score":N,"reasoning":"...","evidence":"..."},{"dimension":"reusability","score":N,"reasoning":"...","evidence":"..."}]`,
      },
      {
        role: 'user',
        content: `Task: ${scenario.thesis}\n\n${codeText}`,
      },
    ],
    temperature: 0.1,
    maxTokens: 1000,
  })

  return parseJudgeResponse('code_execution', resp)
}

/**
 * Coherence judge — evaluates multi-turn consistency and progression.
 *
 * @deprecated Legacy `JudgeFn` factory tied to the fixed gpt-4o prompt shape.
 * Build judges as campaign `JudgeConfig`s (src/campaign/types.ts) — or
 * multi-model panels via `ensembleJudge` (src/judge-panel.ts).
 */
export const coherenceJudge: JudgeFn = async (tc, { scenario, turns }) => {
  if (turns.length < 2) {
    // Single-turn scenarios carry no multi-turn signal. Emit no judge
    // scores so the coherence dimension is correctly absent from the
    // aggregate for this trial rather than pinned to a synthetic value.
    return []
  }

  const conversation = turns
    .map(
      (t, i) =>
        `Turn ${i + 1}:\nUser: ${t.userMessage}\nAgent (${t.agentResponse.length} chars): ${t.agentResponse.slice(0, 1500)}`,
    )
    .join('\n\n---\n\n')

  const resp = await tc.chat({
    model: 'gpt-4o',
    messages: [
      {
        role: 'system',
        content: `You evaluate whether an AI agent maintains coherence across a multi-turn conversation.

Score STRICTLY:
1. **consistency** (0-10): Does the agent contradict itself across turns? Does it remember what it said/built earlier?
2. **progression** (0-10): Does each turn BUILD on the previous? Or does it start fresh? A 5 means "vaguely related." A 10 means "each turn clearly advances the work."
3. **feedback_integration** (0-10): When the user gives feedback, does the agent demonstrate it HEARD the feedback?

Respond with JSON only: [{"dimension":"consistency","score":N,"reasoning":"..."},{"dimension":"progression","score":N,"reasoning":"..."},{"dimension":"feedback_integration","score":N,"reasoning":"..."}]`,
      },
      {
        role: 'user',
        content: `Scenario: ${scenario.thesis}\n\n${conversation}`,
      },
    ],
    temperature: 0.1,
    maxTokens: 800,
  })

  return parseJudgeResponse('coherence', resp)
}

/**
 * Adversarial judge — red-teams agent responses.
 *
 * @deprecated Legacy `JudgeFn` factory tied to the fixed gpt-4o prompt shape.
 * Build judges as campaign `JudgeConfig`s (src/campaign/types.ts) — or
 * multi-model panels via `ensembleJudge` (src/judge-panel.ts).
 */
export const adversarialJudge: JudgeFn = async (tc, { scenario, turns }) => {
  const conversation = turns
    .map(
      (t, i) => `Turn ${i + 1}:\nUser: ${t.userMessage}\nAgent: ${t.agentResponse.slice(0, 1500)}`,
    )
    .join('\n\n---\n\n')

  const resp = await tc.chat({
    model: 'gpt-4o',
    messages: [
      {
        role: 'system',
        content: `You are a red-team evaluator. Find the WEAKEST point in the AI agent's responses. Be adversarial.

1. **hallucination** (0-10, inverted — 10 means NO hallucination): Did the agent make up facts, cite nonexistent tools, invent standards?
2. **false_confidence** (0-10, inverted — 10 means appropriate uncertainty): Did the agent present uncertain information as fact?
3. **worst_failure** (0-10, inverted — 10 means no critical failures): What is the single worst thing in the response?

Be harsh. If everything is genuinely good, say so — but look hard first.

Respond with JSON only: [{"dimension":"hallucination","score":N,"reasoning":"...","evidence":"specific quote"},{"dimension":"false_confidence","score":N,"reasoning":"...","evidence":"..."},{"dimension":"worst_failure","score":N,"reasoning":"...","evidence":"..."}]`,
      },
      {
        role: 'user',
        content: `Persona: ${scenario.persona}\nScenario: ${scenario.thesis}\n\n${conversation}`,
      },
    ],
    temperature: 0.2,
    maxTokens: 800,
  })

  return parseJudgeResponse('adversarial', resp)
}

/**
 * Create a custom judge with a fully custom prompt.
 *
 * @deprecated Legacy `JudgeFn` factory tied to the fixed gpt-4o prompt shape.
 * Build judges as campaign `JudgeConfig`s (src/campaign/types.ts) — or
 * multi-model panels via `ensembleJudge` (src/judge-panel.ts).
 */
export function createCustomJudge(
  name: string,
  systemPrompt: string,
  opts?: { model?: string; temperature?: number; maxTokens?: number },
): JudgeFn {
  return async (tc, { scenario, turns }) => {
    const conversation = turns
      .map(
        (t, i) =>
          `Turn ${i + 1}:\nUser: ${t.userMessage}\nAgent: ${t.agentResponse.slice(0, 2000)}`,
      )
      .join('\n\n---\n\n')

    const resp = await tc.chat({
      model: opts?.model ?? 'gpt-4o',
      messages: [
        {
          role: 'system',
          content: systemPrompt,
        },
        {
          role: 'user',
          content: `Persona: ${scenario.persona} (${scenario.label})\nScenario: ${scenario.thesis}\n\n${conversation}`,
        },
      ],
      temperature: opts?.temperature ?? 0.1,
      maxTokens: opts?.maxTokens ?? 1000,
    })

    return parseJudgeResponse(name, resp)
  }
}

/**
 * Default judge set (domain must be provided for domain expert)
 *
 * @deprecated Legacy `JudgeFn` factory tied to the fixed gpt-4o prompt shape.
 * Build judges as campaign `JudgeConfig`s (src/campaign/types.ts) — or
 * multi-model panels via `ensembleJudge` (src/judge-panel.ts).
 */
export function defaultJudges(domain: string): JudgeFn[] {
  return [createDomainExpertJudge(domain), codeExecutionJudge, coherenceJudge, adversarialJudge]
}

// ── Helpers ──

function parseJudgeResponse(judgeName: string, resp: unknown): JudgeScore[] {
  const content =
    (resp as { choices?: { message?: { content?: string } }[] }).choices?.[0]?.message?.content ??
    ''
  try {
    let cleaned = content.replace(/```json\n?|\n?```/g, '').trim()
    const arrayMatch = cleaned.match(/\[[\s\S]*\]/)
    if (arrayMatch) cleaned = arrayMatch[0]
    const parsed = JSON.parse(cleaned) as {
      dimension: string
      score: number
      reasoning: string
      evidence?: string
    }[]
    return parsed.map((p) => ({
      judgeName,
      dimension: p.dimension,
      score: Math.max(0, Math.min(10, p.score)),
      reasoning: p.reasoning ?? '',
      evidence: p.evidence,
    }))
  } catch (err) {
    // Throw rather than fabricate a zero-score row: a synthetic
    // `{ dimension: 'parse_error', score: 0 }` poisons composites downstream.
    throw new JudgeParseError(judgeName, content, { cause: err })
  }
}
