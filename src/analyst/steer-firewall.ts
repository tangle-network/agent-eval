// The realness-oracle firewall (docs/learning-flywheel.md, "The steer is f(trace)").
//
// A realness/authenticity signal has TWO legitimate roles that must stay
// separated by a firewall:
//   (a) anchor judge J — write-only: scores the chosen output, gates promotion,
//       NEVER seen by the worker/optimizer mid-run (else the loop games it).
//   (b) steer f(trace) — an analyst observes the agent's OWN behavior in the
//       trace ("imported a stub", "used a non-crypto PRNG where encryption was
//       required") and steers the next attempt. Legitimate, because it is derived
//       from OBSERVABLE BEHAVIOR, not from J's held-out verdict.
//
// The correct discriminator is PROVENANCE, not evidence presence. A judge verdict
// lifted into a finding (createJudgeAdapter → liftJudgeScore) is a verdict even
// when it cites an artifact; an evidence-less trace-analyst bullet is an
// observation even though it cites nothing. So the firewall keys on
// `AnalystFinding.derived_from_judge` (set at the judge lift site), NOT on whether
// evidence_refs is populated. The instant a verdict steers the next attempt it is
// a back-channel for J and the loop Goodharts realness exactly as it would
// Goodhart pass-rate.

import type { AnalystFinding, EvidenceRef } from './types'

/** Evidence grounded in the agent's OWN execution: OTLP trace elements
 *  (`span`/`event`) or the artifact it produced (`artifact`). */
const OBSERVABLE_KINDS: ReadonlySet<EvidenceRef['kind']> = new Set<EvidenceRef['kind']>([
  'span',
  'event',
  'artifact',
])

/** DESCRIPTIVE predicate: does the finding cite at least one observable
 *  (span/event/artifact) evidence ref. Useful for ranking evidence quality or
 *  rendering — it is NOT the steer gate. Evidence presence is the WRONG
 *  discriminator for steering: a legitimate trace-analyst observation may cite
 *  nothing (it would be wrongly rejected), and a judge verdict may cite an
 *  artifact (it would be wrongly admitted). Use `assertNoJudgeVerdict` to gate
 *  steering; use this only where "is this grounded in observable evidence" is the
 *  literal question. */
export function isTraceObservable(finding: AnalystFinding): boolean {
  return finding.evidence_refs.some((ref) => OBSERVABLE_KINDS.has(ref.kind))
}

/** True iff the finding is a JUDGE VERDICT (an acceptance score lifted into a
 *  finding), identified by provenance set at the lift site — independent of
 *  whatever evidence it cites. */
export function isJudgeVerdict(finding: AnalystFinding): boolean {
  return finding.derived_from_judge === true
}

/**
 * THE steer firewall. Fail-loud guard for any path that admits analyst findings
 * as STEERING input (the `f(trace)` role): rejects — naming the offenders — any
 * finding whose provenance is a judge verdict, rather than let `J` leak into the
 * loop. Returns the findings unchanged for chaining.
 *
 * Call this at the chokepoint where a detector that ALSO scores/gates has its
 * findings turned into a steer (the judge-and-steer dual-role case). It keys on
 * provenance, so it correctly admits evidence-less trace-analyst observations and
 * correctly rejects an artifact-citing judge verdict — the cases an evidence
 * check gets backwards.
 *
 * It is necessary, not sufficient: it stops PROVENANCE-tagged verdicts. A judge
 * whose output is laundered through a hand-built finding with no provenance flag
 * is out of its reach — provenance must be honestly set at every judge→finding
 * lift (today: createJudgeAdapter). That is why the integrity rule lives at the
 * lift site, and why ProposeContext.judgeScores?: never is the complementary
 * compile-time tripwire on the obvious direct channel.
 */
export function assertNoJudgeVerdict(
  findings: ReadonlyArray<AnalystFinding>,
  context = 'steer',
): ReadonlyArray<AnalystFinding> {
  const leaks = findings.filter(isJudgeVerdict)
  if (leaks.length > 0) {
    throw new Error(
      `${context}: a judge verdict cannot be admitted as steering input — that is the ` +
        `held-out judge leaking into the loop. Offending judge-derived findings: [${leaks
          .map((f) => f.finding_id)
          .join(', ')}]. Steering consumes observations of behavior, never acceptance verdicts.`,
    )
  }
  return findings
}
