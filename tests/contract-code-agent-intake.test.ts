import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  analyzeRuns,
  fromClaudeCodeSession,
  fromCodexSession,
  fromKimiCodeSession,
  fromOpenCodeSession,
  fromPiSession,
  parseCodeAgentJsonl,
} from '../src/contract'
import { validateRunRecord } from '../src/run-record'

describe('code-agent session intake', () => {
  it('parses JSONL while reporting malformed rows', () => {
    const parsed = parseCodeAgentJsonl('{"type":"ok"}\nnot-json\n{"type":"also-ok"}\n')

    expect(parsed.entries).toHaveLength(2)
    expect(parsed.malformedLines).toBe(1)
  })

  it('projects Codex session JSONL into a process-scored RunRecord without raw prompt text', async () => {
    const secretPrompt = 'fix the release without leaking secret-session-text'
    const { runs, diagnostics, metrics } = fromCodexSession({
      entries: [
        {
          timestamp: '2026-06-05T00:00:00.000Z',
          type: 'session_meta',
          payload: { id: 'codex-session-1', cwd: '/repo', model_provider: 'openai' },
        },
        {
          timestamp: '2026-06-05T00:00:01.000Z',
          type: 'turn_context',
          payload: { model: 'claude-code/sonnet', cwd: '/repo' },
        },
        {
          timestamp: '2026-06-05T00:00:02.000Z',
          type: 'event_msg',
          payload: { type: 'task_started', started_at: 1780000000 },
        },
        {
          timestamp: '2026-06-05T00:00:03.000Z',
          type: 'event_msg',
          payload: { type: 'user_message', message: secretPrompt },
        },
        {
          timestamp: '2026-06-05T00:00:04.000Z',
          type: 'response_item',
          payload: { type: 'function_call', name: 'functions.exec_command', call_id: 'call-1' },
        },
        {
          timestamp: '2026-06-05T00:00:05.000Z',
          type: 'response_item',
          payload: { type: 'function_call_output', call_id: 'call-1', output: 'done' },
        },
        {
          timestamp: '2026-06-05T00:00:06.000Z',
          type: 'event_msg',
          payload: {
            type: 'patch_apply_end',
            call_id: 'patch-1',
            success: false,
            status: 'failed',
          },
        },
        {
          timestamp: '2026-06-05T00:00:07.000Z',
          type: 'event_msg',
          payload: {
            type: 'token_count',
            info: {
              total_token_usage: {
                input_tokens: 100,
                output_tokens: 30,
                cache_read_input_tokens: 20,
              },
            },
          },
        },
        {
          timestamp: '2026-06-05T00:00:08.000Z',
          type: 'event_msg',
          payload: {
            type: 'token_count',
            info: {
              total_token_usage: {
                input_tokens: 1000,
                output_tokens: 300,
                cached_input_tokens: 200,
                reasoning_output_tokens: 120,
              },
            },
          },
        },
        {
          timestamp: '2026-06-05T00:00:09.000Z',
          type: 'event_msg',
          payload: { type: 'task_complete', completed_at: 1780000010, duration_ms: 10_000 },
        },
      ],
      malformedLines: 1,
      sourcePath: '/Users/drew/.codex/sessions/demo.jsonl',
      commitSha: 'abc123',
    })

    expect(runs).toHaveLength(1)
    const run = validateRunRecord(runs[0])
    expect(run.runId).toBe('codex:codex-session-1')
    expect(run.model).toBe('claude-code/sonnet@observed-local')
    expect(run.costUsd).toBeGreaterThan(0)
    expect(run.tokenUsage).toEqual({ input: 1000, output: 300, cached: 200 })
    expect(run.outcome.holdoutScore).toBeGreaterThan(0)
    expect(run.outcome.holdoutScore).toBeLessThan(1)
    expect(run.failureMode).toBe('tool_error')
    expect(run.outcome.raw.patch_failures).toBe(1)
    expect(run.outcome.raw.inferred_score).toBe(1)
    expect(JSON.stringify(run)).not.toContain(secretPrompt)

    expect(diagnostics[0]).toMatchObject({
      source: 'codex',
      sessionId: 'codex-session-1',
      malformedLines: 1,
      inferredScore: true,
      hasExplicitTerminalSignal: true,
      hasTokenUsage: true,
      hasCost: true,
    })
    expect(diagnostics[0]!.warnings).toContain('outcome score is inferred from process telemetry')
    expect(metrics[0]!.patchFailures).toBe(1)

    const report = await analyzeRuns({ runs })
    expect(report.n).toBe(1)
    expect(report.composite.n).toBe(1)
  })

  it('projects Codex exec 0.144.1 JSONL lifecycle items and usage', () => {
    const jsonl = readFileSync(
      new URL('./fixtures/codex-exec-0.144.1.jsonl', import.meta.url),
      'utf8',
    )
    const parsed = parseCodeAgentJsonl(jsonl)
    const { runs, diagnostics, metrics } = fromCodexSession({
      ...parsed,
      sourcePath: 'codex-exec-0.144.1.jsonl',
      model: 'gpt-5.4@2026-07-12',
    })

    expect(parsed.entries).toHaveLength(15)
    expect(parsed.malformedLines).toBe(0)
    expect(metrics[0]).toMatchObject({
      entries: 15,
      assistantMessages: 1,
      reasoningItems: 1,
      toolCalls: 4,
      toolOutputs: 4,
      toolErrors: 1,
      patchAttempts: 1,
      patchSuccesses: 1,
      patchFailures: 0,
      turnsStarted: 1,
      turnsCompleted: 1,
      turnsAborted: 0,
      inputTokens: 482267,
      outputTokens: 9006,
      cachedTokens: 409600,
      processScore: 0.9,
    })
    expect(runs[0]).toMatchObject({
      runId: 'codex:00000000-0000-7000-8000-000000000144',
      tokenUsage: { input: 482267, output: 9006, cached: 409600 },
      failureMode: 'tool_error',
    })
    expect(diagnostics[0]).toMatchObject({
      sessionId: '00000000-0000-7000-8000-000000000144',
      hasExplicitTerminalSignal: true,
      hasTokenUsage: true,
    })
  })

  it('treats a failed Codex exec turn as an explicit abort', () => {
    const { runs, diagnostics, metrics } = fromCodexSession({
      entries: [
        { type: 'thread.started', thread_id: 'codex-failed-turn' },
        { type: 'turn.started' },
        { type: 'error', message: 'request failed' },
        { type: 'turn.failed', error: { message: 'request failed' } },
      ],
      model: 'gpt-5.4@2026-07-12',
    })

    expect(metrics[0]).toMatchObject({
      turnsStarted: 1,
      turnsCompleted: 0,
      turnsAborted: 1,
      toolErrors: 1,
      processScore: 0,
    })
    expect(runs[0]!.failureMode).toBe('turn_aborted')
    expect(diagnostics[0]!.hasExplicitTerminalSignal).toBe(true)
  })

  it('projects Claude Code sessions with tool errors and PR links into RunRecord metrics', () => {
    const { runs, diagnostics, metrics } = fromClaudeCodeSession({
      entries: [
        {
          type: 'user',
          sessionId: 'claude-session-1',
          timestamp: '2026-06-05T00:00:00.000Z',
          cwd: '/repo',
          message: { role: 'user', content: [{ type: 'text', text: 'ship the change' }] },
        },
        {
          type: 'assistant',
          sessionId: 'claude-session-1',
          timestamp: '2026-06-05T00:00:05.000Z',
          cwd: '/repo',
          message: {
            model: 'claude-sonnet-4-6',
            role: 'assistant',
            usage: {
              input_tokens: 900,
              output_tokens: 250,
              cache_read_input_tokens: 100,
            },
            content: [
              { type: 'thinking', thinking: 'hidden' },
              { type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'pnpm test' } },
              {
                type: 'tool_result',
                tool_use_id: 'tool-1',
                content: 'failed',
                is_error: true,
              },
            ],
          },
        },
        {
          type: 'pr-link',
          sessionId: 'claude-session-1',
          prNumber: 24,
          prUrl: 'https://github.com/tangle-network/agent-knowledge/pull/24',
          prRepository: 'tangle-network/agent-knowledge',
          timestamp: '2026-06-05T00:00:10.000Z',
        },
        {
          type: 'file-history-snapshot',
          sessionId: 'claude-session-1',
          timestamp: '2026-06-05T00:00:11.000Z',
        },
      ],
      commitSha: 'def456',
    })

    const run = validateRunRecord(runs[0])
    expect(run.runId).toBe('claude-code:claude-session-1')
    expect(run.model).toBe('claude-sonnet-4-6@observed-local')
    expect(run.costUsd).toBeGreaterThan(0)
    expect(run.tokenUsage).toEqual({ input: 900, output: 250, cached: 100 })
    expect(run.outcome.raw.pr_links).toBe(1)
    expect(run.outcome.raw.tool_errors).toBe(1)
    expect(run.failureMode).toBe('tool_error')
    expect(diagnostics[0]!.hasExplicitTerminalSignal).toBe(true)
    expect(metrics[0]).toMatchObject({
      userMessages: 1,
      assistantMessages: 1,
      reasoningItems: 1,
      toolCalls: 1,
      toolOutputs: 1,
      toolErrors: 1,
      prLinks: 1,
      fileSnapshots: 1,
      patchAttempts: 0,
    })
  })

  it('projects OpenCode message and part records without double-counting token summaries', () => {
    const { runs, diagnostics, metrics } = fromOpenCodeSession({
      entries: [
        {
          id: 'msg-user',
          sessionID: 'opencode-session-1',
          role: 'user',
          time: { created: 1780000000 },
        },
        {
          id: 'msg-assistant',
          sessionID: 'opencode-session-1',
          role: 'assistant',
          parentID: 'msg-user',
          providerID: 'kimi',
          modelID: 'kimi-k2-code',
          path: { cwd: '/repo', root: '/repo' },
          time: { created: 1780000001, completed: 1780000011 },
          tokens: { input: 1000, output: 120, reasoning: 30, cache: 40 },
          cost: 0.42,
          finish: 'stop',
        },
        {
          id: 'part-reasoning',
          messageID: 'msg-assistant',
          sessionID: 'opencode-session-1',
          type: 'reasoning',
        },
        {
          id: 'part-tool-ok',
          messageID: 'msg-assistant',
          sessionID: 'opencode-session-1',
          type: 'tool',
          tool: 'bash',
          state: { status: 'completed' },
        },
        {
          id: 'part-tool-error',
          messageID: 'msg-assistant',
          sessionID: 'opencode-session-1',
          type: 'tool',
          tool: 'edit',
          state: { status: 'error' },
        },
        {
          id: 'part-patch',
          messageID: 'msg-assistant',
          sessionID: 'opencode-session-1',
          type: 'patch',
          files: [{ path: 'src/index.ts' }],
        },
        {
          id: 'part-step-finish',
          messageID: 'msg-assistant',
          sessionID: 'opencode-session-1',
          type: 'step-finish',
          tokens: { input: 9999, output: 9999, cache: 9999 },
          cost: 9.99,
        },
      ],
    })

    const run = validateRunRecord(runs[0])
    expect(run.runId).toBe('opencode:opencode-session-1')
    expect(run.model).toBe('kimi/kimi-k2-code@observed-local')
    expect(run.tokenUsage).toEqual({ input: 1000, output: 150, cached: 40 })
    expect(run.costUsd).toBe(0.42)
    expect(run.failureMode).toBe('tool_error')
    expect(run.outcome.raw.tool_calls).toBe(2)
    expect(run.outcome.raw.tool_outputs).toBe(2)
    expect(run.outcome.raw.patch_successes).toBe(1)
    expect(diagnostics[0]!.hasExplicitTerminalSignal).toBe(true)
    expect(metrics[0]).toMatchObject({
      userMessages: 1,
      assistantMessages: 1,
      reasoningItems: 1,
      toolErrors: 1,
      observedCostUsd: 0.42,
    })
  })

  it('projects Kimi Code wire events and token usage into RunRecord metrics', () => {
    const secretPrompt = 'private kimi task text'
    const { runs, diagnostics, metrics } = fromKimiCodeSession({
      entries: [
        {
          session_id: 'kimi-session-1',
          timestamp: 1780000000,
          message: { type: 'TurnBegin', payload: { user_input: secretPrompt } },
        },
        {
          session_id: 'kimi-session-1',
          timestamp: 1780000001,
          message: { type: 'StepBegin', payload: { n: 1 } },
        },
        {
          session_id: 'kimi-session-1',
          timestamp: 1780000002,
          message: { type: 'ContentPart', payload: { type: 'think', think: 'hidden' } },
        },
        {
          session_id: 'kimi-session-1',
          timestamp: 1780000003,
          message: {
            type: 'ToolCall',
            payload: { type: 'function', id: 'tool-1', function: { name: 'bash' } },
          },
        },
        {
          session_id: 'kimi-session-1',
          timestamp: 1780000004,
          message: {
            type: 'ToolResult',
            payload: { tool_call_id: 'tool-1', return_value: { is_error: false } },
          },
        },
        {
          session_id: 'kimi-session-1',
          timestamp: 1780000005,
          message: {
            type: 'StatusUpdate',
            payload: {
              token_usage: {
                input_other: 700,
                output: 110,
                input_cache_read: 50,
                input_cache_creation: 25,
              },
            },
          },
        },
        {
          session_id: 'kimi-session-1',
          timestamp: 1780000010,
          message: { type: 'TurnEnd', payload: {} },
        },
      ],
      model: 'kimi-code@2026-05-01',
    })

    const run = validateRunRecord(runs[0])
    expect(run.runId).toBe('kimi-code:kimi-session-1')
    expect(run.model).toBe('kimi-code@2026-05-01')
    expect(run.tokenUsage).toEqual({ input: 700, output: 110, cached: 75 })
    expect(run.outcome.raw.turns_started).toBe(1)
    expect(run.outcome.raw.turns_completed).toBe(1)
    expect(run.outcome.raw.reasoning_items).toBe(2)
    expect(JSON.stringify(run)).not.toContain(secretPrompt)
    expect(diagnostics[0]!.hasExplicitTerminalSignal).toBe(true)
    expect(metrics[0]).toMatchObject({
      userMessages: 1,
      toolCalls: 1,
      toolOutputs: 1,
      toolErrors: 0,
    })
  })

  it('projects PiGraph graph and reliability artifacts into a process-scored RunRecord', () => {
    const { runs, diagnostics, metrics } = fromPiSession({
      entries: [
        {
          session_id: 'pi-session-1',
          nodes: [
            { id: 'goal', ir: { kind: 'GoalSpec' } },
            { id: 'candidate', ir: { kind: 'ActionCandidate' } },
            { id: 'tool', ir: { kind: 'ToolInvocation' } },
            { id: 'result', ir: { kind: 'ToolResult' } },
            { id: 'verify', ir: { kind: 'VerificationReport' } },
            { id: 'done', ir: { kind: 'CompletionDecision' } },
          ],
          edges: [
            { from: 'goal', to: 'candidate', relation: 'selects' },
            { from: 'candidate', to: 'tool', relation: 'precedes' },
          ],
        },
        {
          session_id: 'pi-session-1',
          averageNodeReliability: 0.82,
          pessimisticPathEstimate: 0.71,
        },
        {
          session_id: 'pi-session-1',
          rows: [
            { validatedSuccessEstimate: 0.87, lift: 0.12 },
            { validatedSuccessEstimate: 0.91, lift: 0.2 },
          ],
        },
      ],
    })

    const run = validateRunRecord(runs[0])
    expect(run.runId).toBe('pi:pi-session-1')
    expect(run.model).toBe('pi@observed-local')
    expect(run.costUsd).toBe(0)
    expect(run.outcome.holdoutScore).toBe(0.91)
    expect(run.outcome.raw.graph_nodes).toBe(6)
    expect(run.outcome.raw.graph_edges).toBe(2)
    expect(run.outcome.raw.action_candidates).toBe(1)
    expect(run.outcome.raw.verification_reports).toBe(1)
    expect(run.outcome.raw.completion_decisions).toBe(1)
    expect(run.outcome.raw.reliability_rows).toBe(2)
    expect(run.outcome.raw.reliability_lift).toBe(0.2)
    expect(diagnostics[0]!.hasExplicitTerminalSignal).toBe(true)
    expect(metrics[0]).toMatchObject({
      toolCalls: 1,
      toolOutputs: 1,
      completionDecisions: 1,
      reliabilityRows: 2,
    })
  })

  it('allows callers to provide an external quality score when one exists', () => {
    const { runs, diagnostics } = fromCodexSession({
      entries: [
        { type: 'session_meta', payload: { id: 'scored-session', model_provider: 'codex' } },
        { type: 'event_msg', payload: { type: 'task_complete', duration_ms: 1000 } },
      ],
      score: 0.92,
      model: 'gpt-5@2026-06-05',
    })

    expect(runs[0]!.outcome.holdoutScore).toBe(0.92)
    expect(runs[0]!.outcome.raw.inferred_score).toBe(0)
    expect(runs[0]!.outcome.raw.quality_label_present).toBe(1)
    expect(diagnostics[0]!.inferredScore).toBe(false)
    expect(diagnostics[0]!.hasQualityLabel).toBe(true)
  })
})
