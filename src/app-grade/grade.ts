/**
 * Grade one running submission for one leaf: a hand-written `GradeLeaf`, or a declarative
 * task through `gradeTask` (`task.ts`), which starts the task's real product for the run.
 *
 * Order: serve, operate the journeys, run the deterministic checks, then ask SystemOne
 * only what could still move the tier (see `decidedWithoutReviews`).
 *
 * Writes the evidence bundle under --out: server.log, network.jsonl, console.jsonl,
 * forgery-attempts.jsonl, journeys/<id>/{steps.jsonl,*.aria.yml,*.png,trace.zip,…},
 * checks.json, evidence.json, integrity.json, jev/<review>.json, cost.json,
 * manifest.json and verdict.json. A task run also writes product.log, setup.jsonl,
 * product-requests.jsonl and reads.json.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { CostLedger } from '../cost-ledger'
import { packageVersion } from '../package-version'
import { EvidenceBrowser } from './browser'
import { targetPicker, type Picker } from './drive'
import { collectIntegrityEvidence, type IntegrityEvidence } from './integrity'
import type { AppGradeJudge } from './judge'
import { runReviews, type ReviewSpec } from './review'
import { serveApp } from './serve'
import { decidedWithoutReviews, deriveVerdict, type EngineeringGates, type Verdict, type VerdictCheck, type VerdictReview } from './verdict'


/** What one leaf contributes to a grading run: its journeys, its deterministic checks and its SystemOne reviews. */
export interface GradeLeaf<E extends { journeyMs: Record<string, number> }> {
  id: string
  /** Review definition version; part of every review digest. */
  reviewVersion: string
  /** Flows this grader cannot operate; any entry caps the tier below S. */
  unmeasured: readonly string[]
  /** Operate the journeys, each in its own browser context, writing evidence under `dir`. */
  runJourneys(browser: EvidenceBrowser, dir: string, url: string, pick: Picker): Promise<E>
  /** Accessibility snapshot path of the first screen, for the `serve.rendered` floor check. */
  landing(evidence: E): string | undefined
  deterministicChecks(evidence: E): VerdictCheck[]
  /**
   * SystemOne reviews over raw evidence only: what the app showed, what the grader did, and the
   * source. No deterministic check status, build gate or derived verdict reaches a model.
   */
  reviewSpecs(input: {
    evidence: E
    readCapture: (path: string) => string
    workdir: string
    integrity: IntegrityEvidence
  }): ReviewSpec[]
}

export interface GradeResult {
  verdict: Verdict
  /** Everything `deriveVerdict` read, so a stored run re-derives without the grader. */
  inputs: { served: boolean; checks: VerdictCheck[]; reviews: VerdictReview[]; engineering: EngineeringGates; unmeasured: string[] }
  checks: VerdictCheck[]
  costUsd: number
  phaseMs: Record<string, number>
}

export async function grade<E extends { journeyMs: Record<string, number> }>(input: {
  leaf: GradeLeaf<E>
  workdir: string
  engineeringPath: string
  out: string
  port: number
  judge: AppGradeJudge
  /** Environment the served app receives beyond PATH, HOME, NODE_ENV and PORT. */
  appEnv?: Record<string, string>
}): Promise<GradeResult> {
  const { judge } = input
  mkdirSync(input.out, { recursive: true })
  const { leaf } = input
  const engineering = JSON.parse(readFileSync(input.engineeringPath, 'utf8')) as { gates: EngineeringGates }
  const ledger = new CostLedger({ costCeilingUsd: 1 })
  const started = Date.now()
  const phaseMs: Record<string, number> = {}
  const served = await serveApp({ workdir: input.workdir, port: input.port, logPath: join(input.out, 'server.log'), ...(input.appEnv ? { env: input.appEnv } : {}) })
  phaseMs.serve = Date.now() - started
  writeFileSync(join(input.out, 'served.json'), JSON.stringify(served.attestation, null, 1))
  let browser: EvidenceBrowser | null = null
  try {
    const checks: VerdictCheck[] = [
      { id: 'serve.ready', gate: 'floor', status: served.attestation.readyAfterMs !== null ? 'pass' : 'fail', detail: `last HTTP status ${served.attestation.lastStatus}` },
      {
        id: 'serve.attested',
        gate: 'floor',
        status: served.attestation.portOwnerIsChild && !served.attestation.isScaffoldPreview ? 'pass' : 'fail',
        detail: `port owner: ${served.attestation.portOwnerCommand ?? 'none'} (pid ${served.attestation.portOwnerPid}, ${served.attestation.portOwnerIsChild ? 'spawned by this run' : 'not spawned by this run'})`,
      },
    ]
    const pick = targetPicker({ judge, costLedger: ledger })
    const readCapture = (path: string) => readFileSync(join(input.out, path), 'utf8')
    let evidence: E | null = null
    if (served.attestation.readyAfterMs !== null) {
      const journeysStarted = Date.now()
      browser = await EvidenceBrowser.launch()
      evidence = await leaf.runJourneys(browser, input.out, served.url, pick)
      phaseMs.journeys = Date.now() - journeysStarted
      const landingPath = leaf.landing(evidence)
      const landing = landingPath ? readCapture(landingPath) : 'ARIA_UNAVAILABLE: no landing capture'
      checks.push({
        id: 'serve.rendered',
        gate: 'floor',
        status: !landing.startsWith('ARIA_UNAVAILABLE') && /- (button|heading|link|textbox|searchbox|list|table)/.test(landing) ? 'pass' : 'fail',
        detail: `landing accessibility snapshot: ${landing.length} chars`,
      })
      checks.push(...leaf.deterministicChecks(evidence))
    }
    const integrity = evidence
      ? collectIntegrityEvidence({ workdir: input.workdir, runDir: input.out, appOrigin: new URL(served.url).origin, graderUserAgent: browser?.userAgent ?? null })
      : null
    if (integrity) {
      const probes = integrity.automationProbes
      checks.push({
        id: 'integrity.noAutomationProbe',
        gate: 'integrity',
        status: probes.length === 0 ? 'pass' : 'fail',
        detail: probes.length === 0 ? 'no app source probes for an automated browser' : probes.slice(0, 5).map((probe) => `${probe.file}:${probe.line} ${probe.excerpt}`).join('; '),
      })
      writeFileSync(join(input.out, 'integrity.json'), JSON.stringify({ automationProbes: probes, candidates: integrity.candidates, counts: integrity.counts }, null, 1))
    }
    const servedOk = checks.filter((check) => check.id.startsWith('serve.')).every((check) => check.status === 'pass')
    writeFileSync(join(input.out, 'checks.json'), JSON.stringify(checks, null, 1))
    writeFileSync(join(input.out, 'evidence.json'), JSON.stringify(evidence, null, 1))

    const reviewsStarted = Date.now()
    const decided = decidedWithoutReviews({ served: servedOk, checks })
    const specs = evidence && integrity ? leaf.reviewSpecs({ evidence, readCapture, workdir: input.workdir, integrity }) : []
    // With no test files the build gate already caps the tier at B; whether tests exercise
    // the product has one answer, so asking a model adds cost and variance, not information.
    const answerable = specs.filter((spec) => !(spec.id === 'engineering' && engineering.gates.tests === 'absent'))
    // A decided tier leaves only integrity questions worth asking, and only when the scan found a candidate.
    const asksIntegrity = (spec: ReviewSpec) => Object.values(spec.tierRole).includes('integrity')
    const asked = decided === null ? answerable : answerable.filter((spec) => asksIntegrity(spec) && integrity!.candidates.length > 0)
    const reviews = await runReviews({
      specs: asked,
      version: leaf.reviewVersion,
      judge,
      costLedger: ledger,
      dir: join(input.out, 'jev'),
    })
    phaseMs.reviews = Date.now() - reviewsStarted
    const inputs: GradeResult['inputs'] = {
      served: servedOk,
      checks,
      reviews: reviews.map((review) => ({ id: review.id, tierRole: review.tierRole, assessments: review.report.assessments })),
      engineering: engineering.gates,
      unmeasured: [...leaf.unmeasured],
    }
    const verdict = deriveVerdict(inputs)
    const cost = { summary: ledger.summary(), receipts: ledger.list() }
    writeFileSync(join(input.out, 'cost.json'), JSON.stringify(cost, null, 1))
    phaseMs.total = Date.now() - started
    const manifest = {
      leaf: leaf.id,
      grader: { package: '@tangle-network/agent-eval', version: packageVersion() },
      browserUserAgent: browser?.userAgent ?? null,
      workdir: input.workdir,
      started: new Date(started).toISOString(),
      finished: new Date().toISOString(),
      phaseMs,
      journeyMs: evidence?.journeyMs ?? null,
      model: judge.ref,
      via: judge.client.transport,
      decidedWithoutReviews: decided,
      reviewsAsked: asked.map((spec) => spec.id),
      reviewsSkipped: specs.filter((spec) => !asked.includes(spec)).map((spec) => spec.id),
      picker: pick.stats,
      servedModels: [...new Set(reviews.map((review) => review.report.servedModel))],
      reviewDigests: Object.fromEntries(reviews.map((review) => [review.id, review.report.reviewDigest])),
      costUsd: cost.summary.totalCostUsd,
      toolCalls: [...pick.stats.toolCalls, ...reviews.flatMap((review) => (review.raw as { transport?: { toolCalls?: string[] } }).transport?.toolCalls ?? [])],
    }
    writeFileSync(join(input.out, 'manifest.json'), JSON.stringify(manifest, null, 1))
    writeFileSync(join(input.out, 'verdict.json'), JSON.stringify({ ...verdict, engineering: engineering.gates, served: inputs.served }, null, 1))
    return { verdict, inputs, checks, costUsd: cost.summary.totalCostUsd, phaseMs }
  } catch (error) {
    // A grading that throws already paid for the picks and reviews it made. Its
    // caller retries the cell, so the spend rides on the error and in cost.json.
    const summary = ledger.summary()
    writeFileSync(join(input.out, 'cost.json'), JSON.stringify({ summary, receipts: ledger.list() }, null, 1))
    throw Object.assign(error instanceof Error ? error : new Error(String(error)), {
      costUsd: summary.totalCostUsd, inputTokens: summary.inputTokens, outputTokens: summary.outputTokens,
    })
  } finally {
    await browser?.close()
    await served.stop()
  }
}
