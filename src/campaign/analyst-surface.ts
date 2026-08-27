/**
 * Treat the trace analyst's instructions as an optimizable text surface.
 *
 * `buildAnalystSurfaceDispatch` analyzes a fixed trace corpus using the
 * supplied surface as `actorDescription`. `failureModeRecallJudge` scores the
 * findings against failure labels derived independently from the analyst output.
 *
 * Example:
 *
 *   const dispatchWithSurface = buildAnalystSurfaceDispatch({ analystOptions: { ai } })
 *   await runImprovementLoop({
 *     baselineSurface: TRACE_ANALYST_ACTOR_DESCRIPTION,
 *     scenarios: trainScenarios,
 *     holdoutScenarios: heldOutScenarios,
 *     dispatchWithSurface,
 *     judges: [failureModeRecallJudge()],
 *     proposer: gepaProposer({ baseUrl, apiKey }),
 *     gate: heldOutGate({ minDelta: 0.02 }),
 *     autoOnPromote: 'none',
 *   })
 */

import type {
  AnalyzeTracesInput,
  AnalyzeTracesOptions,
  AnalyzeTracesResult,
} from '../trace-analyst/analyst'
import { analyzeTraces } from '../trace-analyst/analyst'
import type { DispatchContext, JudgeConfig, MutableSurface, Scenario } from './types'

/**
 * A labeled trace scenario: a FIXED trace corpus plus the failure modes a
 * competent analyst MUST surface from it. The labels are ground truth — the
 * objective failures that actually occurred — which is what makes optimizing
 * the analyst prompt against them meaningful rather than circular.
 */
export interface AnalystScenario extends Scenario {
  kind: 'analyst-surface'
  /** OTLP-JSONL path or an in-memory store of the traces to analyze. */
  source: AnalyzeTracesOptions['source']
  /** The domain question handed to the analyst (framing lives here, not in
   *  the surface under optimization). */
  question: string
  /**
   * Ground-truth failure modes a good analyst must identify. A finding "hits"
   * a mode when it contains ANY of the mode's case-insensitive cues. Derive
   * these from objective signal (failed task + which step broke), never from
   * the analyst's own prior output.
   */
  expectedFailureModes: Array<{ id: string; cues: string[] }>
  /**
   * Cues that mark a finding as HALLUCINATED / out-of-scope for this corpus —
   * naming a tool, error, or failure that did not occur. Presence penalizes
   * precision. Optional; omit to score recall only.
   */
  forbiddenCues?: string[]
}

/** The analyst's output for one scenario — the artifact the judge scores. */
export interface AnalystArtifact {
  answer: string
  findings: string[]
  /** The hardcoded-prompt version the analyst reported (provenance only; the
   *  optimized surface overrides the actual prompt text used). */
  actorPromptVersion: string
}

export interface BuildAnalystSurfaceDispatchOptions {
  /**
   * Everything `analyzeTraces` needs EXCEPT `actorDescription` (supplied by the
   * surface under optimization) and `source` (supplied by the scenario). `ai`
   * (the AxAIService) is required for a live run.
   */
  analystOptions: Omit<AnalyzeTracesOptions, 'actorDescription' | 'source'>
  /** Test seam: defaults to the real `analyzeTraces`. */
  analyze?: (
    input: AnalyzeTracesInput,
    options: AnalyzeTracesOptions,
  ) => Promise<AnalyzeTracesResult>
}

function surfaceToText(surface: MutableSurface): string {
  if (typeof surface === 'string') return surface
  // A code-tier surface can't be an analyst prompt — fail loud rather than
  // silently analyzing with an empty actorDescription.
  throw new Error(
    'buildAnalystSurfaceDispatch: the analyst surface must be a string actorDescription, ' +
      `got a ${surface.kind}-tier surface (${surface.worktreeRef}). The analyst prompt is prompt-tier.`,
  )
}

/**
 * Build the `dispatchWithSurface(surface, scenario, ctx)` the improvement loop
 * calls: run the analyst with `surface` as its actorDescription over the
 * scenario's trace corpus and return its findings.
 */
export function buildAnalystSurfaceDispatch(
  opts: BuildAnalystSurfaceDispatchOptions,
): (
  surface: MutableSurface,
  scenario: AnalystScenario,
  ctx: DispatchContext,
) => Promise<AnalystArtifact> {
  const analyze = opts.analyze ?? analyzeTraces
  return async (surface, scenario, _ctx) => {
    const actorDescription = surfaceToText(surface)
    const res = await analyze(
      { question: scenario.question },
      { ...opts.analystOptions, actorDescription, source: scenario.source },
    )
    return {
      answer: res.answer,
      findings: res.findings,
      actorPromptVersion: res.actorPromptVersion,
    }
  }
}

export interface FailureModeRecallJudgeOptions {
  /** Weight on recall when precision is also scored (forbiddenCues present).
   *  Default 0.5 (equal). Recall-only when no forbiddenCues exist. */
  recallWeight?: number
}

/**
 * Deterministic, ground-truth judge for analyst findings. Composite =
 * recall of the scenario's `expectedFailureModes` (optionally blended with a
 * precision term that penalizes findings tripping `forbiddenCues`). No LLM —
 * the score is a function of the labels, so the analyst prompt is optimized
 * toward surfacing real failures, not toward a judge it can flatter.
 */
export function failureModeRecallJudge(
  opts: FailureModeRecallJudgeOptions = {},
): JudgeConfig<AnalystArtifact, AnalystScenario> {
  const recallWeight = opts.recallWeight ?? 0.5
  return {
    name: 'failure-mode-recall',
    dimensions: [
      { key: 'recall', description: 'fraction of ground-truth failure modes the analyst surfaced' },
      {
        key: 'precision',
        description:
          '1 − share of findings that named a failure/tool/error absent from this corpus',
      },
    ],
    appliesTo: (s) => s.kind === 'analyst-surface',
    score({ artifact, scenario }) {
      const modes = scenario.expectedFailureModes
      if (modes.length === 0) {
        throw new Error(
          `failureModeRecallJudge: scenario '${scenario.id}' has no expectedFailureModes — refusing to score (a vacuous 1.0 would corrupt the comparison)`,
        )
      }
      const hay = artifact.findings.join('\n').toLowerCase()
      const matched = modes.filter((m) => m.cues.some((c) => hay.includes(c.toLowerCase())))
      const recall = matched.length / modes.length

      const forbidden = (scenario.forbiddenCues ?? []).map((c) => c.toLowerCase())
      let precision = 1
      let hallucinated = 0
      if (forbidden.length > 0) {
        const denom = Math.max(1, artifact.findings.length)
        hallucinated = artifact.findings.filter((f) =>
          forbidden.some((c) => f.toLowerCase().includes(c)),
        ).length
        precision = 1 - hallucinated / denom
      }

      const composite =
        forbidden.length > 0 ? recallWeight * recall + (1 - recallWeight) * precision : recall
      const missed = modes.filter((m) => !matched.includes(m)).map((m) => m.id)
      const notes =
        `matched ${matched.length}/${modes.length} failure modes` +
        (missed.length ? `; missed [${missed.join(', ')}]` : '') +
        (hallucinated ? `; ${hallucinated} out-of-corpus finding(s)` : '')
      return { dimensions: { recall, precision }, composite, notes }
    },
  }
}
