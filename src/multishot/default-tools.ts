// Default delegate_research + delegate_code tools and their inline executors.
//
// Consumers can override either by passing their own tools + executors to
// runMultishot. The defaults are sufficient for most domains — point the
// researcher system prompt at your domain's citation style and the coder
// at your preferred language.

import { estimateRouterCost, routerCompletion } from './router'
import type { MultishotToolDefinition, MultishotToolExecutor } from './types'

export const DEFAULT_RESEARCHER_MODEL = 'openai/gpt-4o-mini'
export const DEFAULT_CODER_MODEL = 'openai/gpt-4o-mini'

export interface DefaultResearcherConfig {
  /** Replace the system prompt to bias the researcher toward a domain's
   *  citation style. Defaults to a generic "cite sources by name" prompt. */
  systemPrompt?: string
  model?: string
}

export interface DefaultCoderConfig {
  /** Replace the system prompt to bias the coder toward a language /
   *  framework / artifact style. */
  systemPrompt?: string
  model?: string
}

const GENERIC_RESEARCHER_SYSTEM =
  'You are a research specialist. Return a markdown brief with 3-5 findings. Each finding cites a specific source by name. Add a confidence level (high/medium/low) per finding. No fluff, no preamble.'

const GENERIC_CODER_SYSTEM =
  'You are an expert engineer. Output ONE fenced code block containing the complete solution. Inline-comment non-obvious decisions. No explanation outside the block.'

export const DEFAULT_DELEGATE_RESEARCH_TOOL: MultishotToolDefinition = {
  type: 'function',
  function: {
    name: 'delegate_research',
    description:
      'Research a topic deeply via specialist. Returns evidence-bearing items with citations. Use for audience research, competitive intel, regulatory landscape, market data, citation-grounded analysis.',
    parameters: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'Specific question to research' },
        scope: {
          type: 'string',
          description: 'Optional scope: time window, geography, jurisdiction, segment',
        },
      },
      required: ['question'],
    },
  },
}

export const DEFAULT_DELEGATE_CODE_TOOL: MultishotToolDefinition = {
  type: 'function',
  function: {
    name: 'delegate_code',
    description:
      'Generate a runnable script, template, pipeline, or tool via specialist. Returns complete working code or structured markdown. Use for content pipelines, calc snippets, dashboards, compliance checklists, deadline trackers.',
    parameters: {
      type: 'object',
      properties: {
        goal: { type: 'string', description: 'What the code must accomplish' },
        language: {
          type: 'string',
          description: 'Optional language preference (default: TypeScript)',
        },
      },
      required: ['goal'],
    },
  },
}

export function createResearchExecutor(
  config: DefaultResearcherConfig = {},
): MultishotToolExecutor {
  const systemPrompt = config.systemPrompt ?? GENERIC_RESEARCHER_SYSTEM
  const model = config.model ?? DEFAULT_RESEARCHER_MODEL
  return async (args, ctx) => {
    const question = String(args.question ?? '')
    const scope = args.scope ? String(args.scope) : undefined
    const { message, usage } = await routerCompletion({
      apiKey: ctx.apiKey,
      baseUrl: ctx.baseUrl,
      model,
      temperature: 0.3,
      maxTokens: 1800,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `Research: ${question}${scope ? `\nScope: ${scope}` : ''}` },
      ],
      signal: ctx.signal,
    })
    return { content: message.content ?? '', costUsd: estimateRouterCost(model, usage) }
  }
}

export function createCodeExecutor(config: DefaultCoderConfig = {}): MultishotToolExecutor {
  const systemPrompt = config.systemPrompt ?? GENERIC_CODER_SYSTEM
  const model = config.model ?? DEFAULT_CODER_MODEL
  return async (args, ctx) => {
    const goal = String(args.goal ?? '')
    const language = args.language ? String(args.language) : 'TypeScript'
    const { message, usage } = await routerCompletion({
      apiKey: ctx.apiKey,
      baseUrl: ctx.baseUrl,
      model,
      temperature: 0.2,
      maxTokens: 2000,
      messages: [
        { role: 'system', content: `${systemPrompt}\n\nLanguage: ${language}` },
        { role: 'user', content: `Produce: ${goal}` },
      ],
      signal: ctx.signal,
    })
    return { content: message.content ?? '', costUsd: estimateRouterCost(model, usage) }
  }
}

export interface DefaultToolsConfig {
  research?: DefaultResearcherConfig
  code?: DefaultCoderConfig
  /** When true (default), each tool result is recorded as a typed artifact:
   *  research → type='research', code → type='code'. */
  recordArtifacts?: boolean
}

export interface DefaultToolsBundle {
  tools: MultishotToolDefinition[]
  executors: Record<string, MultishotToolExecutor>
  artifactTypeFor: (toolName: string) => string | undefined
}

export function defaultDelegationTools(config: DefaultToolsConfig = {}): DefaultToolsBundle {
  return {
    tools: [DEFAULT_DELEGATE_RESEARCH_TOOL, DEFAULT_DELEGATE_CODE_TOOL],
    executors: {
      delegate_research: createResearchExecutor(config.research),
      delegate_code: createCodeExecutor(config.code),
    },
    artifactTypeFor: (name) =>
      name === 'delegate_research' ? 'research' : name === 'delegate_code' ? 'code' : undefined,
  }
}

export { defaultRouterBaseUrl } from './router'
