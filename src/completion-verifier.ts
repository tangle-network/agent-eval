/**
 * Completion verifier — the task-completion oracle.
 *
 * Answers the only eval question that is not a proxy: did the agent actually
 * COMPLETE the task — produce every required deliverable, persisted and
 * correct — rather than describe what should be done. A fluent transcript
 * that never produces the artifact scores zero here.
 *
 * Per requirement, a two-stage check:
 *   1. Structural — a produced item (vault artifact / approved proposal /
 *      tool call) of the right kind is matched against the requirement and
 *      carries non-empty content. Deterministic; no LLM.
 *   2. Correctness — only if structurally present AND the matched item
 *      carries content, one targeted check decides whether that item
 *      actually fulfils the requirement. A hallucinated artifact fails here;
 *      an absent one already failed stage 1.
 *
 * `completionRate` is satisfied / total. Quality dimensions are meaningless
 * on an incomplete task — callers gate on `fullyComplete` / `completionRate`
 * before scoring quality.
 */

import { randomUUID } from 'node:crypto'
import type { TCloud } from '@tangle-network/tcloud'
import type { Artifact } from './artifact-validator'
import { recoverTruncatedJson } from './json-recovery'
import { JudgeParseError } from './judges'
import type { RawProviderEvent, RawProviderSink } from './trace/raw-provider-sink'
import type { DefaultVerdict } from './verdict'

/** What kind of produced state can satisfy a requirement structurally. */
export type SatisfiedBy = 'artifact' | 'proposal' | 'tool-call' | 'any'

export interface CompletionRequirement {
  /** Stable id from the task gold (e.g. a persona's `expected_requirements[].req_id`). */
  reqId: string
  /** Human-readable description of the required deliverable. */
  title: string
  /** Optional kind/category hint, matched against a produced item's kind. */
  category?: string
  /** What produced state satisfies this requirement. Defaults to 'any'. */
  satisfiedBy?: SatisfiedBy
}

export interface TaskGold {
  taskId: string
  requirements: CompletionRequirement[]
}

export interface ProducedProposal {
  id: string
  title: string
  status: 'pending' | 'approved' | 'rejected'
  /** Optional persisted body — when present, enables a correctness check. */
  content?: string
}

/** Everything observable about what a run actually produced. */
export interface ProducedState {
  /** Persisted vault artifacts. Reuses the shared `Artifact` shape. */
  artifacts: Artifact[]
  /** Proposals / filings the agent created. */
  proposals: ProducedProposal[]
  /** Names of tools the agent invoked. */
  toolCalls: string[]
}

export interface RequirementCheck {
  reqId: string
  title: string
  /** A produced item of the right kind matched the requirement, non-empty. */
  structurallyPresent: boolean
  /**
   * Whether the matched item actually fulfils the requirement. `null` when
   * not structurally present, when the matched item carries no content
   * to assess, or when the correctness check itself failed (`unmeasured`).
   */
  correct: boolean | null
  /** structurallyPresent && !unmeasured && correct !== false. */
  satisfied: boolean
  /**
   * Set when the correctness check itself errored (LLM call failure or an
   * unparseable response after retry). The requirement's fulfilment is
   * UNKNOWN — `correct` stays null, `satisfied` is false, and
   * `completionVerdict` excludes the row from `completionRate`'s
   * denominator. Never folded into a zero: a synthetic zero is
   * indistinguishable from a real failure (see `JudgeParseError`).
   */
  unmeasured?: true
  /** Why the correctness check could not be measured (present iff `unmeasured`). */
  unmeasuredReason?: string
  /** Human-readable evidence for the verdict. */
  evidence: string[]
}

/** Extends the substrate verdict spine: `valid` = `fullyComplete` and
 *  `score` = `completionRate` — derived in `completionVerdict()`, the one
 *  place those equalities hold by construction. */
export interface CompletionVerdict extends DefaultVerdict {
  taskId: string
  requirements: RequirementCheck[]
  /** satisfied / MEASURABLE requirements (unmeasured rows leave the denominator). */
  completionRate: number
  /** Every measurable requirement satisfied (false when anything is unmeasured). */
  fullyComplete: boolean
  /** Requirements whose correctness check errored — reported, never scored as zero. */
  unmeasuredCount: number
}

/**
 * Construct a `CompletionVerdict` from the per-requirement checks, deriving
 * `completionRate` / `fullyComplete` and the spine fields (`valid` =
 * `fullyComplete`, `score` = `completionRate`) in one place. Throws on zero
 * requirements — a verdict over nothing is a misconfiguration, mirroring
 * `verifyCompletion`'s gold-spec guard.
 */
export function completionVerdict(input: {
  taskId: string
  requirements: RequirementCheck[]
}): CompletionVerdict {
  if (input.requirements.length === 0) {
    throw new Error(
      `completionVerdict: task '${input.taskId}' has no requirement checks — nothing to derive a verdict from`,
    )
  }
  const measurable = input.requirements.filter((r) => !r.unmeasured)
  const unmeasuredCount = input.requirements.length - measurable.length
  if (measurable.length === 0) {
    // Every check errored: this is an infrastructure failure, not a scored
    // run. A 0-rate verdict here would be a fabricated measurement.
    throw new Error(
      `completionVerdict: task '${input.taskId}' has no measurable requirements — all ${input.requirements.length} correctness checks failed (${input.requirements[0]?.unmeasuredReason ?? 'unknown reason'})`,
    )
  }
  const satisfiedCount = measurable.filter((r) => r.satisfied).length
  const completionRate = satisfiedCount / measurable.length
  // A run with unmeasured rows can still report a rate over what WAS
  // measured, but must not claim full completion.
  const fullyComplete = unmeasuredCount === 0 && satisfiedCount === measurable.length
  return {
    taskId: input.taskId,
    requirements: input.requirements,
    completionRate,
    fullyComplete,
    unmeasuredCount,
    valid: fullyComplete,
    score: completionRate,
  }
}

/**
 * Decides whether a produced item's content actually fulfils a requirement.
 * Injected so the structural verifier stays pure and unit-testable; the
 * production implementation is `createLlmCorrectnessChecker`.
 */
export type CorrectnessChecker = (
  requirement: CompletionRequirement,
  content: string,
) => Promise<{ correct: boolean; reason: string }>

const STOPWORDS = new Set([
  'the',
  'a',
  'an',
  'of',
  'for',
  'and',
  'or',
  'to',
  'in',
  'on',
  'with',
  'by',
])

// Deliverable-FORM vocabulary — words that name the SHAPE of an output, not its
// domain content. A correct "swap-comparison view persisted as a ui/** artifact"
// is an OpenUI JSON whose body says nothing about "artifact" / "persisted" /
// "view"; the discriminative tokens are the domain nouns (swap, comparison).
// Stripped from the REQUIREMENT side of structural recall so a deliverable is
// matched on what it IS about, not on the boilerplate describing its form. The
// correctness checker strips the same class via TITLE_STOPWORDS. Anti-game holds:
// the distinctive domain tokens remain, so an off-topic item still fails.
const REQUIREMENT_FORM_STOPWORDS = new Set([
  'generated',
  'generate',
  'view',
  'render',
  'rendered',
  'persisted',
  'persist',
  'artifact',
  'file',
  'document',
  'note',
  'proposal',
  'deliverable',
  'output',
  'created',
  'create',
  'produce',
  'produced',
  'flag',
])

const MATCH_THRESHOLD = 0.5
const MIN_CONTENT_CHARS = 50

function tokens(s: string, extraStop?: Set<string>): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length > 1 && !STOPWORDS.has(t) && !extraStop?.has(t)),
  )
}

/**
 * Recall of the requirement's tokens within a candidate's identifying text.
 * Recall, not Jaccard — a candidate's path/id legitimately carries extra
 * tokens the requirement does not name. The requirement side drops
 * deliverable-FORM vocabulary so recall keys on the distinctive domain tokens.
 */
function tokenRecall(requirementText: string, candidateText: string): number {
  const req = tokens(requirementText, REQUIREMENT_FORM_STOPWORDS)
  if (req.size === 0) return 0
  const cand = tokens(candidateText)
  let hit = 0
  for (const t of req) if (cand.has(t)) hit++
  return hit / req.size
}

interface Candidate {
  reqIndex: number
  /** Unique key for a produced item — each item satisfies at most one requirement. */
  itemKey: string
  score: number
  evidence: string
  /** Content to correctness-check, or null when the matched item has none. */
  content: string | null
}

function artifactCandidates(
  req: CompletionRequirement,
  reqIndex: number,
  artifacts: Artifact[],
): Candidate[] {
  const reqText = `${req.title} ${req.category ?? ''}`
  const out: Candidate[] = []
  artifacts.forEach((a, i) => {
    if ((a.content ?? '').trim().length < MIN_CONTENT_CHARS) return
    // Match against the artifact CONTENT too, not just its path + kind — a
    // generated view / note whose path is generic still satisfies a requirement
    // when its body covers it (e.g. an OpenUI comparison grounded in the on-file
    // figures). Bounded slice keeps the recall text cheap; MATCH_THRESHOLD holds.
    let score = tokenRecall(
      reqText,
      `${a.path ?? ''} ${a.kind} ${(a.content ?? '').slice(0, 4000)}`,
    )
    if (req.category && a.kind && req.category.toLowerCase() === a.kind.toLowerCase()) {
      score = Math.max(score, 1)
    }
    if (score < MATCH_THRESHOLD) return
    out.push({
      reqIndex,
      itemKey: `artifact:${i}`,
      score,
      evidence: `artifact '${a.path ?? a.kind}' matched (token recall ${score.toFixed(2)})`,
      content: a.content ?? null,
    })
  })
  return out
}

function proposalCandidates(
  req: CompletionRequirement,
  reqIndex: number,
  proposals: ProducedProposal[],
): Candidate[] {
  const reqText = `${req.title} ${req.category ?? ''}`
  const out: Candidate[] = []
  for (const p of proposals) {
    // Pending or rejected work is not a completed deliverable.
    if (p.status !== 'approved') continue
    // A proposal needs an assessable BODY to be a deliverable. A bare title is
    // not completion: correctness cannot be judged on it, so a title-only match
    // would auto-pass the oracle (structurallyPresent && correct===null →
    // satisfied) with no verifiable content. Tool calls are the only
    // legitimately content-less deliverable (`toolCallCandidates`).
    const body = (p.content ?? '').trim()
    if (body.length < MIN_CONTENT_CHARS) continue
    // Match against the body as well as the (often short) title — a refusal /
    // flag / analysis proposal whose title is a label still satisfies a
    // descriptively-worded requirement when its content covers it. MATCH_THRESHOLD
    // + the requirement's distinctive tokens keep an off-topic proposal out;
    // correctness (a SEMANTIC checker, NOT this lexical pass) then judges
    // polarity/fulfilment, so a negation that merely contains the tokens fails.
    // Structural and correctness must use different evidence or the two-stage
    // check collapses to one lexical gate.
    const score = tokenRecall(reqText, `${p.title} ${body}`)
    if (score < MATCH_THRESHOLD) continue
    out.push({
      reqIndex,
      itemKey: `proposal:${p.id}`,
      score,
      evidence: `approved proposal '${p.title}' matched (token recall ${score.toFixed(2)})`,
      content: body,
    })
  }
  return out
}

function toolCallCandidates(
  req: CompletionRequirement,
  reqIndex: number,
  toolCalls: string[],
): Candidate[] {
  const out: Candidate[] = []
  toolCalls.forEach((name, i) => {
    const score = tokenRecall(req.title, name)
    if (score < MATCH_THRESHOLD) return
    out.push({
      reqIndex,
      itemKey: `tool:${i}`,
      score,
      evidence: `tool call '${name}' matched (token recall ${score.toFixed(2)})`,
      content: null,
    })
  })
  return out
}

/**
 * Verify whether a run completed the task. `checkCorrectness` is injected —
 * `createLlmCorrectnessChecker` for production, a deterministic stub in tests.
 *
 * Throws on a gold spec with no requirements: an eval task that requires
 * nothing is a misconfiguration, not a vacuously-complete task.
 */
export async function verifyCompletion(
  gold: TaskGold,
  state: ProducedState,
  checkCorrectness: CorrectnessChecker,
): Promise<CompletionVerdict> {
  if (gold.requirements.length === 0) {
    throw new Error(
      `verifyCompletion: task '${gold.taskId}' has no requirements — malformed gold spec`,
    )
  }

  // Collect every above-threshold (requirement, produced-item) candidate, then
  // assign greedily by descending score: each requirement and each produced
  // item is used at most once. One deliverable fulfils one requirement.
  const candidates: Candidate[] = []
  gold.requirements.forEach((req, i) => {
    const by = req.satisfiedBy ?? 'any'
    if (by === 'artifact' || by === 'any') {
      candidates.push(...artifactCandidates(req, i, state.artifacts))
    }
    if (by === 'proposal' || by === 'any') {
      candidates.push(...proposalCandidates(req, i, state.proposals))
    }
    if (by === 'tool-call' || by === 'any') {
      candidates.push(...toolCallCandidates(req, i, state.toolCalls))
    }
  })
  candidates.sort((a, b) => b.score - a.score)

  const assigned = new Map<number, Candidate>()
  const itemTaken = new Set<string>()
  for (const c of candidates) {
    if (assigned.has(c.reqIndex) || itemTaken.has(c.itemKey)) continue
    assigned.set(c.reqIndex, c)
    itemTaken.add(c.itemKey)
  }

  const requirements: RequirementCheck[] = []
  for (let i = 0; i < gold.requirements.length; i++) {
    const req = gold.requirements[i]!
    const match = assigned.get(i)
    const evidence: string[] = []
    let correct: boolean | null = null
    let unmeasuredReason: string | undefined

    if (match) {
      evidence.push(match.evidence)
      if (match.content !== null) {
        try {
          const r = await checkCorrectness(req, match.content)
          correct = r.correct
          evidence.push(`correctness: ${r.correct ? 'pass' : 'fail'} — ${r.reason}`)
        } catch (err) {
          // The CHECKER failed, not the requirement. Recording this as a
          // zero would fabricate a model failure out of an infrastructure
          // one; the requirement is unmeasured and leaves the denominator.
          unmeasuredReason =
            err instanceof JudgeParseError
              ? `checker response unparseable after retry: ${err.raw.slice(0, 200)}`
              : `checker call failed: ${err instanceof Error ? err.message : String(err)}`
          evidence.push(`correctness: UNMEASURED — ${unmeasuredReason}`)
        }
      } else {
        evidence.push('correctness: not assessed — matched item carries no content')
      }
    } else {
      const by = req.satisfiedBy ?? 'any'
      const kind = by === 'any' ? 'artifact/proposal/tool-call' : by
      evidence.push(`no produced ${kind} matched this requirement`)
    }

    const structurallyPresent = match !== undefined
    const unmeasured = unmeasuredReason !== undefined
    const satisfied = structurallyPresent && !unmeasured && correct !== false
    requirements.push({
      reqId: req.reqId,
      title: req.title,
      structurallyPresent,
      correct,
      satisfied,
      ...(unmeasured ? { unmeasured: true as const, unmeasuredReason } : {}),
      evidence,
    })
  }

  return completionVerdict({ taskId: gold.taskId, requirements })
}

export interface LlmCorrectnessCheckerOpts {
  model?: string
  /** Max chars of artifact content sent to the checker. */
  maxContentChars?: number
  /**
   * Checker LLM calls per requirement before giving up (parse failures and
   * call errors both consume attempts). The failure then surfaces as an
   * `unmeasured` requirement, never a zero.
   */
  maxAttempts?: number
  /**
   * Forensic capture of every checker request/response/error — without it a
   * checker failure is unauditable (the agent-turn raws never contain the
   * checker's own calls). Same sink contract as `LlmClient`.
   */
  rawSink?: RawProviderSink
}

/**
 * Parse the correctness checker's model response. Tolerates a response
 * truncated mid-JSON (max_tokens cap) by auto-closing the prefix — the
 * verdict boolean usually lands in the first few tokens, so a recovered
 * prefix with a boolean `correct` is a real measurement, not a guess.
 * Fails loud (JudgeParseError) when no boolean verdict is recoverable.
 */
export function parseCorrectnessResponse(raw: string): { correct: boolean; reason: string } {
  const readVerdict = (candidate: unknown): { correct: boolean; reason: string } | null => {
    if (candidate === null || typeof candidate !== 'object') return null
    const { correct, reason } = candidate as { correct?: unknown; reason?: unknown }
    if (typeof correct !== 'boolean') return null
    return { correct, reason: typeof reason === 'string' ? reason : '' }
  }

  const match = raw.match(/\{[\s\S]*\}/)
  if (match) {
    try {
      const strict = readVerdict(JSON.parse(match[0]))
      if (strict) return strict
    } catch {
      // fall through to truncation recovery
    }
  }
  // The strict path needs a closing `}`; a cap-hit response has none. Take
  // everything from the first `{` and auto-close it.
  const start = raw.indexOf('{')
  if (start !== -1) {
    const recovered = readVerdict(recoverTruncatedJson(raw.slice(start)))
    if (recovered) return recovered
  }
  throw new JudgeParseError('correctness-checker', raw)
}

/**
 * Production `CorrectnessChecker` — one LLM call per matched artifact,
 * deterministic (temperature 0), structured JSON out. Judges fulfilment
 * only: a plan, a gesture, or a description of what should be done does not
 * fulfil a requirement — the artifact must BE the deliverable.
 */
export function createLlmCorrectnessChecker(
  tc: TCloud,
  opts: LlmCorrectnessCheckerOpts = {},
): CorrectnessChecker {
  const model = opts.model ?? 'claude-sonnet-4-6'
  const maxContentChars = opts.maxContentChars ?? 8000
  const maxAttempts = opts.maxAttempts ?? 2
  const sink = opts.rawSink
  const record = async (event: RawProviderEvent): Promise<void> => {
    // Forensic capture is best-effort; the verdict is the system of record.
    try {
      await sink?.record(event)
    } catch {
      // Intentionally swallowed.
    }
  }
  return async (requirement, content) => {
    const request = {
      model,
      messages: [
        {
          role: 'system' as const,
          content:
            'You verify whether a produced work artifact actually fulfils a stated requirement. Judge fulfilment only — is the deliverable substantively present and on-point — not polish. A plan to do it later, a vague gesture, or a description of what should be done does NOT fulfil a requirement; the artifact must BE the deliverable. Respond with a single JSON object: {"correct": boolean, "reason": string (<= 30 words)}.',
        },
        {
          role: 'user' as const,
          content: `Requirement: ${requirement.title}\n${
            requirement.category ? `Category: ${requirement.category}\n` : ''
          }\nProduced artifact:\n${content.slice(0, maxContentChars)}`,
        },
      ],
      temperature: 0,
      maxTokens: 200,
    }
    let lastErr: unknown
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const started = Date.now()
      await record({
        eventId: randomUUID(),
        provider: 'correctness-checker',
        model,
        endpoint: '/chat',
        baseUrl: '',
        attemptIndex: attempt,
        direction: 'request',
        timestamp: started,
        requestBody: request,
        redactedFields: [],
      })
      try {
        const resp = await tc.chat(request)
        const raw =
          (resp as { choices?: { message?: { content?: string } }[] }).choices?.[0]?.message
            ?.content ?? ''
        await record({
          eventId: randomUUID(),
          provider: 'correctness-checker',
          model,
          endpoint: '/chat',
          baseUrl: '',
          attemptIndex: attempt,
          direction: 'response',
          timestamp: Date.now(),
          durationMs: Date.now() - started,
          responseBody: resp,
          redactedFields: [],
        })
        return parseCorrectnessResponse(raw)
      } catch (err) {
        lastErr = err
        await record({
          eventId: randomUUID(),
          provider: 'correctness-checker',
          model,
          endpoint: '/chat',
          baseUrl: '',
          attemptIndex: attempt,
          direction: 'error',
          timestamp: Date.now(),
          durationMs: Date.now() - started,
          errorMessage: err instanceof Error ? err.message : String(err),
          redactedFields: [],
        })
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr))
  }
}

/** Stopwords for requirement-title tokenization — drops the imperative verbs
 *  ('review', 'update', …) common to deliverable titles so recall keys on the
 *  substantive nouns, not the boilerplate ask. */
const TITLE_STOPWORDS = new Set([
  'the',
  'a',
  'an',
  'and',
  'or',
  'for',
  'to',
  'of',
  'in',
  'on',
  'with',
  'review',
  'update',
  'new',
  'proposed',
])

/**
 * Deterministic `CorrectnessChecker` — the no-LLM counterpart to
 * `createLlmCorrectnessChecker`. A produced item fulfils a requirement when its
 * content is substantive (≥ `minContentLength` chars) AND recalls ≥ `minRecall`
 * of the requirement title's significant tokens. No network.
 *
 * Polarity-blind: token recall credits a negation that contains the
 * requirement's tokens ("I will NOT produce the comparison" recalls every token
 * of "produce the comparison"). The structural match stage is ALSO lexical, so
 * pairing the two collapses to a single gameable gate. Use this only as an
 * opt-in structural pre-filter or for tasks whose requirements have no polarity
 * to invert; for produced-state grading the correctness checker MUST be semantic
 * (`createLlmCorrectnessChecker`). See the anti-game fixtures in the test suite.
 */
export function createTokenRecallChecker(
  opts: { minRecall?: number; minContentLength?: number } = {},
): CorrectnessChecker {
  const minRecall = opts.minRecall ?? 0.5
  const minLen = opts.minContentLength ?? 120
  return async (requirement, content) => {
    const body = content.trim()
    if (body.length < minLen)
      return {
        correct: false,
        reason: `content too thin (${body.length} chars) to be the deliverable`,
      }
    const titleTokens = requirement.title
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length > 2 && !TITLE_STOPWORDS.has(t))
    if (titleTokens.length === 0)
      return {
        correct: true,
        reason: 'requirement title has no significant tokens — structural match accepted',
      }
    const lower = body.toLowerCase()
    const hits = titleTokens.filter((t) => lower.includes(t)).length
    const recall = hits / titleTokens.length
    return recall >= minRecall
      ? {
          correct: true,
          reason: `content recalls ${hits}/${titleTokens.length} requirement tokens`,
        }
      : {
          correct: false,
          reason: `content recalls only ${hits}/${titleTokens.length} requirement tokens`,
        }
  }
}
