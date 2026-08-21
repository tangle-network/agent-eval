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
 *     replays within the divergence tolerance AND arm A reproduces the
 *     recorded returncode at k;
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
import { runCounterfactual } from '../counterfactual'
import { mulberry32 } from '../statistics/random'
import type { ToolSpan } from '../trace/schema'
import { InMemoryTraceStore } from '../trace/store'
import {
  type CorpusSpec,
  type EnumerationResult,
  enumerateReplayableCases,
  type ReplayableCase,
} from './corpus'
import type { ReplayExecBackend, ReplayExecBackendFactory } from './exec'
import { type ChatCompletionCaller, type ChatUsage, generateFixCommand } from './fix'
import { type FixLoopAttemptRecord, runFixLoop } from './fix-loop'
import { dockerImagePreparer, type ImagePreparer } from './image-preparer'
import {
  ingestRecordedTrajectory,
  PREFIX_DIVERGENCE_TOLERANCE_PCT,
  type PrefixReplayResult,
  type ReplayVerdict,
  replayVerify,
  SandboxCounterfactualRunner,
} from './verify'

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
  /** Headline predicate: prefix divergence within tolerance AND arm A
   *  reproduced the recorded returncode at k. */
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
     *  the submit command, and golds skipped inside still-replayable cases. */
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
    /** Fix-flip restricted to cases whose recorded returncode at k is nonzero —
     *  real recorded failures, where "the failure vanished" is not vacuous. */
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

export function seededSample<T>(items: readonly T[], size: number, seed: number): Set<T> {
  const pool = [...items]
  const random = mulberry32(seed)
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1))
    ;[pool[i], pool[j]] = [pool[j]!, pool[i]!]
  }
  return new Set(pool.slice(0, size))
}

function caseOutDirName(row: { corpus: string; trajId: string }): string {
  return `${row.corpus}--${row.trajId}`.replaceAll(/[^A-Za-z0-9._-]/g, '_').slice(0, 180)
}

interface ArmBExecution {
  readonly exitCode: number
  readonly prefixExecuted: number
  readonly prefixDivergences: number
  readonly prefixDivergencePct: number
  readonly failureVanished: boolean
  readonly stdout: string
  readonly stderr: string
}

/**
 * Arm B standalone: fresh sandbox, prefix replay, corrected step k. Reuses
 * the same counterfactual scaffold as replayVerify without re-running arm A.
 */
async function executeArmB(
  replayCase: ReplayableCase,
  fixCommand: string,
  backend: ReplayExecBackend,
  signature: string | null,
  stepTimeoutMs: number,
  prefixLimit: number | undefined,
  onProgress?: (message: string) => void,
): Promise<ArmBExecution> {
  const store = new InMemoryTraceStore()
  const { runId } = await ingestRecordedTrajectory(store, replayCase.steps, replayCase.trajId)
  const runner = new SandboxCounterfactualRunner(backend, {
    cwd: replayCase.cwd,
    stepTimeoutMs,
    prefixLimit,
    onProgress,
  })
  await runCounterfactual(
    store,
    runId,
    {
      kind: 'custom',
      at: replayCase.k - 1,
      describe: 'arm-B corrected step',
      apply: (step) => ({
        ...step,
        span: { ...(step.span as ToolSpan), args: { command: fixCommand } },
      }),
    },
    runner,
  )
  const exec = runner.lastArm
  if (!exec) throw new Error('arm B finished without executing the corrected step')
  const prefix: PrefixReplayResult | null = runner.lastPrefix
  if (!prefix) throw new Error('arm B reported no prefix replay result')
  const output = `${exec.stdout}\n${exec.stderr}`
  return {
    exitCode: exec.exitCode,
    prefixExecuted: prefix.prefixExecuted,
    prefixDivergences: prefix.prefixDivergences.length,
    prefixDivergencePct: prefix.prefixDivergencePct,
    failureVanished: exec.exitCode === 0 && (signature ? !output.includes(signature) : true),
    stdout: exec.stdout,
    stderr: exec.stderr,
  }
}

function rate(numerator: number, denominator: number): number | null {
  return denominator > 0 ? numerator / denominator : null
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

  const preparer = options.preparer ?? dockerImagePreparer()
  const backendFactory = options.backendFactory

  mkdirSync(options.out, { recursive: true })
  const progressPath = join(options.out, 'cases.jsonl')
  const rows: ReplayBatchCaseRow[] = []
  const pullFailures: { corpus: string; trajId: string; image: string; error: string }[] = []

  // Phase 1 — arm A for every selected case, serially.
  const verdictByTraj = new Map<string, ReplayVerdict>()
  for (const [index, replayCase] of selected.entries()) {
    const caseStart = Date.now()
    const label = `[${index + 1}/${selected.length}] ${replayCase.corpus}/${replayCase.trajId}`
    onProgress(`${label}: preparing image ${replayCase.image}`)
    const preparation = await preparer.ensure(replayCase.image, replayCase.cwd)
    const base = {
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
    if (!preparation.succeeded) {
      pullFailures.push({
        corpus: replayCase.corpus,
        trajId: replayCase.trajId,
        image: replayCase.image,
        error: preparation.error,
      })
      const row: ReplayBatchCaseRow = {
        ...base,
        derivedImage: null,
        signature: null,
        status: 'image-unavailable',
        error: preparation.error,
        imagePulled: false,
        imageBuilt: false,
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
      rows.push(row)
      appendFileSync(progressPath, `${JSON.stringify(row)}\n`)
      onProgress(`${label}: image unavailable — ${preparation.error}`)
      continue
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
        backend: backendFactory(derivedImage),
        onProgress: (message) => onProgress(`${label}: ${message}`),
      })
      verdictByTraj.set(replayCase.trajId, verdict)
      const returncodeMatch =
        verdict.recordedReturncode !== null && verdict.armA.exitCode === verdict.recordedReturncode
      const row: ReplayBatchCaseRow = {
        ...base,
        derivedImage,
        signature: verdict.signature,
        status: 'ok',
        error: null,
        imagePulled: pulled,
        imageBuilt: built,
        prefixExecuted: verdict.prefixExecuted,
        prefixDivergences: verdict.prefixDivergences.length,
        prefixDivergencePct: verdict.prefixDivergencePct,
        prefixConfirmed: verdict.prefixConfirmed,
        prefixReturncodeMismatches: verdict.prefixReturncodeMismatches,
        prefixUnknownExpectations: verdict.prefixUnknownExpectations,
        armAExit: verdict.armA.exitCode,
        armAReturncodeMatch: returncodeMatch,
        armASignatureMatch: verdict.armA.failureSignatureMatch,
        replayed: verdict.prefixWithinTolerance && returncodeMatch,
        fix: null,
        wallMs: Date.now() - caseStart,
      }
      rows.push(row)
      appendFileSync(progressPath, `${JSON.stringify(row)}\n`)
      onProgress(
        `${label}: armA exit=${verdict.armA.exitCode} rcMatch=${returncodeMatch} ` +
          `divergences=${verdict.prefixDivergences.length}/${verdict.prefixExecuted} ` +
          `(${verdict.prefixDivergencePct}%, ${verdict.prefixUnknownExpectations} unknown-expectation)`,
      )
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const row: ReplayBatchCaseRow = {
        ...base,
        derivedImage,
        signature: null,
        status: 'replay-error',
        error: message.slice(0, 500),
        imagePulled: pulled,
        imageBuilt: built,
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
      rows.push(row)
      appendFileSync(progressPath, `${JSON.stringify(row)}\n`)
      onProgress(`${label}: replay error — ${message.slice(0, 200)}`)
    }
  }

  // Phase 2 — counterfactual fixes for cases where arm A reproduced.
  let llm: ReplayBatchReport['llm'] = null
  if (options.fix !== 'none') {
    const caller = options.fixCaller
    if (!caller) throw new Error(`trajectory-replay: fix=${options.fix} requires a fixCaller`)
    const fixAttempts = options.fixAttempts ?? 3
    const maxFixCases = options.maxFixCases ?? 30
    const seed = options.seed ?? 17
    const eligible = rows.filter((r) => r.status === 'ok' && r.replayed)
    const sampled =
      eligible.length > maxFixCases ? seededSample(eligible, maxFixCases, seed) : new Set(eligible)
    if (eligible.length > maxFixCases) {
      onProgress(
        `fix phase: ${eligible.length} eligible > cap ${maxFixCases}; seeded sample (seed=${seed})`,
      )
    }
    let calls = 0
    let failures = 0
    let promptTokens = 0
    let completionTokens = 0
    let callsWithoutUsage = 0
    for (const row of eligible) {
      const index = rows.indexOf(row)
      if (!sampled.has(row)) {
        rows[index] = {
          ...row,
          fix: {
            attempted: false,
            sampledOut: true,
            command: null,
            llmError: null,
            usage: null,
            armBExit: null,
            armBPrefixExecuted: null,
            armBPrefixDivergences: null,
            armBPrefixDivergencePct: null,
            failureVanished: null,
            armBError: null,
            attempts: null,
            flippedAtAttempt: null,
          },
        }
        continue
      }
      const replayCase = selected.find((c) => c.trajId === row.trajId && c.corpus === row.corpus)!
      const label = `fix ${row.corpus}/${row.trajId}`
      const signature = verdictByTraj.get(row.trajId)?.signature ?? null
      const stepTimeoutMs = options.stepTimeoutMs ?? replayCase.recordedStepTimeoutMs ?? 120_000
      const promptInput = {
        taskStatement: replayCase.taskStatement,
        steps: replayCase.steps,
        k: replayCase.k,
      }
      const caseOut = join(options.out, caseOutDirName(row))

      if (options.fix === 'loop') {
        onProgress(`${label}: fix loop (budget ${fixAttempts} attempts)`)
        const result = await runFixLoop(
          caller,
          promptInput,
          async (command, attempt) => {
            onProgress(
              `${label}: attempt ${attempt} arm B — ${command.split('\n')[0]!.slice(0, 120)}`,
            )
            const armB = await executeArmB(
              replayCase,
              command,
              backendFactory(row.derivedImage!),
              signature,
              stepTimeoutMs,
              options.prefixLimit,
              (message) => onProgress(`${label}: attempt ${attempt}: ${message}`),
            )
            mkdirSync(caseOut, { recursive: true })
            writeFileSync(
              join(caseOut, `armB-attempt${attempt}-result.json`),
              `${JSON.stringify({ command, ...armB }, null, 2)}\n`,
            )
            // armB-result.json always holds the LAST executed attempt — the
            // flipped one when the loop flips (it stops there).
            writeFileSync(
              join(caseOut, 'armB-result.json'),
              `${JSON.stringify({ command, attempt, ...armB }, null, 2)}\n`,
            )
            return armB
          },
          { maxAttempts: fixAttempts, onProgress: (message) => onProgress(`${label}: ${message}`) },
        )
        calls += result.llmCalls
        failures += result.llmFailures
        promptTokens += result.promptTokens
        completionTokens += result.completionTokens
        callsWithoutUsage += result.callsWithoutUsage
        const usage =
          result.promptTokens + result.completionTokens > 0
            ? { promptTokens: result.promptTokens, completionTokens: result.completionTokens }
            : null
        const flippedRecord =
          result.flippedAtAttempt !== null
            ? result.attempts.find((a) => a.attempt === result.flippedAtAttempt)!
            : null
        const summary =
          flippedRecord ?? [...result.attempts].reverse().find((a) => a.executed) ?? null
        const lastRecord = result.attempts.at(-1) ?? null
        rows[index] = {
          ...row,
          fix: summary
            ? {
                attempted: true,
                sampledOut: false,
                command: summary.command,
                llmError: null,
                usage,
                armBExit: summary.exitCode,
                armBPrefixExecuted: summary.prefixExecuted,
                armBPrefixDivergences: summary.prefixDivergences,
                armBPrefixDivergencePct: summary.prefixDivergencePct,
                failureVanished: summary.failureVanished,
                armBError: null,
                attempts: result.attempts,
                flippedAtAttempt: result.flippedAtAttempt,
              }
            : result.aborted
              ? {
                  attempted: true,
                  sampledOut: false,
                  command: lastRecord?.command ?? null,
                  llmError: null,
                  usage,
                  armBExit: null,
                  armBPrefixExecuted: null,
                  armBPrefixDivergences: null,
                  armBPrefixDivergencePct: null,
                  failureVanished: null,
                  armBError: lastRecord?.armBError ?? 'sandbox error',
                  attempts: result.attempts,
                  flippedAtAttempt: null,
                }
              : {
                  attempted: true,
                  sampledOut: false,
                  command: null,
                  llmError: lastRecord?.llmError ?? 'no attempt produced a runnable fix',
                  usage,
                  armBExit: null,
                  armBPrefixExecuted: null,
                  armBPrefixDivergences: null,
                  armBPrefixDivergencePct: null,
                  failureVanished: null,
                  armBError: null,
                  attempts: result.attempts,
                  flippedAtAttempt: null,
                },
        }
        onProgress(
          `${label}: loop done — flipped=${result.flipped}` +
            (result.flippedAtAttempt !== null ? ` at attempt ${result.flippedAtAttempt}` : '') +
            ` (${result.llmCalls} calls, ${result.attempts.filter((a) => a.executed).length} arms)`,
        )
        continue
      }

      onProgress(`${label}: generating corrected command`)
      calls += 1
      const generated = await generateFixCommand(caller, promptInput)
      if (!generated.succeeded) {
        failures += 1
        rows[index] = {
          ...row,
          fix: {
            attempted: true,
            sampledOut: false,
            command: null,
            llmError: generated.error,
            usage: null,
            armBExit: null,
            armBPrefixExecuted: null,
            armBPrefixDivergences: null,
            armBPrefixDivergencePct: null,
            failureVanished: null,
            armBError: null,
            attempts: null,
            flippedAtAttempt: null,
          },
        }
        onProgress(`${label}: LLM failed — ${generated.error.slice(0, 200)}`)
        continue
      }
      if (generated.value.usage === null || generated.value.usage === undefined) {
        callsWithoutUsage += 1
      }
      promptTokens += generated.value.usage?.promptTokens ?? 0
      completionTokens += generated.value.usage?.completionTokens ?? 0
      onProgress(`${label}: arm B — ${generated.value.command.split('\n')[0]!.slice(0, 120)}`)
      try {
        const armB = await executeArmB(
          replayCase,
          generated.value.command,
          backendFactory(row.derivedImage!),
          signature,
          stepTimeoutMs,
          options.prefixLimit,
          (message) => onProgress(`${label}: ${message}`),
        )
        rows[index] = {
          ...row,
          fix: {
            attempted: true,
            sampledOut: false,
            command: generated.value.command,
            llmError: null,
            usage: generated.value.usage,
            armBExit: armB.exitCode,
            armBPrefixExecuted: armB.prefixExecuted,
            armBPrefixDivergences: armB.prefixDivergences,
            armBPrefixDivergencePct: armB.prefixDivergencePct,
            failureVanished: armB.failureVanished,
            armBError: null,
            attempts: null,
            flippedAtAttempt: armB.failureVanished ? 1 : null,
          },
        }
        mkdirSync(caseOut, { recursive: true })
        writeFileSync(
          join(caseOut, 'armB-result.json'),
          `${JSON.stringify({ command: generated.value.command, ...armB }, null, 2)}\n`,
        )
        onProgress(`${label}: armB exit=${armB.exitCode} failureVanished=${armB.failureVanished}`)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        rows[index] = {
          ...row,
          fix: {
            attempted: true,
            sampledOut: false,
            command: generated.value.command,
            llmError: null,
            usage: generated.value.usage,
            armBExit: null,
            armBPrefixExecuted: null,
            armBPrefixDivergences: null,
            armBPrefixDivergencePct: null,
            failureVanished: null,
            armBError: message.slice(0, 500),
            attempts: null,
            flippedAtAttempt: null,
          },
        }
        onProgress(`${label}: arm B error — ${message.slice(0, 200)}`)
      }
    }
    llm = {
      model: options.fixModelLabel ?? 'unknown',
      calls,
      failures,
      promptTokens,
      completionTokens,
      callsWithoutUsage,
    }
  }

  const executedRows = rows.filter((r) => r.status === 'ok')
  const replayed = executedRows.filter((r) => r.replayed)
  const sumOver = (pick: (row: ReplayBatchCaseRow) => number | null): number =>
    executedRows.reduce((total, row) => total + (pick(row) ?? 0), 0)
  const executedSteps = sumOver((r) => r.prefixExecuted)
  const divergentSteps = sumOver((r) => r.prefixDivergences)
  const prefixFidelity = {
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
  const signatureStrict = executedRows.filter((r) => r.replayed && r.armASignatureMatch)
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
  const excludedByReason: Record<string, number> = {}
  for (const excluded of enumeration.excluded) {
    excludedByReason[excluded.reason] = (excludedByReason[excluded.reason] ?? 0) + 1
  }
  const submitGoldsByCorpus: Record<
    string,
    { submitOnlyCases: number; goldsSkippedWithinReplayable: number }
  > = {}
  const submitEntry = (corpus: string) =>
    (submitGoldsByCorpus[corpus] ??= { submitOnlyCases: 0, goldsSkippedWithinReplayable: 0 })
  for (const excluded of enumeration.excluded) {
    if (excluded.reason === 'gold-only-submit-step')
      submitEntry(excluded.corpus).submitOnlyCases += 1
  }
  for (const replayCase of enumeration.replayable) {
    if (replayCase.submitGoldsSkipped > 0) {
      submitEntry(replayCase.corpus).goldsSkippedWithinReplayable += replayCase.submitGoldsSkipped
    }
  }

  const report: ReplayBatchReport = {
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
      submitGoldsByCorpus,
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
      prefixFidelity,
      fixFlipRate:
        options.fix !== 'none'
          ? {
              numerator: flipped.length,
              denominator: armBExecuted.length,
              value: rate(flipped.length, armBExecuted.length),
            }
          : null,
      fixFlipRateNonzeroRc:
        options.fix !== 'none'
          ? {
              numerator: flippedNonzeroRc.length,
              denominator: armBNonzeroRc.length,
              value: rate(flippedNonzeroRc.length, armBNonzeroRc.length),
            }
          : null,
      fixFlipAttempt1:
        options.fix === 'loop'
          ? {
              numerator: flippedAt1.length,
              denominator: attempt1Executed.length,
              value: rate(flippedAt1.length, attempt1Executed.length),
            }
          : null,
      flipsByAttempt: options.fix === 'loop' ? flipsByAttempt : null,
    },
    llm,
    excluded: enumeration.excluded,
    pullFailures,
    cases: rows,
  }
  writeFileSync(join(options.out, 'batch-report.json'), `${JSON.stringify(report, null, 2)}\n`)
  writeFileSync(join(options.out, 'batch-report.md'), renderBatchReport(report))
  return report
}

// ── Report rendering ─────────────────────────────────────────────────

function pct(value: number | null): string {
  return value === null ? '—' : `${(value * 100).toFixed(1)}%`
}

export function renderBatchReport(report: ReplayBatchReport): string {
  const lines: string[] = []
  const { headline, totals } = report
  lines.push('# Replay-verify batch report')
  lines.push('')
  lines.push(`Generated ${report.generatedAt}.`)
  lines.push('')
  lines.push('## Headline')
  lines.push('')
  const fidelity = headline.prefixFidelity
  lines.push(
    `- **Replayability rate: ${pct(headline.replayabilityRate.value)}** ` +
      `(${headline.replayabilityRate.numerator}/${headline.replayabilityRate.denominator} replayable cases ` +
      `where the prefix replayed within ${fidelity.tolerancePct}% divergence AND arm A reproduced the recorded returncode at the gold step k).`,
  )
  lines.push(
    `- Signature-strict rate: ${pct(headline.signatureStrictRate.value)} ` +
      `(${headline.signatureStrictRate.numerator}/${headline.signatureStrictRate.denominator}; additionally requires the recorded error substring in arm A output).`,
  )
  lines.push(
    `- **Prefix divergence: ${fidelity.divergencePct === null ? '—' : `${fidelity.divergencePct}%`}** ` +
      `(${fidelity.divergentSteps}/${fidelity.executedSteps} executed prefix steps did not confirm the recording: ` +
      `${fidelity.returncodeMismatches} returncode mismatches, ${fidelity.unknownExpectations} with no recorded returncode to check). ` +
      `${fidelity.casesWithinTolerance}/${fidelity.casesExecuted} executed cases are within the ${fidelity.tolerancePct}% tolerance.`,
  )
  if (headline.fixFlipRate) {
    lines.push(
      `- **Fix-flip rate: ${pct(headline.fixFlipRate.value)}** ` +
        `(${headline.fixFlipRate.numerator}/${headline.fixFlipRate.denominator} arm-B-executed cases where the generated fix made the failure vanish).`,
    )
  }
  if (headline.fixFlipRateNonzeroRc) {
    lines.push(
      `- Fix-flip rate on recorded-rc≠0 cases: ${pct(headline.fixFlipRateNonzeroRc.value)} ` +
        `(${headline.fixFlipRateNonzeroRc.numerator}/${headline.fixFlipRateNonzeroRc.denominator}; real recorded failures — a gold step recorded with rc 0 flips vacuously).`,
    )
  }
  if (headline.fixFlipAttempt1) {
    lines.push(
      `- Fix-flip@1: ${pct(headline.fixFlipAttempt1.value)} ` +
        `(${headline.fixFlipAttempt1.numerator}/${headline.fixFlipAttempt1.denominator} cases whose attempt 1 executed — the one-shot-comparable number).`,
    )
  }
  if (headline.flipsByAttempt && Object.keys(headline.flipsByAttempt).length > 0) {
    const parts = Object.entries(headline.flipsByAttempt)
      .sort((a, b) => Number(a[0]) - Number(b[0]))
      .map(([attempt, count]) => `attempt ${attempt}: ${count}`)
    lines.push(`- Flips by attempt: ${parts.join(', ')}.`)
  }
  lines.push('')
  lines.push('## Enumeration')
  lines.push('')
  lines.push(
    `${totals.labelEntries} label entries across ${report.corpora.length} corpora → ` +
      `${totals.replayable} replayable (SWE-style docker image + ≥1 gold incorrect step), ${totals.executed} executed.`,
  )
  lines.push('')
  lines.push('| exclusion reason | count |')
  lines.push('| --- | --- |')
  for (const [reason, count] of Object.entries(totals.excludedByReason).sort(
    (a, b) => b[1] - a[1],
  )) {
    lines.push(`| ${reason} | ${count} |`)
  }
  const submitEntries = Object.entries(totals.submitGoldsByCorpus)
  if (submitEntries.length > 0) {
    lines.push('')
    lines.push(
      'Submit-command golds are never counterfactual targets ' +
        '(a gold on the submit step marks a bad submit decision, not a failed command):',
    )
    lines.push('')
    lines.push(
      '| corpus | cases excluded (all golds = submit) | golds skipped within replayable cases |',
    )
    lines.push('| --- | --- | --- |')
    for (const [corpus, stats] of submitEntries.sort((a, b) => a[0].localeCompare(b[0]))) {
      lines.push(`| ${corpus} | ${stats.submitOnlyCases} | ${stats.goldsSkippedWithinReplayable} |`)
    }
  }
  if (report.pullFailures.length > 0) {
    lines.push('')
    lines.push('## Image pull/build failures')
    lines.push('')
    lines.push('| corpus | trajectory | image | error |')
    lines.push('| --- | --- | --- | --- |')
    for (const failure of report.pullFailures) {
      lines.push(
        `| ${failure.corpus} | ${failure.trajId} | \`${failure.image}\` | ${failure.error.replaceAll('|', '\\|')} |`,
      )
    }
  }
  lines.push('')
  lines.push('## Per-case results')
  lines.push('')
  lines.push(
    '| corpus | trajectory | k | rc@k | prefix | confirmed | rc mismatch | unknown rc | div | div% | armA exit | rc match | sig match | replayed | fix | armB exit | armB div% | vanished | wall s |',
  )
  lines.push(`| ${Array(19).fill('---').join(' | ')} |`)
  for (const row of report.cases) {
    const fix = row.fix
    const fixCell = !fix
      ? '—'
      : fix.sampledOut
        ? 'sampled-out'
        : fix.llmError
          ? 'llm-failed'
          : fix.armBError
            ? 'armB-error'
            : fix.attempts
              ? fix.flippedAtAttempt !== null
                ? `flip@${fix.flippedAtAttempt}`
                : `exhausted(${fix.attempts.length})`
              : 'generated'
    lines.push(
      [
        row.corpus,
        row.trajId.length > 48 ? `${row.trajId.slice(0, 45)}…` : row.trajId,
        row.k,
        row.recordedReturncodeAtK ?? 'null',
        row.prefixExecuted ?? '—',
        row.prefixConfirmed ?? '—',
        row.prefixReturncodeMismatches ?? '—',
        row.prefixUnknownExpectations ?? '—',
        row.prefixDivergences ?? '—',
        row.prefixDivergencePct ?? '—',
        row.status === 'ok' ? row.armAExit : row.status,
        row.armAReturncodeMatch ? 'yes' : 'no',
        row.armASignatureMatch ? 'yes' : 'no',
        row.replayed ? '**yes**' : 'no',
        fixCell,
        fix?.armBExit ?? '—',
        fix?.armBPrefixDivergencePct ?? '—',
        fix?.failureVanished === null || fix === null
          ? '—'
          : fix.failureVanished
            ? '**yes**'
            : 'no',
        (row.wallMs / 1000).toFixed(1),
      ].join(' | '),
    )
  }
  if (report.llm) {
    lines.push('')
    lines.push('## LLM fix generation')
    lines.push('')
    lines.push(
      `Model ${report.llm.model}: ${report.llm.calls} calls (${report.llm.failures} failed), ` +
        `${report.llm.promptTokens} prompt + ${report.llm.completionTokens} completion tokens.`,
    )
  }
  lines.push('')
  return lines.join('\n')
}
