import { describe, it, expect } from 'vitest'
import { ScenarioRegistry } from '../src/registry'
import type { ScenarioFile, Scenario } from '../src/types'

describe('ScenarioRegistry', () => {
  const sampleFile: ScenarioFile = {
    id: 'test-scenario-1',
    category: 'pipeline-build',
    persona: 'engineer',
    label: 'Engineer',
    thesis: 'Can the agent build a pipeline?',
    turns: [
      { user: 'Build me a pipeline', expectedBehaviors: ['produces code'] },
    ],
    artifactChecks: [
      { type: 'code_valid', target: 'python', description: 'Valid Python code' },
    ],
  }

  it('registers and retrieves scenarios', () => {
    const registry = new ScenarioRegistry()
    registry.registerFiles([sampleFile])
    expect(registry.count).toBe(1)
    expect(registry.all()[0].id).toBe('test-scenario-1')
  })

  it('filters by category', () => {
    const registry = new ScenarioRegistry()
    registry.registerFiles([
      sampleFile,
      { ...sampleFile, id: 'test-2', category: 'adversarial' },
    ])
    expect(registry.byCategory('pipeline-build')).toHaveLength(1)
    expect(registry.byCategory('adversarial')).toHaveLength(1)
    expect(registry.byCategory('nonexistent')).toHaveLength(0)
  })

  it('filters by persona', () => {
    const registry = new ScenarioRegistry()
    registry.registerFiles([sampleFile])
    registry.register([{
      id: 'direct-scenario',
      persona: 'designer',
      label: 'Designer',
      thesis: 'test',
      dimensions: [],
      turns: [],
      artifactChecks: [],
    }])
    expect(registry.byPersona('engineer')).toHaveLength(1)
    expect(registry.byPersona('designer')).toHaveLength(1)
  })

  it('lists categories', () => {
    const registry = new ScenarioRegistry()
    registry.registerFiles([
      sampleFile,
      { ...sampleFile, id: 'test-2', category: 'pipeline-build' },
      { ...sampleFile, id: 'test-3', category: 'adversarial' },
    ])
    const cats = registry.listCategories()
    expect(cats).toHaveLength(2)
    expect(cats.find(c => c.category === 'pipeline-build')?.count).toBe(2)
  })

  it('finds by id', () => {
    const registry = new ScenarioRegistry()
    registry.registerFiles([sampleFile])
    expect(registry.byId('test-scenario-1')?.thesis).toBe('Can the agent build a pipeline?')
    expect(registry.byId('nonexistent')).toBeUndefined()
  })
})
