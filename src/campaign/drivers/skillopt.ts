/**
 * @experimental
 *
 * `skillOptDriver` — a section-aware, bounded-edit `ImprovementDriver` for
 * structured natural-language procedures (SKILL.md files, runbooks, sectioned
 * system prompts, judge rubrics with dimensions). Implements the SkillOpt
 * methodology (Microsoft, 2026): treat the skill document as a trainable
 * optimization target, train the procedure not the weights, constrain each
 * generation to ≤N targeted edits to prevent useful-rule overwrites.
 *
 * Differs from `gepaDriver` in two specific ways:
 *
 * 1. **Bounded edits.** Each candidate must differ from the baseline by at
 *    most `editBudget` sentence-level changes. The "edit budget functions
 *    as a textual learning rate" — without it, an LLM proposal can rewrite
 *    so much that useful prior rules get overwritten.
 *
 * 2. **Section preservation.** When the surface is a structured doc, the
 *    H2 headers (and an opt-in `preserveSections` allowlist) are
 *    load-bearing for discoverability. Candidates that delete or rename
 *    preserved sections are rejected at parse time.
 *
 * Selectable alongside `gepaDriver` and `evolutionaryDriver`. Use this when
 * the surface IS a structured doc; use `gepaDriver` when the surface is
 * unstructured prose.
 */

import { callLlm, type LlmClientOptions } from '../../llm-client'
import {
  buildReflectionPrompt,
  parseReflectionResponse,
  type TrialTrace,
} from '../../reflective-mutation'
import type { ImprovementDriver, MutableSurface, ProposeContext } from '../types'

const REFLECTION_SYSTEM =
  'You are an expert prompt engineer applying the SkillOpt methodology. ' +
  'You will edit a structured natural-language procedure under TWO HARD ' +
  'CONSTRAINTS: (1) preserve every H2 section heading verbatim — do NOT ' +
  'delete, rename, or merge sections; (2) make at most EDIT_BUDGET targeted ' +
  'sentence-level edits per candidate — bounded edits prevent overwriting ' +
  'useful prior rules. Output ONLY a JSON object of shape ' +
  '{"proposals":[{"label":string,"rationale":string,"payload":string}]} ' +
  'where each `payload` is the FULL improved skill text. No prose outside the JSON.'

export interface SkillOptDriverOptions {
  /** Router transport (apiKey/baseUrl). */
  llm: LlmClientOptions
  /** Model that performs the reflection. */
  model: string
  /** What is being optimized — appears in the reflection prompt for orientation. */
  target: string

  /** Max edits per generation — SkillOpt's "textual learning rate".
   *  Default 3. Lower = more conservative, higher = more exploratory. */
  editBudget?: number

  /** Section headings the driver MUST preserve. When the surface is a
   *  structured skill doc, sections are load-bearing for discoverability.
   *  Default: auto-detected from H2 headers in the baseline. */
  preserveSections?: string[]

  /** Surface-specific mutation levers offered to the model. */
  mutationPrimitives?: string[]
  /** Top/bottom scenarios surfaced as evidence each generation. Default 3. */
  evidenceK?: number
  /** Reflection sampling temperature. Default 0.7. */
  temperature?: number
  /** Reflection max tokens. Default 6000. */
  maxTokens?: number
}

/** Internal — exported for tests. */
export function extractH2Sections(text: string): string[] {
  const out: string[] = []
  for (const line of text.split('\n')) {
    const match = /^##\s+(.+?)\s*$/.exec(line)
    if (match) out.push(match[1]!)
  }
  return out
}

/** Sentence-level edit distance. Counts distinct sentence add/remove/replace
 *  ops between baseline and candidate using a normalised line-by-line diff.
 *  Imperfect (treats trivial whitespace as identical) but tight enough to
 *  bound an LLM rewrite. Exported for tests. */
export function countSentenceEdits(baseline: string, candidate: string): number {
  const norm = (s: string) =>
    s
      .split(/(?<=[.!?])\s+|\n/g)
      .map((p) => p.trim())
      .filter((p) => p.length > 0)
  const a = new Set(norm(baseline))
  const b = new Set(norm(candidate))
  let edits = 0
  for (const s of a) if (!b.has(s)) edits++ // deletions
  for (const s of b) if (!a.has(s)) edits++ // additions
  return edits
}

export function skillOptDriver(opts: SkillOptDriverOptions): ImprovementDriver {
  const evidenceK = opts.evidenceK ?? 3
  const editBudget = opts.editBudget ?? 3
  if (editBudget < 1) {
    throw new Error(
      `skillOptDriver: editBudget must be >= 1, got ${editBudget} (use evolutionaryDriver with a noop mutator for measure-only runs)`,
    )
  }
  return {
    kind: 'skillopt',
    async propose(ctx: ProposeContext): Promise<MutableSurface[]> {
      if (typeof ctx.currentSurface !== 'string') {
        throw new Error(
          `skillOptDriver: surface must be a string skill document; got ${typeof ctx.currentSurface}. Use evolutionaryDriver with a CodeSurface mutator for code-tier surfaces.`,
        )
      }
      const baseline = ctx.currentSurface
      const preserveSections = opts.preserveSections ?? extractH2Sections(baseline)

      const { top, bottom, target } = buildEvidence(ctx, evidenceK, opts.target)

      const reflectionUser = buildReflectionPrompt({
        target,
        parentPayload: baseline,
        topTrials: top,
        bottomTrials: bottom,
        childCount: ctx.populationSize,
        mutationPrimitives: opts.mutationPrimitives,
      })
      const constraintPreamble = [
        '',
        '## SkillOpt constraints (hard rules — violations rejected)',
        '',
        `- Edit budget: at most ${editBudget} sentence-level edits per candidate.`,
        '- Section preservation: every H2 heading below must appear unchanged in your output.',
        ...preserveSections.map((s) => `  - \`## ${s}\``),
        '',
        'Reject any candidate in your own thinking that would delete a section, rename a heading, or exceed the edit budget. Make TARGETED, surgical edits — not rewrites.',
        '',
      ].join('\n')
      const userPrompt = `${reflectionUser}${constraintPreamble}`
      const system = REFLECTION_SYSTEM.replace('EDIT_BUDGET', String(editBudget))

      const result = await callLlm(
        {
          model: opts.model,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: userPrompt },
          ],
          jsonMode: true,
          temperature: opts.temperature ?? 0.7,
          maxTokens: opts.maxTokens ?? 6000,
        },
        opts.llm,
      )

      const proposals = parseReflectionResponse(result.content, ctx.populationSize)
      const out: MutableSurface[] = []
      for (const proposal of proposals) {
        const text = typeof proposal.payload === 'string' ? proposal.payload.trim() : ''
        if (!text || text === baseline) continue
        if (!validateSections(text, preserveSections)) continue
        if (countSentenceEdits(baseline, text) > editBudget * 2) continue // x2: add+remove pair per edit
        if (out.includes(text)) continue
        out.push(text)
      }
      return out
    },
  }
}

function validateSections(candidate: string, required: string[]): boolean {
  if (required.length === 0) return true
  const have = new Set(extractH2Sections(candidate))
  for (const section of required) {
    if (!have.has(section)) return false
  }
  return true
}

/** Reused from gepaDriver pattern — build evidence from prior best candidate. */
function buildEvidence(
  ctx: ProposeContext,
  evidenceK: number,
  baseTarget: string,
): { top: TrialTrace[]; bottom: TrialTrace[]; target: string } {
  const last = ctx.history.at(-1)
  if (!last || last.candidates.length === 0) {
    return { top: [], bottom: [], target: baseTarget }
  }
  const best = [...last.candidates].sort((a, b) => b.composite - a.composite)[0]
  if (!best) return { top: [], bottom: [], target: baseTarget }

  const byScore = [...best.scenarios].sort((a, b) => b.composite - a.composite)
  const toTrace = (s: { scenarioId: string; composite: number }): TrialTrace => ({
    id: s.scenarioId,
    score: s.composite,
  })
  const top = byScore.slice(0, evidenceK).map(toTrace)
  const bottom = byScore.slice(-evidenceK).reverse().map(toTrace)

  const weakest = Object.entries(best.dimensions)
    .sort((a, b) => a[1] - b[1])
    .slice(0, 3)
    .map(([dim, value]) => `${dim} (${value.toFixed(2)})`)
  const target =
    weakest.length > 0 ? `${baseTarget} — weakest dimensions: ${weakest.join(', ')}` : baseTarget

  return { top, bottom, target }
}
