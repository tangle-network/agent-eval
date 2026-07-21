/**
 * Loop provenance — the durable, queryable record of WHAT a self-improvement
 * loop did and WHY, plus the OTel spans that let an OTLP collector pivot from
 * an eval-run to the underlying candidate→cell→gate→promote chain.
 *
 * Two artifacts, one source of truth:
 *
 *   1. `LoopProvenanceRecord` — a structured JSON record capturing every
 *      candidate (surfaceHash + label + rationale + structured cause), its measured composite,
 *      the gate decision + reasons + delta, the held-out lift, the explicit
 *      baseline→candidate diff, and BACKEND PROVENANCE (the
 *      `assertRealBackend` verdict + worker call count + model). This is the
 *      ingestable audit artifact: the +lift recomputes from it, the "because
 *      Z" rationale survives in it, and a stub backend is detectable from it.
 *
 *   2. `loopProvenanceSpans()` — the same chain emitted as OTLP-ingestable
 *      `TraceSpanEvent`s, pivoted on the substrate's standard
 *      `tangle.runId` / `tangle.scenarioId` / `tangle.cellId` /
 *      `tangle.generation` attributes (the same pivots `/adapters/otel`
 *      reads). The hosted `/v1/ingest/traces` endpoint receives the FULL loop,
 *      not just the `cost.*` spans `runCampaign` already emits per cell.
 *
 * The record is built from the loop result and its settled cost receipts — no
 * second usage collector can contradict what the measured cells recorded.
 */

import { createHash } from 'node:crypto'
import { join } from 'node:path'
import {
  type PolicyEditCandidateRecord,
  validatePolicyEditCandidateRecord,
} from '../analyst/policy-edit'
import type { CostReceipt } from '../cost-ledger'
import type { HostedClient } from '../hosted/client'
import type {
  EvalRunCellScore,
  EvalRunEvent,
  EvalRunGenerationSnapshot,
  TraceSpanEvent,
} from '../hosted/types'
import { summarizeAgentReceiptIntegrity } from '../integrity/backend-integrity'
import { canonicalJson, contentHash } from '../verdict-cache'
import { assertCampaignSplitIdentity } from './coverage'
import type { RunImprovementLoopResult } from './presets/run-improvement-loop'
import { campaignMeanComposite } from './score-utils'
import type { CampaignStorage } from './storage'
import { renderSurfaceDiff, surfaceContentHash, surfaceHash } from './surface-identity'
import type {
  CampaignResult,
  GateDecision,
  GateResult,
  GenerationCandidate,
  MutableSurface,
  Scenario,
} from './types'

export interface LoopProvenanceCandidate {
  /** Generation index this candidate was proposed in. */
  generation: number
  /** 16-char loop-identity fingerprint (matches `GenerationCandidate.surfaceHash`). */
  surfaceHash: string
  /** Full sha256 content hash — byte-identical-verifiable. */
  contentHash: string
  /** Exact scored rows that produced this candidate's search result. */
  campaignDigest: `sha256:${string}`
  /** Proposer label, when the proposer returned a `ProposedCandidate`. */
  label?: string
  /** Proposer rationale — the "because Z". When the proposer returned a bare
   *  surface (blind mutator) this is absent. */
  rationale?: string
  /** Exact validated cause when the proposer emitted a structured record. */
  candidateRecord?: PolicyEditCandidateRecord
  /** Exact complete incumbent this candidate mutated. */
  parentSurfaceHash: string
  /** Search-split composite of the exact parent. */
  parentComposite: number
  /** Search-split composite change relative to the exact parent. */
  observedDeltaFromParent?: number
  /** Whether the candidate completed every designed cell and could be selected. */
  eligibleForPromotion: boolean
  /** Designed-denominator receipt retained even for incomplete candidates. */
  coverage: NonNullable<GenerationCandidate['coverage']>
  /** Mean composite this candidate scored on the search split. */
  composite: number
  /** Whether this candidate was promoted out of its generation. */
  promoted: boolean
}

export interface LoopProvenanceBackend {
  /** `assertRealBackend`-grade verdict over the worker call records. */
  verdict: 'real' | 'mixed' | 'stub'
  /** Number of worker LLM calls captured (the audit's "worker call count"). */
  workerCallCount: number
  /** Distinct model ids observed across worker calls. */
  models: string[]
  totalInputTokens: number
  totalOutputTokens: number
  totalCostUsd: number
}

export interface LoopProvenanceEvidence {
  search: {
    splitDigest: `sha256:${string}`
    baselineCampaignDigest: `sha256:${string}`
  }
  holdout: {
    splitDigest: `sha256:${string}`
    baselineCampaignDigest: `sha256:${string}`
    winnerCampaignDigest: `sha256:${string}`
    neutralized?: {
      contentHash: `sha256:${string}`
      campaignDigest: `sha256:${string}`
      composite: number
      lift: number
    }
  }
  costReceiptsDigest: `sha256:${string}`
}

/**
 * The durable provenance record. Aligns to the hosted `EvalRunEvent` path but
 * ADDS the rationale + the explicit baseline→candidate diff (both omitted from
 * the bare hosted event) + backend provenance.
 */
export interface LoopProvenanceRecord {
  schema: 'tangle.loop-provenance'
  /** SHA-256 over the canonical record with this field omitted. */
  recordDigest: `sha256:${string}`
  runId: string
  runDir: string
  timestamp: string
  /** Baseline + winner surface content hashes — distinguishable, byte-verifiable. */
  baselineContentHash: string
  winnerContentHash: string
  /** Proposer label/rationale for the promoted change. Absent ⇒ winner == baseline. */
  winnerLabel?: string
  winnerRationale?: string
  /** The explicit baseline→winner unified diff the gate decided on. */
  diff: string
  /** Every candidate across every generation, with its rationale and structured cause. */
  candidates: LoopProvenanceCandidate[]
  /** Exact campaign, split, surface, and receipt identities behind every summary. */
  evidence: LoopProvenanceEvidence
  /** Baseline composite on the search split that generated the candidates. */
  baselineSearchComposite: number
  /** The gate verdict — decision + reasons + contributing gates + delta. */
  gate: {
    decision: GateDecision
    reasons: string[]
    delta?: number
    contributingGates: Array<{ name: string; passed: boolean; detail: unknown }>
  }
  /** Present iff the loop ran with `holdout: 'deferred'` — the held-out
   *  comparison was intentionally not measured in this run, so the holdout
   *  composites and `heldOutLift` are ABSENT rather than recorded as a
   *  meaningless 0. */
  holdout?: 'deferred'
  /** baseline-on-holdout composite mean. Absent when `holdout === 'deferred'`. */
  baselineHoldoutComposite?: number
  /** winner-on-holdout composite mean. Absent when `holdout === 'deferred'`. */
  winnerHoldoutComposite?: number
  /** winnerHoldout - baselineHoldout — RECOMPUTABLE from this record. Absent
   *  when `holdout === 'deferred'` (no held-out measurement ran). */
  heldOutLift?: number
  /** Backend provenance: stub-vs-real verdict + worker call count + models. */
  backend: LoopProvenanceBackend
  totalCostUsd: number
  totalDurationMs: number
}

export interface BuildLoopProvenanceArgs<TArtifact, TScenario extends Scenario> {
  runId: string
  runDir: string
  timestamp: string
  baselineSurface: MutableSurface
  winnerSurface: MutableSurface
  winnerLabel?: string
  winnerRationale?: string
  /** Exact baseline campaign on the search split. */
  baselineSearchCampaign: CampaignResult<TArtifact, TScenario>
  /** Per-generation candidate records straight off the loop result. */
  generations: Array<{
    generationIndex: number
    candidates: GenerationCandidate[]
    promoted: string[]
    /** Surfaces measured this generation, keyed by surface hash so the content
     *  hash can be computed and the loop identity rechecked from real bytes. */
    surfaces: Array<{
      surfaceHash: string
      surface: MutableSurface
      campaign: CampaignResult<TArtifact, TScenario>
    }>
  }>
  gate: GateResult
  /** Holdout policy the loop ran with. `'deferred'` ⇒ the holdout campaigns
   *  below are the shared empty campaign and the record omits the holdout
   *  composites + `heldOutLift`. Default `'measured'`. */
  holdout?: 'measured' | 'deferred'
  baselineOnHoldout: CampaignResult<TArtifact, TScenario>
  winnerOnHoldout: CampaignResult<TArtifact, TScenario>
  neutralizedSurface?: MutableSurface
  neutralizedOnHoldout?: CampaignResult<TArtifact, TScenario>
  /** Settled run-wide receipts — agent calls are the source for backend provenance. */
  costReceipts: ReadonlyArray<CostReceipt>
  totalCostUsd: number
  totalDurationMs: number
}

export interface LoopProvenanceArgsFromResult<TArtifact, TScenario extends Scenario> {
  runId: string
  runDir: string
  timestamp: string
  baselineSurface: MutableSurface
  result: RunImprovementLoopResult<TArtifact, TScenario>
  costReceipts: ReadonlyArray<CostReceipt>
  totalCostUsd: number
  totalDurationMs: number
}

/** One translation from a completed improvement loop into durable evidence. */
export function loopProvenanceArgsFromResult<TArtifact, TScenario extends Scenario>(
  input: LoopProvenanceArgsFromResult<TArtifact, TScenario>,
): BuildLoopProvenanceArgs<TArtifact, TScenario> {
  const { result } = input
  return {
    runId: input.runId,
    runDir: input.runDir,
    timestamp: input.timestamp,
    baselineSurface: input.baselineSurface,
    winnerSurface: result.winnerSurface,
    ...(result.winnerLabel ? { winnerLabel: result.winnerLabel } : {}),
    ...(result.winnerRationale ? { winnerRationale: result.winnerRationale } : {}),
    baselineSearchCampaign: result.baselineCampaign,
    generations: result.generations.map(({ record, surfaces }) => ({
      generationIndex: record.generationIndex,
      candidates: record.candidates,
      promoted: record.promoted,
      surfaces: surfaces.map(({ surfaceHash, surface, campaign }) => ({
        surfaceHash,
        surface,
        campaign,
      })),
    })),
    gate: result.gateResult,
    ...(result.holdout === 'deferred' ? { holdout: 'deferred' as const } : {}),
    baselineOnHoldout: result.baselineOnHoldout,
    winnerOnHoldout: result.winnerOnHoldout,
    ...(result.neutralizedSurface && result.neutralizedOnHoldout
      ? {
          neutralizedSurface: result.neutralizedSurface,
          neutralizedOnHoldout: result.neutralizedOnHoldout,
        }
      : {}),
    costReceipts: input.costReceipts,
    totalCostUsd: input.totalCostUsd,
    totalDurationMs: input.totalDurationMs,
  }
}

function meanHoldoutComposite<TArtifact, TScenario extends Scenario>(
  campaign: CampaignResult<TArtifact, TScenario>,
): number {
  const xs: number[] = []
  for (const cell of campaign.cells) {
    if (cell.error) continue
    const cs = Object.values(cell.judgeScores).map((s) => s.composite)
    if (cs.length) xs.push(cs.reduce((a, b) => a + b, 0) / cs.length)
  }
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0
}

/** Build the durable provenance record from a completed loop result. */
export function buildLoopProvenanceRecord<TArtifact, TScenario extends Scenario>(
  args: BuildLoopProvenanceArgs<TArtifact, TScenario>,
): LoopProvenanceRecord {
  if (!args.runId.trim() || !args.runDir.trim()) {
    throw new Error('buildLoopProvenanceRecord: runId and runDir must be non-empty')
  }
  const timestampMs = Date.parse(args.timestamp)
  if (!Number.isFinite(timestampMs) || new Date(timestampMs).toISOString() !== args.timestamp) {
    throw new Error('buildLoopProvenanceRecord: timestamp must be a canonical ISO instant')
  }
  const agentReceipts = args.costReceipts.filter((receipt) => receipt.channel === 'agent')
  const integrity = summarizeAgentReceiptIntegrity(agentReceipts)
  const models = [...new Set(agentReceipts.map((receipt) => receipt.model))].sort()
  const baselineSearchComposite = campaignMeanComposite(args.baselineSearchCampaign)
  if (!Number.isFinite(baselineSearchComposite)) {
    throw new Error('buildLoopProvenanceRecord: baselineSearchComposite must be finite')
  }

  const candidates: LoopProvenanceCandidate[] = []
  let incumbentSurfaceHash = surfaceHash(args.baselineSurface)
  let incumbentComposite = baselineSearchComposite
  let previousGeneration = -1
  for (const gen of args.generations) {
    if (
      !Number.isSafeInteger(gen.generationIndex) ||
      gen.generationIndex !== previousGeneration + 1
    ) {
      throw new Error(
        'buildLoopProvenanceRecord: generation indices must be contiguous integers starting at zero',
      )
    }
    previousGeneration = gen.generationIndex
    if (gen.candidates.length === 0) {
      throw new Error('buildLoopProvenanceRecord: a recorded generation must contain a candidate')
    }
    if (new Set(gen.promoted).size !== gen.promoted.length || gen.promoted.length > 1) {
      throw new Error(
        'buildLoopProvenanceRecord: each generation may promote at most one candidate',
      )
    }
    const promotedSet = new Set(gen.promoted)
    const surfaceByHash = new Map(gen.surfaces.map((measured) => [measured.surfaceHash, measured]))
    const candidateByHash = new Map(
      gen.candidates.map((candidate) => [candidate.surfaceHash, candidate]),
    )
    if (candidateByHash.size !== gen.candidates.length) {
      throw new Error('buildLoopProvenanceRecord: duplicate candidate surface hash')
    }
    if (surfaceByHash.size !== gen.surfaces.length) {
      throw new Error('buildLoopProvenanceRecord: duplicate candidate surface entry')
    }
    if (surfaceByHash.size !== candidateByHash.size) {
      throw new Error(
        'buildLoopProvenanceRecord: every measured candidate requires exactly one surface',
      )
    }
    for (const promotedHash of promotedSet) {
      if (!candidateByHash.has(promotedHash)) {
        throw new Error('buildLoopProvenanceRecord: promoted hash has no measured candidate')
      }
    }
    for (const c of gen.candidates) {
      validateCandidateMeasurement(
        c,
        incumbentSurfaceHash,
        incumbentComposite,
        promotedSet.has(c.surfaceHash),
      )
      const measured = surfaceByHash.get(c.surfaceHash)
      if (measured === undefined) {
        throw new Error('buildLoopProvenanceRecord: measured candidate is missing its surface')
      }
      const { surface, campaign } = measured
      if (surfaceHash(surface) !== c.surfaceHash) {
        throw new Error(
          'buildLoopProvenanceRecord: candidate surface hash does not match its surface bytes',
        )
      }
      if (campaign.splitDigest !== args.baselineSearchCampaign.splitDigest) {
        throw new Error(
          'buildLoopProvenanceRecord: candidate campaign does not match the search split',
        )
      }
      const entry: LoopProvenanceCandidate = {
        generation: gen.generationIndex,
        surfaceHash: c.surfaceHash,
        contentHash: surfaceContentHash(surface),
        campaignDigest: campaignMeasurementDigest(campaign),
        parentSurfaceHash: c.parentSurfaceHash!,
        parentComposite: c.parentComposite!,
        eligibleForPromotion: c.eligibleForPromotion!,
        coverage: {
          expectedCells: c.coverage!.expectedCells,
          scorableCells: c.coverage!.scorableCells,
          unscorableCells: c.coverage!.unscorableCells.map((cell) => ({ ...cell })),
        },
        composite: c.composite,
        promoted: promotedSet.has(c.surfaceHash),
      }
      if (c.label) entry.label = c.label
      if (c.rationale) entry.rationale = c.rationale
      if (c.candidateRecord) {
        entry.candidateRecord = validatePolicyEditCandidateRecord(c.candidateRecord)
      }
      if (c.observedDeltaFromParent !== undefined) {
        entry.observedDeltaFromParent = c.observedDeltaFromParent
      }
      candidates.push(entry)
    }
    const promotedHash = gen.promoted[0]
    if (promotedHash) {
      const promoted = candidateByHash.get(promotedHash)!
      incumbentSurfaceHash = promoted.surfaceHash
      incumbentComposite = promoted.composite
    }
  }
  if (surfaceHash(args.winnerSurface) !== incumbentSurfaceHash) {
    throw new Error(
      'buildLoopProvenanceRecord: winner surface does not match the final promoted incumbent',
    )
  }

  const holdoutDeferred = args.holdout === 'deferred'
  const baselineHoldoutComposite = meanHoldoutComposite(args.baselineOnHoldout)
  const winnerHoldoutComposite = meanHoldoutComposite(args.winnerOnHoldout)
  if (args.baselineOnHoldout.splitDigest !== args.winnerOnHoldout.splitDigest) {
    throw new Error('buildLoopProvenanceRecord: baseline and winner use different holdout splits')
  }
  if ((args.neutralizedSurface === undefined) !== (args.neutralizedOnHoldout === undefined)) {
    throw new Error(
      'buildLoopProvenanceRecord: neutralized surface and campaign must be supplied together',
    )
  }
  if (
    args.neutralizedOnHoldout &&
    args.neutralizedOnHoldout.splitDigest !== args.baselineOnHoldout.splitDigest
  ) {
    throw new Error(
      'buildLoopProvenanceRecord: neutralized campaign uses a different holdout split',
    )
  }
  const neutralizedComposite = args.neutralizedOnHoldout
    ? meanHoldoutComposite(args.neutralizedOnHoldout)
    : undefined

  const diff =
    surfaceContentHash(args.baselineSurface) === surfaceContentHash(args.winnerSurface)
      ? ''
      : renderSurfaceDiff(args.winnerSurface, args.baselineSurface)

  const recordWithoutDigest: Omit<LoopProvenanceRecord, 'recordDigest'> = {
    schema: 'tangle.loop-provenance',
    runId: args.runId,
    runDir: args.runDir,
    timestamp: args.timestamp,
    baselineContentHash: surfaceContentHash(args.baselineSurface),
    winnerContentHash: surfaceContentHash(args.winnerSurface),
    diff,
    candidates,
    evidence: {
      search: {
        splitDigest: args.baselineSearchCampaign.splitDigest,
        baselineCampaignDigest: campaignMeasurementDigest(args.baselineSearchCampaign),
      },
      holdout: {
        splitDigest: args.baselineOnHoldout.splitDigest,
        baselineCampaignDigest: campaignMeasurementDigest(args.baselineOnHoldout),
        winnerCampaignDigest: campaignMeasurementDigest(args.winnerOnHoldout),
        ...(args.neutralizedSurface &&
        args.neutralizedOnHoldout &&
        neutralizedComposite !== undefined
          ? {
              neutralized: {
                contentHash: surfaceContentHash(args.neutralizedSurface),
                campaignDigest: campaignMeasurementDigest(args.neutralizedOnHoldout),
                composite: neutralizedComposite,
                lift: neutralizedComposite - baselineHoldoutComposite,
              },
            }
          : {}),
      },
      costReceiptsDigest: canonicalDigest(
        [...args.costReceipts].sort((left, right) => left.callId.localeCompare(right.callId)),
      ),
    },
    baselineSearchComposite,
    gate: {
      decision: args.gate.decision,
      reasons: args.gate.reasons,
      delta: args.gate.delta,
      contributingGates: args.gate.contributingGates.map((g) => ({
        name: g.name,
        passed: g.passed,
        detail: durableGateDetail(g.detail),
      })),
    },
    // Deferred holdout records the MODE, never a fabricated 0-lift: the
    // held-out comparison intentionally did not run in this loop.
    ...(holdoutDeferred
      ? { holdout: 'deferred' as const }
      : {
          baselineHoldoutComposite,
          winnerHoldoutComposite,
          heldOutLift: winnerHoldoutComposite - baselineHoldoutComposite,
        }),
    backend: {
      verdict: integrity.verdict,
      workerCallCount: integrity.totalRecords,
      models,
      totalInputTokens: integrity.totalInputTokens,
      totalOutputTokens: integrity.totalOutputTokens,
      totalCostUsd: integrity.totalCostUsd,
    },
    totalCostUsd: args.totalCostUsd,
    totalDurationMs: args.totalDurationMs,
  }
  if (args.winnerLabel) recordWithoutDigest.winnerLabel = args.winnerLabel
  if (args.winnerRationale) recordWithoutDigest.winnerRationale = args.winnerRationale
  return {
    ...recordWithoutDigest,
    recordDigest: canonicalDigest(recordWithoutDigest),
  }
}

/** Digest the exact campaign fields that can affect a measured comparison. */
export function campaignMeasurementDigest<TArtifact, TScenario extends Scenario>(
  campaign: CampaignResult<TArtifact, TScenario>,
): `sha256:${string}` {
  assertCampaignSplitIdentity(campaign.scenarios, campaign.reps, campaign.splitDigest)
  return canonicalDigest({
    schema: 'tangle.campaign-measurement',
    manifestHash: campaign.manifestHash,
    splitDigest: campaign.splitDigest,
    seed: campaign.seed,
    reps: campaign.reps,
    runDir: campaign.runDir,
    scenarios: campaign.scenarios,
    cells: [...campaign.cells]
      .sort((left, right) => left.cellId.localeCompare(right.cellId))
      .map((cell) => ({
        manifestHash: cell.manifestHash ?? null,
        cellId: cell.cellId,
        scenarioId: cell.scenarioId,
        rep: cell.rep,
        generation: cell.generation ?? null,
        judgeScores: cell.judgeScores,
        costUsd: cell.costUsd,
        costEstimated: cell.costEstimated ?? null,
        costCallIds: [...(cell.costCallIds ?? [])].sort(),
        tokenUsage: cell.tokenUsage,
        resolvedModel: cell.resolvedModel ?? null,
        durationMs: cell.durationMs,
        seed: cell.seed,
        cached: cell.cached,
        error: cell.error ?? null,
      })),
  })
}

/** Recompute and validate the self-addressed durable record. */
export function verifyLoopProvenanceRecord(record: LoopProvenanceRecord): LoopProvenanceRecord {
  if (record.schema !== 'tangle.loop-provenance') {
    throw new Error('loop provenance has an unsupported schema')
  }
  const { recordDigest, ...recordWithoutDigest } = record
  if (recordDigest !== canonicalDigest(recordWithoutDigest)) {
    throw new Error('loop provenance record digest does not match its contents')
  }
  return record
}

export function canonicalDigest(value: unknown): `sha256:${string}` {
  const json = JSON.stringify(value, function strictJson(_key, item: unknown) {
    if (typeof item === 'number' && !Number.isFinite(item)) {
      throw new Error('canonical digest cannot encode a non-finite number')
    }
    if (typeof item === 'bigint' || typeof item === 'function' || typeof item === 'symbol') {
      throw new Error(`canonical digest cannot encode ${typeof item}`)
    }
    if (item === undefined && Array.isArray(this)) {
      throw new Error('canonical digest cannot encode an undefined array item')
    }
    if (item instanceof Map || item instanceof Set) {
      throw new Error(`canonical digest cannot encode ${item instanceof Map ? 'Map' : 'Set'}`)
    }
    return item
  })
  if (json === undefined) throw new Error('canonical digest value is not serializable')
  return `sha256:${contentHash(JSON.parse(json))}`
}

function durableGateDetail(detail: unknown): unknown {
  if (detail === undefined) return null
  try {
    return JSON.parse(canonicalJson(detail)) as unknown
  } catch (cause) {
    throw new Error('buildLoopProvenanceRecord: gate detail must be canonical JSON', {
      cause,
    })
  }
}

function validateCandidateMeasurement(
  candidate: GenerationCandidate,
  expectedParentHash: string,
  expectedParentComposite: number,
  promoted: boolean,
): void {
  if (!Number.isFinite(candidate.composite)) {
    throw new Error('buildLoopProvenanceRecord: candidate composite must be finite')
  }
  if (!candidate.parentSurfaceHash || !/^[a-f0-9]{16}$/.test(candidate.parentSurfaceHash)) {
    throw new Error(
      'buildLoopProvenanceRecord: parentSurfaceHash must be 16 lowercase hex characters',
    )
  }
  if (candidate.parentSurfaceHash !== expectedParentHash) {
    throw new Error('buildLoopProvenanceRecord: candidate parent does not match the incumbent')
  }
  if (
    candidate.parentComposite === undefined ||
    !Number.isFinite(candidate.parentComposite) ||
    Math.abs(candidate.parentComposite - expectedParentComposite) > 1e-12
  ) {
    throw new Error(
      'buildLoopProvenanceRecord: candidate parentComposite does not match the incumbent',
    )
  }
  if (candidate.eligibleForPromotion === undefined || !candidate.coverage) {
    throw new Error(
      'buildLoopProvenanceRecord: candidate measurement requires eligibility and coverage',
    )
  }
  if (candidate.observedDeltaFromParent !== undefined) {
    if (!Number.isFinite(candidate.observedDeltaFromParent)) {
      throw new Error('buildLoopProvenanceRecord: observedDeltaFromParent must be finite')
    }
    if (candidate.eligibleForPromotion !== true) {
      throw new Error(
        'buildLoopProvenanceRecord: observedDeltaFromParent requires a complete eligible candidate and parentSurfaceHash',
      )
    }
  }
  const coverage = candidate.coverage
  if (
    !Number.isSafeInteger(coverage.expectedCells) ||
    coverage.expectedCells <= 0 ||
    !Number.isSafeInteger(coverage.scorableCells) ||
    coverage.scorableCells < 0 ||
    coverage.scorableCells > coverage.expectedCells
  ) {
    throw new Error('buildLoopProvenanceRecord: invalid candidate coverage denominator')
  }
  const unscorableIds = new Set<string>()
  for (const failure of coverage.unscorableCells) {
    if (
      typeof failure.cellId !== 'string' ||
      failure.cellId.length === 0 ||
      typeof failure.reason !== 'string' ||
      failure.reason.length === 0 ||
      unscorableIds.has(failure.cellId)
    ) {
      throw new Error('buildLoopProvenanceRecord: invalid candidate coverage failures')
    }
    unscorableIds.add(failure.cellId)
  }
  if (coverage.expectedCells - coverage.scorableCells !== coverage.unscorableCells.length) {
    throw new Error(
      'buildLoopProvenanceRecord: candidate coverage counts do not match its failures',
    )
  }
  const complete =
    coverage.scorableCells === coverage.expectedCells && coverage.unscorableCells.length === 0
  if (candidate.eligibleForPromotion !== undefined && candidate.eligibleForPromotion !== complete) {
    throw new Error(
      'buildLoopProvenanceRecord: candidate eligibility contradicts its coverage receipt',
    )
  }
  if (complete) {
    if (candidate.observedDeltaFromParent === undefined) {
      throw new Error(
        'buildLoopProvenanceRecord: complete candidate is missing observedDeltaFromParent',
      )
    }
    const recomputed = candidate.composite - candidate.parentComposite
    if (Math.abs(candidate.observedDeltaFromParent - recomputed) > 1e-12) {
      throw new Error('buildLoopProvenanceRecord: observed delta does not match measured scores')
    }
  } else if (candidate.observedDeltaFromParent !== undefined) {
    throw new Error('buildLoopProvenanceRecord: incomplete candidate cannot carry observed delta')
  }
  if (promoted && (!complete || (candidate.observedDeltaFromParent ?? 0) <= 0)) {
    throw new Error('buildLoopProvenanceRecord: promoted candidate must improve the incumbent')
  }
}

// ── OTel span emission ──────────────────────────────────────────────────

const DECISION_OK: GateDecision[] = ['ship']

function hashId(parts: string[]): string {
  return createHash('sha256').update(parts.join(':')).digest('hex')
}

function gateStatus(decision: GateDecision): { code: 'OK' | 'ERROR' | 'UNSET'; message?: string } {
  return DECISION_OK.includes(decision)
    ? { code: 'OK' }
    : { code: 'ERROR', message: `gate decision: ${decision}` }
}

/**
 * Build the loop's OTLP-ingestable spans from a provenance record. One root
 * span per loop (`tangle.runId`), one span per generation, one span per
 * candidate (carrying its surfaceHash + label), and one span for the gate
 * decision (carrying reasons + delta + lift). Candidate + gate spans pivot on
 * the same `tangle.runId` / `tangle.generation` attributes `/adapters/otel`
 * reads, so the hosted collector reconstructs the full tree.
 *
 * Times are synthesized monotonically off a single base so the span tree is
 * orderable; the substrate does not retain per-candidate wall-clock starts.
 */
export function loopProvenanceSpans(
  record: LoopProvenanceRecord,
  opts: { baseTimeMs?: number } = {},
): TraceSpanEvent[] {
  const traceId = hashId(['trace', record.runId]).slice(0, 32)
  const baseNano = (opts.baseTimeMs ?? (Date.parse(record.timestamp) || Date.now())) * 1_000_000
  const endNano = baseNano + Math.max(1, record.totalDurationMs) * 1_000_000
  const spans: TraceSpanEvent[] = []

  const rootSpanId = hashId(['root', record.runId]).slice(0, 16)
  const rootAttributes: TraceSpanEvent['attributes'] = {
    'tangle.runId': record.runId,
    'tangle.runDir': record.runDir,
    'tangle.baselineContentHash': record.baselineContentHash,
    'tangle.winnerContentHash': record.winnerContentHash,
    'tangle.baselineSearchComposite': record.baselineSearchComposite,
    'tangle.gateDecision': record.gate.decision,
    'tangle.backendVerdict': record.backend.verdict,
    'tangle.workerCallCount': record.backend.workerCallCount,
    'tangle.totalCostUsd': record.totalCostUsd,
  }
  if (record.heldOutLift !== undefined) rootAttributes['tangle.heldOutLift'] = record.heldOutLift
  if (record.holdout) rootAttributes['tangle.holdout'] = record.holdout
  spans.push({
    traceId,
    spanId: rootSpanId,
    name: 'improvement-loop',
    startTimeUnixNano: baseNano,
    endTimeUnixNano: endNano,
    attributes: rootAttributes,
    status: gateStatus(record.gate.decision),
    'tangle.runId': record.runId,
  })

  // Group candidates by generation for the per-generation parent span.
  const byGen = new Map<number, LoopProvenanceCandidate[]>()
  for (const c of record.candidates) {
    const arr = byGen.get(c.generation) ?? []
    arr.push(c)
    byGen.set(c.generation, arr)
  }
  for (const [generation, cands] of [...byGen.entries()].sort((a, b) => a[0] - b[0])) {
    const genSpanId = hashId(['gen', record.runId, String(generation)]).slice(0, 16)
    const bestComposite = Math.max(...cands.map((candidate) => candidate.composite))
    spans.push({
      traceId,
      spanId: genSpanId,
      parentSpanId: rootSpanId,
      name: `generation-${generation}`,
      startTimeUnixNano: baseNano,
      endTimeUnixNano: endNano,
      attributes: {
        'tangle.runId': record.runId,
        'tangle.generation': generation,
        'tangle.populationSize': cands.length,
        'tangle.bestComposite': bestComposite,
      },
      'tangle.runId': record.runId,
      'tangle.generation': generation,
    })
    for (let i = 0; i < cands.length; i++) {
      const c = cands[i]!
      const candSpanId = hashId(['cand', record.runId, String(generation), c.surfaceHash]).slice(
        0,
        16,
      )
      const attributes: TraceSpanEvent['attributes'] = {
        'tangle.runId': record.runId,
        'tangle.generation': generation,
        'tangle.surfaceHash': c.surfaceHash,
        'tangle.contentHash': c.contentHash,
        'tangle.parentSurfaceHash': c.parentSurfaceHash,
        'tangle.parentComposite': c.parentComposite,
        'tangle.composite': c.composite,
        'tangle.eligibleForPromotion': c.eligibleForPromotion,
        'tangle.expectedCells': c.coverage.expectedCells,
        'tangle.scorableCells': c.coverage.scorableCells,
        'tangle.unscorableCells': c.coverage.unscorableCells.length,
        'tangle.promoted': c.promoted,
      }
      if (c.observedDeltaFromParent !== undefined) {
        attributes['tangle.observedDeltaFromParent'] = c.observedDeltaFromParent
      }
      if (c.candidateRecord) {
        attributes['tangle.policyEditId'] = c.candidateRecord.policyEdit.editId
      }
      if (c.label) attributes['tangle.candidateLabel'] = c.label
      if (c.rationale) attributes['tangle.candidateRationale'] = c.rationale
      spans.push({
        traceId,
        spanId: candSpanId,
        parentSpanId: genSpanId,
        name: `candidate-${c.surfaceHash}`,
        startTimeUnixNano: baseNano,
        endTimeUnixNano: endNano,
        attributes,
        'tangle.runId': record.runId,
        'tangle.generation': generation,
      })
    }
  }

  // Gate span — child of root, carries the decision/reasons/delta the audit
  // needs and pivots back to the run.
  const gateSpanId = hashId(['gate', record.runId]).slice(0, 16)
  const gateAttributes: TraceSpanEvent['attributes'] = {
    'tangle.runId': record.runId,
    'tangle.gateDecision': record.gate.decision,
    'tangle.gateReasons': JSON.stringify(record.gate.reasons),
  }
  const gateDelta = record.gate.delta ?? record.heldOutLift
  if (gateDelta !== undefined) gateAttributes['tangle.gateDelta'] = gateDelta
  if (record.heldOutLift !== undefined) gateAttributes['tangle.heldOutLift'] = record.heldOutLift
  if (record.baselineHoldoutComposite !== undefined) {
    gateAttributes['tangle.baselineHoldoutComposite'] = record.baselineHoldoutComposite
  }
  if (record.winnerHoldoutComposite !== undefined) {
    gateAttributes['tangle.winnerHoldoutComposite'] = record.winnerHoldoutComposite
  }
  if (record.holdout) gateAttributes['tangle.holdout'] = record.holdout
  spans.push({
    traceId,
    spanId: gateSpanId,
    parentSpanId: rootSpanId,
    name: 'gate-decision',
    startTimeUnixNano: endNano,
    endTimeUnixNano: endNano,
    attributes: gateAttributes,
    status: gateStatus(record.gate.decision),
    'tangle.runId': record.runId,
  })

  return spans
}

// ── Durable emission ─────────────────────────────────────────────────────

/** Canonical durable paths under the run dir. */
export function provenanceRecordPath(runDir: string): string {
  return join(runDir, 'loop-provenance.json')
}
/**
 * Canonical path for the durable OTLP spans JSONL file under a loop run directory.
 */
export function provenanceSpansPath(runDir: string): string {
  return join(runDir, 'loop-provenance-spans.jsonl')
}

export interface EmitLoopProvenanceResult {
  record: LoopProvenanceRecord
  spans: TraceSpanEvent[]
  /** Absolute paths the record + spans were written to, when storage persists. */
  recordPath: string
  spansPath: string
}

export interface EmitLoopProvenanceArgs<TArtifact, TScenario extends Scenario>
  extends BuildLoopProvenanceArgs<TArtifact, TScenario> {
  /** Storage the record + spans are written through. */
  storage: CampaignStorage
  /** When set, the spans are also shipped to the hosted `/v1/ingest/traces`
   *  endpoint so the collector receives the full loop, not just `cost.*`. */
  hostedClient?: HostedClient
}

/** Snapshot a held-out campaign into the hosted `EvalRunGenerationSnapshot`
 *  shape — per-cell composite + per-judge dimensions, aggregate mean, cost,
 *  duration. The dashboard renders these as the baseline → winner comparison. */
function snapshotFromHoldout<TArtifact, TScenario extends Scenario>(
  index: number,
  surfaceHash: string,
  surface: MutableSurface,
  campaign: CampaignResult<TArtifact, TScenario>,
): EvalRunGenerationSnapshot {
  const cells: EvalRunCellScore[] = campaign.cells.map((cell) => {
    const judgeScores = Object.values(cell.judgeScores)
    const composite =
      judgeScores.length === 0
        ? 0
        : judgeScores.reduce((s, j) => s + j.composite, 0) / judgeScores.length
    const score: EvalRunCellScore = {
      scenarioId: cell.scenarioId,
      rep: cell.rep,
      compositeMean: composite,
      dimensions: Object.fromEntries(
        Object.entries(cell.judgeScores).map(([name, s]) => [name, s.dimensions]),
      ),
    }
    if (cell.error) score.errorMessage = cell.error
    return score
  })
  const compositeMean =
    cells.length === 0 ? 0 : cells.reduce((s, c) => s + c.compositeMean, 0) / cells.length
  return {
    index,
    surfaceHash,
    surface,
    cells,
    compositeMean,
    costUsd: campaign.aggregates.totalCostUsd,
    durationMs: campaign.durationMs,
  }
}

/** Build the hosted `EvalRunEvent` from the loop args + record — baseline +
 *  winner snapshots, gate decision, held-out lift, cost, duration. Shipped to
 *  `/v1/ingest/eval-runs` so the run appears in the dashboard's run list (the
 *  trace spans, shipped separately, back the per-candidate drill-down). */
function buildEvalRunEvent<TArtifact, TScenario extends Scenario>(
  args: EmitLoopProvenanceArgs<TArtifact, TScenario>,
  record: LoopProvenanceRecord,
): EvalRunEvent {
  return {
    runId: args.runId,
    runDir: args.runDir,
    timestamp: args.timestamp,
    status: 'finished',
    labels: {},
    baseline: snapshotFromHoldout(
      0,
      record.baselineContentHash,
      args.baselineSurface,
      args.baselineOnHoldout,
    ),
    generations: [
      snapshotFromHoldout(1, record.winnerContentHash, args.winnerSurface, args.winnerOnHoldout),
    ],
    gateDecision: args.gate.decision,
    // Deferred holdout ships NO lift — the wire field is optional and a 0
    // would read downstream as a measured no-improvement.
    ...(record.heldOutLift !== undefined ? { holdoutLift: record.heldOutLift } : {}),
    totalCostUsd: args.totalCostUsd,
    totalDurationMs: args.totalDurationMs,
  }
}

/**
 * Build the provenance record + OTel spans and persist them durably under the
 * run dir (and ship spans to a hosted collector when one is wired). Returns
 * both artifacts so the caller can assert on / re-derive from them.
 *
 * Fail-loud: the durable write throws on storage failure (a swallowed write is
 * exactly the "emitted but lost" failure this closes). The hosted span ship is
 * the one best-effort leg — its failure is logged, not thrown, so an offline
 * collector never fails the loop (the durable artifact is the source of truth).
 */
export async function emitLoopProvenance<TArtifact, TScenario extends Scenario>(
  args: EmitLoopProvenanceArgs<TArtifact, TScenario>,
): Promise<EmitLoopProvenanceResult> {
  const record = buildLoopProvenanceRecord(args)
  const spans = loopProvenanceSpans(record)

  args.storage.ensureDir(args.runDir)
  const recordPath = provenanceRecordPath(args.runDir)
  const spansPath = provenanceSpansPath(args.runDir)
  args.storage.write(recordPath, JSON.stringify(record, null, 2))
  args.storage.write(spansPath, spans.map((s) => JSON.stringify(s)).join('\n'))

  if (args.hostedClient) {
    // Ship BOTH streams so the run is fully visible in the dashboard: the
    // eval-run event (→ run list + baseline/winner/gate/lift) AND the trace
    // spans (→ per-candidate drill-down). Best-effort: an offline collector is
    // logged, never thrown — the durable artifact above is the source of truth.
    try {
      await args.hostedClient.ingestEvalRun(buildEvalRunEvent(args, record))
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      // eslint-disable-next-line no-console -- intentional: hosted ingest is best-effort
      console.warn(`[agent-eval] hosted eval-run ingest failed (continuing): ${msg}`)
    }
    try {
      await args.hostedClient.ingestTraces(spans)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      // eslint-disable-next-line no-console -- intentional: hosted span ship is best-effort
      console.warn(`[agent-eval] provenance span ingest failed (continuing): ${msg}`)
    }
  }

  return { record, spans, recordPath, spansPath }
}
