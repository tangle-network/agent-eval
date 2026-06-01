import type { RunTokenUsage } from '../run-record'

export function objectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

export function stringField(record: Record<string, unknown>, key: string): string | null {
  const value = record[key]
  return typeof value === 'string' ? value : null
}

export function numberField(record: Record<string, unknown>, key: string): number | null {
  const value = record[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

export function tokenUsageField(value: unknown): RunTokenUsage | null {
  const record = objectRecord(value)
  if (!record) return null
  const input = numberField(record, 'input')
  const output = numberField(record, 'output')
  if (input === null || output === null) return null
  const cached = numberField(record, 'cached')
  return {
    input,
    output,
    ...(cached !== null ? { cached } : {}),
  }
}
