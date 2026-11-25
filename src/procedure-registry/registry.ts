/**
 * The procedure registry: a projection, not a service.
 *
 * A procedure is anything an agent can be given and have taken away: a skill, a
 * workflow, a workflow whose steps are workflows, or a skill whose object is
 * other procedures. A version of it is named by the sha256 of its materialized
 * files. This module reads search ledgers and recorded sessions and answers,
 * for each version: where it came from, every time it ran, what that cost, what
 * came of the change it was part of, and every decision taken on it.
 *
 * Nothing here writes. The search ledger stays the one record of a search and
 * the session records stay the one record of a session; the registry is the
 * join of the two on the version digest, rebuilt from them on demand.
 *
 * Three things are kept apart from zero throughout, as in the sources: a
 * measure no execution reported, a change whose outcome the caller did not
 * supply, and a session whose reader does not record changes.
 */

import type { SearchEdgeAttribution, SearchEdgeOperator } from '../campaign/search-ledger-types'
import type { SearchStateView } from '../campaign/search-state'
import type { SearchNode } from '../campaign/search-state-types'
import { ValidationError } from '../errors'
import type {
  SkillInvocationEvent,
  SkillInvoker,
  SkillSessionSource,
  SkillUsageReportOptions,
} from '../skill-usage'
import { afterInvocation, instant } from '../skill-usage/report'
import {
  type ChangeOutcome,
  type ChangeOutcomeIndex,
  type ChangeOutcomeReading,
  HOTFIX_WINDOW_DAYS,
  type InvocationChanges,
  indexChangeOutcomes,
  joinInvocationToChanges,
  type SessionChanges,
} from './change-outcome'

/** What a procedure is. The registry never infers it; the caller classifies, and an unclassified version says so. */
export type ProcedureKind = 'skill' | 'workflow' | 'higher-order-workflow' | 'operator-skill'

export interface ProcedureNodeIdentity {
  /** The version digest when the node's artifact is not the procedure's own bytes, for example a profile that mounts a skill. */
  digest?: string
  kind?: ProcedureKind
  name?: string
}

export interface ProcedureRegistryInput {
  searches?: Iterable<SearchStateView>
  sessions?: SkillSessionSource
  outcomes?: Iterable<ChangeOutcome>
}

export interface ProcedureRegistryOptions extends SkillUsageReportOptions {
  /** Which procedure a search node is. Default: the node's own artifact digest, unclassified. */
  procedureOfNode?: (node: SearchNode, search: SearchStateView) => ProcedureNodeIdentity | null
  /** What kind of procedure a session's skill is. Default: `skill`. */
  kindOfSkill?: (skill: string) => ProcedureKind
}

/** A measure summed over the executions that reported it. */
export interface MeasureTotal {
  sum: number
  /** Executions that reported it. */
  measured: number
  /** Executions that did not: they are not in `sum`, and are not zero. */
  unmeasured: number
}

export interface ExecutionMeasures {
  tokens: number | null
  /** null where no model call could be priced: unknown, not free. */
  usd: number | null
  wallMs: number | null
}

export interface CellExecution extends ExecutionMeasures {
  source: 'search-cell'
  searchId: string
  nodeId: string
  cellId: string
  split: string
  stage: string
  /** `passed`, `failed` or `errored`; null for a cell never settled. */
  outcome: string | null
  score: number | null
}

export interface SessionExecution extends ExecutionMeasures {
  source: 'session'
  harness: string
  sessionId: string
  callId: string
  skill: string
  invoker: SkillInvoker
  at: string | null
  /** The harness refused the call; null when no result is recorded. */
  failed: boolean | null
  /** What the invocation's changes came to. Tokens, cost and wall time run from the invocation to the session's end. */
  changes: InvocationChanges
}

export type ProcedureExecution = CellExecution | SessionExecution

export interface ProcedureEdge {
  searchId: string
  edgeId: string
  operator: SearchEdgeOperator
  attribution: SearchEdgeAttribution
  proposer: { kind: string; name: string } | null
  parents: Array<{ searchId: string; nodeId: string; digest: string | null }>
  /** A later edge into a node that already existed: the same content proposed again. */
  reproposal: boolean
}

export interface ProcedureDecision {
  searchId: string
  nodeId: string
  source: 'node-decided' | 'claim'
  /** `advanced`, `pruned`, `invalid`, `finalist`, `selected`, `rejected`; or the claim's `ship`, `hold`, `test-cannot-resolve`. */
  status: string
  rung: number | null
  rule: string | null
  reason: string
  /** The node's latest decision in its search; earlier ones are history. */
  current: boolean
}

export interface SearchAppearance {
  searchId: string
  nodeId: string
  subject: string
  closed: boolean
  /** The node's latest decision, or null while undecided. */
  status: string | null
}

export interface ChangeCounts {
  yes: number
  no: number
  /** No outcome supplied, or that field unknown. */
  unknown: number
}

export interface ProcedureChanges {
  /** Counted invocations in sessions. */
  invocations: number
  joined: number
  none: number
  notRecorded: number
  /** Changes the joined invocations are part of, each counted once. */
  distinctChanges: number
  /** Of those, the changes the caller supplied an outcome for. */
  withOutcome: number
  merged: ChangeCounts
  gateGreenFirstTry: ChangeCounts
  hotfixed: ChangeCounts
}

export interface ProcedureVersion {
  /** `sha256:<hex>`, or `unversioned:<skill>` when no invocation recorded the text it loaded. */
  key: string
  digest: string | null
  names: string[]
  /** null: unclassified, never guessed. */
  kind: ProcedureKind | null
  /** Digests of the lineage parents. A parent whose digest is unknown is absent here and null in its edge. */
  parents: string[]
  edges: ProcedureEdge[]
  searches: SearchAppearance[]
  decisions: ProcedureDecision[]
  cells: {
    count: number
    passed: number
    failed: number
    errored: number
    tokens: MeasureTotal
    usd: MeasureTotal
    wallMs: MeasureTotal
  }
  sessions: {
    invocations: number
    tokens: MeasureTotal
    usd: MeasureTotal
    wallMs: MeasureTotal
    changes: ProcedureChanges
  }
  executions: ProcedureExecution[]
}

export interface ChangeJoinSummary {
  /** The definition of "needed a hot-fix" every outcome was held to. */
  hotfixWindowDays: number
  invocations: number
  joined: number
  none: number
  notRecorded: number
  /** joined / invocations; null when there are none. This is the share the program's first check reads. */
  joinedShare: number | null
  /** Joined invocations with an outcome for at least one of their changes. */
  withOutcome: number
  withOutcomeShare: number | null
  distinctChanges: number
  outcomesSupplied: number
  outcomesInWrongWindow: number
}

export interface ProcedureRegistry {
  searches: { read: number; closed: number }
  sessions: { read: number; unreadable: number; withInvocation: number }
  invocations: number
  changeJoin: ChangeJoinSummary
  versions: ProcedureVersion[]
  unreadable: Array<{ source: string; error: string }>
  notes: string[]
}

const NOTES = [
  'Session executions measure from the invocation to the end of its session, as `skill-usage` does, so a session that invokes several procedures counts its later work under each and the totals overlap across versions.',
  'Search-cell and session measures are different quantities (a cell is one task, a session is open-ended) and are never added together.',
  'An invocation joins the changes of its own session and of the sessions that spawned it. It joins every change the session produced, before and after the invocation.',
]

interface Builder {
  key: string
  digest: string | null
  names: Set<string>
  kind: ProcedureKind | null
  parents: Set<string>
  edges: ProcedureEdge[]
  searches: SearchAppearance[]
  decisions: ProcedureDecision[]
  executions: ProcedureExecution[]
}

function normalizeDigest(value: string): string {
  const hex = value.startsWith('sha256:') ? value.slice('sha256:'.length) : value
  if (!/^[0-9a-f]{64}$/.test(hex)) {
    throw new ValidationError(`a procedure digest is a sha256, got ${JSON.stringify(value)}`)
  }
  return `sha256:${hex}`
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

function emptyMeasure(): MeasureTotal {
  return { sum: 0, measured: 0, unmeasured: 0 }
}

function addMeasure(total: MeasureTotal, value: number | null): void {
  if (value === null) {
    total.unmeasured += 1
  } else {
    total.sum += value
    total.measured += 1
  }
}

function emptyCounts(): ChangeCounts {
  return { yes: 0, no: 0, unknown: 0 }
}

function count(counts: ChangeCounts, value: boolean | null): void {
  if (value === null) counts.unknown += 1
  else if (value) counts.yes += 1
  else counts.no += 1
}

/** The caller's reading of one change field, across the readings of every outcome the change has. */
function pick(
  readings: ChangeOutcomeReading | undefined,
  field: 'merged' | 'gateGreenFirstTry' | 'hotfixed',
): boolean | null {
  return readings === undefined ? null : readings[field]
}

function summarizeChanges(executions: readonly SessionExecution[], index: ChangeOutcomeIndex) {
  const changes: ProcedureChanges = {
    invocations: executions.length,
    joined: 0,
    none: 0,
    notRecorded: 0,
    distinctChanges: 0,
    withOutcome: 0,
    merged: emptyCounts(),
    gateGreenFirstTry: emptyCounts(),
    hotfixed: emptyCounts(),
  }
  const refs = new Set<string>()
  for (const execution of executions) {
    const joined = execution.changes
    if (joined.status === 'joined') {
      changes.joined += 1
      for (const ref of joined.refs) refs.add(ref)
    } else if (joined.status === 'none') {
      changes.none += 1
    } else {
      changes.notRecorded += 1
    }
  }
  changes.distinctChanges = refs.size
  for (const ref of [...refs].sort(compareText)) {
    const reading = index.byRef.get(ref)
    if (reading !== undefined) changes.withOutcome += 1
    count(changes.merged, pick(reading, 'merged'))
    count(changes.gateGreenFirstTry, pick(reading, 'gateGreenFirstTry'))
    count(changes.hotfixed, pick(reading, 'hotfixed'))
  }
  return changes
}

class Registry {
  private readonly builders = new Map<string, Builder>()

  builder(key: string): Builder {
    let builder = this.builders.get(key)
    if (builder === undefined) {
      builder = {
        key,
        digest: key.startsWith('sha256:') ? key : null,
        names: new Set(),
        kind: null,
        parents: new Set(),
        edges: [],
        searches: [],
        decisions: [],
        executions: [],
      }
      this.builders.set(key, builder)
    }
    return builder
  }

  all(): Builder[] {
    return [...this.builders.values()]
  }
}

interface NodeRef {
  searchId: string
  nodeId: string
}

const nodeKey = (searchId: string, nodeId: string): string => `${searchId}\u0000${nodeId}`

function addSearch(
  registry: Registry,
  search: SearchStateView,
  keys: ReadonlyMap<string, string>,
  options: ProcedureRegistryOptions,
): void {
  const subject = search.header?.subject ?? ''
  const closed = search.closed !== null
  const claim = search.closed?.claim ?? null
  const rootNodeId = search.rootNodeId

  for (const node of search.nodes()) {
    const key = keys.get(nodeKey(search.searchId, node.nodeId)) as string
    const identity = options.procedureOfNode?.(node, search) ?? null
    const builder = registry.builder(key)
    if (identity?.kind !== undefined) builder.kind = identity.kind
    if (identity?.name !== undefined) builder.names.add(identity.name)
    const latest = node.decisions.at(-1)
    builder.searches.push({
      searchId: search.searchId,
      nodeId: node.nodeId,
      subject,
      closed,
      status: latest === undefined ? null : latest.decision.status,
    })

    const resolve = (ref: NodeRef): string | null => {
      const parentKey = keys.get(nodeKey(ref.searchId, ref.nodeId))
      return parentKey?.startsWith('sha256:') ? parentKey : null
    }
    for (const parent of node.parents) {
      const digest = resolve(parent)
      if (digest !== null) builder.parents.add(digest)
    }
    node.edgeIds.forEach((edgeId, position) => {
      const edge = search.edge(edgeId)
      if (edge === undefined) return
      builder.edges.push({
        searchId: search.searchId,
        edgeId,
        operator: edge.operator,
        attribution: edge.attribution,
        proposer:
          edge.proposer === null ? null : { kind: edge.proposer.kind, name: edge.proposer.name },
        parents: edge.parents.map((parent) => ({
          searchId: parent.searchId,
          nodeId: parent.nodeId,
          digest: resolve(parent),
        })),
        reproposal: position > 0,
      })
    })

    node.decisions.forEach((record, position) => {
      builder.decisions.push({
        searchId: search.searchId,
        nodeId: node.nodeId,
        source: 'node-decided',
        status: record.decision.status,
        rung: record.decision.status === 'advanced' ? record.decision.rung : null,
        rule: record.rule,
        reason: record.reason,
        current: position === node.decisions.length - 1,
      })
    })

    for (const cell of search.cells({ nodeId: node.nodeId })) {
      // A cell that never ran, or never settled, is not an execution.
      if (cell.attempts === 0) continue
      builder.executions.push({
        source: 'search-cell',
        searchId: search.searchId,
        nodeId: node.nodeId,
        cellId: cell.cellId,
        split: cell.split,
        stage: cell.stage,
        outcome: cell.outcome,
        score: cell.score,
        tokens: cell.tokensKnown
          ? cell.tokens.inputTokens + cell.tokens.outputTokens + cell.tokens.cachedTokens
          : null,
        usd: cell.costKnown ? cell.spentUsd : null,
        wallMs: cell.wallKnown ? cell.wallMs : null,
      })
    }
  }

  // The claim is the search's own ship-or-hold decision. A hold or an
  // unresolved test keeps the root, so that is the node it is about.
  if (claim !== null) {
    const nodeId = claim.selected ?? rootNodeId
    const key = nodeId === null ? undefined : keys.get(nodeKey(search.searchId, nodeId))
    if (nodeId !== null && key !== undefined) {
      registry.builder(key).decisions.push({
        searchId: search.searchId,
        nodeId,
        source: 'claim',
        status: claim.decision,
        rung: null,
        rule: claim.rule.uri,
        reason: claim.reason,
        current: true,
      })
    }
  }
}

interface PendingInvocation {
  builderKey: string
  sessionId: string
  harness: string
  event: SkillInvocationEvent
  measures: ExecutionMeasures
}

/**
 * Build the registry from search ledgers, recorded sessions and the outcomes of
 * the changes those sessions produced. Any of the three may be absent.
 *
 * An invocation is counted once per call id across the whole source, and with
 * `sinceMs` only invocations at or after it count, exactly as `skill-usage`
 * counts them; an undated invocation cannot be placed in the window and is
 * left out. Versions are ordered by executions, most first, then by key.
 */
export async function buildProcedureRegistry(
  input: ProcedureRegistryInput,
  options: ProcedureRegistryOptions = {},
): Promise<ProcedureRegistry> {
  if (options.sinceMs !== undefined && !Number.isFinite(options.sinceMs)) {
    throw new ValidationError(
      `buildProcedureRegistry: sinceMs must be finite, got ${options.sinceMs}`,
    )
  }
  const outcomes = indexChangeOutcomes(input.outcomes ?? [])
  const registry = new Registry()

  const searches = [...(input.searches ?? [])]
  const keys = new Map<string, string>()
  for (const search of searches) {
    for (const node of search.nodes()) {
      const identity = options.procedureOfNode?.(node, search) ?? null
      keys.set(
        nodeKey(search.searchId, node.nodeId),
        normalizeDigest(identity?.digest ?? node.artifactDigest),
      )
    }
  }
  for (const search of searches) addSearch(registry, search, keys, options)

  const sessionChanges = new Map<string, SessionChanges>()
  const pending: PendingInvocation[] = []
  const unreadable: Array<{ source: string; error: string }> = []
  const seenCalls = new Set<string>()
  const sessions = { read: 0, unreadable: 0, withInvocation: 0 }

  const versionDigest = (event: SkillInvocationEvent): string | null => {
    if (event.version !== null) return event.version.bodySha256
    if (event.skillFile === null || options.readSkillFile === undefined) return null
    const file = options.readSkillFile(event.skillFile)
    return file.succeeded ? file.bodySha256 : null
  }

  for await (const read of input.sessions ?? []) {
    if (!read.succeeded) {
      sessions.unreadable += 1
      unreadable.push({ source: read.source, error: read.error })
      continue
    }
    const session = read.value
    sessions.read += 1
    sessionChanges.set(session.sessionId, {
      parentSessionId: session.parentSessionId,
      refs: session.changes?.map((change) => change.ref),
    })
    let counted = false
    session.events.forEach((event, position) => {
      if (event.kind !== 'skill') return
      if (seenCalls.has(event.callId)) return
      seenCalls.add(event.callId)
      if (options.sinceMs !== undefined) {
        const at = instant(event.at)
        if (at === null || at < options.sinceMs) return
      }
      counted = true
      const hex = versionDigest(event)
      const key = hex === null ? `unversioned:${event.skill}` : normalizeDigest(hex)
      const builder = registry.builder(key)
      builder.names.add(event.skill)
      builder.kind ??= options.kindOfSkill?.(event.skill) ?? 'skill'
      const after = afterInvocation(session, position, event.at, options)
      pending.push({
        builderKey: key,
        sessionId: session.sessionId,
        harness: session.harness,
        event,
        measures: {
          tokens:
            after.modelCalls > 0 && after.modelCallsWithoutUsage === 0 ? after.tokens.total : null,
          usd: after.pricedModelCalls > 0 && after.unpricedModelCalls === 0 ? after.costUsd : null,
          wallMs: after.wallMs,
        },
      })
    })
    if (counted) sessions.withInvocation += 1
  }

  const joins = { joined: 0, none: 0, notRecorded: 0, withOutcome: 0 }
  const joinedRefs = new Set<string>()
  for (const invocation of pending) {
    const { event } = invocation
    const changes = joinInvocationToChanges(invocation.sessionId, sessionChanges, outcomes)
    if (changes.status === 'joined') {
      joins.joined += 1
      for (const ref of changes.refs) joinedRefs.add(ref)
      if (changes.outcomes.length > 0) joins.withOutcome += 1
    } else if (changes.status === 'none') {
      joins.none += 1
    } else {
      joins.notRecorded += 1
    }
    registry.builder(invocation.builderKey).executions.push({
      source: 'session',
      harness: invocation.harness,
      sessionId: invocation.sessionId,
      callId: event.callId,
      skill: event.skill,
      invoker: event.invoker,
      at: event.at,
      failed: event.failed,
      ...invocation.measures,
      changes,
    })
  }

  const versions = registry.all().map((builder): ProcedureVersion => {
    const cells = {
      count: 0,
      passed: 0,
      failed: 0,
      errored: 0,
      tokens: emptyMeasure(),
      usd: emptyMeasure(),
      wallMs: emptyMeasure(),
    }
    const sessionRuns = {
      invocations: 0,
      tokens: emptyMeasure(),
      usd: emptyMeasure(),
      wallMs: emptyMeasure(),
    }
    const runs: SessionExecution[] = []
    for (const execution of builder.executions) {
      if (execution.source === 'search-cell') {
        cells.count += 1
        if (execution.outcome === 'passed') cells.passed += 1
        else if (execution.outcome === 'failed') cells.failed += 1
        else if (execution.outcome === 'errored') cells.errored += 1
        addMeasure(cells.tokens, execution.tokens)
        addMeasure(cells.usd, execution.usd)
        addMeasure(cells.wallMs, execution.wallMs)
      } else {
        sessionRuns.invocations += 1
        addMeasure(sessionRuns.tokens, execution.tokens)
        addMeasure(sessionRuns.usd, execution.usd)
        addMeasure(sessionRuns.wallMs, execution.wallMs)
        runs.push(execution)
      }
    }
    return {
      key: builder.key,
      digest: builder.digest,
      names: [...builder.names].sort(compareText),
      kind: builder.kind,
      parents: [...builder.parents].sort(compareText),
      edges: builder.edges,
      searches: builder.searches,
      decisions: builder.decisions,
      cells,
      sessions: { ...sessionRuns, changes: summarizeChanges(runs, outcomes) },
      executions: builder.executions,
    }
  })
  versions.sort((a, b) => {
    const left = a.cells.count + a.sessions.invocations
    const right = b.cells.count + b.sessions.invocations
    return left !== right ? right - left : compareText(a.key, b.key)
  })

  const share = (part: number): number | null =>
    pending.length === 0 ? null : part / pending.length

  return {
    searches: { read: searches.length, closed: searches.filter((s) => s.closed !== null).length },
    sessions,
    invocations: pending.length,
    changeJoin: {
      hotfixWindowDays: HOTFIX_WINDOW_DAYS,
      invocations: pending.length,
      ...joins,
      joinedShare: share(joins.joined),
      withOutcomeShare: share(joins.withOutcome),
      distinctChanges: joinedRefs.size,
      outcomesSupplied: outcomes.byRef.size,
      outcomesInWrongWindow: outcomes.otherWindow,
    },
    versions,
    unreadable,
    notes: [...NOTES],
  }
}
