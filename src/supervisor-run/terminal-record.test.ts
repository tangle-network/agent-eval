/**
 * Precedence of the terminal record: Runtime's settle record, then Runtime's
 * failure record, then the legacy loops documents by name, then a named
 * absence. Every branch states which record answered.
 */

import { describe, expect, it } from 'vitest'
import { NO_TERMINAL_RECORD, readTerminalRecord } from './terminal-record'

const RUNTIME_RESULT = {
  kind: 'no-winner',
  reason: 'all-children-down',
  tree: { root: 'r', nodes: [] },
  downCount: 1,
}

const FAILURE = {
  runId: 'r',
  pursuitId: 'p',
  at: '2026-09-06T05:58:29.604Z',
  error: { name: 'TypeError', message: 'bad budget' },
}

describe('readTerminalRecord', () => {
  it('reads the status from result.json kind and names the source', () => {
    const record = readTerminalRecord({ state: null, result: RUNTIME_RESULT, failure: null })
    expect(record).toEqual({
      supStatus: 'no-winner',
      supStatusSource: 'runtime-result',
      supReason: 'all-children-down',
      failure: null,
      completed: false,
    })
  })

  it('reports a winner as completed with no reason and no failure', () => {
    const record = readTerminalRecord({
      state: null,
      result: { kind: 'winner', tree: { root: 'r', nodes: [] } },
      failure: null,
    })
    expect(record.supStatus).toBe('winner')
    expect(record.supReason).toBeNull()
    expect(record.failure).toBeNull()
    expect(record.completed).toBe(true)
  })

  it('outranks legacy fields present on the same documents', () => {
    const record = readTerminalRecord({
      state: { status: 'completed' },
      result: { ...RUNTIME_RESULT, sup_status: 'completed' },
      failure: null,
    })
    expect(record.supStatus).toBe('no-winner')
    expect(record.supStatusSource).toBe('runtime-result')
    expect(record.completed).toBe(false)
  })

  it('reports failure.json as a terminal failure when no result landed', () => {
    const record = readTerminalRecord({ state: null, result: null, failure: FAILURE })
    expect(record).toEqual({
      supStatus: 'failed',
      supStatusSource: 'runtime-failure',
      supReason: null,
      failure: {
        source: 'runtime-failure',
        name: 'TypeError',
        message: 'bad budget',
        at: '2026-09-06T05:58:29.604Z',
        earlierAttempt: false,
      },
      completed: false,
    })
  })

  it('keeps the settled status and marks a failure beside it as an earlier attempt', () => {
    const record = readTerminalRecord({ state: null, result: RUNTIME_RESULT, failure: FAILURE })
    expect(record.supStatus).toBe('no-winner')
    expect(record.supStatusSource).toBe('runtime-result')
    expect(record.failure).toEqual({
      source: 'runtime-failure',
      name: 'TypeError',
      message: 'bad budget',
      at: '2026-09-06T05:58:29.604Z',
      earlierAttempt: true,
    })
  })

  it('reads the driver rejection a driver-failed no-winner carries', () => {
    const record = readTerminalRecord({
      state: null,
      result: {
        kind: 'no-winner',
        reason: 'driver-failed',
        tree: { root: 'r', nodes: [] },
        downCount: 0,
        error: { name: 'Error', message: 'act() rejected' },
      },
      failure: null,
    })
    expect(record.supReason).toBe('driver-failed')
    expect(record.failure).toEqual({
      source: 'runtime-result',
      name: 'Error',
      message: 'act() rejected',
      at: null,
      earlierAttempt: false,
    })
  })

  it('reports a failure document without an error object as a failure with missing detail', () => {
    const record = readTerminalRecord({ state: null, result: null, failure: { runId: 'r' } })
    expect(record.supStatus).toBe('failed')
    expect(record.failure).toEqual({ unavailable: 'Runtime failure.json carries no error record' })
  })

  it('falls back to legacy state.json status by name', () => {
    const record = readTerminalRecord({
      state: { status: 'completed' },
      result: { sup_status: 'interrupted' },
      failure: undefined,
    })
    expect(record.supStatus).toBe('completed')
    expect(record.supStatusSource).toBe('legacy-state')
    expect(record.completed).toBe(true)
    expect(record.failure).toEqual({
      unavailable: 'legacy state.json records no failure document',
    })
  })

  it('falls back to legacy result.json sup_status by name', () => {
    const record = readTerminalRecord({
      state: { id: 'x' },
      result: { sup_status: 'interrupted' },
      failure: undefined,
    })
    expect(record.supStatus).toBe('interrupted')
    expect(record.supStatusSource).toBe('legacy-result')
    expect(record.completed).toBe(false)
  })

  it('names the absence when no document carries a status', () => {
    const record = readTerminalRecord({ state: { id: 'x' }, result: null, failure: null })
    expect(record).toEqual({
      supStatus: { unavailable: NO_TERMINAL_RECORD },
      supStatusSource: { unavailable: NO_TERMINAL_RECORD },
      supReason: { unavailable: NO_TERMINAL_RECORD },
      failure: { unavailable: NO_TERMINAL_RECORD },
      completed: null,
    })
  })
})
