import { describe, expect, it } from 'vitest'
import { defineTraceAnalyst } from './define'

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
})
