/**
 * Batch replay verification across gold-labeled trajectory corpora.
 *
 * For every replayable case (a raw trajectory with a recorded image AND at
 * least one gold incorrect step) the batch:
 *   1. derives the replay-ready image through the injected `ImagePreparer`,
 *   2. replays the prefix and runs arm A — the recorded gold step k, and
 *   3. optionally generates a corrected command with one LLM call and runs
 *      arm B in its own fresh session.
 *
 * Headline metrics:
 *   replayability rate — fraction of replayable cases where the prefix
 *     replays within the divergence tolerance AND arm A reproduces a
 *     recorded failure at k; a zero exit without an error signature is not
 *     evidence of failure;
 *   prefix fidelity — executed prefix steps and the share of them that did
 *     not confirm the recording, split by kind. A corpus whose recordings
 *     carry no returncodes shows up here as unknown-expectation steps, never
 *     as a clean replay;
 *   fix-flip rate — fraction of arm-B-executed cases where the failure
 *     vanished (exit 0, signature absent).
 *
 * Image pulls and execs run strictly serially: pulls contend on disk and
 * registry bandwidth, and serial cases keep wall-time attribution per case
 * honest. Pull failures are report rows, never silent skips.
 */

import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { caseOutDirName, runFixPhase } from './batch-fix'
import { renderBatchReport } from './batch-report'
import {
  type CorpusSpec,
  type EnumerationResult,
  enumerateReplayableCases,
  type ReplayableCase,
} from './corpus'
import type { ReplayExecBackendFactory } from './exec'
import type { ChatCompletionCaller, ChatUsage } from './fix'
import type { FixLoopAttemptRecord } from './fix-loop'
import { dockerImagePreparer, type ImagePreparer } from './image-preparer'
import { PREFIX_DIVERGENCE_TOLERANCE_PCT, type ReplayVerdict, replayVerify } from './verify'

// ── Batch execution ──────────────────────────────────────────────────

export interface ReplayBatchOptions {
  readonly corpora: readonly CorpusSpec[]
  readonly out: string
  /** 'generate' = one LLM call per arm-A-reproduced case, then arm B.
   *  'loop' = iterative: failed arms feed their real output into up to
   *  `fixAttempts` prompts, each executed in its own fresh session. */
  readonly fix: 'none' | 'generate' | 'loop'
  /** Attempt budget per case in loop mode (default 3). */
  readonly fixAttempts?: number
  readonly fixCaller?: ChatCompletionCaller
  readonly fixModelLabel?: string
  /** Cap on LLM fix calls; eligible cases beyond it are seeded-sampled out. */
  readonly maxFixCases?: number
  readonly seed?: number
  /** Overrides the per-case recorded step timeout. */
  readonly stepTimeoutMs?: number
  readonly prefixLimit?: number
  /** Run only cases whose trajId contains this substring (smoke knob). */
  readonly caseFilter?: string
  /** Run only the first N replayable cases (smoke knob). */
  readonly caseLimit?: number
  /** Derives the replay-ready image per case. Defaults to the docker preparer. */
  readonly preparer?: ImagePreparer
  /** Builds the exec backend for a case's derived image. */
  readonly backendFactory: ReplayExecBackendFactory
  readonly onProgress?: (message: string) => void
}

export interface ReplayBatchFixResult {
  /** false when the case was eligible but seeded-sampled out of the cap. */
  readonly attempted: boolean
  readonly sampledOut: boolean
  readonly command: string | null
  readonly llmError: string | null
  /** Loop mode: token totals summed across every attempt (null when the
   *  provider reported no usage). */
  readonly usage: ChatUsage | null
  readonly armBExit: number | null
  readonly armBPrefixExecuted: number | null
  readonly armBPrefixDivergences: number | null
  readonly armBPrefixDivergencePct: number | null
  readonly failureVanished: boolean | null
  readonly armBError: string | null
  /** Loop mode only: the full per-attempt trail. Null in generate mode. */
  readonly attempts: readonly FixLoopAttemptRecord[] | null
  /** 1-based attempt that flipped the failure; null when none did.
   *  Generate mode: 1 when the single attempt flipped. */
  readonly flippedAtAttempt: number | null
}

export interface ReplayBatchCaseRow {
  readonly corpus: string
  readonly trajId: string
  readonly image: string
  readonly derivedImage: string | null
  readonly cwd: string
  readonly cwdSource: string
  readonly k: number
  readonly stepCount: number
  readonly goldIncorrectSteps: readonly number[]
  /** Gold steps before k skipped because their action is the submit command. */
  readonly submitGoldsSkipped: number
  readonly recordedReturncodeAtK: number | null
  readonly signature: string | null
  readonly status: 'ok' | 'image-unavailable' | 'replay-error'
  readonly error: string | null
  readonly imagePulled: boolean
  readonly imageBuilt: boolean
  readonly prefixExecuted: number | null
  readonly prefixDivergences: number | null
  readonly prefixDivergencePct: number | null
  /** Prefix steps whose recorded returncode equalled the replayed exit. */
  readonly prefixConfirmed: number | null
  readonly prefixReturncodeMismatches: number | null
  /** Prefix steps the recording carries no returncode for: unverifiable, and
   *  counted as divergences because agreement was never established. */
  readonly prefixUnknownExpectations: number | null
  readonly armAExit: number | null
  readonly armAReturncodeMatch: boolean
  readonly armASignatureMatch: boolean
  /** Headline predicate: prefix within tolerance and arm A reproduced an
   *  observed failure at k. */
  readonly replayed: boolean
  readonly fix: ReplayBatchFixResult | null
  readonly wallMs: number
}

export interface ReplayBatchReport {
  readonly generatedAt: string
  readonly corpora: readonly { name: string; labelsPath: string; preparedDir: string }[]
  readonly totals: {
    readonly labelEntries: number
    readonly replayable: number
    readonly executed: number
    readonly excludedByReason: Record<string, number>
    /** Per-corpus submit-gold accounting: cases dropped because every gold is
     *  a pure submit, and such golds skipped inside replayable cases. */
    readonly submitGoldsByCorpus: Record<
      string,
      { submitOnlyCases: number; goldsSkippedWithinReplayable: number }
    >
  }
  readonly headline: {
    readonly replayabilityRate: { numerator: number; denominator: number; value: number | null }
    readonly signatureStrictRate: { numerator: number; denominator: number; value: number | null }
    /** Corpus-level replay fidelity over every executed prefix step. A corpus
     *  whose recordings cannot adjudicate the replay lands here as
     *  `unknownExpectations`, not as a clean replay. */
    readonly prefixFidelity: {
      readonly executedSteps: number
      readonly divergentSteps: number
      readonly returncodeMismatches: number
      readonly unknownExpectations: number
      /** Divergent over executed steps; null when no prefix step ran. */
      readonly divergencePct: number | null
      readonly tolerancePct: number
      readonly casesWithinTolerance: number
      readonly casesExecuted: number
    }
    readonly fixFlipRate: { numerator: number; denominator: number; value: number | null } | null
    /** Fix-flip restricted to cases whose recorded returncode at k is nonzero. */
    readonly fixFlipRateNonzeroRc: {
      numerator: number
      denominator: number
      value: number | null
    } | null
    /** Loop mode only: flips at attempt 1 over cases whose attempt 1 executed —
     *  the number directly comparable to the one-shot fixFlipRate. */
    readonly fixFlipAttempt1: {
      numerator: number
      denominator: number
      value: number | null
    } | null
    /** Loop mode only: flip count keyed by the attempt number that flipped. */
    readonly flipsByAttempt: Record<string, number> | null
  }
  readonly llm: {
    readonly model: string
    readonly calls: number
    readonly failures: number
    readonly promptTokens: number
    readonly completionTokens: number
    /** Successful calls whose provider reported no usage. Their tokens are
     *  absent from the two totals above, so a nonzero count here means the
     *  totals are a lower bound, not a measurement. */
    readonly callsWithoutUsage: number
  } | null
  readonly excluded: readonly { corpus: string; trajId: string; reason: string; detail?: string }[]
  readonly pullFailures: readonly { corpus: string; trajId: string; image: string; error: string }[]
  readonly cases: readonly ReplayBatchCaseRow[]
}

function rate(numerator: number, denominator: number): number | null {
  return denominator > 0 ? numerator / denominator : null
}

/** What every phase of one batch shares. */
export interface BatchRun {
  readonly options: ReplayBatchOptions
  readonly onProgress: (message: string) => void
  readonly progressPath: string
  readonly preparer: ImagePreparer
}

type CaseIdentity = Pick<
  ReplayBatchCaseRow,
  | 'corpus'
  | 'trajId'
  | 'image'
  | 'cwd'
  | 'cwdSource'
  | 'k'
  | 'stepCount'
  | 'goldIncorrectSteps'
  | 'submitGoldsSkipped'
  | 'recordedReturncodeAtK'
>

function caseIdentity(replayCase: ReplayableCase): CaseIdentity {
  return {
    corpus: replayCase.corpus,
    trajId: replayCase.trajId,
    image: replayCase.image,
    cwd: replayCase.cwd,
    cwdSource: replayCase.cwdSource,
    k: replayCase.k,
    stepCount: replayCase.steps.length,
    goldIncorrectSteps: replayCase.goldIncorrectSteps,
    submitGoldsSkipped: replayCase.submitGoldsSkipped,
    recordedReturncodeAtK: replayCase.recordedReturncodeAtK,
  }
}

/** The row of a case that never produced an arm A verdict. */
function unreplayedRow(
  replayCase: ReplayableCase,
  caseStart: number,
  failure: {
    derivedImage: string | null
    status: 'image-unavailable' | 'replay-error'
    error: string
    imagePulled: boolean
    imageBuilt: boolean
  },
): ReplayBatchCaseRow {
  return {
    ...caseIdentity(replayCase),
    derivedImage: failure.derivedImage,
    signature: null,
    status: failure.status,
    error: failure.error,
    imagePulled: failure.imagePulled,
    imageBuilt: failure.imageBuilt,
    prefixExecuted: null,
    prefixDivergences: null,
    prefixDivergencePct: null,
    prefixConfirmed: null,
    prefixReturncodeMismatches: null,
    prefixUnknownExpectations: null,
    armAExit: null,
    armAReturncodeMatch: false,
    armASignatureMatch: false,
    replayed: false,
    fix: null,
    wallMs: Date.now() - caseStart,
  }
}

function verdictRow(
  replayCase: ReplayableCase,
  caseStart: number,
  image: { derivedImage: string; pulled: boolean; built: boolean },
  verdict: ReplayVerdict,
  returncodeMatch: boolean,
): ReplayBatchCaseRow {
  return {
    ...caseIdentity(replayCase),
    derivedImage: image.derivedImage,
    signature: verdict.signature,
    status: 'ok',
    error: null,
    imagePulled: image.pulled,
    imageBuilt: image.built,
    prefixExecuted: verdict.prefixExecuted,
    prefixDivergences: verdict.prefixDivergences.length,
    prefixDivergencePct: verdict.prefixDivergencePct,
    prefixConfirmed: verdict.prefixConfirmed,
    prefixReturncodeMismatches: verdict.prefixReturncodeMismatches,
    prefixUnknownExpectations: verdict.prefixUnknownExpectations,
    armAExit: verdict.armA.exitCode,
    armAReturncodeMatch: returncodeMatch,
    armASignatureMatch: verdict.armA.failureSignatureMatch,
    replayed: verdict.valid,
    fix: null,
    wallMs: Date.now() - caseStart,
  }
}

/** Phase 1 for one case: prepare its image and run arm A. Every outcome is a row, never a skip. */
async function replayArmA(
  run: BatchRun,
  replayCase: ReplayableCase,
  label: string,
  verdicts: Map<string, ReplayVerdict>,
  pullFailures: { corpus: string; trajId: string; image: string; error: string }[],
): Promise<ReplayBatchCaseRow> {
  const { options, onProgress } = run
  const caseStart = Date.now()
  onProgress(`${label}: preparing image ${replayCase.image}`)
  const preparation = await run.preparer.ensure(replayCase.image, replayCase.cwd)
  if (!preparation.succeeded) {
    pullFailures.push({
      corpus: replayCase.corpus,
      trajId: replayCase.trajId,
      image: replayCase.image,
      error: preparation.error,
    })
    const row = unreplayedRow(replayCase, caseStart, {
      derivedImage: null,
      status: 'image-unavailable',
      error: preparation.error,
      imagePulled: false,
      imageBuilt: false,
    })
    appendFileSync(run.progressPath, `${JSON.stringify(row)}\n`)
    onProgress(`${label}: image unavailable — ${preparation.error}`)
    return row
  }
  const { derivedImage, pulled, built } = preparation.value
  const stepTimeoutMs = options.stepTimeoutMs ?? replayCase.recordedStepTimeoutMs ?? 120_000
  const caseOut = join(options.out, caseOutDirName(replayCase))
  onProgress(`${label}: arm A on ${derivedImage} (k=${replayCase.k}, timeout ${stepTimeoutMs}ms)`)
  try {
    const verdict = await replayVerify({
      stepsPath: replayCase.stepsPath,
      image: derivedImage,
      at: replayCase.k,
      cwd: replayCase.cwd,
      out: caseOut,
      caseId: replayCase.trajId,
      stepTimeoutMs,
      prefixLimit: options.prefixLimit,
      backend: options.backendFactory(derivedImage),
      onProgress: (message) => onProgress(`${label}: ${message}`),
    })
    verdicts.set(replayCase.trajId, verdict)
    const returncodeMatch =
      verdict.recordedReturncode !== null && verdict.armA.exitCode === verdict.recordedReturncode
    const row = verdictRow(
      replayCase,
      caseStart,
      { derivedImage, pulled, built },
      verdict,
      returncodeMatch,
    )
    appendFileSync(run.progressPath, `${JSON.stringify(row)}\n`)
    onProgress(
      `${label}: armA exit=${verdict.armA.exitCode} rcMatch=${returncodeMatch} ` +
        `divergences=${verdict.prefixDivergences.length}/${verdict.prefixExecuted} ` +
        `(${verdict.prefixDivergencePct}%, ${verdict.prefixUnknownExpectations} unknown-expectation)`,
    )
    return row
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const row = unreplayedRow(replayCase, caseStart, {
      derivedImage,
      status: 'replay-error',
      error: message.slice(0, 500),
      imagePulled: pulled,
      imageBuilt: built,
    })
    appendFileSync(run.progressPath, `${JSON.stringify(row)}\n`)
    onProgress(`${label}: replay error — ${message.slice(0, 200)}`)
    return row
  }
}

function prefixFidelityOf(executedRows: readonly ReplayBatchCaseRow[]) {
  const sumOver = (pick: (row: ReplayBatchCaseRow) => number | null): number =>
    executedRows.reduce((total, row) => total + (pick(row) ?? 0), 0)
  const executedSteps = sumOver((r) => r.prefixExecuted)
  const divergentSteps = sumOver((r) => r.prefixDivergences)
  return {
    executedSteps,
    divergentSteps,
    returncodeMismatches: sumOver((r) => r.prefixReturncodeMismatches),
    unknownExpectations: sumOver((r) => r.prefixUnknownExpectations),
    divergencePct:
      executedSteps > 0 ? Number(((divergentSteps / executedSteps) * 100).toFixed(1)) : null,
    tolerancePct: PREFIX_DIVERGENCE_TOLERANCE_PCT,
    casesWithinTolerance: executedRows.filter(
      (r) =>
        r.prefixDivergencePct !== null && r.prefixDivergencePct <= PREFIX_DIVERGENCE_TOLERANCE_PCT,
    ).length,
    casesExecuted: executedRows.length,
  }
}

/** Fix-flip headline rates over the cases whose arm B executed. */
function fixFlipHeadline(rows: readonly ReplayBatchCaseRow[], fix: ReplayBatchOptions['fix']) {
  const armBExecuted = rows.filter((r) => r.fix?.attempted && r.fix.failureVanished !== null)
  const flipped = armBExecuted.filter((r) => r.fix!.failureVanished === true)
  const armBNonzeroRc = armBExecuted.filter(
    (r) => r.recordedReturncodeAtK !== null && r.recordedReturncodeAtK !== 0,
  )
  const flippedNonzeroRc = armBNonzeroRc.filter((r) => r.fix!.failureVanished === true)
  const attempt1Executed = rows.filter(
    (r) => r.fix?.attempts?.find((a) => a.attempt === 1)?.executed === true,
  )
  const flippedAt1 = rows.filter((r) => r.fix?.flippedAtAttempt === 1)
  const flipsByAttempt: Record<string, number> = {}
  for (const row of rows) {
    const at = row.fix?.flippedAtAttempt
    if (typeof at === 'number') flipsByAttempt[String(at)] = (flipsByAttempt[String(at)] ?? 0) + 1
  }
  return {
    fixFlipRate:
      fix !== 'none'
        ? {
            numerator: flipped.length,
            denominator: armBExecuted.length,
            value: rate(flipped.length, armBExecuted.length),
          }
        : null,
    fixFlipRateNonzeroRc:
      fix !== 'none'
        ? {
            numerator: flippedNonzeroRc.length,
            denominator: armBNonzeroRc.length,
            value: rate(flippedNonzeroRc.length, armBNonzeroRc.length),
          }
        : null,
    fixFlipAttempt1:
      fix === 'loop'
        ? {
            numerator: flippedAt1.length,
            denominator: attempt1Executed.length,
            value: rate(flippedAt1.length, attempt1Executed.length),
          }
        : null,
    flipsByAttempt: fix === 'loop' ? flipsByAttempt : null,
  }
}

/** Per-corpus submit-gold accounting: cases dropped for pure-submit golds, and submit golds skipped inside replayable cases. */
function submitGoldsOf(
  enumeration: EnumerationResult,
): ReplayBatchReport['totals']['submitGoldsByCorpus'] {
  const byCorpus: ReplayBatchReport['totals']['submitGoldsByCorpus'] = {}
  const entry = (corpus: string) =>
    (byCorpus[corpus] ??= { submitOnlyCases: 0, goldsSkippedWithinReplayable: 0 })
  for (const excluded of enumeration.excluded) {
    if (excluded.reason === 'gold-only-submit-step') entry(excluded.corpus).submitOnlyCases += 1
  }
  for (const replayCase of enumeration.replayable) {
    if (replayCase.submitGoldsSkipped > 0) {
      entry(replayCase.corpus).goldsSkippedWithinReplayable += replayCase.submitGoldsSkipped
    }
  }
  return byCorpus
}

function buildBatchReport(
  options: ReplayBatchOptions,
  enumeration: EnumerationResult,
  selected: readonly ReplayableCase[],
  rows: readonly ReplayBatchCaseRow[],
  llm: ReplayBatchReport['llm'],
  pullFailures: ReplayBatchReport['pullFailures'],
): ReplayBatchReport {
  const executedRows = rows.filter((r) => r.status === 'ok')
  const replayed = executedRows.filter((r) => r.replayed)
  const signatureStrict = executedRows.filter((r) => r.replayed && r.armASignatureMatch)
  const excludedByReason: Record<string, number> = {}
  for (const excluded of enumeration.excluded) {
    excludedByReason[excluded.reason] = (excludedByReason[excluded.reason] ?? 0) + 1
  }
  return {
    generatedAt: new Date().toISOString(),
    corpora: options.corpora.map((c) => ({
      name: c.name,
      labelsPath: c.labelsPath,
      preparedDir: c.preparedDir,
    })),
    totals: {
      labelEntries: enumeration.labelEntryCount,
      replayable: enumeration.replayable.length,
      executed: selected.length,
      excludedByReason,
      submitGoldsByCorpus: submitGoldsOf(enumeration),
    },
    headline: {
      replayabilityRate: {
        numerator: replayed.length,
        denominator: selected.length,
        value: rate(replayed.length, selected.length),
      },
      signatureStrictRate: {
        numerator: signatureStrict.length,
        denominator: selected.length,
        value: rate(signatureStrict.length, selected.length),
      },
      prefixFidelity: prefixFidelityOf(executedRows),
      ...fixFlipHeadline(rows, options.fix),
    },
    llm,
    excluded: enumeration.excluded,
    pullFailures,
    cases: rows,
  }
}

export async function runReplayBatch(options: ReplayBatchOptions): Promise<ReplayBatchReport> {
  const onProgress = options.onProgress ?? (() => {})
  const enumeration: EnumerationResult = enumerateReplayableCases(options.corpora)
  let selected = enumeration.replayable
  if (options.caseFilter) {
    selected = selected.filter((c) => c.trajId.includes(options.caseFilter!))
  }
  if (options.caseLimit !== undefined) selected = selected.slice(0, options.caseLimit)
  onProgress(
    `enumerated ${enumeration.labelEntryCount} label entries → ${enumeration.replayable.length} replayable, ` +
      `${enumeration.excluded.length} excluded; executing ${selected.length}`,
  )

  mkdirSync(options.out, { recursive: true })
  const run: BatchRun = {
    options,
    onProgress,
    progressPath: join(options.out, 'cases.jsonl'),
    preparer: options.preparer ?? dockerImagePreparer(),
  }
  const rows: ReplayBatchCaseRow[] = []
  const pullFailures: { corpus: string; trajId: string; image: string; error: string }[] = []

  // Phase 1 — arm A for every selected case, serially.
  const verdictByTraj = new Map<string, ReplayVerdict>()
  for (const [index, replayCase] of selected.entries()) {
    const label = `[${index + 1}/${selected.length}] ${replayCase.corpus}/${replayCase.trajId}`
    rows.push(await replayArmA(run, replayCase, label, verdictByTraj, pullFailures))
  }

  // Phase 2 — counterfactual fixes for cases where arm A reproduced.
  const llm = options.fix !== 'none' ? await runFixPhase(run, selected, rows, verdictByTraj) : null

  const report = buildBatchReport(options, enumeration, selected, rows, llm, pullFailures)
  writeFileSync(join(options.out, 'batch-report.json'), `${JSON.stringify(report, null, 2)}\n`)
  writeFileSync(join(options.out, 'batch-report.md'), renderBatchReport(report))
  return report
}
