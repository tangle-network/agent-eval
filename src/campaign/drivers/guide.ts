/**
 * Driver selection guide — "which `ImprovementDriver` do I pick, and why?"
 *
 * The substrate ships seven drivers with overlapping shapes. This is the
 * decision table (data, not behavior): each entry says what a driver mutates,
 * how it proposes changes, when to reach for it, and its relative cost.
 * `selectDriver()` turns a goal + surface into a ranked recommendation.
 *
 * Import the actual driver functions from `@tangle-network/agent-eval/campaign`
 * (gepaDriver, skillOptDriver, aceDriver, memoryCurationDriver, haloDriver,
 * traceAnalystDriver, evolutionaryDriver); this module only helps you choose.
 */

export type DriverName =
  | 'gepa'
  | 'skillOpt'
  | 'ace'
  | 'memoryCuration'
  | 'halo'
  | 'traceAnalyst'
  | 'evolutionary'

/** The mutable surface a driver targets. */
export type DriverSurface = 'prompt' | 'skill-doc' | 'playbook' | 'memory' | 'any'

/** How a driver turns evidence into the next candidate. */
export type DriverStrategy =
  | 'reflective-rewrite'
  | 'anchored-patch'
  | 'append-only'
  | 'dedup-curate'
  | 'analysis-edit'
  | 'population-mutate'

/** What a caller is trying to do this run. */
export type DriverGoal = 'explore' | 'refine' | 'accumulate' | 'benchmark'

export interface DriverGuideEntry {
  /** One-line description of the mechanism. */
  summary: string
  /** The surface the driver edits. */
  surface: DriverSurface
  /** How it proposes the next candidate. */
  strategy: DriverStrategy
  /** When to reach for this driver. */
  whenUse: string
  /** Relative LLM cost per generation. */
  cost: 'low' | 'medium' | 'high'
  /** True when the driver shells out to an external engine (extra setup). */
  external?: boolean
}

export const DRIVER_GUIDE: Record<DriverName, DriverGuideEntry> = {
  gepa: {
    summary:
      'Reflective full-surface rewrite: reflects on the best parent’s weakest dimensions + per-scenario scores, proposes targeted rewrites, maintains a Pareto frontier across generations.',
    surface: 'prompt',
    strategy: 'reflective-rewrite',
    whenUse:
      'The default for a prompt/instruction surface with headroom — broad rewrites plus Pareto-optimal exploration across scenarios.',
    cost: 'medium',
  },
  skillOpt: {
    summary:
      'Patch-mode: bounded, anchored add/delete/replace edits to ONE skill document, so a good rule introduced earlier is not clobbered by a later sweeping rewrite.',
    surface: 'skill-doc',
    strategy: 'anchored-patch',
    whenUse:
      'Refining a skill document incrementally where accumulated rules must be preserved; the edit budget is the "textual learning rate".',
    cost: 'medium',
  },
  ace: {
    summary:
      'Append-mostly playbook curator: grows the playbook with provenance-tagged delta bullets, never merging — guards against context collapse.',
    surface: 'playbook',
    strategy: 'append-only',
    whenUse:
      'Accumulating many specific, hard-won lessons over time where dedup/rewrite would summarize away detail.',
    cost: 'low',
  },
  memoryCuration: {
    summary:
      'Dedup-and-rank curator: builds a compact searchable memory and grafts the most relevant, most-recurrent lessons onto the surface.',
    surface: 'memory',
    strategy: 'dedup-curate',
    whenUse:
      'Accumulating lessons while keeping the surface compact — the complement to ace when context size matters more than verbatim provenance.',
    cost: 'low',
  },
  halo: {
    summary:
      'Wraps the real external HALO engine (Inference.net, `halo` CLI) and applies its findings to the prompt via one LLM edit.',
    surface: 'prompt',
    strategy: 'analysis-edit',
    whenUse:
      'Benchmarking: compete HALO head-to-head against our own analysis on identical traces via compareDrivers.',
    cost: 'high',
    external: true,
  },
  traceAnalyst: {
    summary:
      'Wraps agent-eval’s own trace-analyst engine and applies its findings to the prompt via one identical LLM edit — the symmetric opponent to haloDriver.',
    surface: 'prompt',
    strategy: 'analysis-edit',
    whenUse:
      'Benchmarking our trace-analyst’s analysis quality against HALO (analysis-quality head-to-head), or improving from a real OTLP trace corpus.',
    cost: 'high',
  },
  evolutionary: {
    summary:
      'Adapts a stateless Mutator (population mutate → measure → select); no generation memory beyond the current surface.',
    surface: 'any',
    strategy: 'population-mutate',
    whenUse:
      'Blind population search when you have a Mutator and don’t need reflective reasoning over findings.',
    cost: 'medium',
  },
}

/** Goal → drivers, in preference order. The first match is the default pick. */
const GOAL_RANK: Record<DriverGoal, DriverName[]> = {
  explore: ['gepa', 'evolutionary'],
  refine: ['skillOpt', 'gepa'],
  accumulate: ['ace', 'memoryCuration'],
  benchmark: ['traceAnalyst', 'halo'],
}

export interface SelectDriverCriteria {
  /** What you're trying to do this run. */
  goal: DriverGoal
  /** Restrict to drivers that edit this surface (optional). */
  surface?: DriverSurface
}

export interface DriverRecommendation {
  name: DriverName
  entry: DriverGuideEntry
  reason: string
}

/**
 * Rank the drivers for a goal (and optional surface filter), best first.
 * Returns the recommendation list, not instances — import the chosen driver
 * function yourself. Always returns at least the goal's primary driver.
 */
export function selectDriver(criteria: SelectDriverCriteria): DriverRecommendation[] {
  const ranked = GOAL_RANK[criteria.goal]
  const out: DriverRecommendation[] = []
  for (const name of ranked) {
    const entry = DRIVER_GUIDE[name]
    if (criteria.surface && criteria.surface !== 'any' && entry.surface !== criteria.surface)
      continue
    out.push({
      name,
      entry,
      reason: `${criteria.goal}: ${entry.strategy} on the ${entry.surface} surface — ${entry.whenUse}`,
    })
  }
  // Surface filter can empty a goal's list; fall back to every driver on that
  // surface so the caller always gets an actionable answer, never an empty pick.
  if (out.length === 0 && criteria.surface) {
    for (const name of Object.keys(DRIVER_GUIDE) as DriverName[]) {
      const entry = DRIVER_GUIDE[name]
      if (entry.surface === criteria.surface || entry.surface === 'any') {
        out.push({ name, entry, reason: `surface match (${entry.surface}): ${entry.whenUse}` })
      }
    }
  }
  return out
}
