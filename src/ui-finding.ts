/**
 * UI audit finding — substrate primitive for "what is wrong with the UI?"
 *
 * Used by:
 *   - `@tangle-network/agent-runtime` (ui-auditor profile + delegate) —
 *     produced as the canonical output of an audit iteration, persisted to
 *     disk as GitHub-issue Markdown, surfaced over MCP.
 *   - Downstream ship gates / dashboards / analyst consumers — load and
 *     transform findings without depending on the runtime.
 *
 * Repo layering: agent-eval is the substrate (no upward deps). Consumers
 * read this type from here; the reverse is forbidden. See CLAUDE.md
 * "Repo layering" for the rule. A UI finding makes sense WITHOUT a running
 * agent loop (you can load a saved finding, ship-gate against a set of
 * them, render them in a dashboard), which puts it firmly in substrate.
 *
 * The shape is intentionally minimal — runtime-shaped state (capture
 * timestamps, OTel trace IDs, sandbox placement) lives on auxiliary
 * runtime types in `agent-runtime`, not on the finding itself.
 */

/**
 * Canonical audit lenses. Each lens scopes a finding to a single class of
 * problem so a single audit pass can iterate them without pile-on findings
 * under a generic label.
 *
 * Naming is fixed for cross-package wire compatibility. Treat additions as
 * a substrate-level decision — analysts, gates, and writers all branch on
 * the lens.
 */
export type UiLens =
  | 'consistency'
  | 'hierarchy'
  | 'layout'
  | 'ux-flow'
  | 'duplication'
  | 'accessibility'
  | 'responsive'
  | 'states'
  | 'content'
  | 'interaction'
  | 'performance-perceived'
  | 'other'

/** Frozen tuple of lenses for validation + iteration. */
export const UI_LENSES: readonly UiLens[] = [
  'consistency',
  'hierarchy',
  'layout',
  'ux-flow',
  'duplication',
  'accessibility',
  'responsive',
  'states',
  'content',
  'interaction',
  'performance-perceived',
  'other',
] as const

/**
 * Severity scale — intentionally narrow.
 *
 *   - `critical` — blocks a core task or is an accessibility blocker.
 *   - `high`     — confusing, broken-looking, or noticeable friction.
 *   - `med`      — visible polish issue, would be caught in code review.
 *   - `low`      — nitpick worth fixing eventually.
 */
export type UiFindingSeverity = 'low' | 'med' | 'high' | 'critical'

/** Frozen severity tuple, ordered worst → least bad for sort/report. */
export const UI_FINDING_SEVERITIES: readonly UiFindingSeverity[] = [
  'critical',
  'high',
  'med',
  'low',
] as const

/**
 * Pointer to a screenshot referenced by the finding. The path is
 * intentionally a relative string (relative to the audit workspace root)
 * so findings remain portable across machines and into GitHub issues.
 */
export interface UiFindingScreenshot {
  /** Workspace-relative path to the screenshot file (e.g. `screenshots/home--1280x800--...png`). */
  path: string
  /** Optional viewport the screenshot was taken at, e.g. `1280x800`. */
  viewport?: string
  /** Optional short label that disambiguates multiple captures of the same surface (e.g. `t0`, `step-1`). */
  label?: string
}

/**
 * A single UI audit finding — the unit of work a contributor can act on.
 *
 * Every field except the documented optionals is required. The shape is
 * deliberately constraining: a finding without a screenshot, a lens, a
 * concrete title, and a suggested fix is not actionable, and the auditor
 * validator hard-fails on those gaps.
 */
export interface UiFinding {
  /**
   * Stable identifier within a single audit workspace. Monotonically
   * increasing integer (1, 2, …) assigned by the writer when persisting.
   * Optional in transit (before persistence) — undefined on freshly minted
   * findings emitted from a loop iteration.
   */
  id?: number
  /** Concrete title — names the offending element AND what's wrong. */
  title: string
  /** Lens this finding belongs to. */
  lens: UiLens
  /** Severity. */
  severity: UiFindingSeverity
  /** Logical route the finding was observed on (e.g. `home`, `checkout-step-2`). */
  route: string
  /** Fully qualified URL the finding was observed at. */
  url?: string
  /** Viewport string the offending capture was taken at (e.g. `1280x800`). */
  viewport?: string
  /** CSS selector pinning the offending element, when one can be identified. */
  selector?: string
  /** 1–3 sentences describing what the screenshot shows that is wrong. */
  observation: string
  /** Who is affected and how. Concrete user impact. */
  impact: string
  /** A specific change a contributor could apply without asking back. */
  suggestedFix: string
  /** Optional explicit reproduction steps. Writer synthesizes from route/url/selector when omitted. */
  reproSteps?: string
  /** Free-form tags. */
  tags?: readonly string[]
  /** Screenshot references — required to be non-empty for actionable findings. */
  screenshots: readonly UiFindingScreenshot[]
  /** Cross-references to similar findings already on file, by id. */
  similarTo?: readonly number[]
  /** ISO-8601 creation timestamp set by the writer when persisted. */
  createdAt?: string
}
