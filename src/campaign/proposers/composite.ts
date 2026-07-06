/**
 * `compositeProposer` — run N proposers TOGETHER on the same surface.
 *
 * The question this answers ("why can't we combine GEPA + skillOpt + ACE + a
 * trace-analyst?"): nothing in the loop cares where candidates come from — the
 * generation's population is one pool and the Pareto frontier / promotion logic
 * evaluates every candidate identically. The only missing piece was a proposer
 * that fans the population budget out across members and merges their proposals.
 * This is that piece.
 *
 * Semantics:
 *   - Budget: each member is asked for a share of `populationSize`
 *     (near-equal split by default, or explicit `weights`). Members may return
 *     fewer; the pool is topped up round-robin from members that can offer more
 *     is NOT attempted — proposers are not obligated to be re-entrant.
 *   - Provenance: every candidate's `label` is prefixed with its member's kind
 *     (`gepa:...`, `skill-opt:...`) so generation records and the promotion
 *     provenance attribute each winner to the proposer family that made it —
 *     the cheap, honest version of proposer-level credit assignment.
 *   - Dedup: identical surfaces from different members collapse to the first.
 *   - Failure isolation: one member throwing does not sink the generation; its
 *     error is logged into the surviving candidates' generation via a warning
 *     and the pool proceeds (a generation with zero candidates from all members
 *     failing still throws — that is a real failure).
 *   - Early stop: the composite stops only when EVERY member with a `decide`
 *     votes stop (a member without `decide` never votes stop).
 *
 * This is deliberately NOT joint multi-surface mutation: every member mutates
 * the SAME `MutableSurface`. Joint profile-patch surfaces (prompt+skills+tools
 * in one candidate) require the composite-surface contract and measured
 * component attribution — see the experiment-optimal research brief.
 */

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
  const weights = opts.weights ?? members.map(() => 1)
  if (weights.length !== members.length || weights.some((w) => !(w > 0))) {
    throw new Error('compositeProposer: weights must match proposers length and be positive')
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
          const proposals = await member.propose({ ...ctx, populationSize: share })
          for (const proposal of proposals) {
            const isCandidate =
              typeof proposal === 'object' && proposal !== null && 'surface' in proposal
            const surface = isCandidate
              ? (proposal as ProposedCandidate).surface
              : (proposal as MutableSurface)
            const label = isCandidate ? (proposal as ProposedCandidate).label : 'candidate'
            const rationale = isCandidate ? (proposal as ProposedCandidate).rationale : ''
            const key = typeof surface === 'string' ? surface : JSON.stringify(surface)
            if (seen.has(key)) continue
            seen.add(key)
            pool.push({ surface, label: `${member.kind}:${label}`, rationale })
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
        .map((m) => (m.decide as NonNullable<SurfaceProposer<TFindings>['decide']>)(args))
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
