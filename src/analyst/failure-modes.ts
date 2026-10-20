/**
 * failure-modes — a judged analyst with fixed-choice labels, gated on its own
 * calibration.
 *
 * Labels are adapted from the MAST multi-agent failure taxonomy (Cemri et al.,
 * "Why Do Multi-Agent LLM Systems Fail?", 2025): its fourteen modes in three
 * groups, plus four single-agent modes so the public AgentRx set maps onto the
 * same labels, plus `none`. Two more fixed questions cover delegation-brief
 * completeness and steer handling.
 *
 * The judge runs through the System One decision path (`systemOneAnalyst`).
 * Construction requires a calibration — gold labels compared with the judge's
 * labels on the same items — and refuses to build an analyst whose Cohen's κ
 * is below `FAILURE_MODES_MIN_KAPPA`. A rubric that does not agree with its
 * gold set has nothing to report, so it reports nothing.
 */

import { readFile } from 'node:fs/promises'
import { nominalAgreement } from '../statistics/agreement-irr'
import { type SystemOneEvaluatorOptions, systemOneAnalyst } from '../systemone'
import type { SystemOneQuestions, SystemOneState } from '../systemone-protocol'
import { normalizeAgentRxCategory } from './benchmark-dataset-agentrx'
import type { AgentRxRow } from './benchmark-dataset-types'
import { loadPublicBenchmarkRows } from './benchmark-public-data'
import type { FindingCalibration, FindingScope } from './finding-scope'
import { type Analyst, type AnalystContext, type AnalystFinding, makeFinding } from './types'

export const FAILURE_MODES_ANALYST_ID = 'failure-modes'
export const FAILURE_MODES_VERSION = '1'

/** κ below this refuses the rubric. */
export const FAILURE_MODES_MIN_KAPPA = 0.6

export const FAILURE_MODE_LABELS = {
  // MAST 1 — specification and system design
  'disobey-task-specification': 'Ignored or violated the stated task requirements or constraints.',
  'disobey-role-specification': 'Acted outside its assigned role or took over another role.',
  'step-repetition': 'Repeated a step already completed without new reason.',
  'loss-of-conversation-history': 'Lost earlier context and acted as if it was never given.',
  'unaware-of-termination-conditions': 'Did not recognize when the task was done or must stop.',
  // MAST 2 — inter-agent misalignment
  'conversation-reset': 'Restarted the exchange and discarded progress.',
  'fail-to-ask-for-clarification': 'Proceeded on an ambiguous instruction without asking.',
  'task-derailment': 'Drifted from the task toward a different goal.',
  'information-withholding': 'Kept back information another agent needed.',
  'ignored-other-agent-input': "Disregarded another agent's input or recommendation.",
  'reasoning-action-mismatch': 'Acted against its own stated reasoning or plan.',
  // MAST 3 — task verification and termination
  'premature-termination': 'Stopped before the goal of the task was met.',
  'no-or-incomplete-verification': 'Delivered without verifying, or verified only part.',
  'incorrect-verification': 'Verified, but the check was wrong or passed bad output.',
  // Single-agent modes, so AgentRx labels map onto this set.
  'invented-information': 'Stated facts, results or tool output that do not exist.',
  'invalid-tool-invocation': 'Called a tool with an invalid name, argument or format.',
  'misread-tool-output': 'Misinterpreted what a tool or handoff returned.',
  'system-failure': 'Failed because of infrastructure, not the agent.',
  none: 'No failure mode applies.',
} as const

export type FailureModeLabel = keyof typeof FAILURE_MODE_LABELS

/**
 * AgentRx root-cause category → failure-mode label. `null` categories have no
 * counterpart here and are left out of the gold set, counted as unmapped.
 */
export const AGENT_RX_FAILURE_MODE_MAP: Readonly<Record<string, FailureModeLabel | null>> = {
  'instruction-plan-adherence-failure': 'disobey-task-specification',
  'invention-of-new-information': 'invented-information',
  'invalid-invocation': 'invalid-tool-invocation',
  'misinterpretation-of-tool-output-handoff-failure': 'misread-tool-output',
  'intent-plan-misalignment': 'task-derailment',
  'underspecified-user-intent': 'fail-to-ask-for-clarification',
  'intent-not-supported': null,
  'guardrails-triggered': null,
  'system-failure': 'system-failure',
  inconclusive: null,
}

export const FAILURE_MODES_QUESTIONS = {
  failure_mode: {
    type: 'choice',
    instructions:
      'Which single failure mode best explains why this agent or team fell short? Choose none when it did not fail.',
    criteria: FAILURE_MODE_LABELS,
  },
  delegation_brief: {
    type: 'choice',
    instructions:
      'When this agent delegated work, did the brief state the goal, the constraints, the expected output, and how the result would be checked?',
    criteria: {
      complete: 'Every delegated brief stated goal, constraints, output and check.',
      partial: 'Some brief left out one or more of goal, constraints, output or check.',
      missing: 'Work was delegated with no usable brief.',
      'no-delegation': 'Nothing was delegated.',
    },
  },
  steer_handling: {
    type: 'choice',
    instructions: 'When a steer or correction arrived mid-task, what did the agent do with it?',
    criteria: {
      applied: 'Changed course as the steer asked.',
      ignored: 'Continued as before, or acknowledged without acting.',
      'no-steer': 'No steer arrived.',
    },
  },
} as const satisfies SystemOneQuestions

export interface FailureModeLabelItem {
  id: string
  label: FailureModeLabel
}

export interface FailureModesCalibration extends FindingCalibration {
  /** Gold items with no judge label; each counts as a disagreement. */
  missingPredictions: number
}

export type FailureModesOutcome<T> =
  | { succeeded: true; value: T }
  | { succeeded: false; error: { kind: 'invalid' | 'uncalibrated'; message: string } }

function isLabel(value: unknown): value is FailureModeLabel {
  return typeof value === 'string' && Object.hasOwn(FAILURE_MODE_LABELS, value)
}

/** Gold labels from AgentRx rows: each trajectory's root-cause category, mapped onto this set. */
function failureModeGoldFromAgentRx(rows: readonly AgentRxRow[]): {
  gold: FailureModeLabelItem[]
  unmapped: Array<{ id: string; category: string }>
} {
  const gold: FailureModeLabelItem[] = []
  const unmapped: Array<{ id: string; category: string }> = []
  for (const row of rows) {
    const id = `agentrx:${String(row.trajectory_id)}`
    const rootId = row.root_cause_failure_id ?? row.root_cause?.failure_id
    const root = row.failures.find((failure) => String(failure.failure_id) === String(rootId))
    if (!root)
      throw new TypeError(`AgentRx trajectory '${row.trajectory_id}' has no root-cause failure`)
    const category = normalizeAgentRxCategory(root.failure_category)
    if (!Object.hasOwn(AGENT_RX_FAILURE_MODE_MAP, category)) {
      throw new RangeError(
        `AgentRx category '${root.failure_category}' is outside the AgentRx taxonomy`,
      )
    }
    const label = AGENT_RX_FAILURE_MODE_MAP[category]
    if (label === null || label === undefined) unmapped.push({ id, category })
    else gold.push({ id, label })
  }
  return { gold, unmapped }
}

/** Validate a caller's gold file: a JSON array of `{ id, label }` with unique ids and known labels. */
export function parseFailureModeGold(raw: unknown): FailureModesOutcome<FailureModeLabelItem[]> {
  if (!Array.isArray(raw)) {
    return { succeeded: false, error: { kind: 'invalid', message: 'gold must be a JSON array' } }
  }
  const seen = new Set<string>()
  const items: FailureModeLabelItem[] = []
  for (const [index, row] of raw.entries()) {
    const id = (row as { id?: unknown } | null)?.id
    const label = (row as { label?: unknown } | null)?.label
    if (typeof id !== 'string' || !id.trim() || !isLabel(label)) {
      return {
        succeeded: false,
        error: {
          kind: 'invalid',
          message: `gold row ${index} needs a string id and a known label`,
        },
      }
    }
    if (seen.has(id)) {
      return { succeeded: false, error: { kind: 'invalid', message: `gold id '${id}' repeats` } }
    }
    seen.add(id)
    items.push({ id, label })
  }
  return { succeeded: true, value: items }
}

export interface FailureModeGoldSources {
  /** The public AgentRx label file, the same file `analyst-benchmark --dataset agentrx --labels` reads. */
  agentRxLabelsPath?: string
  /** The caller's gold file: a JSON array of `{ id, label }`. */
  goldPath?: string
}

export interface FailureModeGold {
  gold: FailureModeLabelItem[]
  /** AgentRx rows read from `agentRxLabelsPath`; every one is either in `gold` or in `unmapped`. */
  agentRxRows: number
  unmapped: Array<{ id: string; category: string }>
}

/**
 * Load the calibration gold set from the public AgentRx labels and the
 * caller's gold file, through the analyst module's public-dataset loader.
 * Ids must be unique across both sources. No source, or no gold item, is a
 * failure: an empty gold set would calibrate to an undefined κ.
 */
export async function loadFailureModeGold(
  sources: FailureModeGoldSources,
): Promise<FailureModesOutcome<FailureModeGold>> {
  const invalid = (message: string) =>
    ({ succeeded: false, error: { kind: 'invalid', message } }) as const
  const gold: FailureModeLabelItem[] = []
  let agentRxRows = 0
  let unmapped: FailureModeGold['unmapped'] = []
  try {
    if (sources.agentRxLabelsPath !== undefined) {
      const rows = await loadPublicBenchmarkRows(sources.agentRxLabelsPath)
      agentRxRows = rows.length
      const mapped = failureModeGoldFromAgentRx(rows as unknown as AgentRxRow[])
      gold.push(...mapped.gold)
      unmapped = mapped.unmapped
    }
    if (sources.goldPath !== undefined) {
      const parsed = parseFailureModeGold(JSON.parse(await readFile(sources.goldPath, 'utf8')))
      if (!parsed.succeeded) return parsed
      gold.push(...parsed.value)
    }
  } catch (error) {
    return invalid(error instanceof Error ? error.message : String(error))
  }
  if (gold.length === 0) return invalid('failure-modes calibration needs at least one gold item')
  const ids = new Set<string>()
  for (const item of gold) {
    if (ids.has(item.id)) return invalid(`gold id '${item.id}' repeats across sources`)
    ids.add(item.id)
  }
  return { succeeded: true, value: { gold, agentRxRows, unmapped } }
}

/**
 * Score the judge's labels against gold labels for the same items, usually
 * the set `loadFailureModeGold` returns.
 */
export function calibrateFailureModes(
  gold: readonly FailureModeLabelItem[],
  predictions: readonly FailureModeLabelItem[],
): FailureModesCalibration {
  const predicted = new Map<string, FailureModeLabel>()
  for (const prediction of predictions) {
    if (predicted.has(prediction.id))
      throw new TypeError(`prediction id '${prediction.id}' repeats`)
    predicted.set(prediction.id, prediction.label)
  }
  const ids = new Set<string>()
  let missingPredictions = 0
  const pairs: Array<readonly [string, string]> = []
  for (const item of gold) {
    if (ids.has(item.id)) throw new TypeError(`gold id '${item.id}' repeats`)
    ids.add(item.id)
    const label = predicted.get(item.id)
    if (label === undefined) missingPredictions += 1
    // A missing prediction is its own label: it can never match gold.
    pairs.push([item.label, label ?? '(no prediction)'])
  }
  const agreement = nominalAgreement(pairs)
  return {
    gold_n: agreement.n,
    agreement: agreement.agreement,
    kappa: agreement.kappa,
    missingPredictions,
  }
}

export interface FailureModesAnalystOptions<I> extends SystemOneEvaluatorOptions {
  model: string
  /** The layer the judged subject sits at. */
  layer: 'agent' | 'team' | 'run'
  calibration: FindingCalibration
  renderState: (input: I, context: AnalystContext) => SystemOneState | Promise<SystemOneState>
  /** The judged population: the agent, team or run the state describes. */
  scope: (input: I, context: AnalystContext) => FindingScope
  subject?: (input: I, context: AnalystContext) => string
}

/**
 * Build the failure-modes analyst, or refuse when its calibration does not
 * clear `FAILURE_MODES_MIN_KAPPA`. An undefined κ (no gold, or one label
 * everywhere) is refused the same way.
 */
export function createFailureModesAnalyst<I>(
  options: FailureModesAnalystOptions<I>,
): FailureModesOutcome<Analyst<I>> {
  const { calibration, layer, model, renderState, scope, subject, ...transport } = options
  if (!(calibration.gold_n > 0) || !(calibration.kappa >= FAILURE_MODES_MIN_KAPPA)) {
    return {
      succeeded: false,
      error: {
        kind: 'uncalibrated',
        message: `failure-modes rubric has kappa ${Number.isNaN(calibration.kappa) ? 'undefined' : calibration.kappa.toFixed(3)} over ${calibration.gold_n} gold items; reporting requires kappa >= ${FAILURE_MODES_MIN_KAPPA}`,
      },
    }
  }
  const method = {
    kind: 'judged' as const,
    name: FAILURE_MODES_ANALYST_ID,
    version: FAILURE_MODES_VERSION,
    calibration: {
      gold_n: calibration.gold_n,
      agreement: calibration.agreement,
      kappa: calibration.kappa,
    },
  }
  const analyst = systemOneAnalyst({
    ...transport,
    model,
    renderState,
    id: FAILURE_MODES_ANALYST_ID,
    description: 'Labels agent, team and run failures with a calibrated fixed-choice rubric.',
    inputKind: 'custom',
    version: FAILURE_MODES_VERSION,
    questions: FAILURE_MODES_QUESTIONS,
    findings: (value, input, context) => {
      const judgedSubject = subject?.(input, context)
      const base = {
        analyst_id: FAILURE_MODES_ANALYST_ID,
        derived_from_judge: true,
        layer,
        scope: scope(input, context),
        method,
        evidence_refs: [{ kind: 'artifact' as const, uri: `run://${context.runId}` }],
        ...(judgedSubject === undefined ? {} : { subject: judgedSubject }),
      }
      const out: AnalystFinding[] = []
      const mode = value.answers.failure_mode
      if (mode.choice !== 'none') {
        out.push(
          makeFinding({
            ...base,
            area: 'failure-mode',
            severity: 'medium',
            confidence: mode.confidence,
            claim: `Failure mode: ${mode.choice}`,
            claim_id: `failure-mode:${mode.choice}`,
            rationale: FAILURE_MODE_LABELS[mode.choice],
          }),
        )
      }
      const brief = value.answers.delegation_brief
      if (brief.choice === 'partial' || brief.choice === 'missing') {
        out.push(
          makeFinding({
            ...base,
            area: 'delegation-brief',
            severity: brief.choice === 'missing' ? 'high' : 'medium',
            confidence: brief.confidence,
            claim: `Delegation brief ${brief.choice}`,
            claim_id: `delegation-brief:${brief.choice}`,
          }),
        )
      }
      const steer = value.answers.steer_handling
      if (steer.choice === 'ignored') {
        out.push(
          makeFinding({
            ...base,
            area: 'steer-handling',
            severity: 'high',
            confidence: steer.confidence,
            claim: 'Steer ignored',
            claim_id: 'steer-handling:ignored',
          }),
        )
      }
      return out
    },
  })
  return { succeeded: true, value: analyst }
}
