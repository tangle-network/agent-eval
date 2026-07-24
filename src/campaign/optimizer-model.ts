import {
  assertExternalOptimizerModelBudget,
  type ExternalOptimizerModelBudget,
} from './external-optimizer-process'

export type OptimizerModelBudget = ExternalOptimizerModelBudget

/** One metered OpenAI-compatible model connection shared by official optimizers. */
export interface OpenAICompatibleOptimizerModel {
  model: string
  baseUrl: string
  apiKey: string
  budget: OptimizerModelBudget
}

export function assertOptimizerModel(value: OpenAICompatibleOptimizerModel, label: string): void {
  if (!value || typeof value !== 'object') {
    throw new Error(`${label} is required`)
  }
  for (const field of ['model', 'baseUrl', 'apiKey'] as const) {
    const item = value[field]
    if (typeof item !== 'string' || !item.trim() || item.trim() !== item) {
      throw new Error(`${label}.${field} must be trimmed and non-empty`)
    }
  }
  let url: URL
  try {
    url = new URL(value.baseUrl)
  } catch {
    throw new Error(`${label}.baseUrl must be an absolute HTTP URL`)
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      `${label}.baseUrl must use HTTP or HTTPS without credentials, query, or fragment`,
    )
  }
  assertExternalOptimizerModelBudget(value.budget, `${label}.budget`)
}

export function snapshotOptimizerModel(
  value: OpenAICompatibleOptimizerModel,
): OpenAICompatibleOptimizerModel {
  return {
    ...value,
    budget: structuredClone(value.budget),
  }
}
