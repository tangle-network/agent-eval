/**
 * @experimental
 *
 * `skillOptDriver` — a patch-mode `ImprovementDriver` implementing SkillOpt
 * (Microsoft, arXiv:2605.23904). Where `gepaDriver` regenerates the whole
 * surface by reflection, SkillOpt proposes BOUNDED, anchored edits
 * (add/delete/replace) to ONE skill document, so a good rule introduced
 * earlier is not clobbered by a later sweeping rewrite. The edit budget is the
 * paper's "textual learning rate"; a rejected-edit buffer + a slow-update
 * meta-note steer the optimizer away from dead ends.
 *
 * This module is the PROPOSER — the LLM call that turns evidence into
 * structured patches. The accept-only-if-held-out-improves loop, the budget
 * annealing, and the rejected buffer live in the `runSkillOpt` preset, which
 * owns the epoch hill-climb. The driver also conforms to `ImprovementDriver`
 * (`propose` applies its patches to the current surface and returns the
 * candidate surfaces) so it is a drop-in for `runOptimization` and a fair
 * entrant in `compareDrivers`.
 */

import { callLlm, type LlmClientOptions } from '../../llm-client'
import { renderAnalystEvidence } from '../../reflective-mutation'
import { applySkillPatch, type SkillPatch, type SkillPatchOp } from '../skill-patch'
import type { ImprovementDriver, ProposeContext, ProposedCandidate } from '../types'

const SKILLOPT_SYSTEM =
  'You are a SkillOpt optimizer. You improve ONE skill document by proposing ' +
  'BOUNDED, anchored edits — never a full rewrite. Output ONLY a JSON object of ' +
  'shape {"patches":[{"label":string,"rationale":string,"ops":[op,...]}]} where ' +
  'each op is one of: {"op":"add","after":<exact substring of an existing line, ' +
  'or omit to append>,"text":<new line(s)>}, {"op":"delete","anchor":<exact ' +
  'substring of the line to remove>}, {"op":"replace","anchor":<exact substring ' +
  'of the line to replace>,"text":<replacement line(s)>}. Anchors MUST be ' +
  'verbatim substrings of lines that exist in the document. No prose outside JSON.'

/** Evidence the optimizer reflects on: where the current surface is weakest.
 *  Computed by the caller (the preset uses a TRAIN campaign so proposals never
 *  see the held-out split; the generic loop derives it from history). */
export interface SkillOptEvidence {
  /** Lowest-scoring scenarios (drives WHICH behavior to patch). */
  weakScenarios: Array<{ scenarioId: string; composite: number }>
  /** Lowest-scoring judge dimensions (drives WHAT to patch for). */
  weakDimensions: Array<{ dimension: string; score: number }>
}

/** A patch that was tried and not accepted — fed back to the model so it does
 *  not re-propose a dead end (SkillOpt's rejected-edit buffer). */
export interface RejectedEdit {
  label: string
  rationale: string
  reason: string
}

export interface ProposePatchesArgs {
  surface: string
  evidence: SkillOptEvidence
  /** Max ops per patch this round (the annealed textual learning rate). */
  editBudget: number
  rejectedBuffer: RejectedEdit[]
  /** Slow-update meta guidance accumulated across epochs. */
  metaNote?: string
  /** Analyst findings + research report rendered as a prompt block (the
   *  EYES→HANDS wire) so a patch targets a NAMED diagnosed root cause. Built by
   *  the driver from `ctx.findings`/`ctx.report`; the patch-native `runSkillOpt`
   *  path may also supply it. */
  findingsNote?: string
  /** How many candidate patches to propose. */
  count: number
  signal: AbortSignal
}

export interface SkillOptDriverOptions {
  llm: LlmClientOptions
  model: string
  /** What the skill document governs — orients the prompt. */
  target: string
  /** Default ops-per-patch cap when used as a bare `ImprovementDriver`. The
   *  `runSkillOpt` preset overrides this per epoch as it anneals. Default 3. */
  editBudget?: number
  temperature?: number
  maxTokens?: number
  /** Top-K weak scenarios/dimensions surfaced as evidence. Default 3. */
  evidenceK?: number
}

export interface SkillOptDriver extends ImprovementDriver {
  /** Patch-native path used by `runSkillOpt` (the SkillOpt epoch loop owns
   *  acceptance/budget/buffer). Returns structured patches, NOT surfaces. */
  proposePatches(args: ProposePatchesArgs): Promise<SkillPatch[]>
}

export function skillOptDriver(opts: SkillOptDriverOptions): SkillOptDriver {
  const evidenceK = opts.evidenceK ?? 3
  const defaultBudget = opts.editBudget ?? 3

  async function proposePatches(args: ProposePatchesArgs): Promise<SkillPatch[]> {
    const userPrompt = buildPatchPrompt({
      target: opts.target,
      surface: args.surface,
      evidence: args.evidence,
      editBudget: args.editBudget,
      rejectedBuffer: args.rejectedBuffer,
      metaNote: args.metaNote,
      findingsNote: args.findingsNote,
      count: args.count,
    })
    const result = await callLlm(
      {
        model: opts.model,
        messages: [
          { role: 'system', content: SKILLOPT_SYSTEM },
          { role: 'user', content: userPrompt },
        ],
        jsonMode: true,
        temperature: opts.temperature ?? 0.6,
        maxTokens: opts.maxTokens ?? 4000,
      },
      opts.llm,
    )
    return parseSkillPatchResponse(result.content, args.count, args.editBudget)
  }

  return {
    kind: 'skill-opt',
    proposePatches,
    async propose(ctx: ProposeContext): Promise<ProposedCandidate[]> {
      if (typeof ctx.currentSurface !== 'string') {
        throw new Error(
          'skillOptDriver: surface must be a string skill document (got a CodeSurface). SkillOpt patches text.',
        )
      }
      const surface = ctx.currentSurface
      const patches = await proposePatches({
        surface,
        evidence: evidenceFromHistory(ctx, evidenceK),
        editBudget: defaultBudget,
        rejectedBuffer: [],
        findingsNote: renderAnalystEvidence(ctx.findings, ctx.report) ?? undefined,
        count: ctx.populationSize,
        signal: ctx.signal,
      })
      const out: ProposedCandidate[] = []
      const seen = new Set<string>()
      for (const patch of patches) {
        const { surface: candidate, applied } = applySkillPatch(surface, patch)
        if (applied === 0 || candidate === surface || seen.has(candidate)) continue
        seen.add(candidate)
        out.push({ surface: candidate, label: patch.label, rationale: patch.rationale })
        if (out.length >= ctx.populationSize) break
      }
      return out
    },
  }
}

/** Derive evidence from the loop's generation history (generic-driver path):
 *  the prior best candidate's worst scenarios + weakest dimensions. Empty on
 *  generation 0. */
function evidenceFromHistory(ctx: ProposeContext, k: number): SkillOptEvidence {
  const last = ctx.history.at(-1)
  if (!last || last.candidates.length === 0) return { weakScenarios: [], weakDimensions: [] }
  const best = [...last.candidates].sort((a, b) => b.composite - a.composite)[0]
  if (!best) return { weakScenarios: [], weakDimensions: [] }
  const weakScenarios = [...best.scenarios].sort((a, b) => a.composite - b.composite).slice(0, k)
  const weakDimensions = Object.entries(best.dimensions)
    .sort((a, b) => a[1] - b[1])
    .slice(0, k)
    .map(([dimension, score]) => ({ dimension, score }))
  return { weakScenarios, weakDimensions }
}

function buildPatchPrompt(args: {
  target: string
  surface: string
  evidence: SkillOptEvidence
  editBudget: number
  rejectedBuffer: RejectedEdit[]
  metaNote?: string
  findingsNote?: string
  count: number
}): string {
  const lines: string[] = [
    `Skill document governs: ${args.target}.`,
    '',
    'Current skill document:',
    '```',
    args.surface,
    '```',
    '',
    `Propose ${args.count} candidate patch(es). Each patch is a SMALL bundle of`,
    `at most ${args.editBudget} op(s). Anchors must be verbatim substrings of`,
    'existing lines. Prefer adding a specific missing rule or sharpening a vague',
    'one over deleting; never rewrite the whole document.',
  ]
  if (args.evidence.weakScenarios.length > 0) {
    lines.push(
      '',
      'Weakest scenarios (patch to fix these):',
      ...args.evidence.weakScenarios.map((s) => `- ${s.scenarioId} (${s.composite.toFixed(2)})`),
    )
  }
  if (args.evidence.weakDimensions.length > 0) {
    lines.push(
      '',
      'Weakest dimensions (what to improve):',
      ...args.evidence.weakDimensions.map((d) => `- ${d.dimension} (${d.score.toFixed(2)})`),
    )
  }
  if (args.rejectedBuffer.length > 0) {
    lines.push(
      '',
      'Already tried and REJECTED (do not repeat or restate these edits):',
      ...args.rejectedBuffer.map((e) => `- ${e.label}: ${e.rationale} — ${e.reason}`),
    )
  }
  if (args.findingsNote) {
    lines.push('', args.findingsNote)
  }
  if (args.metaNote) {
    lines.push('', `Strategy note from prior epochs: ${args.metaNote}`)
  }
  return lines.join('\n')
}

/** Parse + validate the patch response. Throws `SkillPatchParseError` when the
 *  response is not valid JSON at all (a router/model failure the caller must
 *  see — never a silent no-op epoch). Returns `[]` only for the legitimate
 *  "valid JSON, zero usable patches" case. Malformed ops within a patch are
 *  dropped (not silently mutated); each patch is truncated to the edit budget. */
export class SkillPatchParseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SkillPatchParseError'
  }
}

export function parseSkillPatchResponse(
  raw: string,
  maxPatches: number,
  editBudget: number,
): SkillPatch[] {
  let text = raw.trim()
  if (text.startsWith('```')) text = text.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '')
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) {
    throw new SkillPatchParseError(
      `parseSkillPatchResponse: response was not valid JSON (no object found): ${snippet(raw)}`,
    )
  }
  let parsed: { patches?: unknown }
  try {
    parsed = JSON.parse(text.slice(start, end + 1))
  } catch (err) {
    throw new SkillPatchParseError(
      `parseSkillPatchResponse: response was not valid JSON (${
        err instanceof Error ? err.message : String(err)
      }): ${snippet(raw)}`,
    )
  }
  const rawPatches = Array.isArray(parsed.patches) ? parsed.patches : []
  const out: SkillPatch[] = []
  for (const rp of rawPatches) {
    if (typeof rp !== 'object' || rp === null) continue
    const obj = rp as Record<string, unknown>
    const ops = Array.isArray(obj.ops) ? obj.ops.map(normalizeOp).filter(isOp) : []
    if (ops.length === 0) continue
    out.push({
      label: typeof obj.label === 'string' ? obj.label : 'patch',
      rationale: typeof obj.rationale === 'string' ? obj.rationale : '',
      ops: ops.slice(0, editBudget),
    })
    if (out.length >= maxPatches) break
  }
  return out
}

function normalizeOp(raw: unknown): SkillPatchOp | null {
  if (typeof raw !== 'object' || raw === null) return null
  const o = raw as Record<string, unknown>
  if (o.op === 'add') {
    if (typeof o.text !== 'string') return null
    const op: SkillPatchOp = { op: 'add', text: o.text }
    if (typeof o.after === 'string') op.after = o.after
    return op
  }
  if (o.op === 'delete') {
    if (typeof o.anchor !== 'string') return null
    return { op: 'delete', anchor: o.anchor }
  }
  if (o.op === 'replace') {
    if (typeof o.anchor !== 'string' || typeof o.text !== 'string') return null
    return { op: 'replace', anchor: o.anchor, text: o.text }
  }
  return null
}

function isOp(op: SkillPatchOp | null): op is SkillPatchOp {
  return op !== null
}

function snippet(s: string, max = 120): string {
  const t = s.trim().replace(/\s+/g, ' ')
  return t.length <= max ? t : `${t.slice(0, max)}…`
}
