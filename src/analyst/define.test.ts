import { describe, expect, it } from 'vitest'
import type { TraceAnalysisStore } from '../trace-analyst/store'
import { defineCustomAnalyst, defineTraceAnalyst } from './define'
import type { ExactCapableAnalyst } from './exact-types'

describe('defineTraceAnalyst', () => {
  it('defines an engine-independent research question', () => {
    const definition = defineTraceAnalyst({
      id: 'failed-tools',
      description: 'Find failed tool calls.',
      area: 'tool-use',
      version: '1.0.0',
      question: 'Why are tools failing?',
      instructions: 'Inspect failures and cite exact spans.',
      toolGroup: 'discoveryAndSearch',
      limits: { maxIterations: 6 },
    })

    expect(definition).toMatchObject({
      id: 'failed-tools',
      area: 'tool-use',
      question: 'Why are tools failing?',
      toolGroup: 'discoveryAndSearch',
      limits: { maxIterations: 6 },
    })
    expect(definition).not.toHaveProperty('engine')
    expect(definition).not.toHaveProperty('cost')
  })

  it('rejects empty identity fields', () => {
    expect(() =>
      defineTraceAnalyst({
        id: '',
        description: 'x',
        area: 'x',
        version: '1.0.0',
        instructions: 'x',
        toolGroup: 'all',
      }),
    ).toThrow(/id must be a non-empty string/)
  })
})

describe('defineCustomAnalyst', () => {
  it('creates an exact-capable analyst when execution configuration is declared', () => {
    const analyst: ExactCapableAnalyst<TraceAnalysisStore> = defineCustomAnalyst({
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
      defineCustomAnalyst({
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
