// Normalizers shared by the recorder and the replay check.
//
// Everything here is pure. The recorder writes what these functions produce;
// the check runs the same functions over a live engine and compares. A field
// that is not normalized identically on both sides would read as a permanent
// mismatch, so there is exactly one implementation.

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, posix, relative, sep } from 'node:path'
import { readCellSpend } from '../../matrix'
import type { MultishotResult, MultishotToolDefinition, MultishotTransportRequest } from '../types'
import type {
  MultishotRecordedMessage,
  MultishotRecordedRequest,
  RecordedJudgeRequest,
  RecordedMultishotError,
  RecordedMultishotResult,
} from './types'

/** Keys whose value is wall clock or run identity. Two runs never agree on
 *  them, so they are removed before comparison instead of being compared. */
export const VOLATILE_KEYS: ReadonlySet<string> = new Set([
  'durationMs',
  'meanDurationMs',
  'matrixId',
  'runId',
])

export function recordMessage(raw: unknown): MultishotRecordedMessage {
  const row = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
  const message: MultishotRecordedMessage = {
    role: typeof row.role === 'string' ? row.role : '(missing role)',
    content: typeof row.content === 'string' ? row.content : null,
  }
  if (typeof row.tool_call_id === 'string') message.toolCallId = row.tool_call_id
  if (Array.isArray(row.tool_calls)) {
    message.toolCalls = row.tool_calls.map((call) => {
      const entry = (typeof call === 'object' && call !== null ? call : {}) as Record<
        string,
        unknown
      >
      const fn = (
        typeof entry.function === 'object' && entry.function !== null ? entry.function : {}
      ) as Record<string, unknown>
      return {
        id: typeof entry.id === 'string' ? entry.id : '(missing id)',
        name: typeof fn.name === 'string' ? fn.name : '(missing name)',
        arguments: typeof fn.arguments === 'string' ? fn.arguments : '(missing arguments)',
      }
    })
  }
  return message
}

export function recordRequest(
  leg: 'agent' | 'driver',
  req: MultishotTransportRequest,
): MultishotRecordedRequest {
  return {
    leg,
    model: req.model,
    temperature: req.temperature ?? null,
    maxTokens: req.maxTokens ?? null,
    tools: req.tools ? (JSON.parse(JSON.stringify(req.tools)) as MultishotToolDefinition[]) : null,
    messages: req.messages.map(recordMessage),
  }
}

/** Judge calls reach the wire as an OpenAI-compat body, not through a
 *  transport, so they are recorded from the request body the stub receives. */
export function recordJudgeRequest(body: Record<string, unknown>): RecordedJudgeRequest {
  return {
    model: typeof body.model === 'string' ? body.model : '(missing model)',
    temperature: typeof body.temperature === 'number' ? body.temperature : null,
    maxTokens: typeof body.max_tokens === 'number' ? body.max_tokens : null,
    messages: Array.isArray(body.messages) ? body.messages.map(recordMessage) : [],
  }
}

export function recordResult(result: MultishotResult): RecordedMultishotResult {
  const { durationMs: _durationMs, ...rest } = result
  return JSON.parse(JSON.stringify(rest)) as RecordedMultishotResult
}

export function recordError(err: unknown): RecordedMultishotError {
  const spend = readCellSpend(err)
  return {
    name: err instanceof Error ? err.name : typeof err,
    message: err instanceof Error ? err.message : String(err),
    cellSpend: spend ? { costUsd: spend.costUsd, kind: spend.kind } : null,
  }
}

/** Deep copy with every wall-clock and run-identity key removed. */
export function stripVolatile(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripVolatile)
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (VOLATILE_KEYS.has(key)) continue
      out[key] = stripVolatile(entry)
    }
    return out
  }
  return value
}

/** The matrix summary Markdown carries a rendered duration. Mask it so the
 *  rest of the document — cell counts, pass rate, mean, cost, the uncaptured
 *  warning — stays under comparison. */
export function maskVolatileMarkdown(text: string): string {
  return text.replace(/\*\*Duration\*\*: \d+s/g, '**Duration**: <elided>')
}

/** Judge calls fan out through `Promise.all` across three slots, so their
 *  issue order is an implementation detail of the cell body, not behaviour a
 *  caller can observe. Their CONTENT is behaviour, so they are compared as a
 *  set with a stable order. */
export function sortJudgeRequests(
  requests: readonly RecordedJudgeRequest[],
): RecordedJudgeRequest[] {
  return [...requests].sort((a, b) => {
    const left = JSON.stringify(a)
    const right = JSON.stringify(b)
    return left < right ? -1 : left > right ? 1 : 0
  })
}

/** Every file under `dir`, keyed by slash-separated relative path. JSON is
 *  parsed and stripped of wall-clock keys; Markdown keeps its text with the
 *  rendered duration masked; anything else is kept verbatim. */
export function readRunDir(dir: string): Record<string, unknown> {
  const files: Record<string, unknown> = {}
  for (const path of walkFiles(dir)) {
    const key = relative(dir, path).split(sep).join(posix.sep)
    const text = readFileSync(path, 'utf8')
    if (path.endsWith('.json')) {
      files[key] = stripVolatile(JSON.parse(text))
      continue
    }
    files[key] = path.endsWith('.md') ? maskVolatileMarkdown(text) : text
  }
  return files
}

function walkFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir).sort()) {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) out.push(...walkFiles(path))
    else out.push(path)
  }
  return out
}
