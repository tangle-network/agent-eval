/**
 * Reflective mutation — primitives for trace-conditioned prompt rewriting.
 *
 * Used by `prompt-evolution.ts` (and any consumer running iterative
 * improvement). Given a parent prompt + concrete trace evidence (top trials,
 * bottom trials, missed expectations), produce an LLM-ready prompt that
 * proposes targeted mutations — not blind rephrasings.
 *
 * Why this lives outside `prompt-evolution.ts`: any consumer that wants to
 * run reflective rewriting WITHOUT the population/Pareto machinery can
 * import these primitives directly.
 *
 * Quality bar (vs. naive "mutate this prompt"):
 *   - Show parent ↔ children diff, not just one variant
 *   - Quote specific missed goldens with their match phrases
 *   - Surface the model's actual emitted output side-by-side with what was expected
 *   - Quote concrete mutation primitives so the model has a vocabulary
 */

export interface TrialTrace {
  /** Stable id for the trial — surfaces in the prompt for grounding. */
  id: string
  /** Score the trial received on its primary metric. */
  score: number
  /** Candidate inputs the agent was given (e.g., the fixture or scenario). */
  inputName?: string
  /**
   * Goldens / expectations this trial was tested against, with whether each
   * was matched. The reflection prompt quotes the missed ones specifically.
   */
  expectations?: Array<{ id: string; phrase: string; matched: boolean }>
  /** Free-form text — what the agent actually emitted (e.g., findings, plan). */
  emitted?: string
  /** Optional structured metrics (recall, precision, cost, latency). */
  metrics?: Record<string, number>
}

export interface ReflectionContext {
  /** What is being mutated — appears in the system prompt for orientation. */
  target: string
  /** Current variant's payload — JSON-serialised for the prompt. */
  parentPayload: unknown
  /** Best-performing trials this generation. */
  topTrials: TrialTrace[]
  /** Worst-performing trials this generation — the missed-golden source. */
  bottomTrials: TrialTrace[]
  /** How many children the mutator should propose. */
  childCount: number
  /** Optional: domain-specific mutation primitives the model can pick from. */
  mutationPrimitives?: string[]
}

export const DEFAULT_MUTATION_PRIMITIVES: string[] = [
  'Strengthen an imperative ("should" → "must")',
  'Add a concrete example pulled from a missed-golden phrase',
  'Remove a redundant rule that did not improve recall',
  'Add a counterfactual ("if X is missing, the score is capped at Y")',
  'Reorder sections so the highest-impact rule is first',
  'Replace abstract language with a domain-specific noun the trial misses',
]

/**
 * Build the LLM-ready reflection prompt. Output is plain text — pass it as
 * the user message. The system message should be small and stable (e.g.
 * "Output ONLY a JSON object matching the schema below.").
 */
export function buildReflectionPrompt(ctx: ReflectionContext): string {
  const primitives = ctx.mutationPrimitives ?? DEFAULT_MUTATION_PRIMITIVES
  const sections: string[] = []

  sections.push(`# Mutation target: ${ctx.target}`)
  sections.push('')
  sections.push(
    `You are tuning the prompt component named \`${ctx.target}\`. The current variant is shown below; you have ${ctx.topTrials.length} top trials and ${ctx.bottomTrials.length} bottom trials as evidence. Propose ${ctx.childCount} mutation${ctx.childCount === 1 ? '' : 's'} that fix specific weaknesses visible in the bottom trials. Avoid blank rephrasings.`,
  )
  sections.push('')

  sections.push('## Current variant')
  sections.push('```json')
  sections.push(JSON.stringify(ctx.parentPayload, null, 2))
  sections.push('```')
  sections.push('')

  if (ctx.bottomTrials.length > 0) {
    sections.push('## Failures (bottom trials) — what went wrong')
    sections.push('')
    for (const trial of ctx.bottomTrials) {
      sections.push(
        `### Trial \`${trial.id}\` — score ${trial.score.toFixed(2)}${trial.inputName ? ` (${trial.inputName})` : ''}`,
      )
      const missed = (trial.expectations ?? []).filter((e) => !e.matched)
      if (missed.length > 0) {
        sections.push('')
        sections.push('**Missed expectations:**')
        for (const m of missed) {
          sections.push(`- \`${m.id}\`: should match phrase \`${quote(m.phrase)}\``)
        }
      }
      if (trial.emitted) {
        sections.push('')
        sections.push('**What the agent emitted:**')
        sections.push('```')
        sections.push(truncate(trial.emitted, 600))
        sections.push('```')
      }
      sections.push('')
    }
  }

  if (ctx.topTrials.length > 0) {
    sections.push('## Successes (top trials) — what to preserve')
    sections.push('')
    for (const trial of ctx.topTrials) {
      sections.push(
        `- \`${trial.id}\`: score ${trial.score.toFixed(2)}${trial.inputName ? ` (${trial.inputName})` : ''}`,
      )
    }
    sections.push('')
  }

  sections.push('## Allowed mutation primitives')
  sections.push('')
  for (const p of primitives) sections.push(`- ${p}`)
  sections.push('')

  sections.push('## Output schema')
  sections.push('')
  sections.push('Respond with a JSON object — no prose, no markdown fences:')
  sections.push('```json')
  sections.push(
    JSON.stringify(
      {
        proposals: [
          {
            label: '<short label, ≤ 40 chars>',
            rationale: '<which failure this targets and which primitive you used>',
            payload: '<full payload of the new variant — same shape as the current variant>',
          },
        ],
      },
      null,
      2,
    ),
  )
  sections.push('```')

  return sections.join('\n')
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s
  return `${s.slice(0, max)}… [truncated]`
}

function quote(s: string): string {
  return s.replace(/`/g, '\\`')
}

export interface ReflectionProposal {
  label: string
  rationale: string
  payload: unknown
}

/**
 * Parse the model's JSON response back into proposals. Tolerates markdown
 * fences and surrounding prose. Returns at most `maxProposals`.
 */
/**
 * Walk the input as JSON-aware (string vs not, escape-aware) and close
 * unclosed `{` / `[` in LIFO order at the tail. If the input was already
 * balanced returns it unchanged. If a string was open at end-of-input we
 * also close it with `"` first, since a truncated string-mid-value is the
 * most common LLM cap-hit failure mode and JSON.parse cannot proceed
 * without one.
 *
 * Returns null when the structure is unrecoverable (e.g. depth would go
 * negative — that's an *over*-closed prefix, not a truncation).
 */
function autoCloseTruncatedJson(raw: string): string | null {
  const stack: Array<'{' | '['> = []
  let inString = false
  let escaped = false
  for (const c of raw) {
    if (escaped) {
      escaped = false
      continue
    }
    if (inString) {
      if (c === '\\') {
        escaped = true
        continue
      }
      if (c === '"') {
        inString = false
        continue
      }
      continue
    }
    if (c === '"') {
      inString = true
      continue
    }
    if (c === '{' || c === '[') stack.push(c)
    else if (c === '}') {
      if (stack.pop() !== '{') return null
    } else if (c === ']') {
      if (stack.pop() !== '[') return null
    }
  }
  if (stack.length === 0 && !inString) return raw
  let suffix = ''
  if (inString) suffix += '"'
  while (stack.length > 0) {
    const opener = stack.pop()!
    suffix += opener === '{' ? '}' : ']'
  }
  return raw + suffix
}

export function parseReflectionResponse(raw: string, maxProposals?: number): ReflectionProposal[] {
  let text = raw.trim()
  if (text.startsWith('```')) text = text.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '')

  // Try to parse as either a JSON object `{proposals: [...]}` or a bare
  // array `[...]`. LLMs frequently emit one or the other depending on how
  // they read the schema example; accept both.
  let parsed: unknown = null
  const objectStart = text.indexOf('{')
  const objectEnd = text.lastIndexOf('}')
  const arrayStart = text.indexOf('[')
  const arrayEnd = text.lastIndexOf(']')
  // Prefer whichever delimiter comes first (the model committed to that shape).
  const tryObjectFirst = objectStart >= 0 && (arrayStart < 0 || objectStart < arrayStart)
  const candidates: string[] = []
  if (tryObjectFirst) {
    if (objectStart >= 0 && objectEnd > objectStart)
      candidates.push(text.slice(objectStart, objectEnd + 1))
    if (arrayStart >= 0 && arrayEnd > arrayStart)
      candidates.push(text.slice(arrayStart, arrayEnd + 1))
  } else {
    if (arrayStart >= 0 && arrayEnd > arrayStart)
      candidates.push(text.slice(arrayStart, arrayEnd + 1))
    if (objectStart >= 0 && objectEnd > objectStart)
      candidates.push(text.slice(objectStart, objectEnd + 1))
  }
  for (const slice of candidates) {
    try {
      parsed = JSON.parse(slice)
      break
    } catch {
      // try next
    }
  }

  // Truncation-tolerant fallback: LLMs frequently hit a max_tokens cap
  // mid-emission, leaving N unclosed `}` / `]` at the tail. Close them in
  // order from the deepest unclosed structure outward, by walking the
  // candidate slice and tracking depth, then retrying JSON.parse. This
  // recovers any complete proposals before the cutoff and drops the rest.
  if (parsed == null) {
    for (const slice of candidates) {
      const closed = autoCloseTruncatedJson(slice)
      if (closed != null && closed !== slice) {
        try {
          parsed = JSON.parse(closed)
          break
        } catch {
          // give up on this candidate
        }
      }
    }
  }

  if (parsed == null) return []

  // Normalize: accept `{proposals: [...]}` or a bare array.
  let proposalsRaw: unknown
  if (Array.isArray(parsed)) {
    proposalsRaw = parsed
  } else if (parsed && typeof parsed === 'object') {
    proposalsRaw = (parsed as { proposals?: unknown }).proposals
  }
  if (!Array.isArray(proposalsRaw)) return []

  const out: ReflectionProposal[] = []
  for (const p of proposalsRaw) {
    if (!p || typeof p !== 'object') continue
    const obj = p as { label?: unknown; rationale?: unknown; payload?: unknown }
    if (!('payload' in obj)) continue
    out.push({
      label: typeof obj.label === 'string' ? obj.label : 'mutation',
      rationale: typeof obj.rationale === 'string' ? obj.rationale : '',
      payload: obj.payload,
    })
    if (maxProposals !== undefined && out.length >= maxProposals) break
  }
  return out
}
