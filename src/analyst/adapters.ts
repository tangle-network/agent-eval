/**
 * Adapter factories — lift each existing agent-eval primitive into the
 * Analyst contract without re-implementing it.
 *
 * Five primitives, five factories. Each one:
 *   - Builds an Analyst with a stable id (caller chooses; defaults
 *     given), a sensible default `inputKind`, a version derived from
 *     the wrapped primitive's version + an adapter revision, and an
 *     `analyze()` that calls the primitive and lifts its output to
 *     AnalystFinding[] using `makeFinding()`.
 *   - Maps severities: the existing `Severity` ('critical' | 'major' |
 *     'minor' | 'info') projects onto AnalystSeverity ('critical' |
 *     'high' | 'medium' | 'low' | 'info'); 'major' → 'high', 'minor' →
 *     'medium'. Domain analysts that want finer-grained mapping override.
 *
 * Adapters never own state. Calling the same factory twice with the
 * same primitive instance is safe.
 */

import type { AxAIService } from '@ax-llm/ax'
import type {
  Finding as LayerFinding,
  Severity as LayerSeverity,
  MultiLayerVerifier,
  VerifyOptions,
} from '../multi-layer-verifier'
import { RunCritic, type RunTrace } from '../run-critic'
import {
  runSemanticConceptJudge,
  SEMANTIC_CONCEPT_JUDGE_VERSION,
  type SemanticConceptJudgeInput,
  type SemanticConceptJudgeOptions,
} from '../semantic-concept-judge'
import { type AnalyzeTracesOptions, analyzeTraces } from '../trace-analyst/analyst'
import type { TraceAnalysisStore } from '../trace-analyst/store'
import type { JudgeFn, JudgeInput, JudgeScore, TCloud } from '../types'
import type { Analyst, AnalystFinding, AnalystSeverity } from './types'
import { makeFinding } from './types'

const ADAPTER_REV = '1'

// ── Severity bridges ───────────────────────────────────────────────

export function liftSeverity(s: LayerSeverity): AnalystSeverity {
  switch (s) {
    case 'critical':
      return 'critical'
    case 'major':
      return 'high'
    case 'minor':
      return 'medium'
    case 'info':
      return 'info'
  }
}

// ── 1. analyzeTraces → Analyst ─────────────────────────────────────

export interface TraceAnalystAdapterOpts {
  id?: string
  area?: string
  /** The natural-language question(s) put to the analyst. One finding per question. */
  questions: string[]
  /** Caller-provided AxAI service — same one trace-analyst.ts expects. */
  ai: AxAIService
  model?: string
  /** Forwarded to analyzeTraces. */
  extra?: Omit<AnalyzeTracesOptions, 'source' | 'ai' | 'model'>
}

/**
 * @deprecated Prefer `createTraceAnalystKind` + one of the failure /
 * improvement kinds from `./kinds`. This adapter wraps the legacy
 * `analyzeTraces` flow whose output is `findings:string[]` — every
 * bullet gets flat-defaulted severity `medium` / confidence `0.6`,
 * which loses the per-finding grading kinds provide via Ax structured
 * output + Zod validation. Kept for one minor while consumers migrate.
 */
export function createTraceAnalystAdapter(
  opts: TraceAnalystAdapterOpts,
): Analyst<TraceAnalysisStore> {
  const id = opts.id ?? 'trace-analyst'
  const area = opts.area ?? 'agent-reasoning'
  return {
    id,
    description:
      'Runs the agent-eval trace analyst over an OTLP trace store and lifts its bulleted findings.',
    inputKind: 'trace-store',
    cost: { kind: 'llm', models: opts.model ? [opts.model] : undefined },
    version: `trace-analyst-${ADAPTER_REV}`,
    async analyze(store, ctx) {
      const out: AnalystFinding[] = []
      for (const question of opts.questions) {
        if (ctx.signal?.aborted) break
        const result = await analyzeTraces(
          { question },
          { source: store, ai: opts.ai, model: opts.model, ...opts.extra },
        )
        const subject = ctx.tags?.subject ?? question.slice(0, 60)
        // The responder produces a list of bullet strings. Each becomes
        // one finding; the prose answer is attached as rationale on the
        // first (so renderers that show only top-N still get context).
        if (result.findings.length === 0) {
          out.push(
            makeFinding({
              analyst_id: id,
              area,
              subject,
              claim: result.answer.slice(0, 200),
              rationale: result.answer,
              severity: 'info',
              confidence: 0.5,
              evidence_refs: [],
              metadata: {
                actor_prompt_version: result.actorPromptVersion,
                turns: result.turnCount,
              },
            }),
          )
          continue
        }
        result.findings.forEach((claim, i) => {
          out.push(
            makeFinding({
              analyst_id: id,
              area,
              subject,
              claim,
              rationale: i === 0 ? result.answer : undefined,
              severity: 'medium',
              confidence: 0.6,
              evidence_refs: [],
              metadata: { question, turns: result.turnCount, finding_index: i },
            }),
          )
        })
      }
      return out
    },
  }
}

// ── 2. MultiLayerVerifier → Analyst ─────────────────────────────────

export interface VerifierAdapterOpts<Env> {
  id?: string
  area?: string
  verifier: MultiLayerVerifier<Env>
  /**
   * The verifier expects an `env` per run. Adapters take it from
   * `AnalystRunInputs.custom[<id>]` via the registry's 'custom' routing.
   */
  options?: Omit<VerifyOptions<Env>, 'env'>
}

export function createVerifierAdapter<Env>(opts: VerifierAdapterOpts<Env>): Analyst<Env> {
  const id = opts.id ?? 'multi-layer-verifier'
  const area = opts.area ?? 'verification'
  return {
    id,
    description:
      "Runs a MultiLayerVerifier and lifts each layer's findings into the analyst envelope.",
    inputKind: 'custom',
    cost: { kind: 'deterministic' },
    version: `verifier-${ADAPTER_REV}`,
    async analyze(env, ctx) {
      const report = await opts.verifier.run({ env, ...opts.options })
      const out: AnalystFinding[] = []
      for (const layer of report.layers) {
        for (const finding of layer.findings) {
          out.push(liftLayerFinding(id, area, layer.layer, finding))
        }
        // Layer-level signal: a failed/error layer is itself a finding
        // even if it didn't emit per-finding rows.
        if (layer.status === 'fail' || layer.status === 'error' || layer.status === 'timeout') {
          out.push(
            makeFinding({
              analyst_id: id,
              area,
              subject: layer.layer,
              claim: `layer "${layer.layer}" ${layer.status}: ${layer.reason ?? 'no reason given'}`,
              severity:
                layer.status === 'error' ? 'high' : layer.status === 'timeout' ? 'medium' : 'high',
              confidence: 1,
              evidence_refs: [],
              metadata: {
                layer_status: layer.status,
                duration_ms: layer.durationMs,
                score: layer.score,
                diagnostics: layer.diagnostics,
              },
            }),
          )
        }
      }
      ctx.log?.('verifier complete', {
        layers: report.layers.length,
        blended: report.blendedScore,
        all_pass: report.allPass,
      })
      return out
    },
  }
}

function liftLayerFinding(
  analyst_id: string,
  area: string,
  layer: string,
  f: LayerFinding,
): AnalystFinding {
  return makeFinding({
    analyst_id,
    area,
    subject: f.layer ?? layer,
    claim: f.message,
    severity: liftSeverity(f.severity),
    confidence: 0.85,
    evidence_refs: f.evidence
      ? [{ kind: 'artifact', uri: 'inline:evidence', excerpt: f.evidence }]
      : [],
    metadata: f.detail,
  })
}

// ── 3. RunCritic → Analyst ──────────────────────────────────────────

export interface RunCriticAdapterOpts {
  id?: string
  area?: string
  critic?: RunCritic
  /** Optional threshold below which a dimension is reported as a finding. Default 0.5. */
  threshold?: number
}

export function createRunCriticAdapter(opts: RunCriticAdapterOpts = {}): Analyst<RunTrace> {
  const id = opts.id ?? 'run-critic'
  const area = opts.area ?? 'run-quality'
  const critic = opts.critic ?? new RunCritic()
  const threshold = opts.threshold ?? 0.5
  return {
    id,
    description:
      'Scores a single run across success / grounding / drift / tool-quality and surfaces below-threshold dimensions.',
    inputKind: 'custom',
    cost: { kind: 'deterministic' },
    version: `run-critic-${ADAPTER_REV}`,
    async analyze(trace) {
      const score = critic.scoreTrace(trace)
      const out: AnalystFinding[] = []
      const dims: Array<[keyof typeof score, AnalystSeverity, string]> = [
        ['success', 'critical', 'run did not complete successfully'],
        ['goalProgress', 'high', 'goal progress is low'],
        ['repoGroundedness', 'high', 'output is poorly grounded in the repository'],
        ['toolUseQuality', 'medium', 'tool use quality is low'],
        ['patchQuality', 'medium', 'no real patch/edit evidence'],
        ['testReality', 'high', 'no real test/build evidence'],
        ['finalGate', 'critical', 'final gate is blocking'],
      ]
      for (const [dim, sev, msg] of dims) {
        const value = score[dim] as number
        if (typeof value === 'number' && value < threshold) {
          out.push(
            makeFinding({
              analyst_id: id,
              area,
              subject: dim,
              claim: msg,
              rationale: `${dim}=${value.toFixed(2)} below threshold ${threshold}`,
              severity: sev,
              confidence: 1,
              evidence_refs: [],
              metadata: { dimension: dim, value, threshold, run_id: trace.run.runId },
            }),
          )
        }
      }
      // Drift penalty is high → surface as a finding (inverse threshold).
      if (score.driftPenalty > 1 - threshold) {
        out.push(
          makeFinding({
            analyst_id: id,
            area,
            subject: 'drift',
            claim: 'agent output drifted from repository signal',
            rationale: `driftPenalty=${score.driftPenalty.toFixed(2)}`,
            severity: 'medium',
            confidence: 0.9,
            evidence_refs: [],
            metadata: { drift_penalty: score.driftPenalty, notes: score.notes },
          }),
        )
      }
      return out
    },
  }
}

// ── 4. JudgeFn → Analyst ────────────────────────────────────────────

export interface JudgeAdapterOpts {
  id?: string
  area?: string
  judge: JudgeFn
  /** TCloud handle the JudgeFn calls. */
  tcloud: TCloud
  /** Optional cost classification — most judges call an LLM. */
  cost?: Analyst['cost']
  /** Optional threshold below which a JudgeScore becomes a finding. Default 6 (on 0-10 scale). */
  threshold?: number
}

export function createJudgeAdapter(opts: JudgeAdapterOpts): Analyst<JudgeInput> {
  const id = opts.id ?? 'judge'
  const area = opts.area ?? 'judge'
  const threshold = opts.threshold ?? 6
  return {
    id,
    description:
      'Wraps an agent-eval JudgeFn into an analyst; below-threshold dimensions surface as findings.',
    inputKind: 'judge-input',
    cost: opts.cost ?? { kind: 'llm' },
    version: `judge-${ADAPTER_REV}`,
    async analyze(input) {
      const scores = await opts.judge(opts.tcloud, input)
      return scores
        .filter((s) => normalize10(s.score) < threshold)
        .map((s) => liftJudgeScore(id, area, s))
    },
  }
}

function normalize10(s: number): number {
  // JudgeScore convention is 0-10 but some judges emit 0-1. Coerce to 0-10.
  return s <= 1 ? s * 10 : s
}

function liftJudgeScore(analyst_id: string, area: string, s: JudgeScore): AnalystFinding {
  const score10 = normalize10(s.score)
  const severity: AnalystSeverity =
    score10 < 3 ? 'critical' : score10 < 5 ? 'high' : score10 < 7 ? 'medium' : 'low'
  return makeFinding({
    analyst_id,
    area,
    subject: s.dimension,
    claim: `${s.judgeName}/${s.dimension} scored ${score10.toFixed(1)}/10`,
    rationale: s.reasoning,
    severity,
    confidence: 0.8,
    evidence_refs: s.evidence
      ? [{ kind: 'artifact', uri: 'inline:evidence', excerpt: s.evidence }]
      : [],
    metadata: { judge_name: s.judgeName, dimension: s.dimension, score_10: score10 },
  })
}

// ── 5. SemanticConceptJudge → Analyst ──────────────────────────────

export interface SemanticConceptJudgeAdapterOpts {
  id?: string
  area?: string
  options?: SemanticConceptJudgeOptions
}

export function createSemanticConceptJudgeAdapter(
  opts: SemanticConceptJudgeAdapterOpts = {},
): Analyst<SemanticConceptJudgeInput> {
  const id = opts.id ?? 'semantic-concept-judge'
  const area = opts.area ?? 'concept-coverage'
  return {
    id,
    description:
      'Runs the semantic-concept judge and surfaces missing / weak concepts as findings.',
    inputKind: 'custom',
    cost: { kind: 'llm', models: opts.options?.model ? [opts.options.model] : undefined },
    version: `${SEMANTIC_CONCEPT_JUDGE_VERSION}-adapter-${ADAPTER_REV}`,
    async analyze(input) {
      const result = await runSemanticConceptJudge(input, opts.options)
      if (!result.available) {
        return [
          makeFinding({
            analyst_id: id,
            area,
            claim: 'semantic-concept judge unavailable',
            rationale: result.error,
            severity: 'info',
            confidence: 1,
            evidence_refs: [],
            metadata: { reason: result.error },
          }),
        ]
      }
      const out: AnalystFinding[] = []
      for (const f of result.findings) {
        // Only surface gaps: missing concepts or low scores. Concepts at
        // 7+/10 with present=true are not findings — they're successes.
        if (f.present && f.score >= 7) continue
        out.push(
          makeFinding({
            analyst_id: id,
            area,
            subject: f.concept,
            claim: f.present
              ? `concept "${f.concept}" is weak (${f.score}/10)`
              : `concept "${f.concept}" is missing`,
            rationale: f.evidence,
            severity: liftSeverity(f.severity),
            confidence: 0.85,
            evidence_refs: [{ kind: 'artifact', uri: 'inline:evidence', excerpt: f.evidence }],
            metadata: {
              concept: f.concept,
              present: f.present,
              score_10: f.score,
              cost_usd: result.costUsd ?? undefined,
            },
          }),
        )
      }
      return out
    },
  }
}
