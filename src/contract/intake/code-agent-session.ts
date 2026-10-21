import { hashCanonical as hashJson } from '../../ledger-core/canonical'
import { isModelPriced } from '../../metrics'
import type {
  RunCostProvenance,
  RunRecord,
  RunTerminalOutcome,
  RunTokenUsage,
} from '../../run-record'
import { codexMetrics } from './code-agent-codex-metrics'
import { record, stringField } from './code-agent-fields'
import { isRecord } from '../../llm-client/json'
import {
  claudeCodeMetrics,
  kimiCodeMetrics,
  openCodeMetrics,
  piGraphMetrics,
  piSessionMetrics,
} from './code-agent-harness-metrics'
import {
  cwdFromEntries,
  fallbackSessionId,
  hashString,
  modelFromEntries,
  sessionIdFromEntries,
  stableSeed,
  withSnapshot,
} from './code-agent-identity'
import {
  admittedCodexItem,
  type CodeAgentSessionObservation,
  type CodeAgentSessionSource,
  observeCodeAgentSession,
} from './code-agent-observation'
import { resolveSessionCost } from './code-agent-session-metrics'
import { clamp01 } from '../../run-score'
import type {
  CodeAgentSessionIntakeOptions,
  CodeAgentSessionIntakeResult,
  CodeAgentSessionMetrics,
} from './code-agent-session-types'

export {
  parseCodeAgentJsonl,
  parseCodeAgentJsonlFile,
  streamCodeAgentJsonlFile,
} from './code-agent-jsonl'
export type {
  CodeAgentSessionAction,
  CodeAgentSessionActionKind,
  CodeAgentSessionActionStatus,
  CodeAgentSessionActionSurface,
  CodeAgentSessionExecutionReceipt,
  CodeAgentSessionObservation,
  CodeAgentSessionSource,
  CodeAgentSessionTerminalStatus,
} from './code-agent-observation'
export { observeCodeAgentSession } from './code-agent-observation'
export type {
  CodeAgentJsonlLine,
  CodeAgentSessionDiagnostic,
  CodeAgentSessionIntakeOptions,
  CodeAgentSessionIntakeResult,
  CodeAgentSessionMetrics,
  ParsedCodeAgentJsonl,
} from './code-agent-session-types'

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

export function fromOpenCodeSession(
  options: CodeAgentSessionIntakeOptions,
): CodeAgentSessionIntakeResult {
  return fromCodeAgentSession('opencode', options)
}

export function fromKimiCodeSession(
  options: CodeAgentSessionIntakeOptions,
): CodeAgentSessionIntakeResult {
  return fromCodeAgentSession('kimi-code', options)
}

/** A native Pi session (`~/.pi/agent/sessions/<cwd>/<ts>_<id>.jsonl`), parsed entries in order. */
export function fromPiSession(
  options: CodeAgentSessionIntakeOptions,
): CodeAgentSessionIntakeResult {
  return fromCodeAgentSession('pi', options)
}

/** The graph IR a Pi graph run exports (`nodes[].ir`), which is not a Pi session. */
export function fromPiGraphSession(
  options: CodeAgentSessionIntakeOptions,
): CodeAgentSessionIntakeResult {
  return fromCodeAgentSession('pi-graph', options)
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
          hasExplicitTerminalSignal: false,
          hasFinalOutput: false,
          hasQualityLabel: false,
          hasTokenUsage: false,
          hasCost: false,
          costKind: 'uncaptured',
          warnings: ['no parseable session entries'],
        },
      ],
      metrics: [],
      observations: [],
    }
  }

  const metrics = metricsFor(source, entries)
  const sessionId =
    sessionIdFromEntries(source, entries) ?? fallbackSessionId(source, options.sourcePath)
  const observation = observeCodeAgentSession({
    source,
    entries,
    sourcePath: options.sourcePath,
    execution: options.execution,
  })
  applyObservedSurfaceMetrics(metrics, observation)
  const model = withSnapshot(options.model ?? modelFromEntries(source, entries) ?? source)
  const tokenUsage: RunTokenUsage = {
    input: metrics.inputTokens,
    output: metrics.outputTokens,
    ...(metrics.reasoningTokens > 0 ? { reasoning: metrics.reasoningTokens } : {}),
    ...(metrics.cachedTokens > 0 ? { cached: metrics.cachedTokens } : {}),
    ...(metrics.cacheWriteTokens > 0 ? { cacheWrite: metrics.cacheWriteTokens } : {}),
  }
  const { costUsd, costProvenance } = resolveSessionCost(options.costProvenance, metrics, model)
  const qualityScore = finiteScore(options.score)
  const invalidQualityScore = options.score !== undefined && qualityScore === undefined
  const promptHash =
    options.promptHash ?? hashString(`prompt:${source}:${firstUserText(entries) ?? ''}`)
  const configHash =
    options.configHash ??
    hashJson({
      source,
      model,
      sourcePath: options.sourcePath ?? null,
      cwd: cwdFromEntries(entries) ?? null,
      entryCount: entries.length,
    })
  const explicitTerminal = observation.terminal.explicit
  const warnings = diagnosticsFor(metrics, {
    model,
    explicitTerminal,
    malformedLines: options.malformedLines ?? 0,
    hasQualityLabel: qualityScore !== undefined,
    invalidQualityScore,
    costKind: costProvenance.kind,
  })

  const terminalOutcome = terminalOutcomeFromSession(observation.terminal)
  const processExitCode = options.execution?.exitCode
  const splitTag = options.splitTag ?? 'holdout'
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
    costProvenance,
    tokenUsage,
    terminalOutcome,
    ...(terminalOutcome === 'failed'
      ? {
          terminalFailureReason:
            processExitCode !== undefined && processExitCode !== 0
              ? `process exited with code ${processExitCode}`
              : metrics.turnsAborted > 0
                ? 'turn aborted'
                : 'session reported terminal failure',
        }
      : {}),
    outcome: {
      ...(qualityScore === undefined
        ? {}
        : splitTag === 'holdout'
          ? { holdoutScore: qualityScore }
          : { searchScore: qualityScore }),
      raw: {
        entries: metrics.entries,
        user_messages: metrics.userMessages,
        assistant_messages: metrics.assistantMessages,
        reasoning_items: metrics.reasoningItems,
        tool_calls: metrics.toolCalls,
        tool_outputs: metrics.toolOutputs,
        tool_errors: metrics.toolErrors,
        execution_error_count: metrics.toolErrors,
        process_error_count: terminalOutcome === 'failed' ? 1 : 0,
        unclassified_error_count: metrics.unclassifiedErrors,
        ...(processExitCode !== undefined ? { process_exit_code: processExitCode } : {}),
        patch_attempts: metrics.patchAttempts,
        patch_successes: metrics.patchSuccesses,
        patch_failures: metrics.patchFailures,
        turns_started: metrics.turnsStarted,
        turns_completed: metrics.turnsCompleted,
        turns_aborted: metrics.turnsAborted,
        context_compactions: metrics.contextCompactions,
        mcp_calls: metrics.mcpCalls,
        subagent_calls: metrics.subagentCalls,
        skill_calls: metrics.skillCalls,
        hook_calls: metrics.hookCalls,
        web_calls: metrics.webCalls,
        code_actions: metrics.codeActions,
        pr_links: metrics.prLinks,
        file_snapshots: metrics.fileSnapshots,
        graph_nodes: metrics.graphNodes,
        graph_edges: metrics.graphEdges,
        action_candidates: metrics.actionCandidates,
        verification_reports: metrics.verificationReports,
        completion_decisions: metrics.completionDecisions,
        reliability_rows: metrics.reliabilityRows,
        reliability_lift: metrics.reliabilityLift,
        input_tokens: metrics.inputTokens,
        output_tokens: metrics.outputTokens,
        reasoning_tokens: metrics.reasoningTokens,
        cached_tokens: metrics.cachedTokens,
        cache_write_tokens: metrics.cacheWriteTokens,
        observed_cost_usd: metrics.observedCostUsd,
        observed_cost_captured: metrics.observedCostCaptured ? 1 : 0,
        estimated_cost_usd: costProvenance.kind === 'estimated' ? costProvenance.usd : 0,
        process_score: metrics.processScore,
        explicit_terminal_signal: explicitTerminal ? 1 : 0,
        quality_label_present: qualityScore !== undefined ? 1 : 0,
        cost_observed: costProvenance.kind === 'observed' ? 1 : 0,
        cost_estimated: costProvenance.kind === 'estimated' ? 1 : 0,
        cost_uncaptured: costProvenance.kind === 'uncaptured' ? 1 : 0,
        cost_unknown: costProvenance.usd === null ? 1 : 0,
      },
    },
    splitTag,
    scenarioId: options.scenarioId ?? sessionId,
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
        hasExplicitTerminalSignal: explicitTerminal,
        hasFinalOutput: observation.finalText !== null,
        hasQualityLabel: qualityScore !== undefined,
        hasTokenUsage:
          metrics.inputTokens > 0 ||
          metrics.outputTokens > 0 ||
          metrics.reasoningTokens > 0 ||
          metrics.cachedTokens > 0 ||
          metrics.cacheWriteTokens > 0,
        hasCost: costProvenance.usd !== null,
        costKind: costProvenance.kind,
        warnings,
      },
    ],
    metrics: [metrics],
    observations: [{ ...observation, sessionId }],
  }
}

function terminalOutcomeFromSession(
  terminal: CodeAgentSessionObservation['terminal'],
): RunTerminalOutcome {
  if (!terminal.explicit) return 'unknown'
  if (terminal.status === 'completed') return 'succeeded'
  if (terminal.status === 'failed') return 'failed'
  return 'unknown'
}

function metricsFor(
  source: CodeAgentSessionSource,
  entries: Record<string, unknown>[],
): CodeAgentSessionMetrics {
  switch (source) {
    case 'codex':
      return codexMetrics(entries)
    case 'claude-code':
      return claudeCodeMetrics(entries)
    case 'opencode':
      return openCodeMetrics(entries)
    case 'kimi-code':
      return kimiCodeMetrics(entries)
    case 'pi':
      return piSessionMetrics(entries)
    case 'pi-graph':
      return piGraphMetrics(entries)
  }
}

function diagnosticsFor(
  metrics: CodeAgentSessionMetrics,
  options: {
    model: string
    explicitTerminal: boolean
    malformedLines: number
    hasQualityLabel: boolean
    invalidQualityScore: boolean
    costKind: RunCostProvenance['kind']
  },
): string[] {
  const warnings: string[] = []
  if (options.invalidQualityScore) warnings.push('non-finite task quality score omitted')
  else if (!options.hasQualityLabel) warnings.push('task quality score not supplied')
  if (!options.explicitTerminal) warnings.push('no explicit terminal success/failure signal')
  if (
    metrics.inputTokens === 0 &&
    metrics.outputTokens === 0 &&
    metrics.reasoningTokens === 0 &&
    metrics.cachedTokens === 0 &&
    metrics.cacheWriteTokens === 0
  ) {
    warnings.push('missing token usage')
  }
  if (options.costKind === 'estimated')
    warnings.push('USD cost estimated from token usage and model pricing')
  if (options.costKind === 'lower-bound') warnings.push('USD cost known only as a lower bound')
  if (options.costKind === 'uncaptured') warnings.push('USD cost uncaptured')
  if (options.costKind === 'uncaptured' && !isModelPriced(options.model))
    warnings.push('model pricing unknown')
  if (options.malformedLines > 0)
    warnings.push(`${options.malformedLines} malformed JSONL lines skipped`)
  return warnings
}

function applyObservedSurfaceMetrics(
  metrics: CodeAgentSessionMetrics,
  observation: CodeAgentSessionObservation,
): void {
  const actions = observation.actions.filter(
    (action) => action.kind === 'tool' || action.kind === 'patch',
  )
  metrics.mcpCalls = actions.filter((action) => action.surface === 'mcp').length
  metrics.subagentCalls = actions.filter((action) => action.surface === 'subagent').length
  metrics.skillCalls = actions.filter((action) => action.surface === 'skill').length
  metrics.hookCalls = actions.filter((action) => action.surface === 'hook').length
  metrics.webCalls = actions.filter((action) => action.surface === 'web').length
  metrics.codeActions = actions.filter((action) => action.surface === 'code').length
}

/** Join the `text` of every part in a `[{ type: 'text', text }]` content list. */
function textFromContentParts(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined
  const text = content
    .map((part) => {
      const obj = record(part)
      return obj ? stringField(obj, 'text') : undefined
    })
    .filter((part): part is string => part !== undefined)
    .join('\n')
  return text.length > 0 ? text : undefined
}

function firstUserText(entries: Record<string, unknown>[]): string | undefined {
  for (const entry of entries) {
    const payload = record(entry.payload)
    const payloadType = payload ? stringField(payload, 'type') : undefined
    if (payloadType === 'user_message') return stringField(payload!, 'message')

    // A Codex rollout carries the prompt only as a `UserMessage` item. Without
    // this, every rollout session hashes the same empty prompt.
    const itemEvent = payload ? admittedCodexItem(entry, false) : null
    if (itemEvent && stringField(itemEvent.item, 'type') === 'user_message') {
      const text = textFromContentParts(itemEvent.item.content)
      if (text) return text
    }

    if (stringField(entry, 'role') === 'user') {
      const content = entry.content
      if (typeof content === 'string') return content
    }

    const wirePayload = record(record(entry.message)?.payload)
    const userInput = wirePayload ? stringField(wirePayload, 'user_input') : undefined
    if (userInput) return userInput

    const message = record(entry.message)
    if (message && stringField(message, 'role') === 'user') {
      const content = message.content
      if (typeof content === 'string') return content
      const text = textFromContentParts(content)
      if (text) return text
    }
  }
  return undefined
}

function finiteScore(value: number | undefined): number | undefined {
  return value !== undefined && Number.isFinite(value) ? clamp01(value) : undefined
}
