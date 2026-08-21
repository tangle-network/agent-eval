/**
 * Record a candidate search into the canonical `SearchLedger`.
 *
 * `runOptimization` and the GEPA adapter produce the same three facts — a
 * bounded plan, a candidate lineage, and a measured outcome per planned task —
 * so both write them through this recorder into one ledger and one
 * `SearchHistoryReceipt`. There is no second lineage record.
 *
 * The ledger contract requires identities a campaign cannot infer: an
 * immutable revision for the agent and proposer implementations, and a model
 * snapshot on every attempt. The caller declares them once in
 * `SearchRunIdentity`. Measured values win wherever execution reported them; a
 * declaration only fills what execution did not report.
 */

import type { CostLedgerHandle, CostReceipt } from '../cost-ledger'
import { canonicalString, hashCanonical } from '../ledger-core/canonical'
import { modelHasSnapshot } from '../run-record'
import type { ExternalTextCandidate } from './external-optimizer-contracts'
import type { GepaCandidatePopulationArtifact } from './gepa-candidate-population'
import { createSearchHistoryReceipt, type SearchHistoryReceipt } from './search-history-receipt'
import type {
  SearchArtifactRef,
  SearchAttemptAccounting,
  SearchCandidateSlot,
  SearchCandidateSurface,
  SearchFailureReason,
  SearchLedger,
  SearchLedgerEvent,
  SearchModelIdentity,
  SearchOperationRecordedEvent,
  SearchPlannedOperation,
  SearchPlannedTask,
  SearchSourceRef,
  SearchSurfaceEvidence,
  SearchTaskOutcome,
} from './search-ledger'
import type { CampaignStorage } from './storage'
import type { CampaignCellResult, MutableSurface, Scenario } from './types'

/** How a search operation executed. The shape the ledger event records. */
export type SearchExecutionIdentity = SearchOperationRecordedEvent['execution']

/** Immutable identities the ledger requires and a campaign cannot infer. */
export interface SearchRunIdentity {
  /** The agent implementation under optimization. */
  agent: SearchSourceRef
  /** The candidate generator: a model call or deterministic code. */
  proposer: SearchExecutionIdentity
  /** The code that plans the search and selects its winner. */
  search: SearchSourceRef
  /** Model the agent runs. Used only for a cell that reported none. */
  model: SearchModelIdentity
}

export interface SearchLedgerBinding {
  ledger: SearchLedger
  identity: SearchRunIdentity
}

/** One proposed candidate, before it is measured. */
export interface ProposedSearchCandidate {
  surface: MutableSurface
  surfaceHash: string
  label?: string
}

/** One measured candidate, after its campaign scored. */
export interface MeasuredSearchCandidate<TArtifact> {
  surface: MutableSurface
  surfaceHash: string
  cells: ReadonlyArray<CampaignCellResult<TArtifact>>
  runDir: string
  /** False when the candidate missed a designed cell. */
  coverageComplete: boolean
}

export interface SearchRecorderOptions<TScenario extends Scenario> {
  binding: SearchLedgerBinding
  storage: CampaignStorage
  runDir: string
  scenarios: ReadonlyArray<TScenario>
  reps: number
  maxGenerations: number
  populationSize: number
  /** Identity of the exact campaign design; the task benchmark pin. */
  splitDigest: `sha256:${string}`
  /** Proposer label recorded on every candidate lineage. */
  proposerLabel: string
  costLedger: CostLedgerHandle
}

interface RegisteredCandidate {
  candidateId: string
  slotId: string
  generation: number
}

const SEARCH_LEDGER_DIR = 'search-ledger'

/**
 * Recorder for one `runOptimization` run: `open()`, then `recordGeneration()`
 * and `recordResults()` per generation, then `finish()`.
 *
 * Every event id is derived from the run, and an id already durable is not
 * appended again, so a resumed run continues one ledger instead of conflicting
 * with its own history.
 */
export class SearchRecorder<TScenario extends Scenario, TArtifact> {
  private readonly opts: SearchRecorderOptions<TScenario>
  private readonly tasks: SearchPlannedTask[]
  private readonly registered = new Map<string, RegisteredCandidate>()
  private readonly order: RegisteredCandidate[] = []
  private readonly coverage = new Map<string, boolean>()
  private readonly openSlots = new Set<string>()
  private readonly durableEventIds = new Set<string>()
  private lastStampMs = 0
  private proposalReceiptCount = 0

  private constructor(opts: SearchRecorderOptions<TScenario>) {
    this.opts = opts
    this.tasks = plannedTasks(opts.scenarios, opts.reps, opts.runDir, opts.splitDigest)
  }

  /** Open the recorder and append the plan. An existing ledger for the same
   *  run is re-read first, so a resumed run keeps one plan and one lineage. */
  static async open<TScenario extends Scenario, TArtifact>(
    opts: SearchRecorderOptions<TScenario>,
  ): Promise<SearchRecorder<TScenario, TArtifact>> {
    const recorder = new SearchRecorder<TScenario, TArtifact>(opts)
    await recorder.hydrate()
    await recorder.plan()
    return recorder
  }

  /**
   * Record one generation's candidate-generation call and the candidates it
   * produced. A proposal larger than the planned population extends the plan
   * with the extra slots; a proposal that fills fewer closes the rest.
   */
  async recordGeneration(input: {
    generation: number
    parentSurfaceHash: string
    candidates: ReadonlyArray<ProposedSearchCandidate>
  }): Promise<void> {
    const { generation, candidates } = input
    const planned = this.opts.populationSize
    if (candidates.length > planned) {
      const extra: SearchCandidateSlot[] = []
      for (let index = planned; index < candidates.length; index++) {
        const slot = {
          slotId: slotId(generation, index),
          generationOperationId: generationOperationId(generation),
        }
        extra.push(slot)
        this.openSlots.add(slot.slotId)
      }
      await this.append({
        kind: 'search-plan-extended',
        eventId: `search:plan-extended:gen-${generation}`,
        occurredAt: this.stamp(),
        artifacts: [this.proposalArtifact(generation, candidates)],
        extension: { candidateSlots: extra, operations: [] },
      })
    }
    await this.recordGenerationOperation(generation, candidates, planned - candidates.length)

    const parent = this.registered.get(input.parentSurfaceHash)
    for (const [index, candidate] of candidates.entries()) {
      const candidateId = candidate.surfaceHash
      const slot = slotId(generation, index)
      const surfaceArtifact = this.writeArtifact(
        'candidate-surface',
        `candidate-${candidateId}.json`,
        { surfaceHash: candidateId, surface: candidate.surface, label: candidate.label ?? '' },
      )
      // A parent measured before this ledger opened — the run baseline, or a
      // surface carried in from an earlier ledger — is not an in-file
      // candidate, so a candidate mutating it is a lineage root.
      const ledgerGeneration = parent ? parent.generation + 1 : 0
      await this.append({
        kind: 'candidate-registered',
        eventId: `candidate:${candidateId}`,
        occurredAt: this.stamp(),
        artifacts: [surfaceArtifact],
        slotId: slot,
        generationOperationId: generationOperationId(generation),
        candidateId,
        lineage: {
          lineageNodeId: candidateId,
          parentCandidateIds: parent ? [parent.candidateId] : [],
          generation: ledgerGeneration,
          proposer: this.opts.proposerLabel,
          proposerSource: this.opts.binding.identity.proposer.source,
        },
        surfaces: candidateSurfaces(candidate.surface, surfaceArtifact),
      })
      this.remember({ candidateId, slotId: slot, generation: ledgerGeneration })
    }
    for (let index = candidates.length; index < planned; index++) {
      await this.closeSlot(slotId(generation, index), generationOperationId(generation), {
        code: 'proposal-short',
        message: `generation ${generation} proposed ${candidates.length} of ${planned} planned candidates`,
      })
    }
  }

  /** Append one task attempt per designed cell of each candidate campaign. */
  async recordResults(
    candidates: ReadonlyArray<MeasuredSearchCandidate<TArtifact>>,
  ): Promise<void> {
    for (const candidate of candidates) {
      const registered = this.registered.get(candidate.surfaceHash)
      if (!registered) {
        throw new Error(
          `search ledger: candidate ${candidate.surfaceHash} produced results without a registration`,
        )
      }
      this.coverage.set(registered.candidateId, candidate.coverageComplete)
      const evidence = this.writeArtifact(
        'candidate-cells',
        `cells-${registered.candidateId}.json`,
        {
          surfaceHash: candidate.surfaceHash,
          runDir: candidate.runDir,
          cells: candidate.cells.map((cell) => ({
            cellId: cell.cellId,
            scenarioId: cell.scenarioId,
            rep: cell.rep,
            judgeScores: cell.judgeScores,
            costUsd: cell.costUsd,
            costProvenance: cell.costProvenance,
            tokenUsage: cell.tokenUsage,
            ...(cell.error === undefined ? {} : { error: cell.error, errorStage: cell.errorStage }),
          })),
        },
      )
      const surfaceIds = candidateSurfaces(candidate.surface, evidence).map(
        (surface) => surface.surfaceId,
      )
      for (const cell of candidate.cells) {
        const taskId = taskIdFor(cell.scenarioId, cell.rep)
        const task = this.tasks.find((planned) => planned.taskId === taskId)
        if (!task) {
          throw new Error(`search ledger: cell ${cell.cellId} is outside the planned task set`)
        }
        await this.append({
          kind: 'task-attempted',
          eventId: `attempt:${registered.candidateId}:${taskId}`,
          occurredAt: this.stamp(),
          artifacts: [evidence],
          candidateId: registered.candidateId,
          runId: `${registered.candidateId}:${cell.cellId}`,
          attemptIndex: 0,
          task: { taskId, source: task.source },
          identity: {
            model: this.cellModel(cell),
            agent: this.opts.binding.identity.agent,
            benchmark: task.benchmark,
          },
          outcome: cellOutcome(cell),
          accounting: cellAccounting(cell),
          surfaceEvidence: surfaceIds.map((surfaceId) => surfaceEvidenceFor(surfaceId, evidence)),
        })
      }
    }
  }

  /**
   * Close the search: unreached generations, the selection operation, one
   * decision per candidate, then the terminal event.
   *
   * The terminal event is appended only when canonical replay accounts for the
   * whole planned denominator. An interrupted or partly unscored search stays
   * `in-progress` and its receipt reports the exact gap, instead of claiming a
   * closed search.
   */
  async finish(input: {
    winnerSurfaceHash: string
    generationsRun: number
    runId: string
  }): Promise<SearchHistoryReceipt> {
    const stopped: SearchFailureReason = {
      code: 'generation-not-reached',
      message: `the search stopped after ${input.generationsRun} generation(s)`,
    }
    for (
      let generation = input.generationsRun;
      generation < this.opts.maxGenerations;
      generation++
    ) {
      await this.recordGenerationOperation(generation, [], this.opts.populationSize, stopped)
      for (let index = 0; index < this.opts.populationSize; index++) {
        await this.closeSlot(slotId(generation, index), generationOperationId(generation), stopped)
      }
    }

    const decisions = this.writeArtifact('search-decisions', 'decisions.json', {
      winnerSurfaceHash: input.winnerSurfaceHash,
      candidates: this.order.map((entry) => entry.candidateId),
    })
    await this.append({
      kind: 'search-operation-recorded',
      eventId: 'operation:selection',
      occurredAt: this.stamp(),
      artifacts: [decisions],
      operationId: 'selection',
      operationKind: 'selection',
      execution: { kind: 'deterministic', source: this.opts.binding.identity.search },
      outcome: { status: 'completed' },
      accounting: {
        tokens: { status: 'known', inputTokens: 0, outputTokens: 0, cachedTokens: 0 },
        cost: { status: 'known', usd: 0, source: 'free' },
      },
    })

    const winner = this.registered.get(input.winnerSurfaceHash)
    for (const entry of this.order) {
      await this.append({
        kind: 'candidate-decided',
        eventId: `decision:${entry.candidateId}`,
        occurredAt: this.stamp(),
        artifacts: [decisions],
        candidateId: entry.candidateId,
        decision:
          winner?.candidateId === entry.candidateId
            ? { status: 'selected' }
            : {
                status: 'rejected',
                reason:
                  this.coverage.get(entry.candidateId) === false
                    ? {
                        code: 'coverage-incomplete',
                        message: 'the candidate missed a designed cell and could not be ranked',
                      }
                    : {
                        code: 'not-promoted',
                        message: 'the candidate did not beat the incumbent',
                      },
              },
      })
    }

    const replay = await this.opts.binding.ledger.replay()
    const { missingCandidateSlots, missingTaskOutcomes, missingOperations } = replay.audit.expected
    if (
      missingCandidateSlots.length === 0 &&
      missingTaskOutcomes.length === 0 &&
      missingOperations.length === 0 &&
      replay.audit.decisions.pending === 0
    ) {
      await this.append({
        kind: 'search-completed',
        eventId: 'search:completed',
        occurredAt: this.stamp(),
        artifacts: [decisions],
        result: winner
          ? { status: 'selected', candidateId: winner.candidateId }
          : {
              status: 'all-rejected',
              reason: {
                code: 'no-promoted-candidate',
                message: 'no candidate beat the incumbent on the designed denominator',
              },
            },
      })
    }
    return this.receipt(input.runId)
  }

  /** Bounded receipt over the exact ledger bytes this run produced. */
  async receipt(runId: string): Promise<SearchHistoryReceipt> {
    const { ledger } = this.opts.binding
    const replay = await ledger.replay()
    const bytes = replay.entries.map((entry) => `${canonicalString(entry)}\n`).join('')
    return createSearchHistoryReceipt({
      producerId: this.opts.proposerLabel,
      runId,
      ledger: {
        role: 'search-ledger',
        uri: `file://${ledger.path}`,
        sha256: hashCanonical(bytes),
        byteLength: new TextEncoder().encode(bytes).byteLength,
      },
      replay,
    })
  }

  /** Read an existing ledger for this run so a resume continues it. */
  private async hydrate(): Promise<void> {
    const replay = await this.opts.binding.ledger.replay()
    for (const entry of replay.entries) {
      this.durableEventIds.add(entry.event.eventId)
      const stamped = Date.parse(entry.event.occurredAt)
      if (stamped > this.lastStampMs) this.lastStampMs = stamped
    }
    for (const slot of replay.plan?.plan.candidateSlots ?? []) this.openSlots.add(slot.slotId)
    for (const extension of replay.planExtensions) {
      for (const slot of extension.extension.candidateSlots) this.openSlots.add(slot.slotId)
    }
    for (const closed of replay.closedCandidateSlots) this.openSlots.delete(closed.slotId)
    for (const candidate of replay.candidates) {
      this.remember({
        candidateId: candidate.candidateId,
        slotId: candidate.slotId,
        generation: candidate.lineage.generation,
      })
      this.openSlots.delete(candidate.slotId)
    }
  }

  private async plan(): Promise<void> {
    const candidateSlots: SearchCandidateSlot[] = []
    const operations: SearchPlannedOperation[] = [{ operationId: 'selection', kind: 'selection' }]
    for (let generation = 0; generation < this.opts.maxGenerations; generation++) {
      operations.push({
        operationId: generationOperationId(generation),
        kind: 'candidate-generation',
      })
      for (let index = 0; index < this.opts.populationSize; index++) {
        const slot = {
          slotId: slotId(generation, index),
          generationOperationId: generationOperationId(generation),
        }
        candidateSlots.push(slot)
        if (!this.registeredSlot(slot.slotId)) this.openSlots.add(slot.slotId)
      }
    }
    await this.append({
      kind: 'search-planned',
      eventId: 'search:plan',
      occurredAt: this.stamp(),
      artifacts: [
        this.writeArtifact('search-plan', 'plan.json', {
          runDir: this.opts.runDir,
          splitDigest: this.opts.splitDigest,
          maxGenerations: this.opts.maxGenerations,
          populationSize: this.opts.populationSize,
          tasks: this.tasks,
        }),
      ],
      plan: { candidateSlots, tasks: this.tasks, operations },
    })
  }

  private registeredSlot(slot: string): boolean {
    return this.order.some((entry) => entry.slotId === slot)
  }

  private remember(entry: RegisteredCandidate): void {
    if (this.registered.has(entry.candidateId)) return
    this.registered.set(entry.candidateId, entry)
    this.order.push(entry)
  }

  private async recordGenerationOperation(
    generation: number,
    candidates: ReadonlyArray<ProposedSearchCandidate>,
    unfilled: number,
    failure?: SearchFailureReason,
  ): Promise<void> {
    const shortfall: SearchFailureReason = {
      code: 'proposal-short',
      message: `generation ${generation} left ${unfilled} planned candidate slot(s) unfilled`,
    }
    const outcome: SearchOperationRecordedEvent['outcome'] = failure
      ? { status: 'failed', failure }
      : unfilled <= 0
        ? { status: 'completed' }
        : candidates.length === 0
          ? { status: 'failed', failure: shortfall }
          : { status: 'partial', failure: shortfall }
    await this.append({
      kind: 'search-operation-recorded',
      eventId: `operation:${generationOperationId(generation)}`,
      occurredAt: this.stamp(),
      artifacts: [this.proposalArtifact(generation, candidates)],
      operationId: generationOperationId(generation),
      operationKind: 'candidate-generation',
      execution: this.opts.binding.identity.proposer,
      outcome,
      accounting: this.proposalAccounting(),
    })
  }

  private async closeSlot(
    slot: string,
    generationOperation: string,
    reason: SearchFailureReason,
  ): Promise<void> {
    if (!this.openSlots.has(slot)) return
    this.openSlots.delete(slot)
    await this.append({
      kind: 'candidate-slot-closed',
      eventId: `slot-closed:${slot}`,
      occurredAt: this.stamp(),
      artifacts: [this.writeArtifact('closed-slot', `slot-${slot}.json`, { slot, reason })],
      slotId: slot,
      generationOperationId: generationOperation,
      reason,
    })
  }

  /** Spend booked to candidate generation since the previous generation. */
  private proposalAccounting(): SearchAttemptAccounting {
    const receipts = this.opts.costLedger.list({ phase: 'search.proposal' })
    const fresh = receipts.slice(this.proposalReceiptCount)
    this.proposalReceiptCount = receipts.length
    return receiptAccounting(fresh)
  }

  private cellModel(cell: CampaignCellResult<TArtifact>): SearchModelIdentity {
    const resolved = cell.resolvedModel
    if (resolved === undefined) return this.opts.binding.identity.model
    if (!modelHasSnapshot(resolved)) {
      throw new Error(
        `search ledger: cell ${cell.cellId} ran model '${resolved}', which carries no immutable snapshot; the ledger cannot record a moving alias as execution identity`,
      )
    }
    return { provider: this.opts.binding.identity.model.provider, snapshot: resolved }
  }

  private proposalArtifact(
    generation: number,
    candidates: ReadonlyArray<ProposedSearchCandidate>,
  ): SearchArtifactRef {
    return this.writeArtifact('candidate-proposal', `proposal-gen-${generation}.json`, {
      generation,
      candidates: candidates.map((candidate) => ({
        surfaceHash: candidate.surfaceHash,
        label: candidate.label ?? '',
      })),
    })
  }

  /** Write one canonical evidence document and return its content address. */
  private writeArtifact(role: string, name: string, body: unknown): SearchArtifactRef {
    const directory = `${this.opts.runDir}/${SEARCH_LEDGER_DIR}`
    const path = `${directory}/${name}`
    const contents = canonicalString(body)
    this.opts.storage.ensureDir(directory)
    this.opts.storage.write(path, contents)
    return {
      role,
      uri: `file://${path}`,
      sha256: hashCanonical(contents),
      byteLength: new TextEncoder().encode(contents).byteLength,
    }
  }

  private async append(event: SearchLedgerEvent): Promise<void> {
    if (this.durableEventIds.has(event.eventId)) return
    await this.opts.binding.ledger.append(event)
    this.durableEventIds.add(event.eventId)
  }

  /** Non-decreasing ISO stamps; the ledger refuses an event that moves back. */
  private stamp(): string {
    const now = Date.now()
    this.lastStampMs = now > this.lastStampMs ? now : this.lastStampMs + 1
    return new Date(this.lastStampMs).toISOString()
  }
}

/** One task per designed (scenario, replicate) cell. */
function plannedTasks<TScenario extends Scenario>(
  scenarios: ReadonlyArray<TScenario>,
  reps: number,
  runDir: string,
  splitDigest: `sha256:${string}`,
): SearchPlannedTask[] {
  const tasks: SearchPlannedTask[] = []
  for (const scenario of scenarios) {
    for (let rep = 0; rep < reps; rep++) {
      tasks.push({
        taskId: taskIdFor(scenario.id, rep),
        source: { uri: `scenario://${scenario.id}`, revision: hashCanonical(scenario) },
        benchmark: { uri: `campaign://${runDir}`, revision: splitDigest },
        maxAttempts: 1,
      })
    }
  }
  return tasks
}

function taskIdFor(scenarioId: string, rep: number): string {
  return `${scenarioId}#rep-${rep}`
}

function slotId(generation: number, index: number): string {
  return `gen-${generation}-slot-${index}`
}

function generationOperationId(generation: number): string {
  return `candidate-generation:gen-${generation}`
}

/** Declared surfaces of one candidate. A component surface declares one
 *  surface per named component, so per-component evidence stays addressable. */
function candidateSurfaces(
  surface: MutableSurface,
  artifact: SearchArtifactRef,
): SearchCandidateSurface[] {
  if (typeof surface === 'string') return [{ surfaceId: 'prompt', kind: 'prompt', artifact }]
  if (surface.kind === 'code') return [{ surfaceId: 'code', kind: 'code', artifact }]
  return Object.keys(surface.components)
    .sort()
    .map((name) => ({ surfaceId: `component:${name}`, kind: 'prompt' as const, artifact }))
}

/** The campaign measures a candidate surface as a whole, so per-surface
 *  attribution stays unmeasured instead of inventing a per-component delta. */
function surfaceEvidenceFor(surfaceId: string, evidence: SearchArtifactRef): SearchSurfaceEvidence {
  return {
    surfaceId,
    fired: true,
    firingCount: 1,
    effect: {
      status: 'not-measured',
      reason: 'the campaign measures the candidate surface as a whole, not per surface',
    },
    evidence: [evidence],
  }
}

function cellOutcome<TArtifact>(cell: CampaignCellResult<TArtifact>): SearchTaskOutcome {
  const scores = Object.entries(cell.judgeScores).filter(
    ([, score]) => score.failed !== true && Number.isFinite(score.composite),
  )
  if (cell.error !== undefined || scores.length === 0) {
    return {
      status: 'errored',
      metrics: {},
      error: {
        code: cell.errorStage ?? 'unscored',
        message: cell.error ?? 'the cell produced no complete judge score',
        retryable: false,
      },
    }
  }
  const composite = scores.reduce((sum, [, score]) => sum + score.composite, 0) / scores.length
  const metrics: Record<string, number> = { composite }
  for (const [judge, score] of scores) metrics[`judge.${judge}`] = score.composite
  return { status: 'passed', score: composite, metrics }
}

function cellAccounting<TArtifact>(cell: CampaignCellResult<TArtifact>): SearchAttemptAccounting {
  const usage = cell.tokenUsage
  return {
    tokens:
      usage.tokensKnown === false
        ? { status: 'unknown', reason: 'a paid call in this cell reported no token usage' }
        : {
            status: 'known',
            inputTokens: usage.input,
            outputTokens: usage.output,
            cachedTokens: 0,
          },
    cost:
      cell.costProvenance.kind === 'uncaptured'
        ? {
            status: 'unknown',
            knownLowerBoundUsd: cell.costUsd,
            reason: 'the cell recorded spend without a provider receipt',
          }
        : {
            status: 'known',
            usd: cell.costUsd,
            source: cell.costProvenance.kind === 'observed' ? 'provider' : 'pricing-table',
          },
  }
}

function receiptAccounting(receipts: ReadonlyArray<CostReceipt>): SearchAttemptAccounting {
  let inputTokens = 0
  let outputTokens = 0
  let cachedTokens = 0
  let usd = 0
  let tokensKnown = true
  let costKnown = true
  for (const receipt of receipts) {
    if (receipt.usageUnknown === true) tokensKnown = false
    inputTokens += receipt.inputTokens
    outputTokens += receipt.outputTokens
    cachedTokens += receipt.cachedTokens ?? 0
    if (receipt.costUnknown) costKnown = false
    else usd += receipt.costUsd
  }
  return {
    tokens: tokensKnown
      ? { status: 'known', inputTokens, outputTokens, cachedTokens }
      : { status: 'unknown', reason: 'a candidate-generation call reported no token usage' },
    cost: costKnown
      ? { status: 'known', usd, source: usd === 0 ? 'free' : 'provider' }
      : {
          status: 'unknown',
          knownLowerBoundUsd: usd,
          reason: 'a candidate-generation call recorded no provider cost',
        },
  }
}

/**
 * Record an optimizer's own candidate graph into the same ledger.
 *
 * A complete optimization method searches inside its own process and reports
 * one artifact when it finishes: the candidate population, with each
 * candidate's parents and its score per selection scenario. This turns that
 * artifact into the canonical event stream, so a first-party method returns
 * the same `SearchHistoryReceipt` the in-process loop returns, and
 * `compareOptimizationMethods({ searchHistoryPolicy: 'require-complete' })`
 * accepts it.
 *
 * A candidate the optimizer left unscored on a planned scenario leaves the
 * planned denominator open, so the receipt reports the gap instead of closing
 * the search.
 */
export async function recordCandidatePopulationSearch<TScenario extends Scenario>(input: {
  ledger: SearchLedger
  storage: CampaignStorage
  runDir: string
  identity: SearchRunIdentity
  population: GepaCandidatePopulationArtifact
  /** Scenarios the optimizer selected on. Must cover the population's ids. */
  scenarios: ReadonlyArray<TScenario>
  /** Spend the optimizer booked to its own candidate generation. */
  generationAccounting: SearchAttemptAccounting
  producerId: string
  runId: string
}): Promise<SearchHistoryReceipt> {
  const { population, ledger, identity } = input
  const stamps = monotonicStamps()
  const writeArtifact = artifactWriter(input.storage, input.runDir)
  const populationArtifact: SearchArtifactRef = {
    role: 'candidate-population',
    uri: `file://${population.summary.path}`,
    sha256: population.summary.sha256,
    byteLength: population.summary.bytes,
  }
  const tasks = input.scenarios
    .filter((scenario) => population.summary.scenarioIds.includes(scenario.id))
    .map((scenario) => ({
      taskId: taskIdFor(scenario.id, 0),
      source: { uri: `scenario://${scenario.id}`, revision: hashCanonical(scenario) },
      benchmark: { uri: `optimizer://${input.producerId}`, revision: population.summary.sha256 },
      maxAttempts: 1,
    }))
  if (tasks.length !== population.summary.scenarioIds.length) {
    throw new Error(
      `search ledger: the candidate population scored ${population.summary.scenarioIds.length} scenarios, but ${tasks.length} were supplied`,
    )
  }

  const generationOperation = 'candidate-generation:population'
  await ledger.append({
    kind: 'search-planned',
    eventId: 'search:plan',
    occurredAt: stamps(),
    artifacts: [populationArtifact],
    plan: {
      candidateSlots: population.candidates.map((candidate) => ({
        slotId: `candidate-${candidate.index}`,
        generationOperationId: generationOperation,
      })),
      tasks,
      operations: [
        { operationId: generationOperation, kind: 'candidate-generation' },
        { operationId: 'selection', kind: 'selection' },
      ],
    },
  })
  await ledger.append({
    kind: 'search-operation-recorded',
    eventId: `operation:${generationOperation}`,
    occurredAt: stamps(),
    artifacts: [populationArtifact],
    operationId: generationOperation,
    operationKind: 'candidate-generation',
    execution: identity.proposer,
    outcome: { status: 'completed' },
    accounting: input.generationAccounting,
  })

  const candidateIds = new Map<number, string>()
  const depths = new Map<number, number>()
  for (const candidate of population.candidates) {
    const parents = candidate.parentIndices.filter((index): index is number => index !== null)
    const candidateId = candidate.candidateHash
    candidateIds.set(candidate.index, candidateId)
    const depth =
      parents.length === 0 ? 0 : Math.max(...parents.map((index) => depths.get(index) ?? 0)) + 1
    depths.set(candidate.index, depth)
    const surfaceArtifact = writeArtifact(
      'candidate-surface',
      `candidate-${candidate.index}.json`,
      {
        index: candidate.index,
        candidateDigest: candidate.candidateDigest,
        candidate: candidate.candidate,
      },
    )
    await ledger.append({
      kind: 'candidate-registered',
      eventId: `candidate:${candidate.index}`,
      occurredAt: stamps(),
      artifacts: [surfaceArtifact],
      slotId: `candidate-${candidate.index}`,
      generationOperationId: generationOperation,
      candidateId,
      lineage: {
        lineageNodeId: candidateId.slice(0, 16),
        parentCandidateIds: parents.map((index) => {
          const parentId = candidateIds.get(index)
          if (!parentId) {
            throw new Error(
              `search ledger: candidate ${candidate.index} names parent ${index}, which precedes no registered candidate`,
            )
          }
          return parentId
        }),
        generation: depth,
        proposer: input.producerId,
        proposerSource: identity.proposer.source,
      },
      surfaces: candidateSurfaces(externalSurface(candidate.candidate), surfaceArtifact),
    })

    const surfaceIds = candidateSurfaces(externalSurface(candidate.candidate), surfaceArtifact).map(
      (surface) => surface.surfaceId,
    )
    for (const score of candidate.selectionScores) {
      const task = tasks.find((planned) => planned.taskId === taskIdFor(score.scenarioId, 0))
      if (!task) {
        throw new Error(
          `search ledger: candidate ${candidate.index} scored unplanned scenario ${score.scenarioId}`,
        )
      }
      await ledger.append({
        kind: 'task-attempted',
        eventId: `attempt:${candidate.index}:${task.taskId}`,
        occurredAt: stamps(),
        artifacts: [populationArtifact],
        candidateId,
        runId: `${input.runId}:${candidate.index}:${task.taskId}`,
        attemptIndex: 0,
        task: { taskId: task.taskId, source: task.source },
        identity: {
          model: identity.model,
          agent: identity.agent,
          benchmark: task.benchmark,
        },
        outcome: { status: 'passed', score: score.score, metrics: { composite: score.score } },
        accounting: {
          tokens: {
            status: 'unknown',
            reason: 'the optimizer reports no token usage per candidate evaluation',
          },
          cost: {
            status: 'unknown',
            knownLowerBoundUsd: 0,
            reason: 'the optimizer reports no cost per candidate evaluation',
          },
        },
        surfaceEvidence: surfaceIds.map((surfaceId) =>
          surfaceEvidenceFor(surfaceId, populationArtifact),
        ),
      })
    }
  }

  await ledger.append({
    kind: 'search-operation-recorded',
    eventId: 'operation:selection',
    occurredAt: stamps(),
    artifacts: [populationArtifact],
    operationId: 'selection',
    operationKind: 'selection',
    execution: { kind: 'deterministic', source: identity.search },
    outcome: { status: 'completed' },
    accounting: {
      tokens: { status: 'known', inputTokens: 0, outputTokens: 0, cachedTokens: 0 },
      cost: { status: 'known', usd: 0, source: 'free' },
    },
  })

  const winnerId = candidateIds.get(population.bestIndex)
  for (const candidate of population.candidates) {
    await ledger.append({
      kind: 'candidate-decided',
      eventId: `decision:${candidate.index}`,
      occurredAt: stamps(),
      artifacts: [populationArtifact],
      candidateId: candidateIds.get(candidate.index)!,
      decision:
        candidate.index === population.bestIndex
          ? { status: 'selected' }
          : {
              status: 'rejected',
              reason: {
                code: 'not-selected',
                message: 'the optimizer selected another candidate',
              },
            },
    })
  }

  const replay = await ledger.replay()
  const { missingCandidateSlots, missingTaskOutcomes, missingOperations } = replay.audit.expected
  if (
    winnerId &&
    missingCandidateSlots.length === 0 &&
    missingTaskOutcomes.length === 0 &&
    missingOperations.length === 0 &&
    replay.audit.decisions.pending === 0
  ) {
    await ledger.append({
      kind: 'search-completed',
      eventId: 'search:completed',
      occurredAt: stamps(),
      artifacts: [populationArtifact],
      result: { status: 'selected', candidateId: winnerId },
    })
  }

  const final = await ledger.replay()
  const bytes = final.entries.map((entry) => `${canonicalString(entry)}\n`).join('')
  return createSearchHistoryReceipt({
    producerId: input.producerId,
    runId: input.runId,
    ledger: {
      role: 'search-ledger',
      uri: `file://${ledger.path}`,
      sha256: hashCanonical(bytes),
      byteLength: new TextEncoder().encode(bytes).byteLength,
    },
    replay: final,
  })
}

/** An optimizer candidate as the canonical mutable surface it represents. */
function externalSurface(candidate: ExternalTextCandidate): MutableSurface {
  return typeof candidate === 'string' ? candidate : { kind: 'components', components: candidate }
}

function artifactWriter(storage: CampaignStorage, runDir: string) {
  const directory = `${runDir}/${SEARCH_LEDGER_DIR}`
  return (role: string, name: string, body: unknown): SearchArtifactRef => {
    const contents = canonicalString(body)
    storage.ensureDir(directory)
    storage.write(`${directory}/${name}`, contents)
    return {
      role,
      uri: `file://${directory}/${name}`,
      sha256: hashCanonical(contents),
      byteLength: new TextEncoder().encode(contents).byteLength,
    }
  }
}

/** Non-decreasing ISO stamps; the ledger refuses an event that moves back. */
function monotonicStamps(): () => string {
  let last = 0
  return () => {
    const now = Date.now()
    last = now > last ? now : last + 1
    return new Date(last).toISOString()
  }
}
