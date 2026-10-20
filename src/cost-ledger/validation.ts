/** Validate cost and usage primitives without admitting work or consulting pricing. */
import { z } from 'zod'
import { ValidationError } from '../errors'
import type { CostUsage } from './contract'

export function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value))
}

export function validationMessage(cause: unknown): string {
  return cause instanceof z.ZodError ? z.prettifyError(cause) : toError(cause).message
}

export function assertUsage(usage: CostUsage): void {
  assertTokenCount(usage.inputTokens, 'inputTokens')
  assertTokenCount(usage.outputTokens, 'outputTokens')
  if (usage.reasoningTokens !== undefined) {
    assertTokenCount(usage.reasoningTokens, 'reasoningTokens')
    if (usage.reasoningTokens > usage.outputTokens) {
      throw new ValidationError('CostLedger: reasoningTokens must not exceed outputTokens')
    }
  }
  if (usage.cachedTokens !== undefined) assertTokenCount(usage.cachedTokens, 'cachedTokens')
  if (usage.cacheWriteTokens !== undefined) {
    assertTokenCount(usage.cacheWriteTokens, 'cacheWriteTokens')
  }
}

export function assertTokenCount(value: unknown, name: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new ValidationError(
      `CostLedger: ${name} must be a non-negative integer, got ${String(value)}`,
    )
  }
}

export function assertNonNegative(value: unknown, name: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new ValidationError(
      `CostLedger: ${name} must be a non-negative finite number, got ${String(value)}`,
    )
  }
}

export function assertTimeout(value: unknown, name: string): asserts value is number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > 2_147_483_647
  ) {
    throw new ValidationError(
      `CostLedger: ${name} must be a non-negative safe integer no greater than 2147483647, got ${String(value)}`,
    )
  }
}

export function assertString(value: unknown, name: string): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ValidationError(`CostLedger: ${name} must be a non-empty string`)
  }
}
