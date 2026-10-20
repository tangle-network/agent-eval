import { readSessionInput, summarizeSessionInput } from '@tangle-network/harness-sessions'
import { numberField, record, stringField, timestampMs } from './code-agent-fields'
import {
  addUsage,
  addUsageTo,
  clamp01,
  emptyMetrics,
  emptyTokenTotals,
  hasTokenTotals,
  penalizeErrors,
} from './code-agent-session-metrics'
import type { CodeAgentSessionMetrics } from './code-agent-session-types'

export function claudeCodeMetrics(entries: Record<string, unknown>[]): CodeAgentSessionMetrics {
  const metrics = emptyMetrics(entries.length)
  let startedAt: number | undefined
  let completedAt: number | undefined

  for (const entry of entries) {
    const type = stringField(entry, 'type')
    const timestamp = timestampMs(entry.timestamp)
    if (timestamp !== undefined) {
      startedAt = startedAt === undefined ? timestamp : Math.min(startedAt, timestamp)
      completedAt = completedAt === undefined ? timestamp : Math.max(completedAt, timestamp)
    }

    if (type === 'user') metrics.userMessages += 1
    if (type === 'assistant') metrics.assistantMessages += 1
    if (type === 'pr-link') metrics.prLinks += 1
    if (type === 'file-history-snapshot') metrics.fileSnapshots += 1

    const message = record(entry.message)
    const content = Array.isArray(message?.content) ? message.content : []
    for (const item of content) {
      const part = record(item)
      if (!part) continue
      const partType = stringField(part, 'type')
      if (partType === 'thinking') metrics.reasoningItems += 1
      if (partType === 'tool_use') metrics.toolCalls += 1
      if (partType === 'tool_result') {
        metrics.toolOutputs += 1
        if (part.is_error === true) metrics.toolErrors += 1
      }
    }
  }

  // Claude Code writes one record per content block of a response, each repeating the response's
  // usage; the shared session reader counts each response once.
  const usage = summarizeSessionInput('claude-code', { records: entries }).usage
  metrics.inputTokens = usage?.input ?? 0
  metrics.outputTokens = usage?.output ?? 0
  metrics.reasoningTokens = usage?.reasoning ?? 0
  metrics.cachedTokens = usage?.cacheRead ?? 0
  metrics.cacheWriteTokens = usage?.cacheWrite ?? 0
  if (startedAt !== undefined && completedAt !== undefined)
    metrics.wallMs = Math.max(0, completedAt - startedAt)
  metrics.processScore = claudeProcessScore(metrics)
  return metrics
}

export function openCodeMetrics(entries: Record<string, unknown>[]): CodeAgentSessionMetrics {
  const metrics = emptyMetrics(entries.length)
  const messageUsage = emptyTokenTotals()
  const partUsage = emptyTokenTotals()
  let messageCost = 0
  let partCost = 0
  let messageCostCaptured = false
  let partCostCaptured = false
  let startedAt: number | undefined
  let completedAt: number | undefined

  for (const entry of entries) {
    const time = record(entry.time)
    const created = timestampMs(time?.created)
    const completed = timestampMs(time?.completed)
    if (created !== undefined)
      startedAt = startedAt === undefined ? created : Math.min(startedAt, created)
    if (completed !== undefined)
      completedAt = completedAt === undefined ? completed : Math.max(completedAt, completed)

    const role = stringField(entry, 'role')
    if (role === 'user') metrics.userMessages += 1
    if (role === 'assistant') {
      metrics.assistantMessages += 1
      const finish = stringField(entry, 'finish')
      if (finish === 'stop') metrics.turnsCompleted += 1
      if (finish === 'error') metrics.turnsAborted += 1
    }

    const type = stringField(entry, 'type')
    if (type === 'reasoning') metrics.reasoningItems += 1
    if (type === 'tool') {
      metrics.toolCalls += 1
      const status = stringField(record(entry.state) ?? {}, 'status')
      if (status === 'completed') metrics.toolOutputs += 1
      if (status === 'error') {
        metrics.toolOutputs += 1
        metrics.toolErrors += 1
      }
    }
    if (type === 'patch') {
      metrics.patchAttempts += 1
      metrics.patchSuccesses += 1
    }

    const cost = numberField(entry, 'cost')
    if (record(entry.tokens) && role) {
      addUsageTo(messageUsage, record(entry.tokens))
      if (cost !== undefined) {
        messageCost += cost
        messageCostCaptured = true
      }
    } else if (record(entry.tokens)) {
      addUsageTo(partUsage, record(entry.tokens))
      if (cost !== undefined) {
        partCost += cost
        partCostCaptured = true
      }
    }
  }

  const usage = hasTokenTotals(messageUsage) ? messageUsage : partUsage
  metrics.inputTokens = usage.input
  metrics.outputTokens = usage.output
  metrics.reasoningTokens = usage.reasoning
  metrics.cachedTokens = usage.cached
  metrics.cacheWriteTokens = usage.cacheWrite
  metrics.observedCostUsd = messageCostCaptured ? messageCost : partCost
  metrics.observedCostCaptured = messageCostCaptured || partCostCaptured
  if (metrics.wallMs === 0 && startedAt !== undefined && completedAt !== undefined)
    metrics.wallMs = Math.max(0, completedAt - startedAt)
  metrics.processScore = terminalProcessScore(metrics)
  return metrics
}

export function kimiCodeMetrics(entries: Record<string, unknown>[]): CodeAgentSessionMetrics {
  const metrics = emptyMetrics(entries.length)
  let startedAt: number | undefined
  let completedAt: number | undefined

  for (const entry of entries) {
    const timestamp = timestampMs(entry.timestamp)
    if (timestamp !== undefined) {
      startedAt = startedAt === undefined ? timestamp : Math.min(startedAt, timestamp)
      completedAt = completedAt === undefined ? timestamp : Math.max(completedAt, timestamp)
    }

    const role = stringField(entry, 'role')
    if (role === 'user') metrics.userMessages += 1
    if (role === 'assistant') metrics.assistantMessages += 1
    if (role === '_usage') addUsage(metrics, entry)

    const message = record(entry.message)
    const messageType = message ? stringField(message, 'type') : undefined
    const payload = record(message?.payload) ?? {}
    if (messageType === 'TurnBegin') {
      metrics.userMessages += 1
      metrics.turnsStarted += 1
    }
    if (messageType === 'TurnEnd') metrics.turnsCompleted += 1
    if (messageType === 'StepInterrupted') metrics.turnsAborted += 1
    if (messageType === 'StepBegin') metrics.reasoningItems += 1
    if (messageType === 'ContentPart') {
      const payloadType = stringField(payload, 'type')
      if (payloadType === 'think') metrics.reasoningItems += 1
      if (payloadType === 'text') metrics.assistantMessages += 1
    }
    if (messageType === 'ToolCall') metrics.toolCalls += 1
    if (messageType === 'ToolResult') {
      metrics.toolOutputs += 1
      if (record(payload.return_value)?.is_error === true) metrics.toolErrors += 1
    }
    if (messageType === 'StatusUpdate') addUsage(metrics, record(payload.token_usage))
    if (messageType === 'Notification') {
      const notification = record(payload.payload)
      const exitCode = numberField(notification ?? {}, 'exit_code')
      if (notification?.timed_out === true || (exitCode !== undefined && exitCode !== 0)) {
        metrics.toolErrors += 1
      }
    }
  }

  if (startedAt !== undefined && completedAt !== undefined)
    metrics.wallMs = Math.max(0, completedAt - startedAt)
  metrics.processScore = terminalProcessScore(metrics)
  return metrics
}

/** A native Pi session's metrics, from the shared reader's fold. */
export function piSessionMetrics(entries: Record<string, unknown>[]): CodeAgentSessionMetrics {
  const metrics = emptyMetrics(entries.length)
  const session = readSessionInput('pi', { records: entries })
  metrics.userMessages = session.messages.filter(
    (m) => m.role === 'user' && m.actor === 'human',
  ).length
  metrics.assistantMessages = session.messages.filter(
    (m) => m.role === 'assistant' && m.actor === 'agent',
  ).length
  metrics.reasoningItems = session.messages.reduce(
    (n, m) => n + m.parts.filter((p) => p.type === 'reasoning').length,
    0,
  )
  metrics.toolCalls = session.toolCalls.length
  metrics.toolOutputs = session.toolCalls.filter((c) => c.result !== null).length
  metrics.toolErrors = session.toolCalls.filter((c) => c.result?.isError === true).length
  metrics.unclassifiedErrors = session.modelCalls.filter((c) => c.error !== null).length
  metrics.turnsStarted = metrics.userMessages
  if (session.ending.status === 'completed') metrics.turnsCompleted = 1
  if (session.ending.status === 'aborted' || session.ending.status === 'error')
    metrics.turnsAborted = 1
  metrics.inputTokens = session.usage?.input ?? 0
  metrics.outputTokens = session.usage?.output ?? 0
  metrics.reasoningTokens = session.usage?.reasoning ?? 0
  metrics.cachedTokens = session.usage?.cacheRead ?? 0
  metrics.cacheWriteTokens = session.usage?.cacheWrite ?? 0
  const costs = session.modelCalls.flatMap((c) => (c.costUsd === null ? [] : [c.costUsd]))
  metrics.observedCostUsd = costs.reduce((a, b) => a + b, 0)
  metrics.observedCostCaptured = costs.length > 0
  if (session.startedAt !== null && session.endedAt !== null)
    metrics.wallMs = Math.max(0, Date.parse(session.endedAt) - Date.parse(session.startedAt))
  metrics.processScore = terminalProcessScore(metrics)
  return metrics
}

export function piGraphMetrics(entries: Record<string, unknown>[]): CodeAgentSessionMetrics {
  const metrics = emptyMetrics(entries.length)
  let bestReliabilityScore: number | undefined

  for (const entry of entries) {
    const nodes = Array.isArray(entry.nodes) ? entry.nodes : []
    const edges = Array.isArray(entry.edges) ? entry.edges : []
    metrics.graphNodes += nodes.length
    metrics.graphEdges += edges.length

    for (const node of nodes) {
      const obj = record(node)
      const ir = record(obj?.ir) ?? obj
      const kind = stringField(ir ?? {}, 'kind')
      if (kind === 'ActionCandidate') metrics.actionCandidates += 1
      if (kind === 'ToolInvocation') metrics.toolCalls += 1
      if (kind === 'ToolResult') metrics.toolOutputs += 1
      if (kind === 'VerificationReport') metrics.verificationReports += 1
      if (kind === 'CompletionDecision') {
        metrics.completionDecisions += 1
        metrics.turnsCompleted += 1
      }
    }

    const averageReliability = numberField(entry, 'averageNodeReliability')
    if (averageReliability !== undefined)
      bestReliabilityScore = maxOptional(bestReliabilityScore, averageReliability)
    const pessimisticPath = numberField(entry, 'pessimisticPathEstimate')
    if (pessimisticPath !== undefined)
      bestReliabilityScore = maxOptional(bestReliabilityScore, pessimisticPath)

    const rows = Array.isArray(entry.rows) ? entry.rows : []
    metrics.reliabilityRows += rows.length
    for (const row of rows) {
      const obj = record(row)
      if (!obj) continue
      const lift = numberField(obj, 'lift')
      if (lift !== undefined) metrics.reliabilityLift = Math.max(metrics.reliabilityLift, lift)
      const validated = numberField(obj, 'validatedSuccessEstimate')
      if (validated !== undefined)
        bestReliabilityScore = maxOptional(bestReliabilityScore, validated)
    }
  }

  metrics.processScore =
    bestReliabilityScore !== undefined
      ? clamp01(bestReliabilityScore)
      : metrics.completionDecisions > 0
        ? 1
        : 0
  return metrics
}

function claudeProcessScore(metrics: CodeAgentSessionMetrics): number {
  const base = metrics.prLinks > 0 ? 1 : metrics.assistantMessages > 0 ? 0.75 : 0
  return penalizeErrors(base, metrics)
}

function terminalProcessScore(metrics: CodeAgentSessionMetrics): number {
  const terminalTurns = metrics.turnsCompleted + metrics.turnsAborted
  const base =
    terminalTurns > 0
      ? metrics.turnsCompleted / terminalTurns
      : metrics.assistantMessages > 0
        ? 0.75
        : metrics.toolCalls > 0
          ? 0.5
          : 0
  return penalizeErrors(base, metrics)
}

function maxOptional(current: number | undefined, next: number): number {
  return current === undefined ? next : Math.max(current, next)
}
