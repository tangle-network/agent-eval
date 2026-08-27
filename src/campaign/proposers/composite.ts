/**
 * Split one generation's candidate budget across independent proposers.
 * Candidate labels retain the originating proposer kind, duplicate surfaces
 * collapse to the first result, and one failed proposer does not discard the
 * other results. The composite stops only when every member with `decide`
 * votes to stop.
 */

import { surfaceContentHash } from '../surface-identity'
import type {
  GenerationRecord,
  MutableSurface,
  ProposeContext,
  ProposedCandidate,
  SurfaceProposer,
} from '../types'

export interface CompositeProposerOptions<TFindings = unknown> {
  /** Member proposers, in priority order (earlier members get the larger share
   *  of an uneven split). At least one required. */
  proposers: Array<SurfaceProposer<TFindings>>
  /** Optional population-share weights, same length as `proposers`. Need not
   *  sum to anything; shares are proportional. Default: equal. */
  weights?: number[]
}

/** Fan the population budget across N proposers and merge their candidates into
 *  one generation pool, with per-member provenance labels. */
export function compositeProposer<TFindings = unknown>(
  opts: CompositeProposerOptions<TFindings>,
): SurfaceProposer<TFindings> {
  const members = opts.proposers
  if (members.length === 0)
    throw new Error('compositeProposer: at least one member proposer required')
  const memberKinds = new Set<string>()
  for (const member of members) {
    if (!member.kind || member.kind.trim() !== member.kind) {
      throw new Error('compositeProposer: member kinds must be trimmed and non-empty')
    }
    if (member.kind.includes(':')) {
      throw new Error(`compositeProposer: member kind '${member.kind}' must not contain ':'`)
    }
    if (memberKinds.has(member.kind)) {
      throw new Error(`compositeProposer: duplicate member kind '${member.kind}'`)
    }
    memberKinds.add(member.kind)
  }
  const weights = opts.weights ?? members.map(() => 1)
  if (
    weights.length !== members.length ||
    weights.some((weight) => !Number.isFinite(weight) || weight <= 0)
  ) {
    throw new Error(
      'compositeProposer: weights must match proposers length and be finite and positive',
    )
  }

  return {
    kind: `composite(${members.map((m) => m.kind).join('+')})`,

    async propose(
      ctx: ProposeContext<TFindings>,
    ): Promise<Array<MutableSurface | ProposedCandidate>> {
      const totalWeight = weights.reduce((a, b) => a + b, 0)
      // Largest-remainder split so shares sum exactly to populationSize and
      // every member with positive weight gets at least the floor of its share.
      const exact = weights.map((w) => (ctx.populationSize * w) / totalWeight)
      const shares = exact.map((e) => Math.floor(e))
      let remaining = ctx.populationSize - shares.reduce((a, b) => a + b, 0)
      const byRemainder = exact
        .map((e, i) => ({ i, rem: e - Math.floor(e) }))
        .sort((a, b) => b.rem - a.rem)
      for (const { i } of byRemainder) {
        if (remaining <= 0) break
        shares[i] = (shares[i] ?? 0) + 1
        remaining -= 1
      }

      const pool: ProposedCandidate[] = []
      const seen = new Set<string>()
      const errors: string[] = []
      for (let i = 0; i < members.length; i += 1) {
        const member = members[i]
        const share = shares[i] ?? 0
        if (!member || share === 0 || ctx.signal.aborted) continue
        try {
          const proposals = await member.propose({
            ...ctx,
            history: historyForMember(ctx.history, member.kind),
            populationSize: share,
          })
          for (const proposal of proposals) {
            const isCandidate =
              typeof proposal === 'object' && proposal !== null && 'surface' in proposal
            const surface = isCandidate
              ? (proposal as ProposedCandidate).surface
              : (proposal as MutableSurface)
            const label = isCandidate ? (proposal as ProposedCandidate).label : 'candidate'
            const rationale = isCandidate ? (proposal as ProposedCandidate).rationale : ''
            const candidateRecord = isCandidate
              ? (proposal as ProposedCandidate).candidateRecord
              : undefined
            const key = surfaceContentHash(surface)
            if (seen.has(key)) continue
            seen.add(key)
            pool.push({
              surface,
              label: `${member.kind}:${label}`,
              rationale,
              ...(candidateRecord ? { candidateRecord } : {}),
            })
          }
        } catch (err) {
          errors.push(`${member.kind}: ${err instanceof Error ? err.message : String(err)}`)
        }
      }
      if (pool.length === 0) {
        throw new Error(
          `compositeProposer: every member failed or proposed nothing${errors.length ? ` — ${errors.join('; ')}` : ''}`,
        )
      }
      if (errors.length > 0) {
        console.warn(
          `[compositeProposer] ${errors.length} member(s) failed this generation: ${errors.join('; ')}`,
        )
      }
      return pool.slice(0, ctx.populationSize)
    },

    decide(args: { history: GenerationRecord[] }): { stop: boolean; reason?: string } {
      const votes = members
        .filter((m) => typeof m.decide === 'function')
        .map((m) =>
          (m.decide as NonNullable<SurfaceProposer<TFindings>['decide']>)({
            history: historyForMember(args.history, m.kind),
          }),
        )
      if (votes.length === 0) return { stop: false }
      const allStop = votes.every((v) => v.stop)
      return allStop
        ? {
            stop: true,
            reason:
              votes
                .map((v) => v.reason)
                .filter(Boolean)
                .join('; ') || 'all members converged',
          }
        : { stop: false }
    },
  }
}

function historyForMember(history: GenerationRecord[], memberKind: string): GenerationRecord[] {
  const prefix = `${memberKind}:`
  return history.map((generation) => ({
    ...generation,
    candidates: generation.candidates.map((candidate) =>
      candidate.label?.startsWith(prefix)
        ? { ...candidate, label: candidate.label.slice(prefix.length) }
        : candidate,
    ),
  }))
}
