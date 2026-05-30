/**
 * @experimental
 *
 * SkillOpt patch primitives (Microsoft, arXiv:2605.23904 — "Executive
 * Strategy for Self-Evolving Agent Skills"). Where GEPA regenerates a surface
 * by reflection, SkillOpt emits BOUNDED, anchored edits to ONE skill document
 * — add / delete / replace — and accepts an edit only if it strictly improves
 * a held-out score. Bounded edits are the "textual learning rate": small,
 * reversible, and cheap to accept/reject, so a good rule introduced earlier is
 * not overwritten by a later sweeping rewrite.
 *
 * This module applies a patch deterministically and reports, per op, what
 * applied and what could not (a missing anchor is a rejected op, never a
 * silently dropped one). Pure, no I/O.
 */

/** A single bounded edit against a skill surface.
 *   - `add`     — insert `text` after the first line containing `after`
 *                 (append to the end when `after` is absent/empty).
 *   - `delete`  — remove the first line containing `anchor`.
 *   - `replace` — replace the first line containing `anchor` with `text`.
 *  `text` may be multi-line; it is spliced in as multiple lines. Anchors match
 *  the FIRST line that contains the substring (deterministic; SkillOpt is
 *  expected to anchor on unique text). */
export type SkillPatchOp =
  | { op: 'add'; after?: string; text: string }
  | { op: 'delete'; anchor: string }
  | { op: 'replace'; anchor: string; text: string }

/** A named, attributable bundle of ops the optimizer proposes as one edit. */
export interface SkillPatch {
  label: string
  rationale: string
  ops: SkillPatchOp[]
}

export interface SkillPatchRejection {
  op: SkillPatchOp
  reason: string
}

export interface ApplySkillPatchResult {
  surface: string
  /** Count of ops that mutated the surface. */
  applied: number
  /** Ops that could not apply (unanchored / empty), with the reason. The
   *  surface still reflects every APPLIED op — partial application is honest,
   *  and the caller decides whether a partial patch is worth scoring. */
  rejected: SkillPatchRejection[]
}

/**
 * Apply a SkillOpt patch to a text surface. Ops apply in array order against
 * the evolving line buffer (an `add after X` followed by a `delete X` sees the
 * inserted lines). A missing anchor rejects only that op; the rest still apply.
 */
export function applySkillPatch(surface: string, patch: SkillPatch): ApplySkillPatchResult {
  let lines = surface.split('\n')
  let applied = 0
  const rejected: SkillPatchRejection[] = []
  const findLine = (anchor: string): number => lines.findIndex((l) => l.includes(anchor))

  for (const op of patch.ops) {
    if (op.op === 'add') {
      if (typeof op.text !== 'string' || op.text.trim() === '') {
        rejected.push({ op, reason: 'empty add text' })
        continue
      }
      const insert = op.text.split('\n')
      if (op.after === undefined || op.after === '') {
        lines = [...lines, ...insert]
        applied++
        continue
      }
      const idx = findLine(op.after)
      if (idx === -1) {
        rejected.push({ op, reason: `add anchor not found: ${truncate(op.after)}` })
        continue
      }
      lines = [...lines.slice(0, idx + 1), ...insert, ...lines.slice(idx + 1)]
      applied++
    } else if (op.op === 'delete') {
      const idx = findLine(op.anchor)
      if (idx === -1) {
        rejected.push({ op, reason: `delete anchor not found: ${truncate(op.anchor)}` })
        continue
      }
      lines = [...lines.slice(0, idx), ...lines.slice(idx + 1)]
      applied++
    } else {
      // replace
      const idx = findLine(op.anchor)
      if (idx === -1) {
        rejected.push({ op, reason: `replace anchor not found: ${truncate(op.anchor)}` })
        continue
      }
      if (typeof op.text !== 'string') {
        rejected.push({ op, reason: 'replace text missing' })
        continue
      }
      lines = [...lines.slice(0, idx), ...op.text.split('\n'), ...lines.slice(idx + 1)]
      applied++
    }
  }

  return { surface: lines.join('\n'), applied, rejected }
}

/** Total ops in a patch — the edit-budget axis (SkillOpt's "textual learning
 *  rate" caps this per epoch). */
export function patchEditCount(patch: SkillPatch): number {
  return patch.ops.length
}

function truncate(s: string, max = 48): string {
  return s.length <= max ? s : `${s.slice(0, max)}…`
}
