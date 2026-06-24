/**
 * Hidden-criteria grading firewall — grade an agent on criteria it never saw.
 *
 * A trustworthy benchmark splits every scenario's data by WHERE each field is
 * allowed to flow, then proves the held-out / judge-only fields never reach the
 * agent during the run. The coding bench expresses this with four destinations
 * (prompt / develop-against / held-out suite / rubric); this module lifts the
 * domain-FREE core out of it so research, legal, tax, content — any domain —
 * can declare the same routing and get the same firewall enforcement and the
 * same held-out-weighted composite, plugging in its OWN grader.
 *
 * Two reusable pieces, both domain-agnostic:
 *
 *   1. FIELD ROUTING BY DESTINATION. A scenario declares each field's
 *      `FieldDestination`; `assertNoHiddenLeak` is a pure checker that throws if
 *      a grading-only or judge-only field's value appears in what reaches the
 *      agent. The domain decides which fields exist and where they go — the
 *      substrate only enforces "hidden stays hidden".
 *
 *   2. HIDDEN-CRITERIA GRADING. The domain supplies its own grader
 *      `(artifact, hiddenCriteria) => { passRate, total }` — the coding
 *      node-test executor is ONE such grader a consumer plugs in; the substrate
 *      bakes in NO node/test/TS/exec/regex. `gradeOnHidden` runs that grader
 *      behind the firewall and `blendHeldout` composes its pass rate with a
 *      judge score into the final number the leaderboard ranks on.
 *
 * Shape mirrors `treatment-gate`/`authenticity`: pure predicates and pure
 * composition over already-computed values, fail-loud, with the
 * "which field / which weight / which grader" decisions left as parameters and
 * no domain literal anywhere in the module.
 *
 * Lives next to `test-graded-scenario` and `partition-held-out` — it is a
 * scorecard/grading concept that makes sense without a running agent loop.
 */

import type { JudgeScore } from './campaign/types'
import { ValidationError } from './errors'

// ── 1. field routing by destination ──────────────────────────────────────────

/**
 * Where one scenario field is allowed to flow. The firewall guarantee is keyed
 * on this tag, not on a field name — a domain can have any number of fields per
 * destination.
 *
 *   - `agent-visible`   reaches the agent's context during the run (the prompt,
 *                       the task statement — what the agent reads to act).
 *   - `develop-against` seeded into the agent's environment during the run so it
 *                       can iterate (a visible example/test/reference). The
 *                       agent MAY read it — that is intentional (real TDD). Not
 *                       a leak: it is example-grade, not the grading criteria.
 *   - `grading-only`    the hidden criteria. Used ONLY at grading, after the run
 *                       — the held-out suite / answer key / hidden requirements.
 *                       Must NEVER reach the agent context. This is what makes a
 *                       good score un-memorizable.
 *   - `judge-only`      grading context for the judge only (rubric anchors,
 *                       design intent). Lives with the judge, never in the agent
 *                       context.
 */
export type FieldDestination = 'agent-visible' | 'develop-against' | 'grading-only' | 'judge-only'

/** The destinations a value must be kept OUT of the agent context for. */
const hiddenDestinations: ReadonlySet<FieldDestination> = new Set<FieldDestination>([
  'grading-only',
  'judge-only',
])

/** True for the destinations whose values must never reach the agent context. */
export function isHiddenDestination(destination: FieldDestination): boolean {
  return hiddenDestinations.has(destination)
}

/**
 * A scenario's fields routed by destination. The domain owns the field set
 * (`TFields` — a record of its named fields to their string-renderable values)
 * and declares one `FieldDestination` per field. `routeFields` builds this from
 * a domain's `(value, destination)` map; the firewall reads it.
 */
export interface RoutedField {
  /** The field's name — for diagnostics only. */
  name: string
  /** The field's value as it would be rendered into text. The firewall compares
   *  this against the agent context, so a domain that ships structured data
   *  passes a stable string projection (e.g. JSON) of the hidden value. */
  value: string
  destination: FieldDestination
}

/**
 * Route a domain's named fields by destination into the firewall's input shape.
 * The `routing` declares each field's destination; the `values` carry each
 * field's renderable string. A field present in `routing` but missing from
 * `values` is an authoring error (fail loud) — every routed field must have a
 * value the firewall can check.
 */
export function routeFields<TName extends string>(
  routing: Readonly<Record<TName, FieldDestination>>,
  values: Readonly<Record<TName, string>>,
): RoutedField[] {
  const out: RoutedField[] = []
  for (const name of Object.keys(routing) as TName[]) {
    const value = values[name]
    if (value === undefined) {
      throw new ValidationError(
        `routed field "${name}" has a destination but no value — every routed field must carry its value`,
      )
    }
    out.push({ name, value, destination: routing[name] })
  }
  return out
}

/** A single detected leak: a hidden field whose value appears in the agent context. */
export interface HiddenLeak {
  field: string
  destination: FieldDestination
}

export interface NoLeakOptions {
  /** Minimum hidden-value length to check. A hidden value shorter than this is
   *  skipped — a one-word or empty hidden field would substring-match innocuous
   *  prose and is not meaningful evidence of a leak. Default 12. */
  minMatchLength?: number
}

/**
 * The FIREWALL. Throws `ValidationError` if any `grading-only`/`judge-only`
 * field's value is found inside `agentContext` — the exact text that reaches the
 * agent during the run (its prompt, its seeded files concatenated, whatever the
 * caller assembled). `agent-visible` and `develop-against` fields are never
 * checked: they are meant to be there.
 *
 * Substring containment is the check: it is domain-free and catches the failure
 * that matters — a hidden answer key, held-out case, or rubric anchor pasted
 * into the prompt. Returns the routed fields on success so a caller can chain.
 */
export function assertNoHiddenLeak(
  fields: readonly RoutedField[],
  agentContext: string,
  opts: NoLeakOptions = {},
): readonly RoutedField[] {
  const minLen = opts.minMatchLength ?? 12
  const leaks: HiddenLeak[] = []
  for (const field of fields) {
    if (!isHiddenDestination(field.destination)) continue
    const needle = field.value.trim()
    if (needle.length < minLen) continue
    if (agentContext.includes(needle)) {
      leaks.push({ field: field.name, destination: field.destination })
    }
  }
  if (leaks.length > 0) {
    const detail = leaks.map((l) => `"${l.field}" (${l.destination})`).join(', ')
    throw new ValidationError(
      `hidden-criteria firewall breached: ${leaks.length} hidden field(s) reached the agent context: ${detail}`,
    )
  }
  return fields
}

/** Collect the values a domain may safely render into the agent context — the
 *  `agent-visible` (and, by intent, `develop-against`) fields — so a caller can
 *  ASSEMBLE the context from the routing rather than hand-picking fields and
 *  risking a slip. `develop-against` is included because it is seeded into the
 *  agent's environment during the run on purpose. */
export function agentVisibleFields(fields: readonly RoutedField[]): RoutedField[] {
  return fields.filter((f) => !isHiddenDestination(f.destination))
}

// ── 2. hidden-criteria grading ────────────────────────────────────────────────

/** What a hidden-criteria grader reports. `passRate = passed / total` over the
 *  hidden checks; `total === 0` means the criteria never ran (e.g. the artifact
 *  did not even load) — an honest zero, never a spurious pass. */
export interface HiddenGradeResult {
  /** Hidden checks that passed. */
  passed: number
  /** Total hidden checks attempted. 0 when the criteria could not run at all. */
  total: number
  /** `passed / total`, or 0 when `total === 0`. The PRIMARY correctness score. */
  passRate: number
  /** Free-form provenance the caller may record (runner output, reason for 0). */
  notes?: string
}

/**
 * The domain's grader: given the agent's artifact and the HIDDEN criteria,
 * return a pass rate. This is the ONE seam a non-coding domain implements — the
 * coding node-test executor is a single implementation of it; a legal grader
 * checks the brief against hidden required holdings, a research grader checks an
 * answer against held-out facts, a tax grader runs hidden return assertions.
 * The substrate calls it ONLY at grading time, behind the firewall.
 *
 * `THidden` is the domain's hidden-criteria payload (the held-out suite, the
 * answer key, the hidden requirements) — opaque to the substrate.
 */
export type HiddenCriteriaGrader<TArtifact, THidden> = (
  artifact: TArtifact,
  hiddenCriteria: THidden,
  signal?: AbortSignal,
) => Promise<HiddenGradeResult> | HiddenGradeResult

/** Normalize a grader's raw `{passed, total}` into a `HiddenGradeResult` with a
 *  consistent, fail-loud `passRate` — the canonical "honest zero on no-run"
 *  rule, single-sourced so every domain grader gets it. */
export function hiddenGrade(passed: number, total: number, notes?: string): HiddenGradeResult {
  const p = Number.isFinite(passed) && passed > 0 ? Math.floor(passed) : 0
  const t = Number.isFinite(total) && total > 0 ? Math.floor(total) : 0
  const passRate = t > 0 ? Math.min(1, p / t) : 0
  return { passed: Math.min(p, t > 0 ? t : p), total: t, passRate, notes }
}

/**
 * Run a domain's hidden-criteria grader behind the firewall. Before grading, it
 * re-asserts the firewall against the agent context the run actually used —
 * proving (at grading time, on real data) that the hidden criteria never
 * reached the agent — then invokes the grader and returns its pass rate. A
 * domain that wants the firewall and the grader wired together in one call uses
 * this; a domain that already asserted the firewall at dispatch time can call
 * its grader directly and feed the result to `blendHeldout`.
 */
export async function gradeOnHidden<TArtifact, THidden>(args: {
  artifact: TArtifact
  hiddenCriteria: THidden
  grader: HiddenCriteriaGrader<TArtifact, THidden>
  /** The routed fields + the exact agent context, re-checked before grading. */
  firewall: { fields: readonly RoutedField[]; agentContext: string; options?: NoLeakOptions }
  signal?: AbortSignal
}): Promise<HiddenGradeResult> {
  assertNoHiddenLeak(args.firewall.fields, args.firewall.agentContext, args.firewall.options)
  const result = await args.grader(args.artifact, args.hiddenCriteria, args.signal)
  return hiddenGrade(result.passed, result.total, result.notes)
}

// ── the composite: hidden correctness (PRIMARY) + judge quality (secondary) ────

/** Weights for the held-out / judge blend. Must be finite and non-negative;
 *  they are renormalized to sum to 1 so a caller can pass any positive ratio. */
export interface BlendWeights {
  /** Weight on the hidden-criteria pass rate (the primary, ungameable score). */
  heldout: number
  /** Weight on the judge's quality composite (the secondary style/quality score). */
  judge: number
}

/** Default blend: 0.7 hidden correctness, 0.3 judge quality. The coding bench's
 *  long-standing split — execution truth dominates, style refines. */
export const defaultBlendWeights: BlendWeights = { heldout: 0.7, judge: 0.3 }

/** The input shape a judge's `score` receives — exactly `JudgeConfig.score`'s
 *  argument: the artifact, plus any scenario/signal fields the judge carries.
 *  `withHeldoutBlend` only reads `artifact`; the rest rides through. */
export interface JudgeScoreInput<TArtifact> {
  artifact: TArtifact
  /** Pass-through for the judge's extra input fields (scenario, signal). */
  [key: string]: unknown
}

function normalizeWeights(weights: BlendWeights): { heldout: number; judge: number } {
  const h = Number.isFinite(weights.heldout) && weights.heldout >= 0 ? weights.heldout : 0
  const j = Number.isFinite(weights.judge) && weights.judge >= 0 ? weights.judge : 0
  const sum = h + j
  if (sum <= 0) {
    throw new ValidationError(
      'blend weights must have a positive sum (got heldout+judge <= 0) — cannot weight a composite by zero',
    )
  }
  return { heldout: h / sum, judge: j / sum }
}

/**
 * Compose the PRIMARY hidden-criteria pass rate with the SECONDARY judge
 * composite into the single score the leaderboard ranks on. Weights are
 * renormalized, so a solution that fails the hidden criteria is capped low no
 * matter how the judge felt about its style, while a stylistically-mediocre but
 * CORRECT solution still earns the bulk of the points. Both inputs are clamped
 * to [0,1] — a judge on a non-unit scale must be normalized by the caller first.
 */
export function blendHeldout(
  heldoutPassRate: number,
  judgeScore: number,
  weights: BlendWeights = defaultBlendWeights,
): number {
  const w = normalizeWeights(weights)
  const heldout = clampUnit(heldoutPassRate)
  const judge = clampUnit(judgeScore)
  return w.heldout * heldout + w.judge * judge
}

/**
 * Wrap a judge's `score` so the `composite` it REPORTS is the held-out-weighted
 * blend. The judge still scores its quality dimensions (recorded, secondary),
 * but the composite that downstream selection/scorecard reads becomes
 * `blendHeldout(heldoutPassRate(artifact), judgeComposite, weights)`. The held-
 * out pass rate is read off the artifact via `heldoutPassRate` — already
 * computed before the judge runs — so no second grading pass is needed.
 *
 * Generic over the artifact type, inferred from `heldoutPassRate`, so it
 * composes with both a `campaign` `JudgeConfig.score` and a bare scoring
 * function. The input is the judge's `{ artifact, ... }` — any extra fields
 * (`scenario`, `signal`) ride through untouched via the index signature.
 */
export function withHeldoutBlend<TArtifact>(
  score: (input: JudgeScoreInput<TArtifact>) => JudgeScore | Promise<JudgeScore>,
  heldoutPassRate: (artifact: TArtifact) => number,
  weights: BlendWeights = defaultBlendWeights,
): (input: JudgeScoreInput<TArtifact>) => Promise<JudgeScore> {
  return async (input: JudgeScoreInput<TArtifact>): Promise<JudgeScore> => {
    const base = await score(input)
    if (base.failed) return base
    const rate = clampUnit(heldoutPassRate(input.artifact))
    const composite = blendHeldout(rate, base.composite, weights)
    const w = normalizeWeights(weights)
    return {
      ...base,
      composite,
      notes:
        `composite=${composite.toFixed(3)} ` +
        `(held-out ${(rate * 100).toFixed(0)}% × ${w.heldout.toFixed(2)} + ` +
        `quality ${base.composite.toFixed(3)} × ${w.judge.toFixed(2)})` +
        (base.notes ? ` — ${base.notes}` : ''),
    }
  }
}

function clampUnit(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(1, value))
}
