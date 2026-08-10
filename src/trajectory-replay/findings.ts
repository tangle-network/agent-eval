/**
 * Proof-carrying findings: execute analyst findings as replays.
 *
 * An analyst finding is a cited claim ("step 12 is where the run went
 * wrong"). This module turns each finding into an executed verdict by
 * replaying the trajectory prefix and running the accused step (arm A),
 * optionally followed by a corrected step (arm B):
 *
 *   `reproduced`     arm A re-produced the recorded failure signature
 *                    (returncode + stable output substring).
 *   `fix-flipped`    arm A reproduced AND arm B's corrected command made the
 *                    failure vanish — the strongest per-finding proof.
 *   `divergent`      arm A executed but the recorded failure did NOT
 *                    reproduce; evidence against the finding (or against
 *                    replay fidelity — the receipt carries prefix
 *                    divergences so the reader can tell which).
 *   `not-replayable` the finding could not be executed at all; the receipt
 *                    carries the precise reason (no step subject, unknown
 *                    trajectory, no recorded image, submit step, …).
 *
 * Verification is execution, not generation: no LLM is involved unless the
 * caller supplies a corrected command for arm B. A caller whose execution
 * environment must be reachable before proofs run passes `preflight`, which
 * fails loud instead of letting verification skip silently.
 *
 * Findings are matched by the shape the analyst product emits
 * (`AnalystFinding`): `subject` (`incorrect-step-<n>` or the wire's
 * `incorrect-steps-<f>-<l>-<escaped|unescaped>-consequence-<c>`),
 * `metadata.block_first_step`, and `trace://<traj>/…` evidence refs.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type CorpusSpec, resolveCaseResources } from './corpus'
import type { ReplayExecBackendFactory } from './exec'
import { dockerImagePreparer, type ImagePreparer } from './image-preparer'
import { isSubmitAction, parseRecordedReturncode, type RecordedTrajectoryStep } from './steps'
import { type ReplayVerdict, replayVerify } from './verify'
import { parseIncorrectStepsSubject } from './wire'

// ── Finding shape (structural subset of the analyst's AnalystFinding) ─

export interface VerifiableFinding {
  readonly finding_id?: string
  readonly analyst_id?: string
  readonly subject?: string
  readonly area?: string
  readonly claim?: string
  readonly evidence_refs?: readonly {
    readonly kind?: string
    readonly uri?: string
    readonly excerpt?: string
  }[]
  readonly metadata?: Readonly<Record<string, unknown>>
}

const SINGLE_STEP_SUBJECT = /^incorrect-step-(\d+)$/

/**
 * 1-based step the finding accuses, or null when the finding names none.
 * `metadata.block_first_step` wins over the subject: the analyst records the
 * block's first incorrect step there even when the subject names a later
 * step of the same block.
 */
export function findingReplayStep(finding: VerifiableFinding): number | null {
  const fromMetadata = finding.metadata?.block_first_step
  if (typeof fromMetadata === 'number' && Number.isInteger(fromMetadata) && fromMetadata >= 1) {
    return fromMetadata
  }
  const subject = finding.subject ?? ''
  const wire = parseIncorrectStepsSubject(subject)
  if (wire) return wire.firstStep
  const single = SINGLE_STEP_SUBJECT.exec(subject)
  if (single) return Number(single[1])
  return null
}

const TRACE_EVIDENCE_URI = /^trace:\/\/([^/]+)\//

/** Trajectory id from the finding's `trace://<traj>/…` evidence refs, or null. */
export function findingTrajectoryId(finding: VerifiableFinding): string | null {
  for (const ref of finding.evidence_refs ?? []) {
    if (typeof ref.uri !== 'string') continue
    const match = TRACE_EVIDENCE_URI.exec(ref.uri)
    if (match) return match[1]!
  }
  return null
}

// ── Replay source ────────────────────────────────────────────────────

/**
 * Where the executable trajectory lives.
 * `direct` — one trajectory's steps.json plus a replay-ready image; the
 *   caller owns image preparation.
 * `corpus` — labeled trajectory corpora; each finding's trajectory is
 *   resolved by its `trace://` evidence and the image is derived through
 *   `preparer` (the docker uid-1000 preparer unless overridden; `null` when
 *   the images are already replay-ready).
 */
export type FindingReplaySource =
  | {
      readonly kind: 'direct'
      readonly stepsPath: string
      readonly image: string
      readonly cwd: string
      readonly caseId?: string
    }
  | {
      readonly kind: 'corpus'
      readonly corpora: readonly CorpusSpec[]
      readonly preparer?: ImagePreparer | null
    }

export interface ResolvedFindingReplay {
  readonly caseId: string
  readonly stepsPath: string
  /** Raw image; corpus-mode execution derives the replay image from it. */
  readonly image: string
  readonly cwd: string
  /** 1-based step_id arm A executes. */
  readonly at: number
  readonly recordedReturncode: number
  readonly recordedStepTimeoutMs: number | null
}

export type FindingReplayability =
  | { readonly replayable: true; readonly resolved: ResolvedFindingReplay }
  | { readonly replayable: false; readonly reason: string }

function checkStep(
  steps: readonly RecordedTrajectoryStep[],
  at: number,
):
  | { readonly ok: true; readonly recordedReturncode: number }
  | { readonly ok: false; readonly reason: string } {
  const step = steps.find((s) => s.step_id === at)
  if (!step) {
    return { ok: false, reason: `step ${at} is outside the trajectory (${steps.length} steps)` }
  }
  if (isSubmitAction(step.action)) {
    return {
      ok: false,
      reason: `step ${at} is the submit action — a submit decision has no executable failure to replay`,
    }
  }
  const recordedReturncode = parseRecordedReturncode(step.observation)
  if (recordedReturncode === null) {
    return {
      ok: false,
      reason: `step ${at} recorded no returncode — there is no executable failure signature to reproduce`,
    }
  }
  return { ok: true, recordedReturncode }
}

/**
 * Decides whether one finding can be executed against the source, and with
 * what invocation. Never throws for a finding-shaped problem — every dead end
 * becomes a `not-replayable` reason the receipt can carry verbatim.
 */
export function resolveFindingReplayability(
  finding: VerifiableFinding,
  source: FindingReplaySource,
): FindingReplayability {
  const at = findingReplayStep(finding)
  if (at === null) {
    return {
      replayable: false,
      reason:
        `subject '${finding.subject ?? '(none)'}' names no trajectory step ` +
        '(expected incorrect-step-<n>, incorrect-steps-<f>-<l>-…, or metadata.block_first_step)',
    }
  }
  if (source.kind === 'direct') {
    const trajId = findingTrajectoryId(finding)
    if (trajId && source.caseId && trajId !== source.caseId) {
      return {
        replayable: false,
        reason: `finding cites trajectory '${trajId}' but the supplied steps are case '${source.caseId}'`,
      }
    }
    let steps: RecordedTrajectoryStep[]
    try {
      steps = JSON.parse(readFileSync(source.stepsPath, 'utf8')) as RecordedTrajectoryStep[]
    } catch (err) {
      throw new Error(
        `verify-findings: cannot read steps file ${source.stepsPath} — ${err instanceof Error ? err.message : String(err)}`,
      )
    }
    if (!Array.isArray(steps) || steps.length === 0) {
      throw new Error(`verify-findings: ${source.stepsPath} is not a non-empty steps array`)
    }
    const step = checkStep(steps, at)
    if (!step.ok) return { replayable: false, reason: step.reason }
    return {
      replayable: true,
      resolved: {
        caseId: source.caseId ?? trajId ?? source.stepsPath,
        stepsPath: source.stepsPath,
        image: source.image,
        cwd: source.cwd,
        at,
        recordedReturncode: step.recordedReturncode,
        recordedStepTimeoutMs: null,
      },
    }
  }
  const trajId = findingTrajectoryId(finding)
  if (!trajId) {
    return {
      replayable: false,
      reason: 'finding carries no trace://<trajectory>/ evidence ref naming its trajectory',
    }
  }
  const failures: string[] = []
  for (const corpus of source.corpora) {
    const resolution = resolveCaseResources(corpus, trajId)
    if (!resolution.resolved) {
      failures.push(
        `${corpus.name}: ${resolution.reason}${resolution.detail ? ` (${resolution.detail})` : ''}`,
      )
      continue
    }
    const step = checkStep(resolution.resources.steps, at)
    if (!step.ok) return { replayable: false, reason: step.reason }
    return {
      replayable: true,
      resolved: {
        caseId: trajId,
        stepsPath: resolution.resources.stepsPath,
        image: resolution.resources.image,
        cwd: resolution.resources.cwd,
        at,
        recordedReturncode: step.recordedReturncode,
        recordedStepTimeoutMs: resolution.resources.recordedStepTimeoutMs,
      },
    }
  }
  return {
    replayable: false,
    reason: `trajectory ${trajId} is not replayable in any corpus — ${failures.join('; ')}`,
  }
}

// ── Verification run ─────────────────────────────────────────────────

export type FindingVerificationStatus =
  | 'reproduced'
  | 'fix-flipped'
  | 'not-replayable'
  | 'divergent'

export interface FindingVerification {
  readonly finding_id: string | null
  readonly subject: string | null
  readonly trajectory_id: string | null
  /** 1-based step the proof executed at; null when not replayable. */
  readonly step: number | null
  readonly verified: FindingVerificationStatus
  /** Present exactly when `verified` is `not-replayable`. */
  readonly reason: string | null
  /** Receipt directory: receipt.json plus, when executed, replay-verdict.json + report.md. */
  readonly receipt: string
  readonly verdict_path: string | null
  /** Receipt dir of the executed proof this finding shares (same case, step, and fix). */
  readonly deduplicated_with: string | null
}

export interface VerifyFindingsRun {
  readonly out: string
  readonly verifications: readonly FindingVerification[]
  readonly counts: Readonly<Record<FindingVerificationStatus, number>>
  /** Executions actually performed (deduplicated proofs count once). */
  readonly executions: number
}

export interface VerifyFindingsOptions {
  readonly source: FindingReplaySource
  /** Receipt root; one subdirectory per finding plus verifications.json. */
  readonly out: string
  /** Corrected command for arm B on every executed finding; omit for arm A only. */
  readonly fixCommand?: string
  readonly stepTimeoutMs?: number
  readonly prefixLimit?: number
  /** Builds the exec backend for a finding's replay image. */
  readonly backendFactory: ReplayExecBackendFactory
  /** Runs once before the first proof, only when some finding is replayable.
   *  Throw to refuse execution against absent or degraded infrastructure. */
  readonly preflight?: () => Promise<void>
  readonly onProgress?: (message: string) => void
}

/** Arm A reproduced → the fix flipping it beats plain reproduction; anything else diverged. */
export function classifyVerdict(verdict: ReplayVerdict): FindingVerificationStatus {
  if (!verdict.armA.failureSignatureMatch) return 'divergent'
  if (verdict.armB?.failureVanished) return 'fix-flipped'
  return 'reproduced'
}

interface ReceiptExecution {
  readonly image: string
  readonly cwd: string
  readonly recordedReturncode: number | null
  readonly signature: string | null
  readonly signatureBasis: string
  readonly armA: {
    readonly command: string
    readonly exitCode: number
    readonly wallMs: number
    readonly failureSignatureMatch: boolean
  }
  readonly armB: {
    readonly command: string
    readonly exitCode: number
    readonly wallMs: number
    readonly failureVanished: boolean
  } | null
  readonly prefixExecuted: number
  readonly prefixDivergences: number
  readonly totalMs: number
}

function receiptExecution(verdict: ReplayVerdict): ReceiptExecution {
  return {
    image: verdict.image,
    cwd: verdict.cwd,
    recordedReturncode: verdict.recordedReturncode,
    signature: verdict.signature,
    signatureBasis: verdict.signatureBasis,
    armA: {
      command: verdict.armA.command,
      exitCode: verdict.armA.exitCode,
      wallMs: verdict.armA.wallMs,
      failureSignatureMatch: verdict.armA.failureSignatureMatch,
    },
    armB: verdict.armB
      ? {
          command: verdict.armB.command,
          exitCode: verdict.armB.exitCode,
          wallMs: verdict.armB.wallMs,
          failureVanished: verdict.armB.failureVanished,
        }
      : null,
    prefixExecuted: verdict.prefixExecuted,
    prefixDivergences: verdict.prefixDivergences.length,
    totalMs: verdict.timings.totalMs,
  }
}

function writeReceipt(
  receiptDir: string,
  finding: VerifiableFinding,
  verification: FindingVerification,
  execution: ReceiptExecution | null,
): void {
  const receipt = {
    schema_version: '1.0.0',
    produced_at: new Date().toISOString(),
    finding_id: verification.finding_id,
    analyst_id: finding.analyst_id ?? null,
    subject: verification.subject,
    claim: typeof finding.claim === 'string' ? finding.claim.slice(0, 600) : null,
    trajectory_id: verification.trajectory_id,
    step: verification.step,
    verified: verification.verified,
    reason: verification.reason,
    execution,
    verdict_path: verification.verdict_path,
    deduplicated_with: verification.deduplicated_with,
  }
  writeFileSync(join(receiptDir, 'receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`)
}

function receiptDirName(index: number, finding: VerifiableFinding): string {
  const id =
    typeof finding.finding_id === 'string' && finding.finding_id.length > 0
      ? finding.finding_id.replace(/[^A-Za-z0-9_-]/g, '_')
      : 'finding'
  return `${String(index + 1).padStart(3, '0')}-${id}`
}

/**
 * Verifies every finding against the source: resolves replayability, executes
 * one proof per distinct (case, step, fix) — findings accusing the same step
 * share the executed proof — and writes a receipt directory per finding plus a
 * run-level verifications.json.
 */
export async function verifyFindings(
  findings: readonly VerifiableFinding[],
  options: VerifyFindingsOptions,
): Promise<VerifyFindingsRun> {
  if (findings.length === 0) throw new Error('verify-findings: no findings to verify')
  mkdirSync(options.out, { recursive: true })
  const resolutions = findings.map((finding) =>
    resolveFindingReplayability(finding, options.source),
  )
  if (resolutions.some((resolution) => resolution.replayable) && options.preflight) {
    await options.preflight()
  }

  // `null` is the caller asserting the corpus images are already replay-ready;
  // only an ABSENT field falls back to the docker preparer.
  const preparer =
    options.source.kind === 'corpus'
      ? options.source.preparer === undefined
        ? dockerImagePreparer()
        : options.source.preparer
      : null
  const preparedImages = new Map<
    string,
    | { readonly succeeded: true; readonly image: string }
    | { readonly succeeded: false; readonly error: string }
  >()
  const executedByKey = new Map<string, FindingVerification>()
  const verifications: FindingVerification[] = []
  let executions = 0

  for (let index = 0; index < findings.length; index++) {
    const finding = findings[index]!
    const resolution = resolutions[index]!
    const receiptDir = join(options.out, receiptDirName(index, finding))
    mkdirSync(receiptDir, { recursive: true })
    const identity = {
      finding_id: finding.finding_id ?? null,
      subject: finding.subject ?? null,
      trajectory_id: findingTrajectoryId(finding),
    }

    if (!resolution.replayable) {
      const verification: FindingVerification = {
        ...identity,
        step: findingReplayStep(finding),
        verified: 'not-replayable',
        reason: resolution.reason,
        receipt: receiptDir,
        verdict_path: null,
        deduplicated_with: null,
      }
      writeReceipt(receiptDir, finding, verification, null)
      verifications.push(verification)
      options.onProgress?.(
        `${identity.finding_id ?? `finding ${index + 1}`}: not-replayable — ${resolution.reason}`,
      )
      continue
    }

    const resolved = resolution.resolved
    const dedupeKey = `${resolved.caseId}::${resolved.at}::${options.fixCommand ?? ''}`
    const prior = executedByKey.get(dedupeKey)
    if (prior) {
      const verification: FindingVerification = {
        ...identity,
        step: resolved.at,
        verified: prior.verified,
        reason: prior.reason,
        receipt: receiptDir,
        verdict_path: prior.verdict_path,
        deduplicated_with: prior.receipt,
      }
      const priorVerdict = prior.verdict_path
        ? (JSON.parse(readFileSync(prior.verdict_path, 'utf8')) as ReplayVerdict)
        : null
      writeReceipt(
        receiptDir,
        finding,
        verification,
        priorVerdict ? receiptExecution(priorVerdict) : null,
      )
      verifications.push(verification)
      options.onProgress?.(
        `${identity.finding_id ?? `finding ${index + 1}`}: ${prior.verified} (shares proof with ${prior.finding_id ?? prior.receipt})`,
      )
      continue
    }

    let image = resolved.image
    if (preparer) {
      const preparationKey = `${resolved.image}::${resolved.cwd}`
      let preparation = preparedImages.get(preparationKey)
      if (!preparation) {
        const ensured = await preparer.ensure(resolved.image, resolved.cwd)
        preparation = ensured.succeeded
          ? { succeeded: true, image: ensured.value.derivedImage }
          : { succeeded: false, error: ensured.error }
        preparedImages.set(preparationKey, preparation)
      }
      if (!preparation.succeeded) {
        const verification: FindingVerification = {
          ...identity,
          step: resolved.at,
          verified: 'not-replayable',
          reason: `replay image could not be prepared — ${preparation.error}`,
          receipt: receiptDir,
          verdict_path: null,
          deduplicated_with: null,
        }
        writeReceipt(receiptDir, finding, verification, null)
        verifications.push(verification)
        options.onProgress?.(
          `${identity.finding_id ?? `finding ${index + 1}`}: not-replayable — image preparation failed`,
        )
        continue
      }
      image = preparation.image
    }

    options.onProgress?.(
      `${identity.finding_id ?? `finding ${index + 1}`}: executing arm A at step ${resolved.at} of ${resolved.caseId} on ${image}`,
    )
    const verdict = await replayVerify({
      stepsPath: resolved.stepsPath,
      image,
      at: resolved.at,
      fixCommand: options.fixCommand,
      cwd: resolved.cwd,
      out: receiptDir,
      caseId: resolved.caseId,
      stepTimeoutMs: options.stepTimeoutMs ?? resolved.recordedStepTimeoutMs ?? undefined,
      prefixLimit: options.prefixLimit,
      backend: options.backendFactory(image),
      onProgress: options.onProgress,
    })
    executions += 1
    const verification: FindingVerification = {
      ...identity,
      step: resolved.at,
      verified: classifyVerdict(verdict),
      reason: null,
      receipt: receiptDir,
      verdict_path: join(receiptDir, 'replay-verdict.json'),
      deduplicated_with: null,
    }
    executedByKey.set(dedupeKey, verification)
    writeReceipt(receiptDir, finding, verification, receiptExecution(verdict))
    verifications.push(verification)
    options.onProgress?.(
      `${identity.finding_id ?? `finding ${index + 1}`}: ${verification.verified}`,
    )
  }

  const counts: Record<FindingVerificationStatus, number> = {
    reproduced: 0,
    'fix-flipped': 0,
    divergent: 0,
    'not-replayable': 0,
  }
  for (const verification of verifications) counts[verification.verified] += 1
  const run: VerifyFindingsRun = { out: options.out, verifications, counts, executions }
  writeFileSync(
    join(options.out, 'verifications.json'),
    `${JSON.stringify({ schema_version: '1.0.0', ...run }, null, 2)}\n`,
  )
  return run
}

// ── Report rendering ─────────────────────────────────────────────────

function verdictCell(verification: FindingVerification): string {
  switch (verification.verified) {
    case 'reproduced':
      return '**VERIFIED** — reproduced'
    case 'fix-flipped':
      return '**VERIFIED** — fix-flipped'
    case 'divergent':
      return 'DIVERGENT — recorded failure did not reproduce'
    case 'not-replayable':
      return `UNVERIFIABLE — ${verification.reason ?? 'no reason recorded'}`
  }
}

/** Markdown section an analysis report appends when finding verification ran. */
export function renderVerifiedFindingsSection(run: VerifyFindingsRun): string {
  const lines: string[] = ['## Verified findings (executed replay)', '']
  const total = run.verifications.length
  lines.push(
    `${total} finding(s) → ${run.counts.reproduced} reproduced, ${run.counts['fix-flipped']} fix-flipped, ` +
      `${run.counts.divergent} divergent, ${run.counts['not-replayable']} not replayable ` +
      `(${run.executions} execution(s); findings accusing the same step share one proof).`,
  )
  lines.push('')
  lines.push('| Finding | Subject | Step | Verdict | Receipt |')
  lines.push('|---|---|---:|---|---|')
  for (const verification of run.verifications) {
    const shared = verification.deduplicated_with ? ' (shared proof)' : ''
    lines.push(
      `| \`${verification.finding_id ?? '—'}\` | \`${verification.subject ?? '—'}\` | ` +
        `${verification.step ?? '—'} | ${verdictCell(verification)} | \`${verification.receipt}\`${shared} |`,
    )
  }
  lines.push('')
  lines.push(
    'VERIFIED = the accused step was re-executed after replaying the trajectory prefix, and the recorded ' +
      'failure signature reproduced (fix-flipped: a corrected command additionally made it vanish). Each receipt ' +
      'directory carries receipt.json and, when executed, replay-verdict.json + report.md with real stdout/stderr.',
  )
  lines.push('')
  return lines.join('\n')
}

// ── Findings file loading ────────────────────────────────────────────

/**
 * Accepts the two shapes findings travel in: a bare JSON array of analyst
 * findings, or an object with a `findings` array (e.g. an extracted
 * `observations[n]` from a result.json).
 */
export function readFindingsFile(path: string): VerifiableFinding[] {
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
  const array = Array.isArray(parsed)
    ? parsed
    : parsed &&
        typeof parsed === 'object' &&
        Array.isArray((parsed as { findings?: unknown }).findings)
      ? (parsed as { findings: unknown[] }).findings
      : null
  if (!array) {
    throw new Error(`${path} is neither a findings array nor an object with a findings array`)
  }
  for (const entry of array) {
    if (!entry || typeof entry !== 'object') {
      throw new Error(`${path}: every finding must be an object, got ${JSON.stringify(entry)}`)
    }
  }
  return array as VerifiableFinding[]
}
