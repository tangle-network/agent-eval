/** Data-driven native protocol recipes. A definition is not an execution receipt. */
import { readFile } from 'node:fs/promises'
import { defineBenchmark, type BenchmarkDefinition } from '../../../src/benchmarks/index'

interface Recipe {
  source: BenchmarkDefinition['source']
  requiredPins: string[]
  assumptions: string[]
  protocolPrefix?: string
}

/** Adding a domain changes recipe data and its native loader/checker, never a source enum. */
export async function researchDefinition(options: {
  recipeId: string
  taskIds: string[]
  protocol: string
  metric: BenchmarkDefinition['metric']
  verification: BenchmarkDefinition['verification']
  protocolPins: Record<string, string>
}): Promise<BenchmarkDefinition> {
  const data = JSON.parse(await readFile(new URL('./sources.json', import.meta.url), 'utf8'))
  if (!Object.hasOwn(data.recipes, options.recipeId)) {
    throw new Error(`Unknown research recipe: ${options.recipeId}`)
  }
  const recipe = data.recipes[options.recipeId] as Recipe
  if (!options.protocol.trim()) throw new Error('A named native protocol/variant is required')
  if (recipe.protocolPrefix && !options.protocol.startsWith(recipe.protocolPrefix)) {
    throw new Error(`${options.recipeId}: protocol must start with ${recipe.protocolPrefix}`)
  }
  for (const key of recipe.requiredPins) {
    if (!options.protocolPins[key]?.trim()) throw new Error(`${options.recipeId}: missing protocol pin ${key}`)
  }
  const pins = {...options.verification.checker.pins}
  for (const [key, value] of Object.entries(options.protocolPins)) {
    if (pins[key] !== undefined && pins[key] !== value) throw new Error(`Conflicting checker pin: ${key}`)
    pins[key] = value
  }
  return defineBenchmark({
    schemaVersion: 1, id: `${options.recipeId}/${options.protocol}`, source: recipe.source,
    taskIds: options.taskIds, metric: options.metric,
    verification: {
      ...options.verification,
      checker: {...options.verification.checker, pins},
      assumptions: [...options.verification.assumptions, ...recipe.assumptions],
    },
  })
}
