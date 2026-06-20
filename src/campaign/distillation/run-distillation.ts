/**
 * `runDistillation` — the teacher→student distillation loop. COMPOSES existing
 * substrate primitives; reimplements none of them:
 *
 *   - DRIVER       = `gepaProposer` (reflective prompt optimizer)
 *   - LOOP         = `runImprovementLoop` (outer: optimize → holdout re-score → gate)
 *   - MEASUREMENT  = `runCampaign` (inside the loop) scoring the student
 *   - JUDGE        = `buildAgreementJudge` — student label vs gold teacher label
 *   - GATE         = caller-supplied (`heldOutGate` / `defaultProductionGate`)
 *   - STUDENT      = a cheap single-shot analyst whose system prompt is the
 *                    `MutableSurface` GEPA mutates; it calls the LLM through
 *                    `createChatClient` and emits a JSON label.
 *
 * The surface IS the student's system prompt. Each generation GEPA rewrites it;
 * `dispatchWithSurface` renders {surface + scenario.input} into a chat request,
 * calls the (cheap) model, parses the produced JSON label, and returns it as
 * the artifact. The agreement judge scores that label against the gold label.
 *
 * `autoOnPromote: 'none'` is FORCED — the loop never opens a PR; the caller
 * (the `distill` CLI) decides what to do with the winning prompt.
 */

import {
  type ChatRequest,
  type ChatResponse,
  type CreateChatClientOpts,
  createChatClient,
} from '../../analyst/chat-client'
import type { LlmCallResult, LlmClientOptions } from '../../llm-client'
import { heldOutGate } from '../gates/heldout-gate'
import { type RunImprovementLoopResult, runImprovementLoop } from '../presets/run-improvement-loop'
import { type GepaProposerConstraints, gepaProposer } from '../proposers/gepa'
import { campaignMeanComposite } from '../score-utils'
import type { CampaignResult, Gate, JudgeConfig } from '../types'
import type { GoldScenario } from './gold-scenarios'

/** Render the student's prompt from {current surface, scenario input}. The
 *  surface is the system prompt; the scenario input is the user turn. Override
 *  to inject few-shot framing or a JSON-schema reminder. */
export type RenderStudentPrompt<TInput> = (args: {
  surface: string
  input: TInput
  scenarioId: string
}) => ChatRequest['messages']

/** Parse the model's raw text into a typed produced label. Throws on
 *  unparseable output — a thrown dispatch is recorded as a failed cell (never
 *  silently scored 0), which is the honest signal that the prompt isn't
 *  emitting valid JSON yet. */
export type ParseStudentLabel<TProduced> = (rawContent: string, scenarioId: string) => TProduced

export interface RunDistillationOptions<TProduced, TInput, TLabel> {
  /** The student analyst's INITIAL system prompt — the baseline surface GEPA
   *  searches from. */
  baselinePrompt: string
  /** Training scenarios (the optimization pool). */
  train: GoldScenario<TInput, TLabel>[]
  /** Held-out scenarios — kept OUT of training; scored only at the gate. */
  holdout: GoldScenario<TInput, TLabel>[]
  /** Transport for BOTH the student (cheap model) and the GEPA reflection
   *  (the optimizer model). The student calls it via `createChatClient`. */
  llm: CreateChatClientOpts
  /** Router transport the GEPA proposer reflects through. `gepaProposer` uses the
   *  package `LlmClient` directly (`LlmClientOptions`), not the ChatClient —
   *  pass the router creds here. A test may inject `fetch` to stub the
   *  reflection HTTP and exercise the wiring without real tokens. */
  reflectionLlm: LlmClientOptions
  /** Cheap model the student runs (e.g. a small/fast model). */
  studentModel: string
  /** Model GEPA uses to propose prompt rewrites (typically a stronger model). */
  optimizerModel: string
  /** Agreement judge — produced student label vs gold teacher label. */
  judge: JudgeConfig<TProduced, GoldScenario<TInput, TLabel>>
  /** Promotion gate. Default: `heldOutGate` over the holdout. Pass
   *  `defaultProductionGate({ holdoutScenarios: holdout, ... })` for the full
   *  red-team / reward-hacking / canary stack. */
  gate?: Gate<TProduced, GoldScenario<TInput, TLabel>>
  /** GEPA population size (candidates per generation). Default 4. */
  populationSize?: number
  /** GEPA generations. Default 3. */
  maxGenerations?: number
  /** Campaign reps per scenario. Default 1 — raise for CI bands on a flaky
   *  student. */
  reps?: number
  /** Where campaign artifacts + traces land. Default a temp dir under cwd. */
  runDir?: string
  /** Levers offered to the GEPA reflection prompt. */
  mutationPrimitives?: string[]
  /** GEPA structured-doc constraints (preserve sections, edit budget). */
  constraints?: GepaProposerConstraints
  /** Gate's minimum holdout-agreement delta to ship. Default 0.0 — a
   *  distillation run reports the lift; the caller decides the bar. Only used
   *  when `gate` is omitted (the default `heldOutGate`). */
  deltaThreshold?: number
  /** Render the student prompt. Default: surface as system, JSON-stringified
   *  input as the user turn with a JSON-only instruction. */
  renderStudentPrompt?: RenderStudentPrompt<TInput>
  /** Parse the model's text into a produced label. Default: strict JSON parse
   *  with fenced-block stripping. */
  parseStudentLabel?: ParseStudentLabel<TProduced>
  /** Per-student-call sampling temperature. Default 0 (deterministic student;
   *  the optimization signal must come from the PROMPT, not sampling noise). */
  studentTemperature?: number
  /** Per-student-call max tokens. Default 1024. */
  studentMaxTokens?: number
}

export interface RunDistillationResult<TProduced, TInput, TLabel>
  extends RunImprovementLoopResult<TProduced, GoldScenario<TInput, TLabel>> {
  /** The winning student prompt (a string surface). */
  winnerPrompt: string
  /** Mean agreement on the HOLDOUT — baseline vs winner. The headline number:
   *  did distillation move the student closer to the teacher on UNSEEN gold? */
  holdoutAgreement: { baseline: number; winner: number; delta: number }
}

export async function runDistillation<TProduced, TInput, TLabel>(
  opts: RunDistillationOptions<TProduced, TInput, TLabel>,
): Promise<RunDistillationResult<TProduced, TInput, TLabel>> {
  if (opts.train.length === 0) throw new Error('runDistillation: train split is empty')
  if (opts.holdout.length === 0) throw new Error('runDistillation: holdout split is empty')

  const chat = createChatClient(opts.llm)
  const render = opts.renderStudentPrompt ?? defaultRenderStudentPrompt
  const parse = opts.parseStudentLabel ?? (defaultParseStudentLabel as ParseStudentLabel<TProduced>)
  const runDir = opts.runDir ?? `.evolve/distillation/${Date.now()}`
  const studentTemperature = opts.studentTemperature ?? 0
  const studentMaxTokens = opts.studentMaxTokens ?? 1024

  const proposer = gepaProposer({
    llm: opts.reflectionLlm,
    model: opts.optimizerModel,
    target:
      'a cheap single-shot analyst system prompt that reproduces an expensive workflow gold verdict',
    mutationPrimitives: opts.mutationPrimitives ?? DEFAULT_MUTATION_PRIMITIVES,
    constraints: opts.constraints,
  })

  const gate =
    opts.gate ??
    heldOutGate<TProduced, GoldScenario<TInput, TLabel>>({
      scenarios: opts.holdout,
      deltaThreshold: opts.deltaThreshold ?? 0,
    })

  const loop = await runImprovementLoop<GoldScenario<TInput, TLabel>, TProduced>({
    baselineSurface: opts.baselinePrompt,
    scenarios: opts.train,
    holdoutScenarios: opts.holdout,
    judges: [opts.judge],
    proposer,
    gate,
    autoOnPromote: 'none', // the loop NEVER opens a PR — the caller decides
    populationSize: opts.populationSize ?? 4,
    maxGenerations: opts.maxGenerations ?? 3,
    reps: opts.reps ?? 1,
    runDir,
    // The student spends tokens; tracing must stay on (the proposer is wired and
    // runImprovementLoop refuses tracing='off' with a proposer).
    tracing: 'on',
    dispatchWithSurface: async (surface, scenario, ctx) => {
      const prompt = render({
        surface: typeof surface === 'string' ? surface : JSON.stringify(surface),
        input: scenario.input,
        scenarioId: scenario.id,
      })
      const response: ChatResponse = await chat.chat(
        {
          model: opts.studentModel,
          messages: prompt,
          jsonMode: true,
          temperature: studentTemperature,
          maxTokens: studentMaxTokens,
        },
        { signal: ctx.signal },
      )
      reportUsage(ctx.cost, response)
      return parse(response.content, scenario.id)
    },
  })

  const winnerPrompt =
    typeof loop.winnerSurface === 'string' ? loop.winnerSurface : opts.baselinePrompt
  const baseline = campaignMeanComposite(loop.baselineOnHoldout)
  const winner = campaignMeanComposite(loop.winnerOnHoldout)

  return {
    ...loop,
    winnerPrompt,
    holdoutAgreement: { baseline, winner, delta: winner - baseline },
  }
}

/** Report the student call's cost + tokens to the cell meter. A cell that
 *  reports neither reads as a stub to `assertRealBackend` — every student call
 *  MUST report. When the proxy doesn't return a cost we still report tokens so
 *  the cell is non-stub. */
function reportUsage(
  cost: {
    observe(amountUsd: number, source: string): void
    observeTokens(u: { input: number; output: number; cached?: number }): void
  },
  response: LlmCallResult,
): void {
  if (typeof response.costUsd === 'number') cost.observe(response.costUsd, 'distillation-student')
  cost.observeTokens({
    input: response.usage.promptTokens,
    output: response.usage.completionTokens,
    cached: response.usage.cachedPromptTokens,
  })
}

const DEFAULT_MUTATION_PRIMITIVES = [
  'Add an explicit output-schema instruction so the model emits exactly the gold label fields as JSON.',
  'Add a one-line decision rule for each verdict field the student keeps getting wrong.',
  'Add a worked example mapping a representative input to its correct gold label.',
  'Tighten ambiguous phrasing that lets the student hedge instead of committing to a verdict.',
  'Add a guardrail that forces the student to set boolean risk flags (e.g. leak risk) when the triggering condition is present.',
]

/** Default student prompt render: surface as system, JSON input as the user
 *  turn, with a JSON-only output instruction. */
export function defaultRenderStudentPrompt<TInput>(args: {
  surface: string
  input: TInput
  scenarioId: string
}): ChatRequest['messages'] {
  return [
    { role: 'system', content: args.surface },
    {
      role: 'user',
      content:
        `Input:\n${stableStringify(args.input)}\n\n` +
        'Respond with ONLY a single JSON object — the verdict. No prose, no code fences.',
    },
  ]
}

/** Default label parse: strip a ```json fence if present, then `JSON.parse`.
 *  Throws on failure so the cell is recorded as failed, not silently zeroed. */
export function defaultParseStudentLabel<TProduced>(
  rawContent: string,
  scenarioId: string,
): TProduced {
  const stripped = stripFence(rawContent).trim()
  if (stripped.length === 0) {
    throw new Error(`distillation student returned empty output for scenario '${scenarioId}'`)
  }
  try {
    return JSON.parse(stripped) as TProduced
  } catch (err) {
    throw new Error(
      `distillation student returned non-JSON for scenario '${scenarioId}': ${
        err instanceof Error ? err.message : String(err)
      } — raw: ${stripped.slice(0, 200)}`,
    )
  }
}

function stripFence(text: string): string {
  const fenced = /```(?:json)?\s*([\s\S]*?)\s*```/.exec(text)
  return fenced ? (fenced[1] ?? text) : text
}

/** Deterministic JSON stringify with sorted keys — so the same input always
 *  renders the same prompt (a key-order shuffle would perturb the student). */
function stableStringify(value: unknown): string {
  return JSON.stringify(value, replacerSortKeys(), 2)
}

function replacerSortKeys(): (key: string, value: unknown) => unknown {
  return (_key, value) => {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const sorted: Record<string, unknown> = {}
      for (const k of Object.keys(value as Record<string, unknown>).sort()) {
        sorted[k] = (value as Record<string, unknown>)[k]
      }
      return sorted
    }
    return value
  }
}

export type { CampaignResult }
