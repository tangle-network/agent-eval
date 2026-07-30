import { z } from 'zod'
import {
  CostAccountingIncompleteError,
  CostCeilingReachedError,
  CostReservationExceededError,
} from '../cost-ledger'
import { AgentEvalError } from '../errors'
import { LlmCallError, LlmResponseError } from '../llm-client'
import type { AnalystBenchmarkError } from './benchmark'

export function publicBenchmarkError(
  error: unknown,
  secrets: readonly string[] = [],
): AnalystBenchmarkError {
  if (error instanceof LlmCallError) {
    return {
      class: 'LlmCallError',
      code: error.code,
      status: error.status,
      message: `Provider request failed with HTTP ${error.status}.`,
    }
  }
  if (error instanceof LlmResponseError) {
    return {
      class: 'LlmResponseError',
      code: error.code,
      message: 'Provider response did not satisfy the structured output contract.',
    }
  }
  if (error instanceof z.ZodError) {
    return {
      class: 'ModelOutputValidationError',
      message: 'Provider response did not match the benchmark output schema.',
    }
  }
  if (error instanceof SyntaxError) {
    return {
      class: 'ModelOutputParseError',
      message: 'Provider response was not valid JSON.',
    }
  }
  if (
    error instanceof CostCeilingReachedError ||
    error instanceof CostAccountingIncompleteError ||
    error instanceof CostReservationExceededError
  ) {
    return {
      class: error.constructor.name,
      code: error.code,
      message: redactSensitiveText(error.message, secrets),
    }
  }
  if (error instanceof Error && error.name === 'AbortError') {
    return {
      class: 'ProviderTimeoutError',
      message: 'Provider request timed out.',
    }
  }
  if (
    error instanceof Error &&
    /(?:assistant steps?|finding evidence|selected missing|selected unavailable|no readable spans|requires a trace store)/i.test(
      error.message,
    )
  ) {
    return {
      class: 'BenchmarkEvidenceError',
      message: redactSensitiveText(error.message, secrets),
    }
  }
  if (error instanceof AgentEvalError) {
    return {
      class: error.constructor.name,
      code: error.code,
      message: redactSensitiveText(error.message, secrets),
    }
  }
  if (error instanceof Error) {
    return {
      class: error.constructor.name || 'Error',
      message: redactSensitiveText(error.message, secrets),
    }
  }
  return {
    class: 'Error',
    message: 'Benchmark analyst execution failed.',
  }
}

function redactSensitiveText(value: string, secrets: readonly string[]): string {
  let redacted = value
  for (const secret of secrets) {
    if (secret) redacted = redacted.replaceAll(secret, '[REDACTED]')
  }
  return redacted
    .replace(/\bBearer\s+[^\s"',;]+/gi, 'Bearer [REDACTED]')
    .replace(
      /\b(api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret)\b\s*[:=]\s*[^\s"',;]+/gi,
      '$1=[REDACTED]',
    )
    .slice(0, 500)
}
