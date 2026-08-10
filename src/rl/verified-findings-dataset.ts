/**
 * Verified-findings dataset — execution-verified gold labels as RL-ready rows.
 *
 * A replay-verify batch re-executes a labeled trajectory prefix inside the
 * original docker image and checks, at the gold "incorrect" step k, whether
 * the recorded failure reproduces (arm A) and whether a generated fix makes
 * it vanish (arm B). That turns an annotation into an *executed* label: the
 * verdict is a returncode/signature comparison, not a rater's opinion.
 *
 * This module joins three artifact families into one row per replayed case:
 *
 *   1. the batch report (`batch-report.json` — per-case verdicts, fix arms),
 *   2. the gold label corpus (`*-labels.json` — incorrect step annotations),
 *   3. the normalized trajectory (`normalized/<trajId>/steps.json` — the
 *      action/observation sequence the agent actually took).
 *
 * The emitted `VerifiedFindingRow` carries the trajectory prefix up to k,
 * the gold label, the execution verdict with its evidence (exit codes,
 * failure signature, prefix divergences), the fix arm when present, and
 * per-row provenance (label/steps/report sha256s, docker images, run ids).
 * Rows are trainer input for step-level localizer/critic models; the reward
 * is deterministic because execution decided it.
 *
 * Join discipline: every missing or inconsistent join throws — a dataset
 * built from partially joined artifacts would silently train on wrong
 * labels. The batch report is authoritative for fix outcomes (per-case
 * `replay-verdict.json` files are written before the fix arm completes);
 * per-case files contribute prefix-divergence detail and run ids only, and
 * are cross-checked against the report where they overlap.
 */

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export const VERIFIED_FINDING_SCHEMA = 'agent-eval/verified-finding@0'

// ── Input shapes (parsed artifacts) ─────────────────────────────────

/** One case row from a replay-verify `batch-report.json`. */
export interface ReplayBatchCase {
  corpus: string
  trajId: string
  image: string
  cwd: string
  cwdSource: string
  k: number
  stepCount: number
  goldIncorrectSteps: number[]
  recordedReturncodeAtK: number
  derivedImage: string | null
  signature: string | null
  status: string
  error: string | null
  prefixExecuted: number
  prefixDivergences: number
  prefixDivergencePct: number
  prefixReturncodeMismatches: number
  prefixUnknownExpectations: number
  armAExit: number | null
  armAReturncodeMatch: boolean
  armASignatureMatch: boolean
  /** Batch verdict: prefix divergence within tolerance AND arm A reproduced the recorded returncode at k. */
  replayed: boolean
  fix: ReplayBatchFix | null
  wallMs: number
}

export interface ReplayBatchFix {
  attempted: boolean
  sampledOut: boolean
  command: string | null
  llmError: string | null
  armBExit: number | null
  failureVanished: boolean | null
}

export interface ReplayBatchReport {
  generatedAt: string
  cases: ReplayBatchCase[]
}

/** Gold label entry for one trajectory (CodeTraceBench annotation format). */
export interface GoldLabelEntry {
  traj_id: string
  solved: boolean
  step_count: number
  agent?: string
  model?: string
  task_name?: string
  difficulty?: string
  incorrect_stages: Array<{ stage_id: number; incorrect_step_ids: number[] }>
}

/** One step from a normalized trajectory `steps.json`. */
export interface NormalizedStep {
  step_id: number
  action: string
  observation?: string | null
}

export interface PrefixDivergence {
  step: number
  /** `unknown-expectation` marks a step the recording carries no returncode
   *  for: it could not be confirmed, so it is not agreement. */
  kind: 'returncode-mismatch' | 'unknown-expectation'
  /** null exactly when `kind` is `unknown-expectation`. */
  expectedReturncode: number | null
  actualExit: number
}

/** Optional extract from a per-case `replay-verdict.json` (arm A detail only). */
export interface CaseVerdictDetail {
  k: number
  prefixExecuted: number
  recordedReturncode: number
  signatureBasis: string | null
  prefixDivergences: PrefixDivergence[]
  armACommand: string | null
  runIds: { original: string | null; armA: string | null }
}

// ── Row schema ──────────────────────────────────────────────────────

export interface TrajectoryStep {
  stepId: number
  action: string
  observation: string | null
  /** True when the observation was cut at `maxObservationChars`; `observationChars` keeps the original length. */
  observationTruncated: boolean
  observationChars: number
}

export type FixOutcome = 'flipped' | 'not-flipped' | 'generation-failed' | 'not-attempted'

export interface VerifiedFindingFix {
  outcome: FixOutcome
  command: string | null
  llmError: string | null
  armBExit: number | null
  failureVanished: boolean | null
}

export interface VerifiedFindingRow {
  schema: typeof VERIFIED_FINDING_SCHEMA
  /** `<runId>/<corpus>/<trajId>` — unique across batches. */
  caseId: string
  corpus: string
  trajId: string
  task: {
    agent: string | null
    model: string | null
    taskName: string | null
    difficulty: string | null
    solved: boolean
    stepCount: number
  }
  gold: {
    /** The verified gold step — the earliest replayable incorrect step. */
    stepK: number
    /** The exact command the agent ran at step k (never truncated — it is the labeled object). */
    actionAtK: string
    /** Incorrect steps the batch considered replay targets (submit-step golds excluded). */
    goldIncorrectSteps: number[]
    /** Every incorrect step in the label entry, across stages. */
    labelIncorrectSteps: number[]
    recordedReturncodeAtK: number
  }
  /** Prefix context 1..k — post-k steps are excluded so a trainer never sees the future. */
  trajectory: {
    window: { start: number; end: number }
    steps: TrajectoryStep[]
  }
  verification: {
    reproduced: boolean
    /** Arm A output also contained the recorded error substring (or returncode-only basis matched). */
    signatureStrict: boolean
    signatureBasis: string | null
    signature: string | null
    prefixExecuted: number
    prefixDivergences: number
    prefixDivergencePct: number
    prefixReturncodeMismatches: number
    /** Steps the recording carries no returncode for. Nonzero here means part
     *  of the prefix replay was never confirmed against the recording. */
    prefixUnknownExpectations: number
    prefixDivergenceDetail: PrefixDivergence[] | null
    armAExit: number | null
    armAReturncodeMatch: boolean
    armACommand: string | null
    wallMs: number
  }
  fix: VerifiedFindingFix
  provenance: {
    runId: string
    batchGeneratedAt: string
    batchReportSha256: string
    labelsPath: string
    labelsSha256: string
    stepsPath: string
    stepsSha256: string
    image: string
    derivedImage: string | null
    cwd: string
    cwdSource: string
    originalRunId: string | null
    armARunId: string | null
  }
}

export interface VerifiedFindingsSummary {
  rows: number
  reproduced: number
  /** Reproduced AND arm A matched the failure signature — the batch report's headline strict rate.
   *  Row-level `verification.signatureStrict` is raw arm A evidence and can be true on a
   *  non-reproduced case (signature matched but the prefix diverged past tolerance). */
  signatureStrict: number
  fix: Record<FixOutcome, number>
  byCorpus: Record<string, { rows: number; reproduced: number; fixFlipped: number }>
}

// ── Pure join ───────────────────────────────────────────────────────

const DEFAULT_MAX_OBSERVATION_CHARS = 4000

export interface BuildVerifiedFindingRowArgs {
  batchCase: ReplayBatchCase
  label: GoldLabelEntry
  steps: NormalizedStep[]
  runId: string
  batchGeneratedAt: string
  batchReportSha256: string
  labelsPath: string
  labelsSha256: string
  stepsPath: string
  stepsSha256: string
  detail?: CaseVerdictDetail
  maxObservationChars?: number
}

function fail(caseId: string, message: string): never {
  throw new Error(`verified-findings: ${caseId}: ${message}`)
}

function deriveFixOutcome(caseId: string, batchCase: ReplayBatchCase): VerifiedFindingFix {
  const fix = batchCase.fix
  if (fix === null) {
    if (batchCase.replayed) {
      fail(
        caseId,
        'replayed case has no fix record — the batch always records the fix arm for replayed cases',
      )
    }
    return {
      outcome: 'not-attempted',
      command: null,
      llmError: null,
      armBExit: null,
      failureVanished: null,
    }
  }
  const base = {
    command: fix.command,
    llmError: fix.llmError,
    armBExit: fix.armBExit,
    failureVanished: fix.failureVanished,
  }
  if (fix.command !== null) {
    if (fix.failureVanished === null) {
      fail(
        caseId,
        'fix command present but failureVanished missing — arm B verdict was never recorded',
      )
    }
    return { outcome: fix.failureVanished ? 'flipped' : 'not-flipped', ...base }
  }
  if (fix.llmError !== null) return { outcome: 'generation-failed', ...base }
  if (!fix.attempted || fix.sampledOut) return { outcome: 'not-attempted', ...base }
  fail(caseId, 'unrecognized fix record state (attempted, no command, no llmError)')
}

function truncateObservation(
  observation: string | null | undefined,
  maxChars: number,
): Pick<TrajectoryStep, 'observation' | 'observationTruncated' | 'observationChars'> {
  if (observation === null || observation === undefined) {
    return { observation: null, observationTruncated: false, observationChars: 0 }
  }
  if (observation.length <= maxChars) {
    return { observation, observationTruncated: false, observationChars: observation.length }
  }
  return {
    observation: observation.slice(0, maxChars),
    observationTruncated: true,
    observationChars: observation.length,
  }
}

/**
 * Join one batch case with its gold label and trajectory into a row.
 * Throws on any join inconsistency — never emits a partially joined row.
 */
export function buildVerifiedFindingRow(args: BuildVerifiedFindingRowArgs): VerifiedFindingRow {
  const { batchCase, label, steps, detail } = args
  const caseId = `${args.runId}/${batchCase.corpus}/${batchCase.trajId}`
  const maxObservationChars = args.maxObservationChars ?? DEFAULT_MAX_OBSERVATION_CHARS

  if (batchCase.status !== 'ok') {
    fail(
      caseId,
      `case status is '${batchCase.status}' (error: ${batchCase.error ?? 'none'}) — only ok cases join`,
    )
  }
  if (label.traj_id !== batchCase.trajId) {
    fail(caseId, `label traj_id '${label.traj_id}' does not match the case`)
  }
  if (label.step_count !== batchCase.stepCount) {
    fail(caseId, `label step_count ${label.step_count} != case stepCount ${batchCase.stepCount}`)
  }
  if (steps.length !== batchCase.stepCount) {
    fail(caseId, `steps.json has ${steps.length} steps, case expects ${batchCase.stepCount}`)
  }
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]!
    if (step.step_id !== i + 1) {
      fail(caseId, `steps.json is not contiguous 1..n: index ${i} has step_id ${step.step_id}`)
    }
  }
  const k = batchCase.k
  if (k < 1 || k > batchCase.stepCount) {
    fail(caseId, `gold step k=${k} is outside 1..${batchCase.stepCount}`)
  }
  if (!batchCase.goldIncorrectSteps.includes(k)) {
    fail(
      caseId,
      `gold step k=${k} is not in goldIncorrectSteps [${batchCase.goldIncorrectSteps.join(', ')}]`,
    )
  }
  const labelIncorrectSteps = [
    ...new Set(label.incorrect_stages.flatMap((s) => s.incorrect_step_ids)),
  ].sort((a, b) => a - b)
  for (const goldStep of batchCase.goldIncorrectSteps) {
    if (!labelIncorrectSteps.includes(goldStep)) {
      fail(
        caseId,
        `case gold step ${goldStep} is absent from the label's incorrect steps — label/report mismatch`,
      )
    }
  }
  if (detail !== undefined) {
    if (detail.k !== k) fail(caseId, `per-case verdict k=${detail.k} != report k=${k}`)
    if (detail.prefixExecuted !== batchCase.prefixExecuted) {
      fail(
        caseId,
        `per-case verdict prefixExecuted=${detail.prefixExecuted} != report ${batchCase.prefixExecuted}`,
      )
    }
    if (detail.recordedReturncode !== batchCase.recordedReturncodeAtK) {
      fail(
        caseId,
        `per-case verdict recordedReturncode=${detail.recordedReturncode} != report ${batchCase.recordedReturncodeAtK}`,
      )
    }
    if (detail.prefixDivergences.length !== batchCase.prefixDivergences) {
      fail(
        caseId,
        `per-case verdict lists ${detail.prefixDivergences.length} prefix divergences != report ${batchCase.prefixDivergences}`,
      )
    }
    const unknown = detail.prefixDivergences.filter((d) => d.kind === 'unknown-expectation').length
    if (unknown !== batchCase.prefixUnknownExpectations) {
      fail(
        caseId,
        `per-case verdict lists ${unknown} unknown-expectation steps != report ${batchCase.prefixUnknownExpectations}`,
      )
    }
  }

  const stepAtK = steps[k - 1]!
  const trajectorySteps: TrajectoryStep[] = steps.slice(0, k).map((step) => ({
    stepId: step.step_id,
    action: step.action,
    ...truncateObservation(step.observation, maxObservationChars),
  }))

  return {
    schema: VERIFIED_FINDING_SCHEMA,
    caseId,
    corpus: batchCase.corpus,
    trajId: batchCase.trajId,
    task: {
      agent: label.agent ?? null,
      model: label.model ?? null,
      taskName: label.task_name ?? null,
      difficulty: label.difficulty ?? null,
      solved: label.solved,
      stepCount: batchCase.stepCount,
    },
    gold: {
      stepK: k,
      actionAtK: stepAtK.action,
      goldIncorrectSteps: [...batchCase.goldIncorrectSteps].sort((a, b) => a - b),
      labelIncorrectSteps,
      recordedReturncodeAtK: batchCase.recordedReturncodeAtK,
    },
    trajectory: {
      window: { start: 1, end: k },
      steps: trajectorySteps,
    },
    verification: {
      reproduced: batchCase.replayed,
      signatureStrict: batchCase.armASignatureMatch,
      signatureBasis: detail?.signatureBasis ?? null,
      signature: batchCase.signature,
      prefixExecuted: batchCase.prefixExecuted,
      prefixDivergences: batchCase.prefixDivergences,
      prefixDivergencePct: batchCase.prefixDivergencePct,
      prefixReturncodeMismatches: batchCase.prefixReturncodeMismatches,
      prefixUnknownExpectations: batchCase.prefixUnknownExpectations,
      prefixDivergenceDetail: detail?.prefixDivergences ?? null,
      armAExit: batchCase.armAExit,
      armAReturncodeMatch: batchCase.armAReturncodeMatch,
      armACommand: detail?.armACommand ?? null,
      wallMs: batchCase.wallMs,
    },
    fix: deriveFixOutcome(caseId, batchCase),
    provenance: {
      runId: args.runId,
      batchGeneratedAt: args.batchGeneratedAt,
      batchReportSha256: args.batchReportSha256,
      labelsPath: args.labelsPath,
      labelsSha256: args.labelsSha256,
      stepsPath: args.stepsPath,
      stepsSha256: args.stepsSha256,
      image: batchCase.image,
      derivedImage: batchCase.derivedImage,
      cwd: batchCase.cwd,
      cwdSource: batchCase.cwdSource,
      originalRunId: detail?.runIds.original ?? null,
      armARunId: detail?.runIds.armA ?? null,
    },
  }
}

export function summarizeVerifiedFindings(rows: VerifiedFindingRow[]): VerifiedFindingsSummary {
  const summary: VerifiedFindingsSummary = {
    rows: rows.length,
    reproduced: 0,
    signatureStrict: 0,
    fix: { flipped: 0, 'not-flipped': 0, 'generation-failed': 0, 'not-attempted': 0 },
    byCorpus: {},
  }
  for (const row of rows) {
    if (row.verification.reproduced) summary.reproduced++
    if (row.verification.reproduced && row.verification.signatureStrict) summary.signatureStrict++
    summary.fix[row.fix.outcome]++
    let corpus = summary.byCorpus[row.corpus]
    if (corpus === undefined) {
      corpus = { rows: 0, reproduced: 0, fixFlipped: 0 }
      summary.byCorpus[row.corpus] = corpus
    }
    corpus.rows++
    if (row.verification.reproduced) corpus.reproduced++
    if (row.fix.outcome === 'flipped') corpus.fixFlipped++
  }
  return summary
}

export function verifiedFindingsToJsonl(rows: VerifiedFindingRow[]): string {
  return rows.map((row) => JSON.stringify(row)).join('\n') + (rows.length > 0 ? '\n' : '')
}

// ── Filesystem loader ───────────────────────────────────────────────

export interface VerifiedFindingsCorpusSource {
  labelsPath: string
  /** Directory containing `normalized/<trajId>/steps.json`. */
  preparedDir: string
}

export interface VerifiedFindingsSource {
  batchReportPath: string
  /** Batch run identifier embedded in every caseId, e.g. 'run2-20260802'. */
  runId: string
  /** Corpus name (as it appears in the batch report) → label + trajectory locations. */
  corpora: Record<string, VerifiedFindingsCorpusSource>
  /** Batch run directory holding `<corpus>--<trajId>/replay-verdict.json`; when set, every case must have one. */
  runDir?: string
  maxObservationChars?: number
}

export interface VerifiedFindingsDataset {
  rows: VerifiedFindingRow[]
  summary: VerifiedFindingsSummary
  provenance: {
    runId: string
    batchReportPath: string
    batchReportSha256: string
    batchGeneratedAt: string
    corpora: Record<string, { labelsPath: string; labelsSha256: string; preparedDir: string }>
  }
}

function sha256(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex')
}

function readJson(path: string, what: string): { value: unknown; sha256: string } {
  let buffer: Buffer
  try {
    buffer = readFileSync(path)
  } catch (error) {
    throw new Error(
      `verified-findings: cannot read ${what} at ${path}: ${(error as Error).message}`,
    )
  }
  try {
    return { value: JSON.parse(buffer.toString('utf8')), sha256: sha256(buffer) }
  } catch (error) {
    throw new Error(
      `verified-findings: ${what} at ${path} is not valid JSON: ${(error as Error).message}`,
    )
  }
}

interface CaseVerdictFile {
  k: number
  prefixExecuted: number
  recordedReturncode: number
  signatureBasis?: string | null
  prefixDivergences?: PrefixDivergence[]
  armA?: { command?: string | null } | null
  runIds?: { original?: string | null; armA?: string | null } | null
}

const PREFIX_DIVERGENCE_KINDS = new Set(['returncode-mismatch', 'unknown-expectation'])

function loadCaseVerdictDetail(runDir: string, batchCase: ReplayBatchCase): CaseVerdictDetail {
  const path = join(runDir, `${batchCase.corpus}--${batchCase.trajId}`, 'replay-verdict.json')
  const parsed = readJson(path, `per-case verdict for ${batchCase.trajId}`).value as CaseVerdictFile
  const divergences = parsed.prefixDivergences ?? []
  // A record without a kind came from a comparison that could not tell a
  // confirmed match from an unverifiable step, so the whole file is unusable.
  for (const divergence of divergences) {
    if (!PREFIX_DIVERGENCE_KINDS.has(divergence.kind)) {
      throw new Error(
        `verified-findings: ${path} step ${divergence.step} has divergence kind ` +
          `'${divergence.kind}'; expected one of ${[...PREFIX_DIVERGENCE_KINDS].join(', ')}`,
      )
    }
  }
  return {
    k: parsed.k,
    prefixExecuted: parsed.prefixExecuted,
    recordedReturncode: parsed.recordedReturncode,
    signatureBasis: parsed.signatureBasis ?? null,
    prefixDivergences: divergences,
    armACommand: parsed.armA?.command ?? null,
    runIds: {
      original: parsed.runIds?.original ?? null,
      armA: parsed.runIds?.armA ?? null,
    },
  }
}

/**
 * Load a replay-verify batch and join it into verified-finding rows.
 * Every case in the report must join: an unresolvable corpus, a missing
 * label entry, or a missing trajectory throws instead of dropping the row.
 */
export function loadVerifiedFindingsDataset(
  source: VerifiedFindingsSource,
): VerifiedFindingsDataset {
  const report = readJson(source.batchReportPath, 'batch report')
  const parsedReport = report.value as ReplayBatchReport
  if (!Array.isArray(parsedReport.cases) || parsedReport.cases.length === 0) {
    throw new Error(`verified-findings: batch report at ${source.batchReportPath} has no cases`)
  }
  if (typeof parsedReport.generatedAt !== 'string' || parsedReport.generatedAt.length === 0) {
    throw new Error(
      `verified-findings: batch report at ${source.batchReportPath} has no generatedAt`,
    )
  }

  const labelCache = new Map<string, { sha256: string; byTrajId: Map<string, GoldLabelEntry> }>()
  const corporaProvenance: VerifiedFindingsDataset['provenance']['corpora'] = {}

  const resolveCorpus = (corpus: string) => {
    const config = source.corpora[corpus]
    if (config === undefined) {
      throw new Error(
        `verified-findings: batch report references corpus '${corpus}' but no labels/preparedDir was configured for it`,
      )
    }
    let cached = labelCache.get(corpus)
    if (cached === undefined) {
      const labels = readJson(config.labelsPath, `labels for corpus '${corpus}'`)
      const entries = labels.value as GoldLabelEntry[]
      if (!Array.isArray(entries)) {
        throw new Error(
          `verified-findings: labels for corpus '${corpus}' at ${config.labelsPath} are not an array`,
        )
      }
      const byTrajId = new Map<string, GoldLabelEntry>()
      for (const entry of entries) {
        if (byTrajId.has(entry.traj_id)) {
          throw new Error(
            `verified-findings: labels for corpus '${corpus}' contain duplicate traj_id '${entry.traj_id}'`,
          )
        }
        byTrajId.set(entry.traj_id, entry)
      }
      cached = { sha256: labels.sha256, byTrajId }
      labelCache.set(corpus, cached)
      corporaProvenance[corpus] = {
        labelsPath: config.labelsPath,
        labelsSha256: labels.sha256,
        preparedDir: config.preparedDir,
      }
    }
    return { config, ...cached }
  }

  const rows: VerifiedFindingRow[] = []
  for (const batchCase of parsedReport.cases) {
    const { config, sha256: labelsSha256, byTrajId } = resolveCorpus(batchCase.corpus)
    const label = byTrajId.get(batchCase.trajId)
    if (label === undefined) {
      throw new Error(
        `verified-findings: ${source.runId}/${batchCase.corpus}/${batchCase.trajId}: no label entry in ${config.labelsPath}`,
      )
    }
    const stepsPath = join(config.preparedDir, 'normalized', batchCase.trajId, 'steps.json')
    const stepsFile = readJson(stepsPath, `trajectory steps for ${batchCase.trajId}`)
    const steps = stepsFile.value as NormalizedStep[]
    if (!Array.isArray(steps)) {
      throw new Error(`verified-findings: trajectory steps at ${stepsPath} are not an array`)
    }
    const detail =
      source.runDir === undefined ? undefined : loadCaseVerdictDetail(source.runDir, batchCase)
    rows.push(
      buildVerifiedFindingRow({
        batchCase,
        label,
        steps,
        runId: source.runId,
        batchGeneratedAt: parsedReport.generatedAt,
        batchReportSha256: report.sha256,
        labelsPath: config.labelsPath,
        labelsSha256,
        stepsPath,
        stepsSha256: stepsFile.sha256,
        detail,
        maxObservationChars: source.maxObservationChars,
      }),
    )
  }
  rows.sort((a, b) => a.caseId.localeCompare(b.caseId))

  return {
    rows,
    summary: summarizeVerifiedFindings(rows),
    provenance: {
      runId: source.runId,
      batchReportPath: source.batchReportPath,
      batchReportSha256: report.sha256,
      batchGeneratedAt: parsedReport.generatedAt,
      corpora: corporaProvenance,
    },
  }
}
