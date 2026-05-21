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

import type { TCloud } from '@tangle-network/tcloud'
import type { Artifact } from './artifact-validator'

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
   * not structurally present, or when the matched item carries no content
   * to assess.
   */
  correct: boolean | null
  /** structurallyPresent && correct !== false. */
  satisfied: boolean
  /** Human-readable evidence for the verdict. */
  evidence: string[]
}

export interface CompletionVerdict {
  taskId: string
  requirements: RequirementCheck[]
  /** satisfied / total requirements. */
  completionRate: number
  /** Every requirement satisfied. */
  fullyComplete: boolean
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

const MATCH_THRESHOLD = 0.5
const MIN_CONTENT_CHARS = 50

function tokens(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length > 1 && !STOPWORDS.has(t)),
  )
}

/**
 * Recall of the requirement's tokens within a candidate's identifying text.
 * Recall, not Jaccard — a candidate's path/id legitimately carries extra
 * tokens the requirement does not name.
 */
function tokenRecall(requirementText: string, candidateText: string): number {
  const req = tokens(requirementText)
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
    let score = tokenRecall(reqText, `${a.path ?? ''} ${a.kind}`)
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
    const score = tokenRecall(reqText, p.title)
    if (score < MATCH_THRESHOLD) continue
    const body = p.content ?? ''
    out.push({
      reqIndex,
      itemKey: `proposal:${p.id}`,
      score,
      evidence: `approved proposal '${p.title}' matched (token recall ${score.toFixed(2)})`,
      content: body.trim().length >= MIN_CONTENT_CHARS ? body : null,
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

    if (match) {
      evidence.push(match.evidence)
      if (match.content !== null) {
        const r = await checkCorrectness(req, match.content)
        correct = r.correct
        evidence.push(`correctness: ${r.correct ? 'pass' : 'fail'} — ${r.reason}`)
      } else {
        evidence.push('correctness: not assessed — matched item carries no content')
      }
    } else {
      const by = req.satisfiedBy ?? 'any'
      const kind = by === 'any' ? 'artifact/proposal/tool-call' : by
      evidence.push(`no produced ${kind} matched this requirement`)
    }

    const structurallyPresent = match !== undefined
    const satisfied = structurallyPresent && correct !== false
    requirements.push({
      reqId: req.reqId,
      title: req.title,
      structurallyPresent,
      correct,
      satisfied,
      evidence,
    })
  }

  const satisfiedCount = requirements.filter((r) => r.satisfied).length
  return {
    taskId: gold.taskId,
    requirements,
    completionRate: satisfiedCount / requirements.length,
    fullyComplete: satisfiedCount === requirements.length,
  }
}

export interface LlmCorrectnessCheckerOpts {
  model?: string
  /** Max chars of artifact content sent to the checker. */
  maxContentChars?: number
}

/** Parse the correctness checker's model response. Fails loud on a bad shape. */
export function parseCorrectnessResponse(raw: string): { correct: boolean; reason: string } {
  const match = raw.match(/\{[\s\S]*\}/)
  if (!match) {
    throw new Error(`correctness checker: no JSON object in model response: ${raw.slice(0, 200)}`)
  }
  const parsed = JSON.parse(match[0]) as { correct?: unknown; reason?: unknown }
  if (typeof parsed.correct !== 'boolean') {
    throw new Error(`correctness checker: 'correct' is not a boolean in: ${match[0].slice(0, 200)}`)
  }
  return { correct: parsed.correct, reason: typeof parsed.reason === 'string' ? parsed.reason : '' }
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
  return async (requirement, content) => {
    const resp = await tc.chat({
      model,
      messages: [
        {
          role: 'system',
          content:
            'You verify whether a produced work artifact actually fulfils a stated requirement. Judge fulfilment only — is the deliverable substantively present and on-point — not polish. A plan to do it later, a vague gesture, or a description of what should be done does NOT fulfil a requirement; the artifact must BE the deliverable. Respond with a single JSON object: {"correct": boolean, "reason": string (<= 30 words)}.',
        },
        {
          role: 'user',
          content: `Requirement: ${requirement.title}\n${
            requirement.category ? `Category: ${requirement.category}\n` : ''
          }\nProduced artifact:\n${content.slice(0, maxContentChars)}`,
        },
      ],
      temperature: 0,
      maxTokens: 200,
    })
    const raw =
      (resp as { choices?: { message?: { content?: string } }[] }).choices?.[0]?.message?.content ??
      ''
    return parseCorrectnessResponse(raw)
  }
}
