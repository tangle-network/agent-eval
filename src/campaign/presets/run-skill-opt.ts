/**
 * Optimize one skill document with the repeated selection method from SkillOpt
 * (Microsoft, arXiv:2605.23904).
 *
 * Each round proposes bounded patches from item-level training evidence, then
 * accepts the first patch that improves the selection score. Later rounds see
 * aggregate acceptance feedback and prior rejected edits, so selection data is
 * adaptively reused. It is not a final test. Use `compareOptimizationMethods` when you
 * need a separate test partition.
 */

import type { CostLedgerHandle, CostLedgerSummary } from '../../cost-ledger'
import type { RejectedEdit, SkillOptEvidence, SkillOptProposer } from '../proposers/skill-opt'
import { type RunCampaignOptions, runCampaign } from '../run-campaign'
import { resolveRunDir } from '../run-dir'
import { campaignBreakdown, campaignMeanComposite } from '../score-utils'
import { applySkillPatch } from '../skill-patch'
import { createRunCostLedger, fsCampaignStorage } from '../storage'
import type { CampaignResult, DispatchContext, Scenario } from '../types'

export interface RunSkillOptOptions<TScenario extends Scenario, TArtifact>
  extends Omit<RunCampaignOptions<TScenario, TArtifact>, 'dispatch' | 'scenarios'> {
  /** The skill document being optimized. */
  baselineSurface: string
  /** Dispatcher taking the CURRENT skill surface + scenario → artifact. */
  dispatchWithSurface: (
    surface: string,
    scenario: TScenario,
    ctx: DispatchContext,
  ) => Promise<TArtifact>
  proposer: SkillOptProposer
  /** Item-level evidence shown to the proposer. Must be disjoint from selection. */
  trainScenarios: TScenario[]
  /** Adaptively reused candidate-selection scenarios. An edit is accepted ONLY
   *  if it strictly improves the mean composite here. This is not a final test. */
  selectionScenarios: TScenario[]
  maxEpochs: number
  /** Candidate patches proposed per epoch. Default 2. */
  patchesPerEpoch?: number
  /** Initial ops-per-patch cap (the textual learning rate). Default 3. */
  editBudget?: number
  /** Strict acceptance margin: accept iff the selection composite improves by
   *  MORE than this. Default 0 (any strict improvement). */
  minImprovement?: number
  /** Stop after this many consecutive epochs with no acceptance. Default =
   *  `maxEpochs` (never early-stop). */
  patience?: number
  /** Shrink the edit budget by 1 after 2 consecutive rejected epochs (min 1).
   *  Default true. */
  budgetAnneal?: boolean
  /** Cap on the rejected-edit buffer (most-recent kept). Default 12. */
  rejectedBufferSize?: number
  /** Refresh the slow-update meta note every N epochs. Default 2. 0 disables. */
  slowMetaEvery?: number
  /** Top-K weak scenarios/dimensions surfaced as evidence each epoch. Default 3. */
  evidenceK?: number
  /** Abort signal forwarded to the patch-proposing LLM calls. */
  signal?: AbortSignal
}

export interface AcceptedEdit {
  epoch: number
  label: string
  rationale: string
  /** Selection composite improvement vs the surface before this edit. */
  selectionDelta: number
}

export interface SkillOptEpochRecord {
  epoch: number
  editBudget: number
  proposed: number
  /** The accepted edit this epoch, or null if every proposal was rejected. */
  accepted: AcceptedEdit | null
  rejected: RejectedEdit[]
  /** Selection composite of the CURRENT surface at the END of the epoch. */
  selectionComposite: number
}

export interface RunSkillOptResult {
  winnerSurface: string
  baselineSelectionComposite: number
  winnerSelectionComposite: number
  /** `winnerSelectionComposite - baselineSelectionComposite`. This is not test lift. */
  selectionLift: number
  acceptedEdits: AcceptedEdit[]
  rejectedEdits: RejectedEdit[]
  epochsRun: number
  history: SkillOptEpochRecord[]
  /** Full run spend. Alias of `cost.totalCostUsd`; includes scoring, proposals,
   *  and judges. */
  totalCostUsd: number
  /** Run-wide spend, including scoring, proposals, and judges. */
  cost: CostLedgerSummary
}

/**
 * SkillOpt sequential hill-climb: each epoch reflects on train-scenario weaknesses, proposes bounded patches, accepts the first patch that strictly improves the selection composite, and anneals the edit budget on consecutive rejections.
 */
export async function runSkillOpt<TScenario extends Scenario, TArtifact>(
  opts: RunSkillOptOptions<TScenario, TArtifact>,
): Promise<RunSkillOptResult> {
  const legacy = opts as RunSkillOptOptions<TScenario, TArtifact> & {
    holdoutScenarios?: unknown
  }
  if (legacy.holdoutScenarios !== undefined) {
    throw new Error(
      'runSkillOpt: holdoutScenarios was renamed to selectionScenarios because SkillOpt adaptively reuses it for edit acceptance. Provide selectionScenarios and score any final test outside runSkillOpt.',
    )
  }
  if (!Array.isArray(opts.trainScenarios) || opts.trainScenarios.length === 0)
    throw new Error('runSkillOpt: trainScenarios is empty')
  if (!Array.isArray(opts.selectionScenarios) || opts.selectionScenarios.length === 0)
    throw new Error('runSkillOpt: selectionScenarios is empty')
  if (!opts.judges || opts.judges.length === 0) {
    throw new Error(
      'runSkillOpt: at least one judge is required — scoring (and therefore acceptance) is meaningless without one, and would report a silent zero lift.',
    )
  }
  // train ∩ selection must be empty: proposals reflect on TRAIN evidence, so any
  // overlap leaks the acceptance axis into the proposal evidence.
  const selectionIds = new Set(opts.selectionScenarios.map((s) => s.id))
  const overlap = opts.trainScenarios.filter((s) => selectionIds.has(s.id)).map((s) => s.id)
  if (overlap.length > 0) {
    throw new Error(
      `runSkillOpt: trainScenarios and selectionScenarios must be disjoint (overlap: [${overlap.join(
        ', ',
      )}]) — a shared scenario leaks the selection axis into the proposal evidence.`,
    )
  }

  const maxEpochs = opts.maxEpochs
  const patchesPerEpoch = opts.patchesPerEpoch ?? 2
  const initialBudget = opts.editBudget ?? 3
  const minImprovement = opts.minImprovement ?? 0
  const patience = opts.patience ?? maxEpochs
  const budgetAnneal = opts.budgetAnneal ?? true
  const rejectedBufferSize = opts.rejectedBufferSize ?? 12
  const slowMetaEvery = opts.slowMetaEvery ?? 2
  const evidenceK = opts.evidenceK ?? 3

  assertPositiveSafeInteger('maxEpochs', maxEpochs)
  assertPositiveSafeInteger('patchesPerEpoch', patchesPerEpoch)
  assertPositiveSafeInteger('editBudget', initialBudget)
  assertFiniteNonNegative('minImprovement', minImprovement)
  assertPositiveSafeInteger('patience', patience)
  assertNonNegativeSafeInteger('rejectedBufferSize', rejectedBufferSize)
  assertNonNegativeSafeInteger('slowMetaEvery', slowMetaEvery)
  assertPositiveSafeInteger('evidenceK', evidenceK)
  if (typeof opts.runDir !== 'string' || opts.runDir.trim().length === 0) {
    throw new Error('runSkillOpt: runDir must be a non-empty string')
  }

  const runDir = resolveRunDir(opts.runDir, opts.repo)
  const storage = opts.storage ?? fsCampaignStorage()
  const costLedger =
    opts.costLedger ??
    createRunCostLedger({
      storage,
      runDir,
      costCeilingUsd: opts.costCeiling,
    })

  const scoreSelection = async (surface: string, tag: string): Promise<number> => {
    const campaign = await runScoringCampaign(
      opts,
      opts.selectionScenarios,
      surface,
      tag,
      costLedger,
      runDir,
    )
    return campaignMeanComposite(campaign)
  }
  const trainEvidence = async (surface: string, tag: string): Promise<SkillOptEvidence> => {
    const campaign = await runScoringCampaign(
      opts,
      opts.trainScenarios,
      surface,
      tag,
      costLedger,
      runDir,
    )
    return toEvidence(campaign, evidenceK)
  }

  let current = opts.baselineSurface
  let currentEvidence = await trainEvidence(current, 'baseline-train')
  const baselineSelection = await scoreSelection(current, 'baseline-selection')
  let currentSelection = baselineSelection

  const buffer: RejectedEdit[] = []
  const acceptedEdits: AcceptedEdit[] = []
  const rejectedAll: RejectedEdit[] = []
  const history: SkillOptEpochRecord[] = []
  let budget = initialBudget
  let sinceAccept = 0
  let metaNote: string | undefined
  let epochsRun = 0

  for (let epoch = 0; epoch < maxEpochs; epoch++) {
    epochsRun++
    const proposed = await opts.proposer.proposePatches({
      surface: current,
      evidence: currentEvidence,
      editBudget: budget,
      rejectedBuffer: buffer,
      metaNote,
      count: patchesPerEpoch,
      signal: opts.signal ?? new AbortController().signal,
      costLedger,
      costPhase: 'skill-opt.proposal',
    })
    if (!Array.isArray(proposed)) {
      throw new Error('runSkillOpt: proposer.proposePatches() must return an array')
    }
    const patches = proposed.slice(0, patchesPerEpoch)

    let accepted: AcceptedEdit | null = null
    const rejectedThisEpoch: RejectedEdit[] = []
    for (let i = 0; i < patches.length; i++) {
      const patch = patches[i]!
      const { surface: candidate, applied } = applySkillPatch(current, patch)
      if (applied === 0 || candidate === current) {
        rejectedThisEpoch.push({
          label: patch.label,
          rationale: patch.rationale,
          reason: 'no-op (unanchored or zero-change)',
        })
        continue
      }
      const candidateSelection = await scoreSelection(
        candidate,
        `epoch-${epoch}-cand-${i}-selection`,
      )
      if (candidateSelection > currentSelection + minImprovement) {
        accepted = {
          epoch,
          label: patch.label,
          rationale: patch.rationale,
          selectionDelta: candidateSelection - currentSelection,
        }
        current = candidate
        currentSelection = candidateSelection
        // The surface changed — recompute evidence for the next epoch from it.
        currentEvidence = await trainEvidence(current, `epoch-${epoch}-train`)
        break // greedy: take the first strictly-improving edit
      }
      rejectedThisEpoch.push({
        label: patch.label,
        rationale: patch.rationale,
        reason: `selection ${candidateSelection.toFixed(3)} ≤ current ${currentSelection.toFixed(3)}`,
      })
    }

    if (accepted) {
      acceptedEdits.push(accepted)
      sinceAccept = 0
    } else {
      sinceAccept++
      if (budgetAnneal && sinceAccept >= 2 && budget > 1) budget--
    }
    // Maintain the bounded rejected-edit buffer (steers the proposer away from
    // dead ends; capped so the prompt stays bounded).
    for (const r of rejectedThisEpoch) {
      buffer.push(r)
      rejectedAll.push(r)
    }
    while (buffer.length > rejectedBufferSize) buffer.shift()

    // Slow-update meta note: a cross-epoch digest refreshed on a slow cadence.
    if (slowMetaEvery > 0 && (epoch + 1) % slowMetaEvery === 0) {
      metaNote = buildMetaNote(acceptedEdits, buffer)
    }

    history.push({
      epoch,
      editBudget: budget,
      proposed: patches.length,
      accepted,
      rejected: rejectedThisEpoch,
      selectionComposite: currentSelection,
    })

    if (sinceAccept >= patience) break
  }

  const cost = costLedger.summary()
  return {
    winnerSurface: current,
    baselineSelectionComposite: baselineSelection,
    winnerSelectionComposite: currentSelection,
    selectionLift: currentSelection - baselineSelection,
    acceptedEdits,
    rejectedEdits: rejectedAll,
    epochsRun,
    history,
    totalCostUsd: cost.totalCostUsd,
    cost,
  }
}

function runScoringCampaign<TScenario extends Scenario, TArtifact>(
  opts: RunSkillOptOptions<TScenario, TArtifact>,
  scenarios: TScenario[],
  surface: string,
  tag: string,
  costLedger: CostLedgerHandle,
  runDir: string,
): Promise<CampaignResult<TArtifact, TScenario>> {
  return runCampaign<TScenario, TArtifact>({
    ...opts,
    costLedger,
    scenarios,
    dispatch: (scenario, ctx) => opts.dispatchWithSurface(surface, scenario, ctx),
    runDir: `${runDir}/${tag}`,
  })
}

function assertPositiveSafeInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`runSkillOpt: ${name} must be a positive safe integer`)
  }
}

function assertNonNegativeSafeInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`runSkillOpt: ${name} must be a non-negative safe integer`)
  }
}

function assertFiniteNonNegative(name: string, value: number): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`runSkillOpt: ${name} must be a finite number greater than or equal to 0`)
  }
}

function toEvidence<TArtifact, TScenario extends Scenario>(
  campaign: CampaignResult<TArtifact, TScenario>,
  k: number,
): SkillOptEvidence {
  const { dimensions, scenarios } = campaignBreakdown(campaign)
  const weakScenarios = [...scenarios].sort((a, b) => a.composite - b.composite).slice(0, k)
  const weakDimensions = Object.entries(dimensions)
    .sort((a, b) => a[1] - b[1])
    .slice(0, k)
    .map(([dimension, score]) => ({ dimension, score }))
  return { weakScenarios, weakDimensions }
}

function buildMetaNote(accepted: AcceptedEdit[], rejected: RejectedEdit[]): string {
  const parts: string[] = []
  if (accepted.length > 0) {
    parts.push(
      `Edits that improved selection so far: ${accepted
        .map((a) => `"${a.label}" (+${a.selectionDelta.toFixed(3)})`)
        .join('; ')}. Build on these.`,
    )
  }
  if (rejected.length > 0) {
    const labels = [...new Set(rejected.map((r) => r.label))].slice(0, 5)
    parts.push(`Dead ends to avoid: ${labels.join(', ')}. Try a different anchor or rule.`)
  }
  parts.push('Keep edits small and anchored to existing lines.')
  return parts.join(' ')
}
