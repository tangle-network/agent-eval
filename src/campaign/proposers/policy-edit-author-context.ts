/** One measured scenario row eligible for PolicyEdit author context. */
export interface PolicyEditAuthorScenarioRow {
  scenarioId: string
  composite: number
}

export interface SelectPolicyEditAuthorRowsOptions {
  /** Maximum returned rows. Must be a positive safe integer. */
  limit: number
  /** Optional score to compare against, keyed by scenario ID. */
  referenceByScenario?: ReadonlyMap<string, number>
}

export interface SerializedJsonBudget {
  json: string
  actualChars: number
  maxChars: number
}

interface RankedRow<T> {
  row: T
  delta: number | null
}

/**
 * Select a bounded, deterministic evidence slice for a PolicyEdit author.
 *
 * Rows are deduplicated by scenario ID, keeping the first measured row. The
 * result then interleaves three ranked views: hardest score, largest regression,
 * and largest improvement. A row selected by multiple views appears once.
 */
export function selectPolicyEditAuthorRows<T extends PolicyEditAuthorScenarioRow>(
  rows: readonly T[],
  options: SelectPolicyEditAuthorRowsOptions,
): T[] {
  assertPositiveSafeInteger(options.limit, 'limit')

  const unique = new Map<string, RankedRow<T>>()
  for (const row of rows) {
    if (!row.scenarioId || row.scenarioId.trim() !== row.scenarioId) {
      throw new Error('selectPolicyEditAuthorRows: scenarioId must be trimmed and non-empty')
    }
    if (!Number.isFinite(row.composite)) {
      throw new Error(
        `selectPolicyEditAuthorRows: composite must be finite for '${row.scenarioId}'`,
      )
    }
    if (unique.has(row.scenarioId)) continue

    const reference = options.referenceByScenario?.get(row.scenarioId)
    if (reference !== undefined && !Number.isFinite(reference)) {
      throw new Error(
        `selectPolicyEditAuthorRows: reference must be finite for '${row.scenarioId}'`,
      )
    }
    unique.set(row.scenarioId, {
      row,
      delta: reference === undefined ? null : row.composite - reference,
    })
  }

  const hardest = [...unique.values()].sort(
    (a, b) => a.row.composite - b.row.composite || compareScenarioId(a.row, b.row),
  )
  const regressions = [...unique.values()]
    .filter((entry) => entry.delta !== null && entry.delta < 0)
    .sort((a, b) => a.delta! - b.delta! || compareScenarioId(a.row, b.row))
  const improvements = [...unique.values()]
    .filter((entry) => entry.delta !== null && entry.delta > 0)
    .sort((a, b) => b.delta! - a.delta! || compareScenarioId(a.row, b.row))
  const rankings = [hardest, regressions, improvements]
  const maxDepth = Math.max(...rankings.map((ranking) => ranking.length), 0)
  const selected: T[] = []
  const selectedIds = new Set<string>()

  for (let depth = 0; depth < maxDepth && selected.length < options.limit; depth += 1) {
    for (const ranking of rankings) {
      const entry = ranking[depth]
      if (!entry || selectedIds.has(entry.row.scenarioId)) continue
      selected.push(entry.row)
      selectedIds.add(entry.row.scenarioId)
      if (selected.length === options.limit) break
    }
  }
  return selected
}

/** Serialize once and fail before dispatch when author context exceeds its budget. */
export function assertPolicyEditAuthorContextBudget(
  value: unknown,
  maxChars: number,
): SerializedJsonBudget {
  assertPositiveSafeInteger(maxChars, 'maxChars')
  const json = JSON.stringify(value)
  if (json === undefined) {
    throw new Error('assertPolicyEditAuthorContextBudget: value must serialize to JSON')
  }
  const actualChars = json.length
  if (actualChars > maxChars) {
    throw new Error(
      `assertPolicyEditAuthorContextBudget: serialized JSON exceeds budget (actualChars=${actualChars}, maxChars=${maxChars})`,
    )
  }
  return { json, actualChars, maxChars }
}

function compareScenarioId(a: PolicyEditAuthorScenarioRow, b: PolicyEditAuthorScenarioRow): number {
  return a.scenarioId < b.scenarioId ? -1 : a.scenarioId > b.scenarioId ? 1 : 0
}

function assertPositiveSafeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive safe integer (got ${value})`)
  }
}
