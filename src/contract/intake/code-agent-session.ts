import { createHash } from 'node:crypto'
import { estimateCost, isModelPriced } from '../../metrics'
import type { RunRecord, RunSplitTag, RunTokenUsage } from '../../run-record'

export type CodeAgentSessionSource = 'codex' | 'claude-code'

export interface ParsedCodeAgentJsonl {
  entries: unknown[]
  malformedLines: number
}

export interface CodeAgentSessionMetrics {
  entries: number
  userMessages: number
  assistantMessages: number
  reasoningItems: number
  toolCalls: number
  toolOutputs: number
  toolErrors: number
  patchAttempts: number
  patchSuccesses: number
  patchFailures: number
  turnsStarted: number
  turnsCompleted: number
  turnsAborted: number
  contextCompactions: number
  prLinks: number
  inputTokens: number
  outputTokens: number
  cachedTokens: number
  wallMs: number
  processScore: number
}

export interface CodeAgentSessionDiagnostic {
  source: CodeAgentSessionSource
  sessionId: string
  sourcePath?: string
  entries: number
  malformedLines: number
  inferredScore: boolean
  hasExplicitTerminalSignal: boolean
  hasQualityLabel: boolean
  hasTokenUsage: boolean
  hasCost: boolean
  warnings: string[]
}

export interface CodeAgentSessionIntakeResult {
  runs: RunRecord[]
  diagnostics: CodeAgentSessionDiagnostic[]
  metrics: CodeAgentSessionMetrics[]
}

export interface CodeAgentSessionIntakeOptions {
  entries: unknown[]
  malformedLines?: number
  sourcePath?: string
  experimentId?: string
  candidateId?: string
  seed?: number
  splitTag?: RunSplitTag
  scenarioId?: string
  model?: string
  promptHash?: string
  configHash?: string
  commitSha?: string
  score?: number
}

export function parseCodeAgentJsonl(jsonl: string): ParsedCodeAgentJsonl {
  const entries: unknown[] = []
  let malformedLines = 0
  for (const line of jsonl.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      entries.push(JSON.parse(trimmed))
    } catch {
      malformedLines += 1
    }
  }
  return { entries, malformedLines }
}

export function fromCodexSession(
  options: CodeAgentSessionIntakeOptions,
): CodeAgentSessionIntakeResult {
  return fromCodeAgentSession('codex', options)
}

export function fromClaudeCodeSession(
  options: CodeAgentSessionIntakeOptions,
): CodeAgentSessionIntakeResult {
  return fromCodeAgentSession('claude-code', options)
}

function fromCodeAgentSession(
  source: CodeAgentSessionSource,
  options: CodeAgentSessionIntakeOptions,
): CodeAgentSessionIntakeResult {
  const entries = options.entries.filter(isRecord)
  if (entries.length === 0) {
    return {
      runs: [],
      diagnostics: [
        {
          source,
          sessionId: fallbackSessionId(source, options.sourcePath),
          sourcePath: options.sourcePath,
          entries: 0,
          malformedLines: options.malformedLines ?? 0,
          inferredScore: true,
          hasExplicitTerminalSignal: false,
          hasQualityLabel: false,
          hasTokenUsage: false,
          hasCost: false,
          warnings: ['no parseable session entries'],
        },
      ],
      metrics: [],
    }
  }

  const metrics = source === 'codex' ? codexMetrics(entries) : claudeCodeMetrics(entries)
  const sessionId =
    sessionIdFromEntries(source, entries) ?? fallbackSessionId(source, options.sourcePath)
  const model = withSnapshot(options.model ?? modelFromEntries(source, entries) ?? source)
  const tokenUsage: RunTokenUsage = {
    input: metrics.inputTokens,
    output: metrics.outputTokens,
    ...(metrics.cachedTokens > 0 ? { cached: metrics.cachedTokens } : {}),
  }
  const costUsd =
    metrics.inputTokens > 0 || metrics.outputTokens > 0
      ? estimateCost(metrics.inputTokens, metrics.outputTokens, model)
      : 0
  const score = clamp01(options.score ?? metrics.processScore)
  const promptHash =
    options.promptHash ?? hashString(`prompt:${source}:${firstUserText(entries) ?? ''}`)
  const configHash =
    options.configHash ??
    hashJson({
      source,
      model,
      sourcePath: options.sourcePath,
      cwd: cwdFromEntries(entries),
      entryCount: entries.length,
    })
  const explicitTerminal = hasExplicitTerminalSignal(source, metrics)
  const warnings = diagnosticsFor(metrics, {
    model,
    explicitTerminal,
    malformedLines: options.malformedLines ?? 0,
    scoreOverridden: options.score !== undefined,
    costUsd,
  })

  const run: RunRecord = {
    runId: `${source}:${sessionId}`,
    experimentId: options.experimentId ?? `${source}-local-sessions`,
    candidateId: options.candidateId ?? model,
    seed: options.seed ?? stableSeed(sessionId),
    model,
    promptHash,
    configHash,
    commitSha: options.commitSha ?? 'local-session',
    wallMs: metrics.wallMs,
    costUsd,
    tokenUsage,
    outcome: {
      holdoutScore: score,
      raw: {
        entries: metrics.entries,
        user_messages: metrics.userMessages,
        assistant_messages: metrics.assistantMessages,
        reasoning_items: metrics.reasoningItems,
        tool_calls: metrics.toolCalls,
        tool_outputs: metrics.toolOutputs,
        tool_errors: metrics.toolErrors,
        patch_attempts: metrics.patchAttempts,
        patch_successes: metrics.patchSuccesses,
        patch_failures: metrics.patchFailures,
        turns_started: metrics.turnsStarted,
        turns_completed: metrics.turnsCompleted,
        turns_aborted: metrics.turnsAborted,
        context_compactions: metrics.contextCompactions,
        pr_links: metrics.prLinks,
        input_tokens: metrics.inputTokens,
        output_tokens: metrics.outputTokens,
        cached_tokens: metrics.cachedTokens,
        process_score: score,
        inferred_score: options.score === undefined ? 1 : 0,
        explicit_terminal_signal: explicitTerminal ? 1 : 0,
        quality_label_present: options.score !== undefined ? 1 : 0,
        cost_unknown: costUsd === 0 && !isModelPriced(model) ? 1 : 0,
      },
    },
    splitTag: options.splitTag ?? 'holdout',
    ...(options.scenarioId ? { scenarioId: options.scenarioId } : {}),
    ...(metrics.toolErrors > 0 || metrics.turnsAborted > 0
      ? { failureMode: metrics.turnsAborted > 0 ? 'turn_aborted' : 'tool_error' }
      : {}),
  }

  return {
    runs: [run],
    diagnostics: [
      {
        source,
        sessionId,
        sourcePath: options.sourcePath,
        entries: entries.length,
        malformedLines: options.malformedLines ?? 0,
        inferredScore: options.score === undefined,
        hasExplicitTerminalSignal: explicitTerminal,
        hasQualityLabel: options.score !== undefined,
        hasTokenUsage: metrics.inputTokens > 0 || metrics.outputTokens > 0,
        hasCost: costUsd > 0,
        warnings,
      },
    ],
    metrics: [metrics],
  }
}

function codexMetrics(entries: Record<string, unknown>[]): CodeAgentSessionMetrics {
  const metrics = emptyMetrics(entries.length)
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
        setCumulativeUsage(metrics, record(record(payload.info)?.total_token_usage))
      const result = record(payload.result)
      if (result && 'Err' in result) metrics.toolErrors += 1
    }
  }

  if (metrics.wallMs === 0 && startedAt !== undefined && completedAt !== undefined) {
    metrics.wallMs = Math.max(0, completedAt - startedAt)
  }
  metrics.processScore = codexProcessScore(metrics)
  return metrics
}

function claudeCodeMetrics(entries: Record<string, unknown>[]): CodeAgentSessionMetrics {
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
    if (type === 'file-history-snapshot') metrics.patchAttempts += 1

    const message = record(entry.message)
    if (message) addUsage(metrics, record(message.usage))
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

  if (startedAt !== undefined && completedAt !== undefined)
    metrics.wallMs = Math.max(0, completedAt - startedAt)
  metrics.patchSuccesses = metrics.patchAttempts
  metrics.processScore = claudeProcessScore(metrics)
  return metrics
}

function emptyMetrics(entries: number): CodeAgentSessionMetrics {
  return {
    entries,
    userMessages: 0,
    assistantMessages: 0,
    reasoningItems: 0,
    toolCalls: 0,
    toolOutputs: 0,
    toolErrors: 0,
    patchAttempts: 0,
    patchSuccesses: 0,
    patchFailures: 0,
    turnsStarted: 0,
    turnsCompleted: 0,
    turnsAborted: 0,
    contextCompactions: 0,
    prLinks: 0,
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
    wallMs: 0,
    processScore: 0,
  }
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

function claudeProcessScore(metrics: CodeAgentSessionMetrics): number {
  const base = metrics.prLinks > 0 ? 1 : metrics.assistantMessages > 0 ? 0.75 : 0
  return penalizeErrors(base, metrics)
}

function penalizeErrors(base: number, metrics: CodeAgentSessionMetrics): number {
  const operations = Math.max(1, metrics.toolCalls + metrics.patchAttempts)
  const errorRate = Math.min(1, (metrics.toolErrors + metrics.patchFailures) / operations)
  return clamp01(base * (1 - 0.5 * errorRate))
}

function addUsage(
  metrics: CodeAgentSessionMetrics,
  usage: Record<string, unknown> | null | undefined,
): void {
  const parsed = readUsage(usage)
  metrics.inputTokens += parsed.input
  metrics.outputTokens += parsed.output
  metrics.cachedTokens += parsed.cached
}

function setCumulativeUsage(
  metrics: CodeAgentSessionMetrics,
  usage: Record<string, unknown> | null | undefined,
): void {
  const parsed = readUsage(usage)
  metrics.inputTokens = Math.max(metrics.inputTokens, parsed.input)
  metrics.outputTokens = Math.max(metrics.outputTokens, parsed.output)
  metrics.cachedTokens = Math.max(metrics.cachedTokens, parsed.cached)
}

function readUsage(usage: Record<string, unknown> | null | undefined): {
  input: number
  output: number
  cached: number
} {
  if (!usage) return { input: 0, output: 0, cached: 0 }
  return {
    input: numericUsage(usage, ['input_tokens', 'inputTokens', 'prompt_tokens', 'promptTokens']),
    output: numericUsage(usage, [
      'output_tokens',
      'outputTokens',
      'completion_tokens',
      'completionTokens',
    ]),
    cached: numericUsage(usage, [
      'cached_tokens',
      'cachedTokens',
      'cache_read_input_tokens',
      'cacheReadInputTokens',
      'cache_creation_input_tokens',
      'cacheCreationInputTokens',
    ]),
  }
}

function numericUsage(obj: Record<string, unknown>, names: string[]): number {
  let total = 0
  for (const name of names) {
    const value = obj[name]
    if (typeof value === 'number' && Number.isFinite(value)) total += value
  }
  return total
}

function diagnosticsFor(
  metrics: CodeAgentSessionMetrics,
  options: {
    model: string
    explicitTerminal: boolean
    malformedLines: number
    scoreOverridden: boolean
    costUsd: number
  },
): string[] {
  const warnings: string[] = []
  if (!options.scoreOverridden) warnings.push('outcome score is inferred from process telemetry')
  if (!options.explicitTerminal) warnings.push('no explicit terminal success/failure signal')
  if (metrics.inputTokens === 0 && metrics.outputTokens === 0) warnings.push('missing token usage')
  if (options.costUsd === 0 && !isModelPriced(options.model)) warnings.push('model pricing unknown')
  if (options.malformedLines > 0)
    warnings.push(`${options.malformedLines} malformed JSONL lines skipped`)
  return warnings
}

function hasExplicitTerminalSignal(
  source: CodeAgentSessionSource,
  metrics: CodeAgentSessionMetrics,
): boolean {
  if (source === 'codex') return metrics.turnsCompleted + metrics.turnsAborted > 0
  return metrics.prLinks > 0 || metrics.toolErrors > 0
}

function sessionIdFromEntries(
  source: CodeAgentSessionSource,
  entries: Record<string, unknown>[],
): string | undefined {
  for (const entry of entries) {
    if (source === 'codex') {
      const payload = record(entry.payload)
      const id = payload ? stringField(payload, 'id') : undefined
      if (id) return id
    }
    const sessionId = stringField(entry, 'sessionId') ?? stringField(entry, 'session_id')
    if (sessionId) return sessionId
  }
  return undefined
}

function modelFromEntries(
  source: CodeAgentSessionSource,
  entries: Record<string, unknown>[],
): string | undefined {
  let providerModel: string | undefined
  for (const entry of entries) {
    if (source === 'codex') {
      const payload = record(entry.payload)
      const model = payload ? stringField(payload, 'model') : undefined
      if (model) return model
      providerModel =
        providerModel ?? (payload ? stringField(payload, 'model_provider') : undefined)
    }
    const message = record(entry.message)
    const model = message ? stringField(message, 'model') : undefined
    if (model) return model
  }
  return providerModel
}

function cwdFromEntries(entries: Record<string, unknown>[]): string | undefined {
  for (const entry of entries) {
    const cwd =
      stringField(entry, 'cwd') ??
      (record(entry.payload) ? stringField(record(entry.payload)!, 'cwd') : undefined)
    if (cwd) return cwd
  }
  return undefined
}

function firstUserText(entries: Record<string, unknown>[]): string | undefined {
  for (const entry of entries) {
    const payload = record(entry.payload)
    const payloadType = payload ? stringField(payload, 'type') : undefined
    if (payloadType === 'user_message') return stringField(payload!, 'message')

    const message = record(entry.message)
    if (message && stringField(message, 'role') === 'user') {
      const content = message.content
      if (typeof content === 'string') return content
      if (Array.isArray(content)) {
        const text = content
          .map((part) => {
            const obj = record(part)
            return obj ? stringField(obj, 'text') : undefined
          })
          .filter((part): part is string => part !== undefined)
          .join('\n')
        if (text) return text
      }
    }
  }
  return undefined
}

function fallbackSessionId(source: CodeAgentSessionSource, sourcePath: string | undefined): string {
  return hashString(`${source}:${sourcePath ?? 'unknown-session'}`).slice(
    'sha256:'.length,
    'sha256:'.length + 20,
  )
}

function withSnapshot(model: string): string {
  const trimmed = model.trim() || 'unknown'
  if (trimmed.includes('@') || /-\d{8}$/.test(trimmed) || /-\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    return trimmed
  }
  return `${trimmed}@observed-local`
}

function hashJson(value: unknown): string {
  return hashString(JSON.stringify(value))
}

function hashString(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`
}

function stableSeed(value: string): number {
  return createHash('sha256').update(value).digest().readUInt32BE(0)
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(1, value))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function record(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null
}

function stringField(obj: Record<string, unknown>, key: string): string | undefined {
  const value = obj[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function numberField(obj: Record<string, unknown>, key: string): number | undefined {
  const value = obj[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function timestampMs(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > 1_000_000_000_000 ? value : value * 1000
  }
  if (typeof value === 'string' && value.length > 0) {
    const parsed = Date.parse(value)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
}
