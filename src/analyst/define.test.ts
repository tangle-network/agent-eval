import { describe, expect, it } from 'vitest'
import { defineTraceAnalyst } from './define'

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
