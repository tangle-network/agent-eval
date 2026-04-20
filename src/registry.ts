import type { Scenario, ScenarioFile } from './types'

/**
 * ScenarioRegistry — manages scenario discovery and filtering.
 *
 * Each agent registers its scenarios. The registry handles conversion
 * from ScenarioFile format to the framework's Scenario type.
 */
export class ScenarioRegistry {
  private scenarios: Scenario[] = []
  private scenarioFiles: ScenarioFile[] = []

  /** Register scenarios from ScenarioFile format */
  registerFiles(files: ScenarioFile[]): void {
    this.scenarioFiles.push(...files)
    this.scenarios.push(...files.map(toScenario))
  }

  /** Register pre-built Scenario objects directly */
  register(scenarios: Scenario[]): void {
    this.scenarios.push(...scenarios)
  }

  /** Get all scenarios */
  all(): Scenario[] {
    return [...this.scenarios]
  }

  /** Get scenarios filtered by category */
  byCategory(category: string): Scenario[] {
    const fromFiles = this.scenarioFiles
      .filter(sf => sf.category === category)
      .map(toScenario)
    return fromFiles
  }

  /** List all categories with counts */
  listCategories(): { category: string; count: number }[] {
    const counts: Record<string, number> = {}
    for (const sf of this.scenarioFiles) {
      counts[sf.category] = (counts[sf.category] ?? 0) + 1
    }
    return Object.entries(counts).map(([category, count]) => ({ category, count }))
  }

  /** Get scenarios filtered by persona */
  byPersona(persona: string): Scenario[] {
    return this.scenarios.filter(s => s.persona === persona)
  }

  /** Get a single scenario by ID */
  byId(id: string): Scenario | undefined {
    return this.scenarios.find(s => s.id === id)
  }

  /** Count total scenarios */
  get count(): number {
    return this.scenarios.length
  }
}

/** Convert ScenarioFile to the framework's Scenario type */
function toScenario(sf: ScenarioFile): Scenario {
  return {
    id: sf.id,
    persona: sf.persona,
    label: sf.label,
    thesis: sf.thesis,
    dimensions: [],
    turns: sf.turns,
    artifactChecks: sf.artifactChecks,
    systemPromptAppend: sf.isControl ? 'You are a helpful AI assistant.' : undefined,
  }
}
