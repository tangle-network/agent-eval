/**
 * Remediation adapters — HOW DO WE MAKE IT HAPPEN?
 *
 * The diagnose chain ends by feeding existing improvement machinery,
 * not by building new machinery:
 *
 *   - `toAnalystFindings` → the analyst contract (`makeFinding`), so
 *     responsibility evidence flows into the same registry / steering /
 *     diff pipeline every other analyst feeds.
 *   - `toCorpusRecord` → the RL corpus (`CorpusRecord`), pinning the
 *     diagnosed failure + validated repair as a permanent scenario.
 *   - `suggestInvariant` → a plain-data hint in the shape the
 *     trace-contracts machinery consumes (`never` / `without` clauses).
 */

import type { AnalystFinding, AnalystSeverity, EvidenceRef } from '../analyst/types'
import { makeFinding } from '../analyst/types'
import type { CounterfactualMutation } from '../counterfactual'
import { ValidationError } from '../errors'
import type { CorpusRecord } from '../rl/corpus'
import type { RunRecord } from '../run-record'
import { validateRunRecord } from '../run-record'
import type { CausalResponsibilityReport, StepResponsibility } from './causal-sweep'
import type { RepairReport, ValidatedRepair } from './repair'

export const DIAGNOSE_ANALYST_ID = 'diagnose-causal-sweep'

/** Severity from causal effect size. Effects whose CI includes zero are
 *  'info' regardless of magnitude — an indistinguishable-from-noise effect
 *  must not steer remediation priority. */
export function severityFromEffect(responsibility: StepResponsibility): AnalystSeverity {
  if (!responsibility.ciExcludesZero) return 'info'
  const magnitude = Math.abs(responsibility.meanEffect)
  if (magnitude >= 0.5) return 'critical'
  if (magnitude >= 0.25) return 'high'
  if (magnitude >= 0.1) return 'medium'
  return 'low'
}

/** Deterministic human-readable rendering of a mutation — used in
 *  recommended actions, corpus completions, and invariant hints. */
export function describeMutation(mutation: CounterfactualMutation): string {
  switch (mutation.kind) {
    case 'swap-model':
      return `use model '${mutation.newModel}' at step ${mutation.at}`
    case 'swap-tool-result':
      return `replace the tool result at step ${mutation.at} with ${JSON.stringify(mutation.newResult)}`
    case 'truncate-after':
      return `stop the run after step ${mutation.at}`
    case 'inject-system-message':
      return `inject system message at step ${mutation.at}: ${mutation.content}`
    case 'custom':
      return `${mutation.describe} (step ${mutation.at})`
  }
}

/**
 * Lift a responsibility report (and optionally its validated repairs) into
 * `AnalystFinding`s via the real `makeFinding` factory. One finding per
 * probed step; a validated repair for that step upgrades the finding with
 * a `recommended_action` + the replay-validation evidence.
 *
 * Findings are OBSERVED causal probes (replay deltas), not judge verdicts,
 * so `derived_from_judge` stays unset and they may steer.
 */
export function toAnalystFindings(
  report: CausalResponsibilityReport,
  repairs?: RepairReport,
): AnalystFinding[] {
  const repairByStep = new Map<string, ValidatedRepair>()
  for (const r of repairs?.repairs ?? []) {
    if (!repairByStep.has(r.stepRef.spanId)) repairByStep.set(r.stepRef.spanId, r)
  }

  return report.steps.map((resp) => {
    const repair = repairByStep.get(resp.stepRef.spanId)
    const evidence: EvidenceRef[] = [
      {
        kind: 'span',
        uri: `span://${resp.stepRef.spanId}`,
        excerpt: `step ${resp.stepRef.index} (${resp.stepRef.kind} '${resp.stepRef.name}') meanEffect=${resp.meanEffect.toFixed(4)} ci=[${resp.ci.lower.toFixed(4)}, ${resp.ci.upper.toFixed(4)}] reps=${resp.reps}`,
      },
      {
        kind: 'metric',
        uri: `metric://diagnose/${report.runId}/step/${resp.stepRef.index}/${resp.mutationKind}`,
        excerpt: `deltas=[${resp.deltas.map((d) => d.toFixed(4)).join(', ')}]`,
      },
      ...resp.counterfactualRunIds.map((id): EvidenceRef => ({ kind: 'span', uri: `run://${id}` })),
    ]
    return makeFinding({
      analyst_id: DIAGNOSE_ANALYST_ID,
      severity: severityFromEffect(resp),
      area: 'causal-attribution',
      claim: `step '${resp.stepRef.name}' (${resp.stepRef.kind}) is causally responsible for the run outcome under ${resp.mutationKind}`,
      rationale: resp.ciExcludesZero
        ? `mean effect ${resp.meanEffect.toFixed(4)} over ${resp.reps} counterfactual replays; CI [${resp.ci.lower.toFixed(4)}, ${resp.ci.upper.toFixed(4)}] excludes zero`
        : `mean effect ${resp.meanEffect.toFixed(4)} over ${resp.reps} counterfactual replays; CI [${resp.ci.lower.toFixed(4)}, ${resp.ci.upper.toFixed(4)}] includes zero — not distinguishable from noise`,
      evidence_refs: evidence,
      recommended_action: repair ? describeMutation(repair.mutation) : undefined,
      validation_plan: repair
        ? `replay-validated: ${repair.reps}/${repair.reps} reps scored >= ${repairs!.flipThreshold} (mean ${repair.meanScore.toFixed(4)}, delta ${repair.deltaScore.toFixed(4)})`
        : undefined,
      confidence: repair ? 0.95 : resp.ciExcludesZero ? 0.85 : 0.3,
      subject: resp.stepRef.spanId,
      metadata: {
        stepRef: resp.stepRef,
        mutationKind: resp.mutationKind,
        meanEffect: resp.meanEffect,
        ci: resp.ci,
        deltas: resp.deltas,
        counterfactualRunIds: resp.counterfactualRunIds,
        ...(repair ? { repair: { mutation: repair.mutation, meanScore: repair.meanScore } } : {}),
      },
    })
  })
}

/**
 * Pin the diagnosed failure as a permanent corpus scenario. Takes the
 * original run's `RunRecord` projection plus a validated repair and emits
 * a fresh `CorpusRecord` (new runId, so corpus dedup keeps both the raw
 * failure and the diagnosed entry).
 *
 * `completion` defaults to the validated mutation's rendering — "what
 * should have happened" in machine-derived form. Supply `prompt` (and
 * optionally a richer `completion`) when the trajectory text is available
 * so the record is harvestable by `buildDatasetFromCorpus`.
 */
export function toCorpusRecord(
  run: RunRecord,
  repair: ValidatedRepair,
  opts: { prompt?: string; completion?: string } = {},
): CorpusRecord {
  const record: CorpusRecord = {
    ...run,
    runId: `${run.runId}#repair:${repair.stepRef.spanId}`,
    outcome: {
      ...run.outcome,
      raw: {
        ...run.outcome.raw,
        diagnose_blamed_step_index: repair.stepRef.index,
        diagnose_repair_mean_score: repair.meanScore,
        diagnose_repair_delta_score: repair.deltaScore,
        diagnose_repair_reps: repair.reps,
      },
    },
    prompt: opts.prompt,
    completion: opts.completion ?? describeMutation(repair.mutation),
  }
  // Boundary check — a corpus record that fails RunRecord validation would
  // poison every downstream harvest.
  validateRunRecord(record)
  return record
}

/** Plain-data invariant hint. The trace-contracts machinery consumes this
 *  shape: `never` is a pattern that must not appear in a passing trace;
 *  `without` is a guard whose absence makes the failure reachable. */
export interface InvariantHint {
  description: string
  never?: string
  without?: string
}

/**
 * Derive an invariant hint from a validated repair. Deterministic per
 * mutation kind — the hint names the contract a trace must satisfy so
 * the diagnosed failure cannot silently recur.
 */
export function suggestInvariant(repair: ValidatedRepair): InvariantHint {
  const { stepRef, mutation } = repair
  const at = `step ${stepRef.index} (${stepRef.kind} '${stepRef.name}')`
  switch (mutation.kind) {
    case 'swap-tool-result':
      return {
        description: `the result of tool '${stepRef.name}' was causally responsible for the failure; a replaced result flipped the outcome (delta ${repair.deltaScore.toFixed(4)})`,
        never: `unvalidated result from tool '${stepRef.name}' flows downstream`,
        without: `result guard on tool '${stepRef.name}'`,
      }
    case 'swap-model':
      return {
        description: `swapping the model at ${at} to '${mutation.newModel}' flipped the outcome (delta ${repair.deltaScore.toFixed(4)})`,
        never: `llm span '${stepRef.name}' runs on a model other than '${mutation.newModel}'`,
      }
    case 'inject-system-message':
      return {
        description: `injecting a system message at ${at} flipped the outcome (delta ${repair.deltaScore.toFixed(4)})`,
        without: `system message present at '${stepRef.name}': ${mutation.content}`,
      }
    case 'truncate-after':
      return {
        description: `stopping after ${at} flipped the outcome (delta ${repair.deltaScore.toFixed(4)}) — continuation past this step caused the failure`,
        never: `spans execute after '${stepRef.name}' (index ${stepRef.index})`,
      }
    case 'custom':
      return {
        description: `${mutation.describe} at ${at} flipped the outcome (delta ${repair.deltaScore.toFixed(4)})`,
      }
    default: {
      const exhausted: never = mutation
      throw new ValidationError(
        `suggestInvariant: unknown mutation kind ${JSON.stringify(exhausted)}`,
      )
    }
  }
}
