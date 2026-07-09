/**
 * Evidence grounding for reflective optimizers (GEPA-style revise loops).
 *
 * Two failure modes recur when an LLM revises an artifact from raw rollout
 * traces (first measured in agent-lab R358, where naive reflection REGRESSED
 * the score 0.375 -> 0.125 before these helpers fixed it):
 *
 * 1. The environment often hides WHY a rollout failed - a tool call can
 *    succeed while an invisible downstream check fails - so the reviser
 *    cannot see the cause in the transcript. The only reliable signal is the
 *    field-level difference between what passing and failing rollouts did.
 *    `rolloutArgumentDiff` computes that difference deterministically so the
 *    reviser is handed the diff instead of being trusted to derive it.
 *
 * 2. Revisers invent plausible-but-wrong literal values ("use 'new'",
 *    "use 'sent'") that no passing rollout ever used, turning every rollout
 *    into a failure. `classifyUngroundedLiterals` mechanically detects them,
 *    separating HARMFUL literals (ones failing rollouts actually used -
 *    proven damage) from benign illustrations (e.g. a name example like
 *    'Doe'), so callers can hard-reject the former and merely log the latter.
 *    Rejecting every ungrounded quoted word is too blunt: it killed a run
 *    over a surname illustration before the severity split existed.
 *
 * Pure data in, data out: no LLM calls, no filesystem, no domain knowledge.
 */

/** One tool/action call observed in a rollout: a name plus its arguments. */
export interface RolloutCall {
  readonly name: string
  readonly args: Readonly<Record<string, unknown>>
}

/** A scored rollout: its calls plus the scalar outcome used to split pass/fail. */
export interface ScoredRollout {
  /** Caller-meaningful identifier (task id, cell id) used only for reporting. */
  readonly id: string
  /** Scalar outcome in [0, 1]; `passThreshold` splits passing from failing. */
  readonly score: number
  readonly calls: readonly RolloutCall[]
}

export interface RolloutArgumentDiffOptions {
  /** Rollouts with `score >= passThreshold` count as passing. Default 1. */
  readonly passThreshold?: number
  /** Max distinct values listed per field per side in the rendered text. Default 4. */
  readonly maxValuesPerField?: number
}

export interface RolloutArgumentDiff {
  /** Human/LLM-readable per-field diff, one line per field. */
  readonly text: string
  /** Lowercased stringified argument values seen in passing rollouts. */
  readonly passingValues: ReadonlySet<string>
  /** Lowercased stringified argument values seen in failing rollouts. */
  readonly failingValues: ReadonlySet<string>
}

/**
 * Deterministic per-field diff of call arguments between passing and failing
 * rollouts. A field set by failing rollouts but left unset by passing ones is
 * the classic poison-input signature; a field whose values differ across the
 * split points at the correct value. Feed `text` to the reviser verbatim.
 */
export function rolloutArgumentDiff(
  rollouts: readonly ScoredRollout[],
  opts: RolloutArgumentDiffOptions = {},
): RolloutArgumentDiff {
  const passThreshold = opts.passThreshold ?? 1
  const maxValues = opts.maxValuesPerField ?? 4
  const collect = (pass: boolean): Map<string, Set<string>> => {
    const byField = new Map<string, Set<string>>()
    for (const r of rollouts) {
      if (pass !== r.score >= passThreshold) continue
      for (const c of r.calls) {
        for (const [k, v] of Object.entries(c.args)) {
          const set = byField.get(k) ?? new Set<string>()
          set.add(String(v))
          byField.set(k, set)
        }
      }
    }
    return byField
  }
  const passing = collect(true)
  const failing = collect(false)
  const lines: string[] = []
  for (const field of new Set([...passing.keys(), ...failing.keys()])) {
    const pv = [...(passing.get(field) ?? [])].slice(0, maxValues)
    const fv = [...(failing.get(field) ?? [])].slice(0, maxValues)
    const render = (vals: string[]) => (vals.length ? JSON.stringify(vals) : 'NOT SET (omitted)')
    lines.push(`  ${field}: passing runs -> ${render(pv)} | failing runs -> ${render(fv)}`)
  }
  const lower = (m: Map<string, Set<string>>): Set<string> => {
    const out = new Set<string>()
    for (const vals of m.values()) for (const v of vals) out.add(v.toLowerCase())
    return out
  }
  return {
    text: lines.join('\n') || '  (no calls observed)',
    passingValues: lower(passing),
    failingValues: lower(failing),
  }
}

export interface UngroundedLiteralReport {
  /** Quoted single-word literals in the text that no passing rollout used. */
  readonly ungrounded: readonly string[]
  /** The subset failing rollouts actually used - prescribing these is proven harmful. */
  readonly harmful: readonly string[]
}

/**
 * Scan revised artifact text for single-quoted single-word literals (the
 * "use exactly 'new'" pattern) that appear in no passing rollout's argument
 * values. Multi-word quotes pass (they are prose, not prescriptions).
 * Callers should reject on `harmful` (with a bounded retry) and at most log
 * `ungrounded` - see the module header for why the severities differ.
 */
export function classifyUngroundedLiterals(
  text: string,
  diff: Pick<RolloutArgumentDiff, 'passingValues' | 'failingValues'>,
): UngroundedLiteralReport {
  const ungrounded = new Set<string>()
  for (const m of text.matchAll(/'([a-z][a-z_-]{1,19})'/gi)) {
    const w = (m[1] as string).toLowerCase()
    if (!diff.passingValues.has(w)) ungrounded.add(w)
  }
  const all = [...ungrounded]
  return {
    ungrounded: all,
    harmful: all.filter((w) => diff.failingValues.has(w)),
  }
}
