import { createHash } from 'node:crypto'
import { summarizeSessionInput } from '@tangle-network/harness-sessions'
import { record, stringField } from './code-agent-fields'
import type { CodeAgentSessionSource } from './code-agent-observation'

export function sessionIdFromEntries(
  source: CodeAgentSessionSource,
  entries: Record<string, unknown>[],
): string | undefined {
  for (const entry of entries) {
    if (source === 'pi' && entry.type === 'session') {
      const id = stringField(entry, 'id')
      if (id) return id
    }
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

export function modelFromEntries(
  source: CodeAgentSessionSource,
  entries: Record<string, unknown>[],
): string | undefined {
  // A native Pi session records the provider and model of each answered call.
  if (source === 'pi')
    return summarizeSessionInput('pi', { records: entries }).lastServedModel ?? undefined
  let providerModel: string | undefined
  for (const entry of entries) {
    if (source === 'codex') {
      const payload = record(entry.payload)
      const model = payload ? stringField(payload, 'model') : undefined
      if (model) return model
      providerModel =
        providerModel ?? (payload ? stringField(payload, 'model_provider') : undefined)
    }
    const openCodeModel = stringField(entry, 'modelID')
    if (openCodeModel) {
      const provider = stringField(entry, 'providerID')
      return provider ? `${provider}/${openCodeModel}` : openCodeModel
    }
    const modelObject = record(entry.model)
    const nestedModel = stringField(modelObject ?? {}, 'modelID')
    if (nestedModel) {
      const provider = stringField(modelObject ?? {}, 'providerID')
      return provider ? `${provider}/${nestedModel}` : nestedModel
    }
    const message = record(entry.message)
    const model = message ? stringField(message, 'model') : undefined
    if (model) return model
  }
  return providerModel
}

export function cwdFromEntries(entries: Record<string, unknown>[]): string | undefined {
  for (const entry of entries) {
    const path = record(entry.path)
    const cwd =
      stringField(entry, 'cwd') ??
      stringField(path ?? {}, 'cwd') ??
      stringField(path ?? {}, 'root') ??
      (record(entry.payload) ? stringField(record(entry.payload)!, 'cwd') : undefined)
    if (cwd) return cwd
  }
  return undefined
}

export function fallbackSessionId(
  source: CodeAgentSessionSource,
  sourcePath: string | undefined,
): string {
  return hashString(`${source}:${sourcePath ?? 'unknown-session'}`).slice(
    'sha256:'.length,
    'sha256:'.length + 20,
  )
}

export function withSnapshot(model: string): string {
  const trimmed = model.trim() || 'unknown'
  if (trimmed.includes('@') || /-\d{8}$/.test(trimmed) || /-\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    return trimmed
  }
  return `${trimmed}@observed-local`
}

export function hashString(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`
}

export function stableSeed(value: string): number {
  return createHash('sha256').update(value).digest().readUInt32BE(0)
}
