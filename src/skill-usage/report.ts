/**
 * Skill usage from session records: one row per skill and version.
 *
 * A row counts how often a skill started and who started it, then what the
 * session did afterwards: tool calls, tool errors, tokens, wall time and cost
 * from the first invocation to the end of that session. It reads recorded
 * sessions, so it says what happened, not what the skill caused; the paired
 * comparison in `runSkillEval` answers that.
 *
 * Three things are kept apart from zero throughout: a session that could not be
 * read, a version the session did not record, and a measure with no reading.
 */

import type { CostUsage, CustomTokenPricing } from '../cost-ledger/contract'
import { costForTokenPricing, costForUsage } from '../cost-ledger/pricing'
import { ValidationError } from '../errors'
import { sampleMedian } from '../statistics'
import type {
  SkillInvocationEvent,
  SkillInvoker,
  SkillSessionEvent,
  SkillSessionRecord,
  SkillSessionSource,
  SkillVersionEvidence,
} from './session-record'
import type { SkillFileRead } from './skill-file'

export interface SkillUsageReportOptions {
  /** Count only invocations at or after this instant (epoch ms). */
  sinceMs?: number
  /** Rates for a model the caller knows better than the cost ledger's table. */
  pricing?: (model: string) => CustomTokenPricing | undefined
  /** Reads the skill file an invocation names. Omit to leave skill files unread. */
  readSkillFile?: (path: string) => SkillFileRead
}

/** The skill file a row's first counted invocation names, as it is now. */
export type SkillFileState =
  | { path: string; state: 'not-read' }
  | { path: string; state: 'unreadable'; error: string }
  /** `current`: the file's body is this row's version. `changed`: it is not. */
  | { path: string; state: 'current' | 'changed'; fileSha256: string }

export interface SkillUsageTokens {
  input: number
  output: number
  cached: number
  cacheWrite: number
  total: number
}

/** What sessions did from a skill's first counted invocation to their end, summed over sessions. */
export interface SkillUsageAfterInvocation {
  /** Tool calls, not counting skill invocations. */
  toolCalls: number
  toolErrors: number
  /** Tool calls with no recorded result: neither a success nor an error. */
  toolCallsUnsettled: number
  modelCalls: number
  /** Model calls that recorded no usage; their tokens are missing from `tokens`. */
  modelCallsWithoutUsage: number
  tokens: SkillUsageTokens
  /** null when no session recorded both instants. */
  wallMs: number | null
  sessionsWithWallTime: number
  /** null when no model call could be priced: unknown, not free. */
  costUsd: number | null
  pricedModelCalls: number
  /** Model calls with usage whose model has no rate; their cost is missing from `costUsd`. */
  unpricedModelCalls: number
  /** Median over the row's sessions; null where no session has the measure. */
  perSessionMedian: {
    toolCalls: number | null
    toolErrors: number | null
    tokens: number | null
    wallMs: number | null
    costUsd: number | null
  }
}

export interface SkillUsageRow {
  skill: string
  /** null when no invocation in the row has a readable version. */
  version: SkillVersionEvidence | null
  skillFile: SkillFileState | null
  invocations: Record<SkillInvoker, number> & { total: number }
  /** Invocations the harness refused. */
  failedInvocations: number
  sessions: number
  subagentSessions: number
  /** Share of this row's invocations made inside subagent sessions. */
  subagentShare: number
  firstAt: string | null
  lastAt: string | null
  afterFirstInvocation: SkillUsageAfterInvocation
}

export interface SkillUsageReport {
  /** ISO instant the window opens at; null when every invocation counts. */
  since: string | null
  sessions: {
    read: number
    unreadable: number
    subagent: number
    /** Sessions with at least one counted invocation. */
    withInvocation: number
    /** Sessions whose reader reported a gap. */
    withGaps: number
  }
  invocations: Record<SkillInvoker, number> & {
    total: number
    /** A call id already counted, for example in a resumed session's copy of its history. */
    duplicates: number
    beforeWindow: number
    /** No timestamp, so it cannot be placed in the window. */
    undated: number
  }
  skills: number
  rows: SkillUsageRow[]
  /** Every model that answered in the sessions read, most calls first. */
  models: SkillUsageModel[]
  unreadable: Array<{ source: string; error: string }>
  notes: string[]
}

export interface SkillUsageModel {
  /** null when the session did not say which model answered. */
  model: string | null
  modelCalls: number
  /** False when neither the caller nor the cost ledger has a rate: its calls add no cost. */
  priced: boolean
}

export interface SessionAfter {
  toolCalls: number
  toolErrors: number
  toolCallsUnsettled: number
  modelCalls: number
  modelCallsWithoutUsage: number
  tokens: SkillUsageTokens
  wallMs: number | null
  costUsd: number
  pricedModelCalls: number
  unpricedModelCalls: number
}

interface RowAccumulator {
  skill: string
  version: SkillVersionEvidence | null
  skillFile: string | null
  invocations: Record<SkillInvoker, number>
  failedInvocations: number
  subagentInvocations: number
  subagentSessions: number
  firstMs: number | null
  lastMs: number | null
  sessions: SessionAfter[]
}

const OVERLAP_NOTE =
  'A session that invokes several skills counts its later work under each of them, so the after-invocation columns overlap across rows and do not add up.'
const PRICING_NOTE =
  'costUsd prices each model call with the cost ledger: the rates the caller gave for that model, else the ledger model table. ' +
  'Cache reads and writes are priced only at a rate the table names for that model; a call with cache tokens on a model without one, ' +
  'or a model with no row, is counted as not priced and stays out of the total.'

function emptyTokens(): SkillUsageTokens {
  return { input: 0, output: 0, cached: 0, cacheWrite: 0, total: 0 }
}

function addUsage(tokens: SkillUsageTokens, usage: CostUsage): void {
  const cached = usage.cachedTokens ?? 0
  const cacheWrite = usage.cacheWriteTokens ?? 0
  tokens.input += usage.inputTokens
  tokens.output += usage.outputTokens
  tokens.cached += cached
  tokens.cacheWrite += cacheWrite
  tokens.total += usage.inputTokens + usage.outputTokens + cached + cacheWrite
}

export function instant(value: string | null): number | null {
  if (value === null) return null
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? ms : null
}

/** What one response cost, or null when neither the caller nor the cost ledger has a rate for its model. */
function modelCallCost(
  model: string | null,
  usage: CostUsage,
  pricing: SkillUsageReportOptions['pricing'],
): number | null {
  if (model === null) return null
  const rates = pricing?.(model)
  if (rates !== undefined) return costForTokenPricing(rates, usage)
  const priced = costForUsage(model, usage)
  return priced.costUnknown ? null : priced.costUsd
}

/** What one session did after position `from`, to its end. */
export function afterInvocation(
  session: SkillSessionRecord,
  from: number,
  startedAt: string | null,
  options: SkillUsageReportOptions,
  /** Stop at this event position and this instant instead of the session's end. */
  until: { eventIndex: number; at: string | null } | null = null,
): SessionAfter {
  const after: SessionAfter = {
    toolCalls: 0,
    toolErrors: 0,
    toolCallsUnsettled: 0,
    modelCalls: 0,
    modelCallsWithoutUsage: 0,
    tokens: emptyTokens(),
    wallMs: null,
    costUsd: 0,
    pricedModelCalls: 0,
    unpricedModelCalls: 0,
  }
  const stop = until === null ? session.events.length : Math.min(until.eventIndex, session.events.length)
  for (let index = from + 1; index < stop; index++) {
    const event = session.events[index] as SkillSessionEvent
    if (event.kind === 'tool') {
      after.toolCalls += 1
      if (event.failed === true) after.toolErrors += 1
      else if (event.failed === null) after.toolCallsUnsettled += 1
    } else if (event.kind === 'model') {
      after.modelCalls += 1
      if (event.usage === null) {
        after.modelCallsWithoutUsage += 1
        continue
      }
      addUsage(after.tokens, event.usage)
      const cost = modelCallCost(event.model, event.usage, options.pricing)
      if (cost === null) {
        after.unpricedModelCalls += 1
      } else {
        after.costUsd += cost
        after.pricedModelCalls += 1
      }
    }
  }
  const start = instant(startedAt)
  const end = instant(until === null ? session.endedAt : until.at)
  if (start !== null && end !== null && end >= start) after.wallMs = end - start
  return after
}

function median(values: Array<number | null>): number | null {
  return sampleMedian(values.filter((value): value is number => value !== null))
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0)
}

function rowAfter(sessions: readonly SessionAfter[]): SkillUsageAfterInvocation {
  const tokens = emptyTokens()
  for (const session of sessions) {
    tokens.input += session.tokens.input
    tokens.output += session.tokens.output
    tokens.cached += session.tokens.cached
    tokens.cacheWrite += session.tokens.cacheWrite
    tokens.total += session.tokens.total
  }
  const walls = sessions.flatMap((session) => (session.wallMs === null ? [] : [session.wallMs]))
  const pricedModelCalls = sum(sessions.map((session) => session.pricedModelCalls))
  const priced = sessions.filter((session) => session.pricedModelCalls > 0)
  return {
    toolCalls: sum(sessions.map((session) => session.toolCalls)),
    toolErrors: sum(sessions.map((session) => session.toolErrors)),
    toolCallsUnsettled: sum(sessions.map((session) => session.toolCallsUnsettled)),
    modelCalls: sum(sessions.map((session) => session.modelCalls)),
    modelCallsWithoutUsage: sum(sessions.map((session) => session.modelCallsWithoutUsage)),
    tokens,
    wallMs: walls.length === 0 ? null : sum(walls),
    sessionsWithWallTime: walls.length,
    costUsd: pricedModelCalls === 0 ? null : sum(sessions.map((session) => session.costUsd)),
    pricedModelCalls,
    unpricedModelCalls: sum(sessions.map((session) => session.unpricedModelCalls)),
    perSessionMedian: {
      toolCalls: median(sessions.map((session) => session.toolCalls)),
      toolErrors: median(sessions.map((session) => session.toolErrors)),
      tokens: median(
        sessions.map((session) =>
          session.modelCalls > session.modelCallsWithoutUsage ? session.tokens.total : null,
        ),
      ),
      wallMs: median(walls),
      costUsd: median(priced.map((session) => session.costUsd)),
    },
  }
}

function skillFileState(
  path: string | null,
  version: SkillVersionEvidence | null,
  read: ((path: string) => SkillFileRead) | undefined,
): SkillFileState | null {
  if (path === null) return null
  if (read === undefined) return { path, state: 'not-read' }
  const file = read(path)
  if (!file.succeeded) return { path, state: 'unreadable', error: file.error }
  return {
    path,
    state: file.bodySha256 === version?.bodySha256 ? 'current' : 'changed',
    fileSha256: file.fileSha256,
  }
}

/**
 * Build the usage report from any source of session reads.
 *
 * An invocation is counted once per call id across the whole source, so a
 * resumed session that carries a copy of its history adds nothing. With
 * `sinceMs`, only invocations at or after it count, and a session's "first
 * invocation" is its first counted one. Rows are ordered by invocations, most
 * first, then by skill name and version.
 */
export async function buildSkillUsageReport(
  source: SkillSessionSource,
  options: SkillUsageReportOptions = {},
): Promise<SkillUsageReport> {
  if (options.sinceMs !== undefined && !Number.isFinite(options.sinceMs)) {
    throw new ValidationError(
      `buildSkillUsageReport: sinceMs must be finite, got ${options.sinceMs}`,
    )
  }
  const files = new Map<string, SkillFileRead>()
  const readSkillFile =
    options.readSkillFile === undefined
      ? undefined
      : (path: string): SkillFileRead => {
          const known = files.get(path)
          if (known !== undefined) return known
          const read = (options.readSkillFile as (path: string) => SkillFileRead)(path)
          files.set(path, read)
          return read
        }

  const rows = new Map<string, RowAccumulator>()
  const seenCalls = new Set<string>()
  const unreadable: Array<{ source: string; error: string }> = []
  const sessions = { read: 0, unreadable: 0, subagent: 0, withInvocation: 0, withGaps: 0 }
  const invocations = { agent: 0, user: 0, harness: 0, duplicates: 0, beforeWindow: 0, undated: 0 }
  const modelCalls = new Map<string | null, number>()

  /** The version an invocation ran: what the session recorded, else the skill file as it is now. */
  const versionOf = (event: SkillInvocationEvent): SkillVersionEvidence | null => {
    if (event.version !== null) return event.version
    if (event.skillFile === null || readSkillFile === undefined) return null
    const file = readSkillFile(event.skillFile)
    return file.succeeded ? { bodySha256: file.bodySha256, source: 'file' } : null
  }

  for await (const read of source) {
    if (!read.succeeded) {
      sessions.unreadable += 1
      unreadable.push({ source: read.source, error: read.error })
      continue
    }
    const session = read.value
    const subagent = session.parentSessionId !== null
    sessions.read += 1
    if (subagent) sessions.subagent += 1
    if (session.gaps.length > 0) sessions.withGaps += 1
    for (const event of session.events) {
      if (event.kind === 'model')
        modelCalls.set(event.model, (modelCalls.get(event.model) ?? 0) + 1)
    }

    const rowsInSession = new Set<string>()
    session.events.forEach((event, index) => {
      if (event.kind !== 'skill') return
      if (seenCalls.has(event.callId)) {
        invocations.duplicates += 1
        return
      }
      seenCalls.add(event.callId)
      if (options.sinceMs !== undefined) {
        const at = instant(event.at)
        if (at === null) {
          invocations.undated += 1
          return
        }
        if (at < options.sinceMs) {
          invocations.beforeWindow += 1
          return
        }
      }
      const version = versionOf(event)
      const key = `${event.skill}\u0000${version?.bodySha256 ?? ''}`
      let row = rows.get(key)
      if (row === undefined) {
        row = {
          skill: event.skill,
          version,
          skillFile: null,
          invocations: { agent: 0, user: 0, harness: 0 },
          failedInvocations: 0,
          subagentInvocations: 0,
          subagentSessions: 0,
          firstMs: null,
          lastMs: null,
          sessions: [],
        }
        rows.set(key, row)
      }
      // The session's own record of the text outranks a later read of the file.
      if (version?.source === 'session' && row.version?.source === 'file') row.version = version
      invocations[event.invoker] += 1
      row.invocations[event.invoker] += 1
      if (event.failed === true) row.failedInvocations += 1
      if (subagent) row.subagentInvocations += 1
      const at = instant(event.at)
      if (at !== null) {
        if (row.firstMs === null || at < row.firstMs) row.firstMs = at
        if (row.lastMs === null || at > row.lastMs) row.lastMs = at
      }
      if (row.skillFile === null) row.skillFile = event.skillFile
      if (!rowsInSession.has(key)) {
        rowsInSession.add(key)
        if (subagent) row.subagentSessions += 1
        row.sessions.push(afterInvocation(session, index, event.at, options))
      }
    })
    if (rowsInSession.size > 0) sessions.withInvocation += 1
  }

  const total = invocations.agent + invocations.user + invocations.harness
  const built: SkillUsageRow[] = [...rows.values()].map((row) => {
    const rowTotal = row.invocations.agent + row.invocations.user + row.invocations.harness
    return {
      skill: row.skill,
      version: row.version,
      skillFile: skillFileState(row.skillFile, row.version, readSkillFile),
      invocations: { ...row.invocations, total: rowTotal },
      failedInvocations: row.failedInvocations,
      sessions: row.sessions.length,
      subagentSessions: row.subagentSessions,
      subagentShare: row.subagentInvocations / rowTotal,
      firstAt: row.firstMs === null ? null : new Date(row.firstMs).toISOString(),
      lastAt: row.lastMs === null ? null : new Date(row.lastMs).toISOString(),
      afterFirstInvocation: rowAfter(row.sessions),
    }
  })
  built.sort((a, b) => {
    if (a.invocations.total !== b.invocations.total) {
      return b.invocations.total - a.invocations.total
    }
    if (a.skill !== b.skill) return a.skill < b.skill ? -1 : 1
    const left = a.version?.bodySha256 ?? ''
    const right = b.version?.bodySha256 ?? ''
    return left < right ? -1 : left > right ? 1 : 0
  })

  return {
    since: options.sinceMs === undefined ? null : new Date(options.sinceMs).toISOString(),
    sessions,
    invocations: { ...invocations, total },
    skills: new Set(built.map((row) => row.skill)).size,
    rows: built,
    models: [...modelCalls.entries()]
      .map(([model, calls]) => ({
        model,
        modelCalls: calls,
        priced: modelCallCost(model, { inputTokens: 0, outputTokens: 0 }, options.pricing) !== null,
      }))
      .sort((a, b) => {
        if (a.modelCalls !== b.modelCalls) return b.modelCalls - a.modelCalls
        const left = a.model ?? ''
        const right = b.model ?? ''
        return left < right ? -1 : left > right ? 1 : 0
      }),
    unreadable,
    notes: [OVERLAP_NOTE, PRICING_NOTE],
  }
}

function compact(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`
  return String(value)
}

function minutes(ms: number | null): string {
  return ms === null ? 'no reading' : `${(ms / 60_000).toFixed(1)}m`
}

function dollars(usd: number | null): string {
  return usd === null ? 'not priced' : `$${usd.toFixed(2)}`
}

/**
 * The report as a short text table: the summary lines, then the rows with the
 * most invocations. An unreadable version reads `not recorded`, a missing
 * measure `no reading` or `not priced`; none of them prints as a zero.
 */
export function renderSkillUsageTable(report: SkillUsageReport, limit = 30): string {
  const { sessions, invocations } = report
  const lines = [
    `window: ${report.since === null ? 'all recorded invocations' : `since ${report.since}`}`,
    `sessions: ${sessions.read} read (${sessions.subagent} subagent), ${sessions.unreadable} unreadable, ${sessions.withInvocation} with a skill invocation`,
    `invocations: ${invocations.total} across ${report.skills} skills: ${invocations.agent} agent, ${invocations.user} user, ${invocations.harness} harness`,
    `not counted: ${invocations.duplicates} repeated call ids, ${invocations.beforeWindow} before the window, ${invocations.undated} without a timestamp`,
    `models: ${
      report.models.length === 0
        ? 'none recorded'
        : report.models
            .map(
              (entry) =>
                `${entry.model ?? 'not recorded'} ${entry.modelCalls} calls${entry.priced ? '' : ' (no rate)'}`,
            )
            .join(', ')
    }`,
    '',
  ]
  const header = [
    'skill',
    'version',
    'calls',
    'agent/user/harness',
    'sessions',
    'subagent',
    'tool calls',
    'tool errors',
    'tokens',
    'wall',
    'ledger cost',
  ]
  const body = report.rows.slice(0, limit).map((row) => {
    const after = row.afterFirstInvocation
    return [
      row.skill,
      row.version === null ? 'not recorded' : row.version.bodySha256.slice(0, 12),
      String(row.invocations.total),
      `${row.invocations.agent}/${row.invocations.user}/${row.invocations.harness}`,
      String(row.sessions),
      `${Math.round(row.subagentShare * 100)}%`,
      String(after.toolCalls),
      String(after.toolErrors),
      after.modelCalls === after.modelCallsWithoutUsage
        ? 'no reading'
        : compact(after.tokens.total),
      minutes(after.wallMs),
      dollars(after.costUsd),
    ]
  })
  const widths = header.map((title, column) =>
    Math.max(title.length, ...body.map((cells) => (cells[column] as string).length)),
  )
  const format = (cells: string[]): string =>
    cells
      .map((cell, column) => cell.padEnd(widths[column] as number))
      .join('  ')
      .trimEnd()
  lines.push(format(header), ...body.map(format))
  if (report.rows.length > limit) lines.push(`... ${report.rows.length - limit} more rows`)
  lines.push('', 'tool calls, tool errors, tokens, wall and cost are summed over sessions, each')
  lines.push('from its first counted invocation of the row to the end of that session.')
  for (const note of report.notes) lines.push(note)
  return `${lines.join('\n')}\n`
}
