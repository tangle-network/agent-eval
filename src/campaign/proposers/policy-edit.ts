/**
 * `policyEditProposer` turns typed analyst policy edits into measured candidate
 * surfaces. It is deliberately deterministic: analysts propose the edit, this
 * proposer only checks admission and applies it. The campaign/holdout loop still
 * decides whether the candidate actually wins.
 */

import {
  admitPolicyEdit,
  applyPolicyEditToSurface,
  type FindingToPolicyEditOptions,
  isPolicyEdit,
  type PolicyEdit,
  type PolicyEditAdmission,
  type PolicyEditAdmissionOptions,
  policyEditsFromFindings,
} from '../../analyst/policy-edit'
import type { AnalystFinding } from '../../analyst/types'
import type { MutableSurface, ProposeContext, ProposedCandidate, SurfaceProposer } from '../types'

export interface PolicyEditProposerOptions {
  /** Static edits, useful when an analyst has already emitted typed edits. When
   * omitted, the proposer reads `ctx.findings`. */
  edits?: ReadonlyArray<PolicyEdit>
  /** Adapter for legacy `AnalystFinding` rows. Findings without typed expected
   * gain are ignored rather than inflated with fake numbers. */
  findingOptions?: FindingToPolicyEditOptions
  /** Admission threshold. Defaults live in `admitPolicyEdit`. */
  admission?: PolicyEditAdmissionOptions
  /** Candidate cap. Default: `ctx.populationSize`. */
  maxCandidates?: number
  /** Optional callback for audit UIs/tests that need rejected edit reasons. */
  onAdmission?: (admission: PolicyEditAdmission) => void
}

export function policyEditProposer(opts: PolicyEditProposerOptions = {}): SurfaceProposer {
  return {
    kind: 'policy-edit',
    async propose(ctx: ProposeContext): Promise<ProposedCandidate[]> {
      const edits = materializePolicyEdits(opts.edits ?? ctx.findings, opts.findingOptions)
      const limit = Math.max(
        0,
        Math.min(opts.maxCandidates ?? ctx.populationSize, ctx.populationSize),
      )
      const out: ProposedCandidate[] = []
      if (limit === 0) return out

      for (const edit of edits) {
        const admission = admitPolicyEdit(edit, opts.admission)
        opts.onAdmission?.(admission)
        if (admission.decision !== 'admit') continue

        const surface = coerceCandidateSurface(applyPolicyEditToSurface(ctx.currentSurface, edit))
        if (sameSurface(ctx.currentSurface, surface)) continue

        out.push({
          surface,
          label: `policy-edit:${edit.axis}`,
          rationale:
            `${edit.editId} expected ${edit.expectedGain.direction} ` +
            `${edit.expectedGain.metric} by ${edit.expectedGain.amount}; ` +
            `source findings [${edit.source.findingIds.join(', ')}]`,
        })
        if (out.length >= limit) break
      }

      return out
    },
  }
}

function materializePolicyEdits(
  inputs: ReadonlyArray<unknown>,
  findingOptions: FindingToPolicyEditOptions | undefined,
): PolicyEdit[] {
  const edits: PolicyEdit[] = []
  const findings: AnalystFinding[] = []

  for (const input of inputs) {
    if (isPolicyEdit(input)) {
      edits.push(input)
    } else if (isAnalystFindingLike(input)) {
      findings.push(input)
    }
  }

  if (findings.length > 0) edits.push(...policyEditsFromFindings(findings, findingOptions))
  return edits
}

function isAnalystFindingLike(input: unknown): input is AnalystFinding {
  if (!input || typeof input !== 'object') return false
  const obj = input as Record<string, unknown>
  return (
    typeof obj.finding_id === 'string' &&
    typeof obj.analyst_id === 'string' &&
    typeof obj.claim === 'string' &&
    Array.isArray(obj.evidence_refs)
  )
}

function coerceCandidateSurface(surface: unknown): MutableSurface {
  if (typeof surface === 'string') return surface
  if (surface && typeof surface === 'object') {
    const obj = surface as Record<string, unknown>
    if (obj.kind === 'code' && typeof obj.worktreeRef === 'string') {
      return surface as MutableSurface
    }
    return JSON.stringify(surface, null, 2)
  }
  throw new Error('policyEditProposer: policy edit produced an unsupported surface')
}

function sameSurface(a: MutableSurface, b: MutableSurface): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}
