/**
 * Composable assertion library for sandbox eval scenarios.
 *
 * Each assertion is a pure function returning an HarnessAssertion result.
 */

import type { HarnessAssertion } from './sandbox-harness.js'

// ---------------------------------------------------------------------------
// Status assertions
// ---------------------------------------------------------------------------

export function assertHttpOk(name: string, res: Response): HarnessAssertion {
  return {
    name,
    status: res.ok ? 'pass' : 'fail',
    expected: '2xx',
    actual: String(res.status),
  }
}

export function assertStatus(
  name: string,
  actual: string,
  expected: string | string[],
): HarnessAssertion {
  const valid = Array.isArray(expected) ? expected : [expected]
  return {
    name,
    status: valid.includes(actual) ? 'pass' : 'fail',
    expected: valid.join('|'),
    actual,
  }
}

export function assertExists(name: string, value: unknown): HarnessAssertion {
  return {
    name,
    status: value != null && value !== '' ? 'pass' : 'fail',
    expected: 'non-null/non-empty',
    actual: String(value),
  }
}

// ---------------------------------------------------------------------------
// Timing assertions (SLOs)
// ---------------------------------------------------------------------------

export function assertLatencyUnder(
  name: string,
  actualMs: number,
  targetMs: number,
): HarnessAssertion {
  return {
    name,
    status: actualMs <= targetMs ? 'pass' : 'fail',
    expected: `≤${targetMs}ms`,
    actual: `${actualMs}ms`,
  }
}

// ---------------------------------------------------------------------------
// Content assertions
// ---------------------------------------------------------------------------

export function assertContains(name: string, actual: string, expected: string): HarnessAssertion {
  return {
    name,
    status: actual.includes(expected) ? 'pass' : 'fail',
    expected: `contains "${expected}"`,
    actual: actual.length > 200 ? `${actual.slice(0, 200)}...` : actual,
  }
}

export function assertNotContains(
  name: string,
  actual: string,
  forbidden: string,
): HarnessAssertion {
  return {
    name,
    status: !actual.includes(forbidden) ? 'pass' : 'fail',
    expected: `does not contain "${forbidden}"`,
    actual: actual.length > 200 ? `${actual.slice(0, 200)}...` : actual,
  }
}

// ---------------------------------------------------------------------------
// SSE / event assertions
// ---------------------------------------------------------------------------

export function assertEventCount(
  name: string,
  count: number,
  min: number,
  max?: number,
): HarnessAssertion {
  const inRange = count >= min && (max === undefined || count <= max)
  return {
    name,
    status: inRange ? 'pass' : 'fail',
    expected: max !== undefined ? `${min}-${max} events` : `≥${min} events`,
    actual: `${count} events`,
  }
}

// ---------------------------------------------------------------------------
// JSON shape assertions
// ---------------------------------------------------------------------------

export function assertHasField(
  name: string,
  obj: Record<string, unknown>,
  field: string,
): HarnessAssertion {
  return {
    name,
    status: field in obj ? 'pass' : 'fail',
    expected: `has field "${field}"`,
    actual: `keys: ${Object.keys(obj).join(', ')}`,
  }
}
