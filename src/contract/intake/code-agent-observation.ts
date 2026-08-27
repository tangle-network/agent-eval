export type CodeAgentSessionSource = 'codex' | 'claude-code' | 'opencode' | 'kimi-code' | 'pi'

export type CodeAgentSessionTerminalStatus = 'completed' | 'failed' | 'unknown'

export type CodeAgentSessionActionKind = 'tool' | 'patch' | 'terminal' | 'graph-completion'

export type CodeAgentSessionActionSurface =
  | 'tool'
  | 'mcp'
  | 'subagent'
  | 'skill'
  | 'hook'
  | 'web'
  | 'code'

export type CodeAgentSessionActionStatus = 'started' | 'completed' | 'failed' | 'unknown'

export interface CodeAgentSessionExecutionReceipt {
  exitCode: number
  startedAtMs?: number
  completedAtMs?: number
}

export interface CodeAgentSessionAction {
  id: string
  stepIndex: number
  kind: CodeAgentSessionActionKind
  surface: CodeAgentSessionActionSurface
  name: string
  status: CodeAgentSessionActionStatus
  timestampMs?: number
  costUsd?: number
  metadata: Record<string, unknown>
}

export interface CodeAgentSessionObservation {
  source: CodeAgentSessionSource
  sessionId: string
  finalText: string | null
  terminal: {
    status: CodeAgentSessionTerminalStatus
    explicit: boolean
  }
  actions: CodeAgentSessionAction[]
}

export interface ObserveCodeAgentSessionOptions {
  source: CodeAgentSessionSource
  entries: unknown[]
  sourcePath?: string
  execution?: CodeAgentSessionExecutionReceipt
}

interface SessionProjection {
  finalText: string | null
  terminal: CodeAgentSessionTerminalStatus
  explicitTerminal: boolean
  actions: CodeAgentSessionAction[]
}

/**
 * Project one provider session into the exact user-visible answer and a
 * provider-neutral action stream. Raw prompts, tool inputs, and tool outputs
 * stay out of this projection; callers retain the source JSONL as evidence.
 */
export function observeCodeAgentSession(
  options: ObserveCodeAgentSessionOptions,
): CodeAgentSessionObservation {
  const entries = options.entries.filter(isRecord)
  const projection = projectionFor(options.source, entries)
  const terminal = terminalWithExecution(projection, options.execution)
  return {
    source: options.source,
    sessionId:
      sessionIdFromEntries(options.source, entries) ??
      fallbackSessionId(options.source, options.sourcePath),
    finalText: projection.finalText,
    terminal,
    actions: projection.actions,
  }
}

function projectionFor(
  source: CodeAgentSessionSource,
  entries: Record<string, unknown>[],
): SessionProjection {
  switch (source) {
    case 'codex':
      return codexProjection(entries)
    case 'claude-code':
      return claudeProjection(entries)
    case 'opencode':
      return openCodeProjection(entries)
    case 'kimi-code':
      return kimiProjection(entries)
    case 'pi':
      return piProjection(entries)
  }
}

function codexProjection(entries: Record<string, unknown>[]): SessionProjection {
  const actions: CodeAgentSessionAction[] = []
  const calls = new Map<string, CodeAgentSessionAction>()
  let finalText: string | null = null
  let terminal: CodeAgentSessionTerminalStatus = 'unknown'
  let explicitTerminal = false

  for (const entry of entries) {
    const entryType = stringField(entry, 'type')
    const payload = record(entry.payload) ?? {}
    const payloadType = stringField(payload, 'type')
    const timestampMs = timestamp(entry.timestamp)
    const item = record(entry.item)

    if (entryType === 'item.started' && item) {
      const itemType = stringField(item, 'type')
      if (isCodexActionItem(itemType)) {
        const id = stringField(item, 'id') ?? `item-${actions.length}`
        const action = actionFor({
          id,
          stepIndex: actions.length,
          kind: itemType === 'file_change' ? 'patch' : 'tool',
          surface: codexItemSurface(itemType, item),
          name: codexItemName(itemType, item),
          status: 'started',
          timestampMs,
          metadata: compactMetadata({ sourceEventType: entryType, itemType }),
        })
        calls.set(id, action)
        actions.push(action)
      }
    }

    if (entryType === 'item.completed' && item) {
      const itemType = stringField(item, 'type')
      if (itemType === 'agent_message' || itemType === 'message') {
        finalText = nonEmpty(stringField(item, 'text')) ?? finalText
      }
      if (isCodexActionItem(itemType)) {
        const id = stringField(item, 'id') ?? `item-${actions.length}`
        const status = codexItemStatus(itemType, item)
        const existing = calls.get(id)
        if (existing) {
          existing.status = status
        } else {
          const action = actionFor({
            id,
            stepIndex: actions.length,
            kind: itemType === 'file_change' ? 'patch' : 'tool',
            surface: codexItemSurface(itemType, item),
            name: codexItemName(itemType, item),
            status,
            timestampMs,
            metadata: compactMetadata({ sourceEventType: entryType, itemType }),
          })
          calls.set(id, action)
          actions.push(action)
        }
      }
    }

    if (entryType === 'response_item') {
      if (payloadType === 'message' || payloadType === 'agent_message') {
        finalText = textFromMessagePayload(payload) ?? finalText
      }
      if (payloadType === 'function_call' || payloadType === 'custom_tool_call') {
        const id =
          stringField(payload, 'call_id') ?? stringField(payload, 'id') ?? `call-${actions.length}`
        const name = stringField(payload, 'name') ?? payloadType
        const action = actionFor({
          id,
          stepIndex: actions.length,
          kind: 'tool',
          surface: surfaceForTool(name),
          name,
          status: 'started',
          timestampMs,
          metadata: compactMetadata({ sourceEventType: entryType, payloadType }),
        })
        calls.set(id, action)
        actions.push(action)
      }
      if (payloadType === 'function_call_output' || payloadType === 'custom_tool_call_output') {
        const id = stringField(payload, 'call_id') ?? stringField(payload, 'id')
        const existing = id ? calls.get(id) : undefined
        if (existing) existing.status = looksLikeError(payload.output) ? 'failed' : 'completed'
      }
    }

    if (entryType === 'event_msg') {
      if (payloadType === 'agent_message') {
        finalText =
          nonEmpty(stringField(payload, 'message')) ??
          nonEmpty(stringField(payload, 'text')) ??
          finalText
      }
      if (payloadType === 'patch_apply_end') {
        const patchStatus =
          typeof payload.success === 'boolean'
            ? payload.success
              ? 'completed'
              : 'failed'
            : 'unknown'
        actions.push(
          actionFor({
            id: stringField(payload, 'call_id') ?? `patch-${actions.length}`,
            stepIndex: actions.length,
            kind: 'patch',
            surface: 'code',
            name: 'patch',
            status: patchStatus,
            timestampMs,
            metadata: compactMetadata({ sourceEventType: entryType, payloadType }),
          }),
        )
      }
      if (payloadType === 'sub_agent_activity') {
        const name = stringField(payload, 'kind') ?? 'subagent'
        actions.push(
          actionFor({
            id: stringField(payload, 'event_id') ?? `subagent-${actions.length}`,
            stepIndex: actions.length,
            kind: 'tool',
            surface: 'subagent',
            name,
            status: statusFrom(payload),
            timestampMs,
            metadata: compactMetadata({ sourceEventType: entryType, payloadType }),
          }),
        )
      }
      if (payloadType === 'task_complete' || payloadType === 'turn_aborted') {
        const completed = payloadType === 'task_complete'
        terminal = completed ? 'completed' : 'failed'
        explicitTerminal = true
        actions.push(terminalAction(actions.length, payloadType, completed, timestampMs))
      }
    }

    if (entryType === 'turn.completed' || entryType === 'exec_done') {
      const completed = entry.success !== false
      terminal = completed ? 'completed' : 'failed'
      explicitTerminal = true
      finalText = nonEmpty(stringField(entry, 'message')) ?? finalText
      actions.push(terminalAction(actions.length, entryType, completed, timestampMs))
    }
    if (entryType === 'turn.failed' || entryType === 'error') {
      terminal = 'failed'
      explicitTerminal = true
      actions.push(terminalAction(actions.length, entryType, false, timestampMs))
    }
  }

  return { finalText, terminal, explicitTerminal, actions }
}

function claudeProjection(entries: Record<string, unknown>[]): SessionProjection {
  const actions: CodeAgentSessionAction[] = []
  const calls = new Map<string, CodeAgentSessionAction>()
  let finalText: string | null = null
  let resultText: string | null = null
  let terminal: CodeAgentSessionTerminalStatus = 'unknown'
  let explicitTerminal = false

  for (const entry of entries) {
    const entryType = stringField(entry, 'type')
    const timestampMs = timestamp(entry.timestamp)
    const message = record(entry.message)
    const content = Array.isArray(message?.content) ? message.content : []

    if (entryType === 'assistant') {
      const text = textBlocks(content)
      if (text !== null) finalText = text
      for (const value of content) {
        const part = record(value)
        if (!part) continue
        const partType = stringField(part, 'type')
        if (partType === 'tool_use') {
          const id = stringField(part, 'id') ?? `tool-${actions.length}`
          const name = stringField(part, 'name') ?? 'tool'
          const action = actionFor({
            id,
            stepIndex: actions.length,
            kind: 'tool',
            surface: surfaceForTool(name),
            name,
            status: 'started',
            timestampMs,
            metadata: compactMetadata({ sourceEventType: entryType, partType }),
          })
          calls.set(id, action)
          actions.push(action)
        }
      }
      completeClaudeTools(content, calls)
      const stopReason = stringField(message ?? {}, 'stop_reason')
      if (stopReason === 'end_turn') {
        terminal = 'completed'
        explicitTerminal = true
        actions.push(terminalAction(actions.length, stopReason, true, timestampMs))
      }
    }

    if (entryType === 'user') {
      completeClaudeTools(content, calls)
    }
    if (entryType === 'tool_use') {
      const id = stringField(entry, 'id') ?? `tool-${actions.length}`
      const name = stringField(entry, 'name') ?? 'tool'
      const action = actionFor({
        id,
        stepIndex: actions.length,
        kind: 'tool',
        surface: surfaceForTool(name),
        name,
        status: 'started',
        timestampMs,
        metadata: { sourceEventType: entryType },
      })
      calls.set(id, action)
      actions.push(action)
    }
    if (entryType === 'tool_result') {
      const id = stringField(entry, 'tool_use_id')
      const action = id ? calls.get(id) : undefined
      if (action) action.status = entry.is_error === true ? 'failed' : 'completed'
    }

    if (entryType === 'system') {
      const subtype = stringField(entry, 'subtype')
      const hookName = stringField(entry, 'hook_name') ?? stringField(entry, 'hookName')
      if (subtype?.toLowerCase().includes('hook') || hookName) {
        actions.push(
          actionFor({
            id: stringField(entry, 'uuid') ?? `hook-${actions.length}`,
            stepIndex: actions.length,
            kind: 'tool',
            surface: 'hook',
            name: hookName ?? subtype ?? 'hook',
            status: statusFrom(entry),
            timestampMs,
            metadata: compactMetadata({ sourceEventType: entryType, subtype }),
          }),
        )
      }
    }

    if (entryType === 'pr-link') {
      actions.push(terminalAction(actions.length, entryType, true, timestampMs))
    }

    if (entryType === 'result') {
      resultText = nonEmpty(stringField(entry, 'result')) ?? resultText
      const subtype = stringField(entry, 'subtype')
      const completed = entry.is_error !== true && !subtype?.toLowerCase().includes('error')
      terminal = completed ? 'completed' : 'failed'
      explicitTerminal = true
      actions.push(terminalAction(actions.length, subtype ?? entryType, completed, timestampMs))
    }
    if (entryType === 'error') {
      terminal = 'failed'
      explicitTerminal = true
      actions.push(terminalAction(actions.length, entryType, false, timestampMs))
    }
  }

  return {
    finalText: resultText ?? finalText,
    terminal,
    explicitTerminal,
    actions,
  }
}

function openCodeProjection(entries: Record<string, unknown>[]): SessionProjection {
  const actions: CodeAgentSessionAction[] = []
  const assistantMessageIds = new Set(
    entries
      .filter((entry) => stringField(entry, 'role') === 'assistant')
      .map((entry) => stringField(entry, 'id'))
      .filter((id): id is string => id !== undefined),
  )
  let finalText: string | null = null
  let terminal: CodeAgentSessionTerminalStatus = 'unknown'
  let explicitTerminal = false

  for (const entry of entries) {
    const entryType = stringField(entry, 'type')
    const part = record(entry.part) ?? entry
    const partType = stringField(part, 'type')
    const timestampMs = timestamp(entry.timestamp) ?? timestamp(record(entry.time)?.created)

    if (entryType === 'text' && record(entry.part)) {
      finalText = nonEmpty(stringField(part, 'text')) ?? finalText
    } else if (
      partType === 'text' &&
      (assistantMessageIds.size === 0 ||
        assistantMessageIds.has(stringField(part, 'messageID') ?? ''))
    ) {
      finalText = nonEmpty(stringField(part, 'text')) ?? finalText
    }

    if (entryType === 'tool_use' || partType === 'tool') {
      const state = record(part.state) ?? {}
      const name = stringField(part, 'tool') ?? 'tool'
      actions.push(
        actionFor({
          id: stringField(part, 'callID') ?? stringField(part, 'id') ?? `tool-${actions.length}`,
          stepIndex: actions.length,
          kind: 'tool',
          surface: surfaceForTool(name),
          name,
          status: statusFrom(state),
          timestampMs,
          metadata: compactMetadata({ sourceEventType: entryType, partType }),
        }),
      )
    }
    if (partType === 'patch') {
      actions.push(
        actionFor({
          id: stringField(part, 'id') ?? `patch-${actions.length}`,
          stepIndex: actions.length,
          kind: 'patch',
          surface: 'code',
          name: 'patch',
          status: 'completed',
          timestampMs,
          metadata: compactMetadata({ sourceEventType: entryType, partType }),
        }),
      )
    }

    if (stringField(entry, 'role') === 'assistant') {
      const finish = stringField(entry, 'finish')
      if (finish === 'stop' || finish === 'error') {
        const completed = finish === 'stop'
        terminal = completed ? 'completed' : 'failed'
        explicitTerminal = true
        actions.push(terminalAction(actions.length, finish, completed, timestampMs))
      }
    }
    if (entryType === 'error') {
      terminal = 'failed'
      explicitTerminal = true
      actions.push(terminalAction(actions.length, entryType, false, timestampMs))
    }
  }

  return { finalText, terminal, explicitTerminal, actions }
}

function kimiProjection(entries: Record<string, unknown>[]): SessionProjection {
  const actions: CodeAgentSessionAction[] = []
  const calls = new Map<string, CodeAgentSessionAction>()
  let finalText: string | null = null
  let terminal: CodeAgentSessionTerminalStatus = 'unknown'
  let explicitTerminal = false

  for (const entry of entries) {
    const timestampMs = timestamp(entry.timestamp)
    const message = record(entry.message)
    const messageType = stringField(message ?? {}, 'type')
    const payload = record(message?.payload) ?? {}
    if (messageType === 'ContentPart' && stringField(payload, 'type') === 'text') {
      finalText =
        nonEmpty(stringField(payload, 'text')) ??
        nonEmpty(stringField(payload, 'content')) ??
        finalText
    }
    if (messageType === 'ToolCall') {
      const fn = record(payload.function) ?? {}
      const id = stringField(payload, 'id') ?? `tool-${actions.length}`
      const name = stringField(fn, 'name') ?? 'tool'
      const action = actionFor({
        id,
        stepIndex: actions.length,
        kind: 'tool',
        surface: surfaceForTool(name),
        name,
        status: 'started',
        timestampMs,
        metadata: { sourceEventType: messageType },
      })
      calls.set(id, action)
      actions.push(action)
    }
    if (messageType === 'ToolResult') {
      const id = stringField(payload, 'tool_call_id')
      const action = id ? calls.get(id) : undefined
      if (action)
        action.status = record(payload.return_value)?.is_error === true ? 'failed' : 'completed'
    }
    if (messageType === 'TurnEnd' || messageType === 'StepInterrupted') {
      const completed = messageType === 'TurnEnd'
      terminal = completed ? 'completed' : 'failed'
      explicitTerminal = true
      actions.push(terminalAction(actions.length, messageType, completed, timestampMs))
    }
  }

  return { finalText, terminal, explicitTerminal, actions }
}

function piProjection(entries: Record<string, unknown>[]): SessionProjection {
  const actions: CodeAgentSessionAction[] = []
  let terminal: CodeAgentSessionTerminalStatus = 'unknown'
  let explicitTerminal = false
  for (const entry of entries) {
    const nodes = Array.isArray(entry.nodes) ? entry.nodes : []
    for (const value of nodes) {
      const node = record(value)
      const ir = record(node?.ir) ?? node
      const kind = stringField(ir ?? {}, 'kind')
      if (kind === 'ToolInvocation') {
        actions.push(
          actionFor({
            id:
              stringField(ir ?? {}, 'id') ??
              stringField(node ?? {}, 'id') ??
              `tool-${actions.length}`,
            stepIndex: actions.length,
            kind: 'tool',
            surface: 'tool',
            name: stringField(ir ?? {}, 'name') ?? 'graph-tool',
            status: 'started',
            timestampMs: timestamp(ir?.createdAt),
            metadata: { sourceEventType: 'graph-node', graphKind: kind },
          }),
        )
      }
      if (kind === 'ToolResult') {
        const prior = [...actions].reverse().find((action) => action.kind === 'tool')
        if (prior) prior.status = 'completed'
      }
      if (kind === 'CompletionDecision') {
        terminal = 'completed'
        explicitTerminal = true
        actions.push(
          actionFor({
            id:
              stringField(ir ?? {}, 'id') ??
              stringField(node ?? {}, 'id') ??
              `completion-${actions.length}`,
            stepIndex: actions.length,
            kind: 'graph-completion',
            surface: 'tool',
            name: 'complete',
            status: 'completed',
            timestampMs: timestamp(ir?.createdAt),
            metadata: { sourceEventType: 'graph-node', graphKind: kind },
          }),
        )
      }
    }
  }
  return { finalText: null, terminal, explicitTerminal, actions }
}

function completeClaudeTools(content: unknown[], calls: Map<string, CodeAgentSessionAction>): void {
  for (const value of content) {
    const part = record(value)
    if (!part || stringField(part, 'type') !== 'tool_result') continue
    const id = stringField(part, 'tool_use_id')
    const action = id ? calls.get(id) : undefined
    if (action) action.status = part.is_error === true ? 'failed' : 'completed'
  }
}

function isCodexActionItem(itemType: string | undefined): boolean {
  return (
    itemType === 'command_execution' ||
    itemType === 'mcp_tool_call' ||
    itemType === 'collab_tool_call' ||
    itemType === 'web_search' ||
    itemType === 'file_change'
  )
}

function codexItemSurface(
  itemType: string | undefined,
  item: Record<string, unknown>,
): CodeAgentSessionActionSurface {
  if (itemType === 'mcp_tool_call') return 'mcp'
  if (itemType === 'collab_tool_call') return 'subagent'
  if (itemType === 'web_search') return 'web'
  if (itemType === 'file_change') return 'code'
  return surfaceForTool(stringField(item, 'name') ?? itemType ?? 'tool')
}

function codexItemName(itemType: string | undefined, item: Record<string, unknown>): string {
  if (itemType === 'mcp_tool_call') {
    const server = stringField(item, 'server')
    const tool = stringField(item, 'tool')
    return [server, tool].filter(Boolean).join('/') || 'mcp'
  }
  if (itemType === 'collab_tool_call') return stringField(item, 'tool') ?? 'subagent'
  if (itemType === 'web_search') return 'web_search'
  if (itemType === 'file_change') return 'file_change'
  return stringField(item, 'name') ?? itemType ?? 'tool'
}

function codexItemStatus(
  itemType: string | undefined,
  item: Record<string, unknown>,
): CodeAgentSessionActionStatus {
  const status = statusFrom(item)
  if (status === 'failed') return status
  if (itemType === 'command_execution') {
    const exitCode = numberField(item, 'exit_code')
    if (exitCode !== undefined) return exitCode === 0 ? 'completed' : 'failed'
  }
  if (itemType === 'mcp_tool_call' && record(item.error)) return 'failed'
  return status === 'unknown' || status === 'started' ? 'completed' : status
}

function textFromMessagePayload(payload: Record<string, unknown>): string | null {
  const direct = nonEmpty(stringField(payload, 'text'))
  if (direct) return direct
  const content = payload.content
  if (typeof content === 'string') return nonEmpty(content)
  if (Array.isArray(content)) return textBlocks(content)
  return null
}

function textBlocks(values: unknown[]): string | null {
  const text = values
    .map((value) => record(value))
    .filter((value): value is Record<string, unknown> => value !== null)
    .filter((value) => stringField(value, 'type') === 'text')
    .map((value) => stringField(value, 'text'))
    .filter((value): value is string => value !== undefined)
    .join('\n')
  return nonEmpty(text)
}

function terminalWithExecution(
  projection: SessionProjection,
  execution: CodeAgentSessionExecutionReceipt | undefined,
): CodeAgentSessionObservation['terminal'] {
  if (!execution) {
    return { status: projection.terminal, explicit: projection.explicitTerminal }
  }
  assertExecutionReceipt(execution)
  return {
    status: execution.exitCode !== 0 || projection.terminal === 'failed' ? 'failed' : 'completed',
    explicit: true,
  }
}

function assertExecutionReceipt(receipt: CodeAgentSessionExecutionReceipt): void {
  if (!Number.isSafeInteger(receipt.exitCode)) {
    throw new Error('code-agent execution exitCode must be a safe integer')
  }
  for (const [name, value] of [
    ['startedAtMs', receipt.startedAtMs],
    ['completedAtMs', receipt.completedAtMs],
  ] as const) {
    if (value !== undefined && (!Number.isFinite(value) || value < 0)) {
      throw new Error(`code-agent execution ${name} must be a non-negative finite number`)
    }
  }
  if (
    receipt.startedAtMs !== undefined &&
    receipt.completedAtMs !== undefined &&
    receipt.completedAtMs < receipt.startedAtMs
  ) {
    throw new Error('code-agent execution completedAtMs precedes startedAtMs')
  }
}

function terminalAction(
  stepIndex: number,
  name: string,
  completed: boolean,
  timestampMs: number | undefined,
): CodeAgentSessionAction {
  return actionFor({
    id: `terminal-${stepIndex}`,
    stepIndex,
    kind: 'terminal',
    surface: 'tool',
    name,
    status: completed ? 'completed' : 'failed',
    timestampMs,
    metadata: { sourceEventType: name },
  })
}

function actionFor(input: CodeAgentSessionAction): CodeAgentSessionAction {
  return input
}

function surfaceForTool(name: string): CodeAgentSessionActionSurface {
  const normalized = name.toLowerCase()
  if (normalized.startsWith('mcp__') || normalized.includes('mcp_tool')) return 'mcp'
  if (
    normalized === 'task' ||
    normalized === 'agent' ||
    normalized.includes('subagent') ||
    normalized.includes('spawn_agent') ||
    normalized.includes('collab') ||
    normalized.startsWith('multi_agent')
  ) {
    return 'subagent'
  }
  if (normalized === 'skill' || normalized.includes('skill')) return 'skill'
  if (normalized.includes('hook')) return 'hook'
  if (
    normalized.includes('web_search') ||
    normalized.includes('webfetch') ||
    normalized === 'web'
  ) {
    return 'web'
  }
  if (
    normalized === 'edit' ||
    normalized === 'write' ||
    normalized.includes('patch') ||
    normalized.includes('file_change')
  ) {
    return 'code'
  }
  return 'tool'
}

function statusFrom(value: Record<string, unknown>): CodeAgentSessionActionStatus {
  const status = (stringField(value, 'status') ?? '').toLowerCase()
  if (status === 'completed' || status === 'success' || status === 'succeeded') return 'completed'
  if (status === 'error' || status === 'failed' || status === 'declined') return 'failed'
  if (status === 'running' || status === 'started' || status === 'in_progress') return 'started'
  return 'unknown'
}

function compactMetadata(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter((entry) => entry[1] !== undefined))
}

function sessionIdFromEntries(
  source: CodeAgentSessionSource,
  entries: Record<string, unknown>[],
): string | undefined {
  for (const entry of entries) {
    if (source === 'codex') {
      const threadId = stringField(entry, 'thread_id')
      if (threadId) return threadId
      const payload = record(entry.payload)
      const id = payload ? stringField(payload, 'id') : undefined
      if (id) return id
    }
    const message = record(entry.message)
    const payload = record(message?.payload)
    const sessionId =
      stringField(entry, 'sessionID') ??
      stringField(entry, 'sessionId') ??
      stringField(entry, 'session_id') ??
      stringField(payload ?? {}, 'session_id')
    if (sessionId) return sessionId
  }
  return undefined
}

function fallbackSessionId(source: CodeAgentSessionSource, sourcePath: string | undefined): string {
  return `${source}:${sourcePath ?? 'unknown-session'}`
}

function looksLikeError(value: unknown): boolean {
  if (isRecord(value)) {
    if (value.success === false || value.is_error === true) return true
    const exitCode = numberField(value, 'exit_code')
    if (exitCode !== undefined && exitCode !== 0) return true
  }
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? '')
  return /\b(?:error|failed|failure)\b|exit(?:_| )code["\s:]+[1-9]/i.test(text)
}

function nonEmpty(value: string | undefined): string | null {
  return value !== undefined && value.length > 0 ? value : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function record(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null
}

function stringField(value: Record<string, unknown>, key: string): string | undefined {
  const field = value[key]
  return typeof field === 'string' && field.length > 0 ? field : undefined
}

function numberField(value: Record<string, unknown>, key: string): number | undefined {
  const field = value[key]
  return typeof field === 'number' && Number.isFinite(field) ? field : undefined
}

function timestamp(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > 1_000_000_000_000 ? value : value * 1_000
  }
  if (typeof value === 'string' && value.length > 0) {
    const parsed = Date.parse(value)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
}
