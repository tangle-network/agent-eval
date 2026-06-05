import { describe, expect, it } from 'vitest'
import {
  analyzeRuns,
  fromClaudeCodeSession,
  fromCodexSession,
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
                cache_read_input_tokens: 200,
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
