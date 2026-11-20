import type { CostLedgerHandle } from '../cost-ledger'
import { excerptEvidence } from '../reflective-mutation'
import {
  assertJsonValue,
  type ExternalEvaluationMeasurement,
  type ExternalTextCandidate,
  type ExternalTextEvaluationRequest,
  isCandidateText,
  safePathComponent,
} from './external-optimizer-process'
import type { OptimizationMethodInput } from './optimization-method'
import { runCampaign } from './run-campaign'
import { campaignBreakdown, campaignEvidence, type DescribeArtifact } from './score-utils'
import { type CampaignCellMeasurement, campaignCellMeasurement } from './search-campaign-cell'
import { surfaceContentHash } from './surface-identity'
import type {
  CampaignCellResult,
  CampaignResult,
  DispatchContext,
  MutableSurface,
  Scenario,
} from './types'

export interface ExternalOptimizationExample {
  id: string
  data: unknown
}

export interface ExternalTextEvaluationResponse {
  score: number
  info: {
    scenarioId: string
    dimensions: Record<string, number>
    /** Higher-is-better objectives consumed by GEPA hybrid/Pareto selection. */
    scores?: Record<string, number>
    notes?: string
    artifact?: unknown
    /** The optimizer score is a finite protocol value; Eval remains the
     * authority for whether the underlying cell actually produced a score. */
    status?: 'scored' | 'failed'
    error?: {
      stage: 'dispatch' | 'judge' | 'unknown'
      message: string
    }
  }
}

export function createExternalTextEvaluator<TScenario extends Scenario, TArtifact>(args: {
  input: OptimizationMethodInput<TScenario, TArtifact>
  label: string
  runDir: string
  /** Identity of the exact execution and scoring behavior used by this evaluator. */
  compatibleRunId: string
  costPhase: string
  costTags?: Readonly<Record<string, string>>
  costLedger: CostLedgerHandle
  scenarioById: ReadonlyMap<string, TScenario>
  maxCandidateChars: number
  maxEvidenceChars: number
  /** The method's own hook; the caller's `input.describeArtifact` applies when it is absent. */
  describeArtifact?: DescribeArtifact<TArtifact, TScenario>
}): (
  request: ExternalTextEvaluationRequest,
  signal?: AbortSignal,
  measured?: (measurement: ExternalEvaluationMeasurement) => void,
) => Promise<ExternalTextEvaluationResponse> {
  const shared = args.input.describeArtifact
  if (args.describeArtifact && shared && args.describeArtifact !== shared) {
    throw new Error(
      `${args.label}: describeArtifact is set both on the method and by its caller; set it once`,
    )
  }
  const describeArtifact = args.describeArtifact ?? shared
  // One entry per candidate and case: a repeated request is answered from the
  // cells the first request measured, and reports them as reused.
  const cached = new Map<string, Promise<ScoredScenario>>()
  return async ({ candidate, exampleId }, signal, measured) => {
    if (!args.scenarioById.has(exampleId)) {
      throw new Error(`${args.label} requested unknown train or selection case '${exampleId}'`)
    }
    const detachedCandidate = cloneExternalTextCandidate(candidate)
    const surface =
      typeof detachedCandidate === 'string'
        ? detachedCandidate
        : ({ kind: 'components', components: detachedCandidate } as const)
    const candidateLength =
      typeof detachedCandidate === 'string'
        ? detachedCandidate.length
        : JSON.stringify(detachedCandidate).length
    if (
      (typeof detachedCandidate === 'string' &&
        !isCandidateText(detachedCandidate, args.maxCandidateChars)) ||
      candidateLength > args.maxCandidateChars
    ) {
      throw new Error(`${args.label} submitted an invalid candidate`)
    }
    const scenario = args.scenarioById.get(exampleId)!
    const cacheKey = `${args.compatibleRunId}:${surfaceContentHash(surface)}:${exampleId}`
    const existing = cached.get(cacheKey)
    if (existing) {
      const reused = await existing
      if (reused.cells.length > 0) measured?.({ source: 'reused', cells: reused.cells })
      return answer(reused)
    }

    const result = scoreOneScenario({
      input: args.input,
      label: args.label,
      candidate: surface,
      scenario,
      runDir: args.runDir,
      compatibleRunId: args.compatibleRunId,
      costPhase: args.costPhase,
      costTags: args.costTags,
      costLedger: args.costLedger,
      maxEvidenceChars: args.maxEvidenceChars,
      ...(describeArtifact ? { describeArtifact } : {}),
      signal,
    })
    cached.set(cacheKey, result)
    void result.then(
      (scored) => {
        // Failed cells and refused evidence are durable diagnostics, not
        // reusable scores. Leave the successful path cached, but let a later
        // GEPA request retry the failed or missing cell on resume.
        const reusable = 'response' in scored && scored.response.info.status !== 'failed'
        if (!reusable && cached.get(cacheKey) === result) cached.delete(cacheKey)
      },
      () => {
        if (cached.get(cacheKey) === result) cached.delete(cacheKey)
      },
    )
    const scored = await result
    // Reported before a refusal is thrown: the cells were measured and paid
    // for, so the observation log keeps them whatever the optimizer receives.
    if (scored.cells.length > 0) measured?.({ source: 'measured', cells: scored.cells })
    return answer(scored)
  }
}

/**
 * One evaluation's campaign cells, and either the optimizer's response or why
 * the evaluation is refused after it measured them.
 */
type ScoredScenario =
  | { cells: CampaignCellMeasurement[]; response: ExternalTextEvaluationResponse }
  | { cells: CampaignCellMeasurement[]; refusal: Error }

function answer(scored: ScoredScenario): ExternalTextEvaluationResponse {
  if ('refusal' in scored) throw scored.refusal
  return scored.response
}

export function mapExternalScenarios<TScenario extends Scenario>(
  train: readonly TScenario[],
  selection: readonly TScenario[],
  label: string,
): Map<string, TScenario> {
  const out = new Map<string, TScenario>()
  for (const scenario of [...train, ...selection]) {
    if (out.has(scenario.id)) {
      throw new Error(
        `${label} requires unique train and selection ids; duplicate '${scenario.id}'`,
      )
    }
    out.set(scenario.id, scenario)
  }
  return out
}

export function describeExternalScenario<TScenario extends Scenario>(
  scenario: TScenario,
  label: string,
  maxChars: number,
  describe?: (scenario: TScenario) => unknown,
): ExternalOptimizationExample {
  const data = structuredClone(describe ? describe(scenario) : { id: scenario.id })
  assertJsonValue(data, `${label} scenario '${scenario.id}'`)
  const serializedChars = JSON.stringify(data).length
  if (serializedChars > maxChars) {
    throw new Error(
      `${label} scenario '${scenario.id}' exceeds maxEvidenceChars (${serializedChars} > ${maxChars})`,
    )
  }
  return deepFreeze({ id: scenario.id, data })
}

export function encodeExternalTextCandidate(surface: MutableSurface): ExternalTextCandidate {
  if (typeof surface === 'string') return surface
  if (surface.kind === 'components') return { ...surface.components }
  throw new Error('external text optimizers cannot encode a code surface')
}

export function decodeExternalTextCandidate(candidate: ExternalTextCandidate): MutableSurface {
  return typeof candidate === 'string'
    ? candidate
    : { kind: 'components', components: { ...candidate } }
}

async function scoreOneScenario<TScenario extends Scenario, TArtifact>(args: {
  input: OptimizationMethodInput<TScenario, TArtifact>
  label: string
  candidate:
    | string
    | { readonly kind: 'components'; readonly components: Readonly<Record<string, string>> }
  scenario: TScenario
  runDir: string
  compatibleRunId: string
  costPhase: string
  costTags?: Readonly<Record<string, string>>
  costLedger: CostLedgerHandle
  maxEvidenceChars: number
  describeArtifact?: DescribeArtifact<TArtifact, TScenario>
  signal?: AbortSignal
}): Promise<ScoredScenario> {
  const { runOptions } = args.input
  // runCampaign reports each cell as it persists it, so when the campaign
  // throws, the cells it finished are still known; the dispatches name the
  // cells it started, so a cell the throw interrupted is known too.
  const settled: CampaignCellResult<TArtifact>[] = []
  const started = new Map<string, StartedCell>()
  let campaign: CampaignResult<TArtifact, TScenario>
  try {
    campaign = await runCampaign<TScenario, TArtifact>({
      ...runOptions,
      scenarios: [structuredClone(args.scenario)],
      dispatch: (scenario, context) => {
        noteDispatch(started, scenario.id, context)
        return args.input.dispatchWithSurface(args.candidate, scenario, context)
      },
      onCellSettled: async (cell, scenario) => {
        settled.push(cell)
        await runOptions.onCellSettled?.(cell, scenario)
      },
      dispatchRef: `external-text:${args.compatibleRunId}:${surfaceContentHash(args.candidate)}`,
      judges: [...args.input.judges],
      runDir: `${args.runDir}/evaluations/${safePathComponent(args.compatibleRunId)}/${safePathComponent(surfaceContentHash(args.candidate))}/${safePathComponent(args.scenario.id)}`,
      seed: args.input.seed,
      costLedger: args.costLedger,
      costPhase: args.costPhase,
      ...(args.costTags ? { costTags: args.costTags } : {}),
      maxConcurrency: 1,
      ...(args.signal ? { signal: args.signal } : {}),
    })
  } catch (error) {
    const refusal = error instanceof Error ? error : new Error(String(error))
    return {
      cells: [
        ...measureByRep(settled),
        ...interruptedCells(started, settled, args.costLedger, refusal.message),
      ],
      refusal,
    }
  }
  const cells = measureByRep(campaign.cells)
  // From here every refusal keeps `cells`: they were measured and paid for.
  const respond = (response: ExternalTextEvaluationResponse): ScoredScenario => {
    const bounded = boundEvidence(response, args.maxEvidenceChars)
    if (bounded) return { cells, response: bounded }
    return {
      cells,
      refusal: new Error(
        `${args.label} evaluation evidence for '${args.scenario.id}' exceeds maxEvidenceChars (${args.maxEvidenceChars}) in fields no excerpt can shorten`,
      ),
    }
  }
  const failedCell = campaign.cells.find((cell) => cell.error !== undefined)
  if (failedCell) {
    const stage = failedCell.errorStage ?? 'unknown'
    const message = failedCell.error?.slice(0, 2_000) ?? 'cell failed without an error message'
    return respond({
      // GEPA requires a finite score for every callback response. This zero is
      // an optimizer penalty only; the campaign cell remains unscored below.
      score: 0,
      info: {
        scenarioId: failedCell.scenarioId,
        dimensions: {},
        status: 'failed',
        notes: `Evaluation failed at ${stage}; optimizer penalty score 0 is not a measured zero. ${message}`,
        error: { stage, message },
      },
    })
  }
  const breakdown = campaignBreakdown(campaign)
  const row = breakdown.scenarios[0]
  if (!row) {
    return {
      cells,
      refusal: new Error(`${args.label} evaluation produced no score for '${args.scenario.id}'`),
    }
  }
  // The evidence the native reflective path shows, kept as a JSON value so a
  // described artifact may carry inline images.
  const artifact = campaignEvidence(campaign.cells, {
    scenarios: [args.scenario],
    ...(args.describeArtifact ? { describeArtifact: args.describeArtifact } : {}),
  }).get(args.scenario.id)
  return respond({
    score: row.composite,
    info: {
      scenarioId: row.scenarioId,
      dimensions: breakdown.dimensions,
      scores: { ...breakdown.dimensions },
      status: 'scored',
      ...(row.notes ? { notes: row.notes } : {}),
      ...(artifact !== undefined ? { artifact } : {}),
    },
  })
}

function measureByRep<TArtifact>(
  cells: readonly CampaignCellResult<TArtifact>[],
): CampaignCellMeasurement[] {
  return [...cells].sort((left, right) => left.rep - right.rep).map(campaignCellMeasurement)
}

/** A campaign cell whose dispatch started, by the context runCampaign gave it. */
interface StartedCell {
  cellId: string
  scenarioId: string
  rep: number
  runAttemptId: string
  /** Dispatches of this cell in this run attempt: its execution attempt number. */
  dispatches: number
  startedMs: number
}

function noteDispatch(
  started: Map<string, StartedCell>,
  scenarioId: string,
  context: DispatchContext,
): void {
  const known = started.get(context.cellId)
  if (known) {
    known.dispatches += 1
    return
  }
  started.set(context.cellId, {
    cellId: context.cellId,
    scenarioId,
    rep: context.rep,
    runAttemptId: context.runAttemptId,
    dispatches: 1,
    startedMs: Date.now(),
  })
}

/**
 * Every cell that started but never settled before runCampaign threw. No cell
 * result exists for it, so its outcome is the throw and its accounting is
 * unknown: the agent spend the cost ledger holds for its attempt is a lower
 * bound, since a dispatch that ignored cancellation may still be paying.
 */
function interruptedCells(
  started: ReadonlyMap<string, StartedCell>,
  settled: readonly CampaignCellResult<unknown>[],
  costLedger: CostLedgerHandle,
  thrown: string,
): CampaignCellMeasurement[] {
  const settledIds = new Set(settled.map((cell) => cell.cellId))
  return [...started.values()]
    .filter((cell) => !settledIds.has(cell.cellId))
    .sort((left, right) => left.rep - right.rep)
    .map((cell): CampaignCellMeasurement => {
      const reason = `runCampaign threw before campaign cell ${cell.cellId} settled`
      const spent = costLedger.summary({
        channel: 'agent',
        tags: { runAttemptId: cell.runAttemptId, cellId: cell.cellId },
      })
      return {
        cellId: cell.cellId,
        scenarioId: cell.scenarioId,
        rep: cell.rep,
        attempt: { runAttemptId: cell.runAttemptId, number: cell.dispatches },
        cached: false,
        outcome: {
          status: 'errored',
          metrics: {},
          error: {
            code: 'campaign-threw',
            message: `${reason}: ${thrown.slice(0, 2_000)}`,
            retryable: false,
          },
        },
        accounting: {
          tokens: { status: 'unknown', reason },
          cost: {
            status: 'unknown',
            knownLowerBoundUsd: spent.totalCostUsd,
            reason: `${reason}; the agent spend its receipts proved by then is a lower bound`,
          },
        },
        durationMs: Date.now() - cell.startedMs,
        traceRef: { unknown: `${reason}, so no trace was named for it` },
      }
    })
}

/**
 * The response within `maxChars` of JSON, or undefined when it cannot be.
 *
 * The bound limits how much evidence the optimizer reads per evaluation, and
 * an excerpt meets it without hiding that anything was cut: the judge notes,
 * the error message and a text artifact keep their head and tail around an
 * omitted-count marker (`excerptEvidence`), sharing the room the other fields
 * leave. A described artifact stays whole when the text fields alone can make
 * room; otherwise it is shown as its excerpted JSON text, as the native
 * reflective path shows it. Only the fields no excerpt can shorten (the
 * scores, the dimensions and the ids) can make a response not fit.
 */
function boundEvidence(
  response: ExternalTextEvaluationResponse,
  maxChars: number,
): ExternalTextEvaluationResponse | undefined {
  if (JSON.stringify(response).length <= maxChars) return response
  const { info } = response
  const fit = (artifactAsText: boolean): ExternalTextEvaluationResponse | undefined => {
    const artifact =
      typeof info.artifact === 'string'
        ? info.artifact
        : artifactAsText && info.artifact !== undefined
          ? JSON.stringify(info.artifact)
          : undefined
    const fields: Array<['notes' | 'message' | 'artifact', string]> = []
    if (info.notes !== undefined) fields.push(['notes', info.notes])
    if (info.error) fields.push(['message', info.error.message])
    if (artifact !== undefined) fields.push(['artifact', artifact])
    const build = (texts: readonly string[]): ExternalTextEvaluationResponse => {
      const text = new Map(fields.map(([name], index) => [name, texts[index]!]))
      const notes = text.get('notes')
      const message = text.get('message')
      const excerpted = text.get('artifact')
      return {
        ...response,
        info: {
          ...info,
          ...(notes === undefined ? {} : { notes }),
          ...(message === undefined || !info.error ? {} : { error: { ...info.error, message } }),
          ...(excerpted === undefined ? {} : { artifact: excerpted }),
        },
      }
    }
    const texts = fitTexts(
      fields.map(([, value]) => value),
      (candidate) => JSON.stringify(build(candidate)).length,
      maxChars,
    )
    return texts && build(texts)
  }
  const describedArtifact = info.artifact !== undefined && typeof info.artifact !== 'string'
  return fit(false) ?? (describedArtifact ? fit(true) : undefined)
}

/**
 * Excerpts of `texts` whose `size` is at most `maxChars`, or undefined when
 * the rest of the value alone exceeds it. The room left by the rest is shared
 * evenly, and a text shorter than its share leaves the remainder to the
 * others. Sizes count JSON-encoded characters, so escapes are paid for.
 */
function fitTexts(
  texts: readonly string[],
  size: (texts: readonly string[]) => number,
  maxChars: number,
): string[] | undefined {
  const fixed = size(texts.map(() => ''))
  if (fixed > maxChars) return undefined
  const encoded = (text: string) => JSON.stringify(text).length - 2
  const shares = new Array<number>(texts.length).fill(0)
  let room = maxChars - fixed
  let remaining = texts.length
  const shortestFirst = texts
    .map((_, index) => index)
    .sort((left, right) => encoded(texts[left]!) - encoded(texts[right]!))
  for (const index of shortestFirst) {
    shares[index] = Math.min(encoded(texts[index]!), Math.floor(room / remaining))
    room -= shares[index]!
    remaining -= 1
  }
  return texts.map((text, index) => excerptWithin(text, shares[index]!))
}

/** The longest `excerptEvidence` of `text` whose JSON-encoded content fits `maxEncoded`. */
function excerptWithin(text: string, maxEncoded: number): string {
  let limit = maxEncoded
  while (limit > 0) {
    const excerpt = excerptEvidence(text, limit)
    const over = JSON.stringify(excerpt).length - 2 - maxEncoded
    if (over <= 0) return excerpt
    limit -= over
  }
  return ''
}

function cloneExternalTextCandidate(candidate: ExternalTextCandidate): ExternalTextCandidate {
  return typeof candidate === 'string' ? candidate : { ...candidate }
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child)
    Object.freeze(value)
  }
  return value
}
