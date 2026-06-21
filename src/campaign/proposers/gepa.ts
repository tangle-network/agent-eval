/**
 * `gepaProposer` — a reflective `SurfaceProposer` for prompt-tier surfaces.
 * Each generation it reflects on the prior best candidate's per-scenario
 * scores + weakest dimensions, asks an LLM to propose targeted rewrites of
 * the current surface, and returns them as the next population.
 *
 * Maps onto the GEPA paper (Agrawal et al., arXiv:2507.19457):
 *   - *Reflection*: each generation reflects on the best parent's weakest
 *     dimensions + per-scenario top/bottom scores to propose targeted rewrites.
 *   - *Pareto frontier*: `runOptimization` maintains the non-dominated set of
 *     surfaces across generations (per-scenario objective vectors) and supplies
 *     it as `ctx.paretoParents`. A surface uniquely best on one hard scenario
 *     survives even when its mean composite is lower.
 *   - *Combine complementary lessons*: when the frontier has >1 member, the
 *     first population slot is a merge of those parents' strengths (one LLM
 *     call citing each parent's winning scenarios). Toggle via `combineParents`.
 * Dominance is computed by the package-canonical `paretoFrontier` (`pareto.ts`).
 *
 * Optional `constraints` move structured-doc guards into the proposer
 * (preserve H2 section headings, cap sentence-level edits) — useful when
 * the surface IS a structured procedure like a SKILL.md / runbook /
 * judge rubric. When `constraints` is omitted, behavior is unchanged.
 *
 * The proposer is surface-agnostic — any string surface in any consumer opts
 * in by selecting it. Reuses the generic reflection primitive
 * (`buildReflectionPrompt` / `parseReflectionResponse`) and the router client.
 *
 * Earns its keep where there is real per-instance signal (which the
 * dimensional + per-scenario evidence + the `LabeledScenarioStore` flywheel
 * now provide). For thin-signal surfaces it degrades to plain reflection.
 * On generation 0 (no history) it reflects on the current surface against
 * the mutation primitives alone.
 */

import { callLlm, type LlmClientOptions } from '../../llm-client'
import {
  buildReflectionPrompt,
  parseReflectionResponse,
  renderAnalystEvidence,
  type TrialTrace,
} from '../../reflective-mutation'
import type { ProposeContext, ProposedCandidate, SurfaceProposer } from '../types'

const REFLECTION_SYSTEM =
  'You are an expert prompt engineer performing GEPA-style reflective mutation. ' +
  'You are given a prompt surface, its top trials (preserve what works) and its ' +
  'bottom trials (the evidence to fix). For each proposal, reason in this order ' +
  'before writing the payload: (1) LOCALIZE — point to the exact span of the ' +
  'current surface responsible for a bottom-trial failure; (2) DIAGNOSE the root ' +
  'cause (a missing rule, an ambiguous instruction, an over-broad directive), not ' +
  'just the symptom; (3) propose the MINIMAL, GENERALIZABLE edit that fixes the ' +
  'whole failure class — state it as a rule the agent should follow, never a patch ' +
  'memorized to the shown trials (that is overfitting and will not transfer to the ' +
  'held-out set); (4) PRESERVE every instruction the top trials depend on — do not ' +
  'delete or weaken working guidance. Put this localize→diagnose→fix reasoning in ' +
  "each proposal's `rationale`. " +
  'Output ONLY a JSON object of shape ' +
  '{"proposals":[{"label":string,"rationale":string,"payload":string}]} where ' +
  'each `payload` is the FULL improved surface text. No prose outside the JSON.'

const COMBINE_SYSTEM =
  'You are an expert prompt engineer performing a GEPA "combine complementary ' +
  'lessons" merge. You are given several non-dominated versions of one surface; ' +
  'each is uniquely best on different scenarios. Produce ONE new version that ' +
  'keeps what makes each version strong on its winning scenarios and resolves ' +
  'conflicts in favor of the more general rule. Output ONLY a JSON object of ' +
  'shape {"proposals":[{"label":string,"rationale":string,"payload":string}]} ' +
  'with exactly one proposal whose `payload` is the FULL merged surface text. ' +
  'No prose outside the JSON.'

export interface GepaProposerConstraints {
  /** H2 section headings that MUST appear unchanged in every candidate.
   *  When set, the proposer auto-detects current H2s if this is empty AND
   *  rejects any candidate that drops or renames a preserved heading.
   *  Use when the surface is a structured doc (SKILL.md, runbook,
   *  sectioned system prompt, judge rubric). */
  preserveSections?: string[]
  /** Maximum sentence-level edits per candidate vs the parent surface.
   *  Rejection threshold = maxSentenceEdits × 2 (counts adds + removes).
   *  Inspired by SkillOpt's edit-budget as a "textual learning rate."
   *  Cap prevents an LLM rewrite from overwriting useful prior rules. */
  maxSentenceEdits?: number
}

export interface GepaProposerOptions {
  /** Router transport (apiKey/baseUrl). */
  llm: LlmClientOptions
  /** Model that performs the reflection. */
  model: string
  /** What is being optimized — appears in the reflection prompt for orientation. */
  target: string
  /** Surface-specific mutation levers offered to the model. */
  mutationPrimitives?: string[]
  /** Top/bottom scenarios surfaced as evidence each generation. Default 3. */
  evidenceK?: number
  /** Reflection sampling temperature. Default 0.7. */
  temperature?: number
  /** Reflection max tokens. Default 6000. */
  maxTokens?: number
  /** Structured-doc constraints. Candidates violating any are rejected
   *  post-parse and dropped from the returned population. */
  constraints?: GepaProposerConstraints
  /** GEPA combine-complementary-lessons: when the loop supplies a Pareto
   *  frontier of >1 non-dominated parents (`ctx.paretoParents`), spend one
   *  slot of the population on a merge of their strengths. Default `true` —
   *  this is the GEPA-faithful behavior; the merge only fires once the
   *  frontier has more than one member (generation ≥ 1). Set `false` for
   *  pure single-parent reflection. */
  combineParents?: boolean
  /** Cap on how many frontier parents feed one combine prompt (highest
   *  composite first), to bound prompt size. Default 4. */
  combineMaxParents?: number
}

export function gepaProposer(opts: GepaProposerOptions): SurfaceProposer {
  const evidenceK = opts.evidenceK ?? 3
  const combineParents = opts.combineParents ?? true
  const combineMaxParents = opts.combineMaxParents ?? 4
  if (combineParents && combineMaxParents < 1) {
    throw new Error('gepaProposer: combineMaxParents must be >= 1 when combineParents is enabled')
  }
  return {
    kind: 'gepa',
    async propose(ctx: ProposeContext): Promise<ProposedCandidate[]> {
      const parent =
        typeof ctx.currentSurface === 'string'
          ? ctx.currentSurface
          : JSON.stringify(ctx.currentSurface)

      // Shared accept path: constraint checks + dedup, used by BOTH the
      // combine merge and the reflection fill so the population is consistent.
      const constraints = opts.constraints
      const preserveSections =
        constraints?.preserveSections !== undefined
          ? constraints.preserveSections.length === 0
            ? extractH2Sections(parent)
            : constraints.preserveSections
          : null
      const maxEdits = constraints?.maxSentenceEdits
      const out: ProposedCandidate[] = []
      const seen = new Set<string>()
      const accept = (payload: unknown, label: string, rationale: string): void => {
        const text = typeof payload === 'string' ? payload.trim() : ''
        if (!text || text === parent || seen.has(text)) return
        if (preserveSections && !validatePreservedSections(text, preserveSections)) return
        if (maxEdits !== undefined && countSentenceEdits(parent, text) > maxEdits * 2) return
        seen.add(text)
        // Thread label + rationale through so the candidate stays attributable:
        // the loop records WHY this rewrite was proposed, not just the payload.
        out.push({ surface: text, label, rationale })
      }

      // ── (1) GEPA combine-complementary-lessons ──────────────────────────
      // When the loop supplies >1 non-dominated parents, spend the first slot
      // merging their strengths. Only string surfaces merge (the proposer is
      // prompt-tier); the merge prompt cites each parent's winning scenarios.
      const stringParents = (combineParents ? (ctx.paretoParents ?? []) : [])
        .filter((p): p is typeof p & { surface: string } => typeof p.surface === 'string')
        .sort((a, b) => b.composite - a.composite)
        .slice(0, combineMaxParents)
      if (stringParents.length > 1) {
        const combinePrompt = buildCombinePrompt({
          target: opts.target,
          parents: stringParents,
          evidenceK,
        })
        const combineResult = await callLlm(
          {
            model: opts.model,
            messages: [
              { role: 'system', content: COMBINE_SYSTEM },
              { role: 'user', content: combinePrompt },
            ],
            jsonMode: true,
            temperature: opts.temperature ?? 0.7,
            maxTokens: opts.maxTokens ?? 6000,
          },
          opts.llm,
        )
        const merged = parseReflectionResponse(combineResult.content, 1)[0]
        if (merged) {
          accept(
            merged.payload,
            merged.label || 'pareto-combine',
            merged.rationale ||
              `combined ${stringParents.length} non-dominated parents (gen ${stringParents
                .map((p) => p.generation)
                .join(',')})`,
          )
        }
      }

      // ── (2) Reflection fill for the remaining population budget ──────────
      const reflectCount = Math.max(0, ctx.populationSize - out.length)
      if (reflectCount > 0) {
        const { top, bottom, target } = buildEvidence(ctx, evidenceK, opts.target)
        const userPrompt = buildReflectionPrompt({
          target,
          parentPayload: parent,
          topTrials: top,
          bottomTrials: bottom,
          childCount: reflectCount,
          mutationPrimitives: opts.mutationPrimitives,
        })
        // Append the analyst's diagnosis (ctx.findings / ctx.report) so
        // reflection targets named root causes, not just low-scoring trials.
        const analyst = renderAnalystEvidence(ctx.findings, ctx.report)
        const finalPrompt = analyst ? `${userPrompt}\n\n${analyst}` : userPrompt
        const result = await callLlm(
          {
            model: opts.model,
            messages: [
              { role: 'system', content: REFLECTION_SYSTEM },
              { role: 'user', content: finalPrompt },
            ],
            jsonMode: true,
            temperature: opts.temperature ?? 0.7,
            maxTokens: opts.maxTokens ?? 6000,
          },
          opts.llm,
        )
        for (const proposal of parseReflectionResponse(result.content, reflectCount)) {
          accept(proposal.payload, proposal.label, proposal.rationale)
        }
      }

      return out.slice(0, ctx.populationSize)
    },
  }
}

/** Build the GEPA combine prompt: each non-dominated parent's full surface +
 *  the scenarios it scores highest on, so the model can merge complementary
 *  strengths rather than blend blindly. */
function buildCombinePrompt(args: {
  target: string
  parents: Array<{ surface: string; objectives: Record<string, number>; composite: number }>
  evidenceK: number
}): string {
  const lines: string[] = [
    `You are merging ${args.parents.length} versions of: ${args.target}.`,
    '',
    'Each version is on the Pareto frontier — none dominates the others; each',
    'wins on different scenarios. Combine their complementary strengths into',
    'ONE version. Below, each version lists the scenarios it scores highest on.',
    '',
  ]
  args.parents.forEach((p, i) => {
    const tag = String.fromCharCode(65 + i) // A, B, C...
    const best = Object.entries(p.objectives)
      .sort((a, b) => b[1] - a[1])
      .slice(0, args.evidenceK)
      .map(([id, score]) => `${id} (${score.toFixed(2)})`)
    lines.push(
      `### Version ${tag} (mean ${p.composite.toFixed(2)}; strongest on: ${
        best.join(', ') || 'n/a'
      })`,
      '```',
      p.surface,
      '```',
      '',
    )
  })
  lines.push(
    'Return ONE merged version that would score well on the union of every',
    "version's winning scenarios. Keep each version's specific winning rule;",
    'where two rules conflict, prefer the more general one and note the choice',
    'in your rationale.',
  )
  return lines.join('\n')
}

/** Extract H2 headings (`## Foo`) from a markdown surface. Exported for
 *  consumers building custom mutators that share the same invariant. */
export function extractH2Sections(text: string): string[] {
  const out: string[] = []
  for (const line of text.split('\n')) {
    const match = /^##\s+(.+?)\s*$/.exec(line)
    if (match) out.push(match[1]!)
  }
  return out
}

/** Sentence-level edit distance — count distinct add/remove ops between
 *  two surfaces via a normalised line-by-line set diff. Treats trivial
 *  whitespace as identical. Exported for tests + consumer-side validators. */
export function countSentenceEdits(baseline: string, candidate: string): number {
  const norm = (s: string) =>
    s
      .split(/(?<=[.!?])\s+|\n/g)
      .map((p) => p.trim())
      .filter((p) => p.length > 0)
  const a = new Set(norm(baseline))
  const b = new Set(norm(candidate))
  let edits = 0
  for (const s of a) if (!b.has(s)) edits++
  for (const s of b) if (!a.has(s)) edits++
  return edits
}

function validatePreservedSections(candidate: string, required: readonly string[]): boolean {
  if (required.length === 0) return true
  const have = new Set(extractH2Sections(candidate))
  for (const section of required) {
    if (!have.has(section)) return false
  }
  return true
}

/** Turn the prior generation's best candidate into reflective evidence:
 *  top/bottom scenarios by composite + a weakest-dimensions note on the target.
 *  Empty on generation 0 — the model reflects on the surface alone. */
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
  const toTrace = (s: { scenarioId: string; composite: number; notes?: string }): TrialTrace => ({
    id: s.scenarioId,
    score: s.composite,
    // The judge's "why it scored low" — grounds the reflection on real failure
    // patterns instead of blind rephrasing. Generalizable by the judge contract.
    ...(s.notes ? { failureNote: s.notes } : {}),
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
