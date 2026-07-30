import { describe, expect, it } from 'vitest'
import { defineTraceAnalyst } from './define'
import type { ExactCapableAnalyst } from './exact-types'

describe('defineTraceAnalyst', () => {
  it('fills the fixed trace-store fields and preserves the declared cost', () => {
    const analyst = defineTraceAnalyst({
      id: 'failed-tools',
      description: 'Find failed tool calls.',
      cost: { kind: 'deterministic' },
      async analyze() {
        return []
      },
    })
    expect(analyst).toMatchObject({
      id: 'failed-tools',
      inputKind: 'trace-store',
      version: '1.0.0',
      cost: { kind: 'deterministic' },
    })
  })

  it('rejects empty identity fields before registration', () => {
    expect(() =>
      defineTraceAnalyst({
        id: '',
        description: 'x',
        cost: { kind: 'deterministic' },
        async analyze() {
          return []
        },
      }),
    ).toThrow(/id must not be empty/)
  })

  it('rejects a missing cost declaration from JavaScript callers', () => {
    const missingCost = {
      id: 'model-backed',
      description: 'Calls a model.',
      async analyze() {
        return []
      },
    }

    expect(() => {
      // @ts-expect-error JavaScript callers can omit a TypeScript-required property.
      defineTraceAnalyst(missingCost)
    }).toThrow(/cost must be declared/)
  })

  it('creates an exact-capable analyst when execution configuration is declared', () => {
    const analyst: ExactCapableAnalyst = defineTraceAnalyst({
      id: 'tool-fidelity',
      description: 'Compare native and normalized tool calls.',
      version: '2.0.0',
      cost: { kind: 'deterministic' },
      executionConfig: {
        kind: 'tool-fidelity',
        schemaVersion: '1',
      },
      async analyze() {
        return []
      },
    })

    expect(analyst.executionConfig).toEqual({
      kind: 'tool-fidelity',
      schemaVersion: '1',
    })
  })

  it('rejects a non-object exact execution configuration', () => {
    expect(() =>
      defineTraceAnalyst({
        id: 'tool-fidelity',
        description: 'Compare native and normalized tool calls.',
        cost: { kind: 'deterministic' },
        // @ts-expect-error JavaScript callers can supply a non-object value.
        executionConfig: [],
        async analyze() {
          return []
        },
      }),
    ).toThrow(/executionConfig must be an object/)
  })
})
