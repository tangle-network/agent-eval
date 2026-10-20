import { numberField, record, stringField, timestampMs } from './code-agent-fields'
import { admittedCodexItem, hasCodexTranscriptStream } from './code-agent-observation'
import {
  addUsage as addCodexExecUsage,
  emptyMetrics,
  penalizeErrors,
  readUsage,
} from './code-agent-session-metrics'
import type { CodeAgentSessionMetrics } from './code-agent-session-types'

export function codexMetrics(entries: Record<string, unknown>[]): CodeAgentSessionMetrics {
  const metrics = emptyMetrics(entries.length)
  const startedToolIds = new Set<string>()
  const transcriptStream = hasCodexTranscriptStream(entries)
  let startedAt: number | undefined
  let completedAt: number | undefined

  for (const entry of entries) {
    const payload = record(entry.payload) ?? {}
    const entryType = stringField(entry, 'type')
    const payloadType = stringField(payload, 'type')
    const timestamp = timestampMs(entry.timestamp)
    if (timestamp !== undefined) {
      startedAt = startedAt === undefined ? timestamp : Math.min(startedAt, timestamp)
      completedAt = completedAt === undefined ? timestamp : Math.max(completedAt, timestamp)
    }

    if (entryType === 'turn.started') metrics.turnsStarted += 1
    if (entryType === 'turn.completed') {
      metrics.turnsCompleted += 1
      addCodexExecUsage(metrics, record(entry.usage))
    }
    if (entryType === 'turn.failed') metrics.turnsAborted += 1
    if (entryType === 'error') metrics.unclassifiedErrors += 1

    const itemEvent = admittedCodexItem(entry, transcriptStream)
    if (itemEvent) {
      addCodexExecItem(
        metrics,
        startedToolIds,
        itemEvent.eventType,
        itemEvent.item,
        transcriptStream,
      )
    }

    if (entryType === 'response_item') {
      if (payloadType === 'function_call' || payloadType === 'custom_tool_call')
        metrics.toolCalls += 1
      if (payloadType === 'function_call_output' || payloadType === 'custom_tool_call_output')
        metrics.toolOutputs += 1
      if (payloadType === 'reasoning') metrics.reasoningItems += 1
      if (payloadType === 'message' && stringField(payload, 'role') === 'assistant')
        metrics.assistantMessages += 1
    }

    if (entryType === 'event_msg') {
      if (payloadType === 'user_message') metrics.userMessages += 1
      if (payloadType === 'agent_message') metrics.assistantMessages += 1
      if (payloadType === 'task_started') {
        metrics.turnsStarted += 1
        const started = timestampMs(payload.started_at)
        if (started !== undefined) {
          startedAt = startedAt === undefined ? started : Math.min(startedAt, started)
        }
      }
      if (payloadType === 'task_complete') {
        metrics.turnsCompleted += 1
        const completed = timestampMs(payload.completed_at)
        if (completed !== undefined) {
          completedAt = completedAt === undefined ? completed : Math.max(completedAt, completed)
        }
        const duration = numberField(payload, 'duration_ms')
        if (duration !== undefined) metrics.wallMs = Math.max(metrics.wallMs, duration)
      }
      if (payloadType === 'turn_aborted') {
        metrics.turnsAborted += 1
        const completed = timestampMs(payload.completed_at)
        if (completed !== undefined) {
          completedAt = completedAt === undefined ? completed : Math.max(completedAt, completed)
        }
      }
      if (payloadType === 'context_compacted') metrics.contextCompactions += 1
      if (payloadType === 'patch_apply_end') {
        metrics.patchAttempts += 1
        if (payload.success === true) metrics.patchSuccesses += 1
        else {
          metrics.patchFailures += 1
          metrics.toolErrors += 1
        }
      }
      if (payloadType === 'token_count')
        setCodexCumulativeUsage(metrics, record(record(payload.info)?.total_token_usage))
      const result = record(payload.result)
      if (result && 'Err' in result) metrics.unclassifiedErrors += 1
    }
  }

  if (metrics.wallMs === 0 && startedAt !== undefined && completedAt !== undefined) {
    metrics.wallMs = Math.max(0, completedAt - startedAt)
  }
  metrics.processScore = codexProcessScore(metrics)
  return metrics
}

function addCodexExecItem(
  metrics: CodeAgentSessionMetrics,
  startedToolIds: Set<string>,
  eventType: 'item.started' | 'item.completed',
  item: Record<string, unknown>,
  transcriptStream: boolean,
): void {
  const itemType = stringField(item, 'type')
  const itemId = stringField(item, 'id')
  // `response_item` owns the tool call accounting wherever the transport
  // carries it. A rollout file already counts the enclosing call there, so an
  // item that reaches this point adds only the surface it alone reports.
  const isTool =
    !transcriptStream &&
    (itemType === 'command_execution' ||
      itemType === 'mcp_tool_call' ||
      itemType === 'collab_tool_call' ||
      itemType === 'web_search')

  if (eventType === 'item.started' && isTool) {
    metrics.toolCalls += 1
    if (itemId) startedToolIds.add(itemId)
  }
  if (eventType === 'item.completed' && isTool) {
    if (!itemId || !startedToolIds.has(itemId)) metrics.toolCalls += 1
    metrics.toolOutputs += 1
  }
  if (eventType !== 'item.completed') return

  if (itemType === 'agent_message' || itemType === 'message') metrics.assistantMessages += 1
  if (itemType === 'user_message') metrics.userMessages += 1
  if (itemType === 'reasoning') metrics.reasoningItems += 1
  if (itemType === 'context_compaction') metrics.contextCompactions += 1
  if (itemType === 'file_change') {
    metrics.patchAttempts += 1
    const status = stringField(item, 'status')
    if (status === 'completed') metrics.patchSuccesses += 1
    if (status === 'failed') {
      metrics.patchFailures += 1
      metrics.toolErrors += 1
    }
  }
  if (itemType === 'error') metrics.unclassifiedErrors += 1
  else if (codexExecToolFailed(itemType, item)) metrics.toolErrors += 1
}

function codexExecToolFailed(itemType: string | undefined, item: Record<string, unknown>): boolean {
  const status = stringField(item, 'status')
  if (itemType === 'command_execution') {
    const exitCode = numberField(item, 'exit_code')
    return (
      status === 'failed' || status === 'declined' || (exitCode !== undefined && exitCode !== 0)
    )
  }
  if (itemType === 'mcp_tool_call') return status === 'failed' || record(item.error) !== null
  return itemType === 'collab_tool_call' && status === 'failed'
}

function setCodexCumulativeUsage(
  metrics: CodeAgentSessionMetrics,
  usage: Record<string, unknown> | null,
): void {
  const parsed = readUsage(usage)
  metrics.inputTokens = Math.max(metrics.inputTokens, parsed.input)
  metrics.outputTokens = Math.max(metrics.outputTokens, parsed.output)
  metrics.reasoningTokens = Math.max(metrics.reasoningTokens, parsed.reasoning)
  metrics.cachedTokens = Math.max(metrics.cachedTokens, parsed.cached)
  metrics.cacheWriteTokens = Math.max(metrics.cacheWriteTokens, parsed.cacheWrite)
}

function codexProcessScore(metrics: CodeAgentSessionMetrics): number {
  const terminalTurns = metrics.turnsCompleted + metrics.turnsAborted
  const base =
    terminalTurns > 0
      ? metrics.turnsCompleted / terminalTurns
      : metrics.assistantMessages > 0
        ? 0.5
        : 0
  return penalizeErrors(base, metrics)
}
