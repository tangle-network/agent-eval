/**
 * Analyst-kind factory — the typed, focused replacement for the
 * legacy `createTraceAnalystAdapter`.
 *
 * A "kind" is a specialized analyst whose actor prompt, tool subset,
 * and Ax recursion config target one failure-mode lens (failure-mode
 * classification, knowledge gap discovery, knowledge poisoning, recursive
 * self-improvement, ...). Kinds emit findings in the typed `RawAnalystFinding`
 * shape via a JSON-array Ax output; the factory validates each row with
 * Zod and lifts it into `AnalystFinding[]` with no shape guessing.
 *
 * Composition rules:
 *   - Each kind owns its actor description. No generic "answer this
 *     question" prompt — the prompt names the failure lens.
 *   - Each kind picks a narrow tool subset from `ANALYST_TOOL_GROUPS`.
 *     A kind that never needs full-trace dumps can drop `viewTrace` /
 *     `viewSpans` and stay cheap.
 *   - Each kind declares its recursion + parallelism budget. Discovery-
 *     heavy kinds (failure-mode) get higher `maxDepth`; lens kinds
 *     (poisoning) usually stay at 0 since they have a tighter brief.
 *
 * Optimizer hook: kinds may declare `goldens` — labeled examples used
 * by `AxMiPRO` / `AxBootstrapFewShot` / `AxGEPA` to fit the actor
 * description programmatically. Stored on the kind, not the registry,
 * because the right metric is kind-specific.
 */

import type { AxAIService, AxFunction } from '@ax-llm/ax'
import { AxJSRuntime, agent } from '@ax-llm/ax'
import type { TraceAnalysisStore } from '../trace-analyst/store'
import { TraceFileMissingError } from '../trace-analyst/store-otlp'
import {
  parseRawFinding,
  RAW_FINDING_SCHEMA_PROMPT,
  type RawAnalystFinding,
} from './finding-signature'
import type { Analyst, AnalystContext, AnalystCost, AnalystFinding } from './types'
import { makeFinding } from './types'

/**
 * Per-kind specification. The factory turns this into a regular
 * `Analyst<TraceAnalysisStore>` ready for `AnalystRegistry.register()`.
 */
export interface TraceAnalystKindSpec {
  /** Stable id. Appears in finding_id, telemetry, and registry exclusions. */
  id: string
  /** One-sentence description shown in `registry.list()`. */
  description: string
  /** Coarse classification stamped on every emitted finding (`failure-mode`, `knowledge-gap`, ...). */
  area: string
  /** Bump on any breaking change to the actor prompt or output schema. */
  version: string
  /** Actor system prompt. Must instruct the LLM to emit `findings` per the schema. */
  actorDescription: string
  /** Responder system prompt; falls back to a minimal "format the findings" instruction. */
  responderDescription?: string
  /** Tool functions the actor may call. Pick narrow subsets via `ANALYST_TOOL_GROUPS`. */
  buildTools: (store: TraceAnalysisStore) => AxFunction[]
  /** Recursion budget. `maxDepth: 0` disables subagents. */
  recursion?: { maxDepth: number; maxParallelSubagents?: number }
  /** Actor turn cap. Default 12. */
  maxTurns?: number
  /** Runtime char cap. Default 6000. */
  maxRuntimeChars?: number
  /** Cost classification surfaced in `registry.list()` and budget enforcement. */
  cost: AnalystCost
  /** Per-finding-row hook — kinds may reject / rewrite before lifting. */
  postProcess?: (row: RawAnalystFinding, ctx: AnalystContext) => RawAnalystFinding | null
  /** Optional optimizer hook — populated when a kind wants to fit its prompt against labeled examples. */
  goldens?: TraceAnalystGolden[]
}

/**
 * One labeled example consumed by Ax optimizers (MIPRO / GEPA / Bootstrap).
 * Each input is the same `{question}` an analyst would receive; `expected`
 * is the ground-truth finding set a fitted prompt should produce on this
 * input. Metric: kind-specific (default: F1 on `finding_id` overlap).
 */
export interface TraceAnalystGolden {
  question: string
  expected: ReadonlyArray<Omit<RawAnalystFinding, 'confidence'>>
}

export interface CreateTraceAnalystKindOpts {
  /** AxAIService bound at registration time. */
  ai: AxAIService
  /** Optional model override; falls back to the AI service's default. */
  model?: string
  /** Override the spec's `version` (e.g. when an optimizer has fitted a new prompt). */
  versionSuffix?: string
}

/**
 * Build an `Analyst<TraceAnalysisStore>` from a kind spec.
 *
 * Lifts the Ax pipeline once at registration time so the registry
 * gets a stateless analyst. The Ax agent is freshly constructed per
 * `analyze()` call (the agent carries chat-log + usage state we don't
 * want shared across analyst runs).
 */
export function createTraceAnalystKind(
  spec: TraceAnalystKindSpec,
  opts: CreateTraceAnalystKindOpts,
): Analyst<TraceAnalysisStore> {
  const version = opts.versionSuffix ? `${spec.version}+${opts.versionSuffix}` : spec.version
  return {
    id: spec.id,
    description: spec.description,
    inputKind: 'trace-store',
    cost: spec.cost,
    version,
    async analyze(store, ctx) {
      const tools = spec.buildTools(store)
      const maxDepth = spec.recursion?.maxDepth ?? 0
      const maxParallel = spec.recursion?.maxParallelSubagents ?? 2

      const actorDescription =
        spec.actorDescription.trim() +
        '\n\n' +
        RAW_FINDING_SCHEMA_PROMPT +
        '\n\nReturn the array in the `findings` output field. Use `final(...)` ' +
        'with the structured `{ findings }` payload when you are done.'

      const ax = agent<{ question: string }, { findings: unknown[] }>(
        'question:string -> findings:json[]',
        {
          agentIdentity: {
            name: spec.id,
            description: spec.description,
          },
          contextFields: ['question'],
          runtime: new AxJSRuntime({
            permissions: [],
            blockDynamicImport: true,
            allowedModules: [],
            freezeIntrinsics: true,
            blockShadowRealm: true,
            preventGlobalThisExtensions: false,
          }),
          mode: maxDepth > 0 ? 'advanced' : 'simple',
          recursionOptions: maxDepth > 0 ? { maxDepth } : undefined,
          maxTurns: spec.maxTurns ?? 12,
          maxRuntimeChars: spec.maxRuntimeChars ?? 6000,
          maxBatchedLlmQueryConcurrency: maxParallel,
          promptLevel: 'detailed',
          contextPolicy: { preset: 'full', budget: 'balanced' },
          functions: { local: tools },
          actorOptions: {
            description: actorDescription,
            ...(opts.model ? { model: opts.model } : {}),
            showThoughts: false,
            thinkingTokenBudget: 'none' as unknown as number,
          },
          responderOptions: {
            description:
              spec.responderDescription ??
              'Format the structured `findings` array exactly as the actor produced it. Do not add, drop, or summarize entries.',
            ...(opts.model ? { model: opts.model } : {}),
            showThoughts: false,
          },
          bubbleErrors: [TraceFileMissingError],
        },
      )

      ctx.log?.(`analyst.kind ${spec.id} forward`, {
        max_depth: maxDepth,
        tool_count: tools.length,
        tags: ctx.tags,
      })

      const result = await ax.forward(opts.ai, { question: deriveQuestion(ctx, spec) })

      const out: AnalystFinding[] = []
      const rawRows = Array.isArray(result.findings) ? result.findings : []
      for (const row of rawRows) {
        const parsed = parseRawFinding(row, ctx.log)
        if (!parsed) continue
        const postProcessed = spec.postProcess?.(parsed, ctx) ?? parsed
        if (!postProcessed) continue
        out.push(toAnalystFinding(spec, postProcessed))
      }

      ctx.log?.(`analyst.kind ${spec.id} done`, {
        emitted: rawRows.length,
        accepted: out.length,
      })
      return out
    },
  }
}

function deriveQuestion(ctx: AnalystContext, spec: TraceAnalystKindSpec): string {
  // Kinds can be steered with a per-run focusing tag without recompiling
  // the actor description. Operators set `tags.focus = "leaf-X"` and the
  // kind's brief is concatenated with that focus for the actor prompt's
  // user message. Falls back to the spec id when no tag is present.
  const focus = ctx.tags?.focus?.trim()
  if (focus) return `${spec.id}: ${focus}`
  return spec.id
}

function toAnalystFinding(spec: TraceAnalystKindSpec, raw: RawAnalystFinding): AnalystFinding {
  return makeFinding({
    analyst_id: spec.id,
    area: spec.area,
    subject: raw.subject,
    claim: raw.claim,
    rationale: raw.rationale,
    severity: raw.severity,
    confidence: raw.confidence,
    evidence_refs: [
      {
        kind: evidenceKindFromUri(raw.evidence_uri),
        uri: raw.evidence_uri,
        excerpt: raw.evidence_excerpt,
      },
    ],
    recommended_action: raw.recommended_action,
    metadata: { kind_version: spec.version },
  })
}

function evidenceKindFromUri(uri: string): 'span' | 'artifact' | 'metric' | 'event' | 'finding' {
  if (uri.startsWith('span://')) return 'span'
  if (uri.startsWith('artifact://')) return 'artifact'
  if (uri.startsWith('metric://')) return 'metric'
  if (uri.startsWith('event://')) return 'event'
  if (uri.startsWith('finding://')) return 'finding'
  return 'artifact'
}
