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
// The same detector can serve both roles ONLY behind this firewall: a finding
// admitted as a steer input must report what the agent DID (cite a trace span /
// event / produced artifact), never a bare verdict ("this output is fake / will
// fail"). The instant a steer carries a predicted verdict instead of an observed
// action, it is a back-channel for J and the loop Goodharts realness exactly as
// it would Goodhart pass-rate. This module makes the rule enforceable.

import type { AnalystFinding, EvidenceRef } from './types'

/** Evidence grounded in the agent's OWN execution: OTLP trace elements
 *  (`span`/`event`) or the artifact it produced (`artifact`). These are
 *  observations of behavior — legitimately available to a steer.
 *
 *  Excluded: `metric` (a named scalar — could carry a judge score) and
 *  `finding` (cross-analyst chaining — not a direct observation). A finding
 *  grounded ONLY in those is not a behavioral observation and must not steer. */
const OBSERVABLE_KINDS: ReadonlySet<EvidenceRef['kind']> = new Set<EvidenceRef['kind']>([
  'span',
  'event',
  'artifact',
])

/** True iff the finding is grounded in observable behavior — it cites at least
 *  one span / event / artifact. Such a finding is steer-admissible: it tells the
 *  next attempt what the agent DID. A finding with no observable evidence is a
 *  bare claim/verdict and is NOT steer-admissible (it could be J leaking in). */
export function isTraceObservable(finding: AnalystFinding): boolean {
  return finding.evidence_refs.some((ref) => OBSERVABLE_KINDS.has(ref.kind))
}

/** Fail-loud guard for any path that admits analyst findings as STEERING input
 *  (the `f(trace)` role). Throws — naming the offenders — if any finding is not
 *  trace-observable, rather than let a verdict-shaped finding leak into steering.
 *  Returns the findings unchanged for chaining.
 *
 *  Call this at the chokepoint where a detector that ALSO scores/gates (a
 *  realness/authenticity judge) has its findings turned into a steer — that is
 *  the exact place the firewall must hold. Do NOT use it to filter the general
 *  HALO/trace-analyst apply path, whose findings are intentionally
 *  evidence-agnostic; this is specifically the judge-and-steer dual-role case. */
export function assertTraceObservable(
  findings: ReadonlyArray<AnalystFinding>,
  context = 'steer',
): ReadonlyArray<AnalystFinding> {
  const leaks = findings.filter((f) => !isTraceObservable(f))
  if (leaks.length > 0) {
    throw new Error(
      `${context}: findings admitted as steering input must be trace-observable ` +
        `(cite a span/event/artifact — what the agent DID). These cite no observable ` +
        `behavior and would leak a verdict into steering: [${leaks
          .map((f) => f.finding_id)
          .join(', ')}]. Steering consumes observations, never the judge's held-out verdict.`,
    )
  }
  return findings
}
