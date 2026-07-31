/**
 * Default analyst kinds focused on agent failure + recursive
 * self-improvement.
 *
 * The five kinds chain. Two independent classifiers partition the
 * outcome surface: failure-mode names how a run broke, intent-divergence
 * names where it drifted from what the user asked and how many turns
 * that cost. Knowledge-gap and knowledge-poisoning then explain *why* in
 * two orthogonal ways — missing information versus false information.
 * Improvement proposes the concrete edits. Register all five against the
 * same trace store in this order and run the registry with
 * `chainFindings: true` to pass each completed kind's findings to the
 * kinds that follow it.
 */

export {
  CONTROL_INTEGRITY_ANALYST,
  ControlIntegrityAnalyst,
  emitControlIntegrityFindings,
} from './control-integrity'
export { FAILURE_MODE_KIND_SPEC } from './failure-mode'
export { IMPROVEMENT_KIND_SPEC } from './improvement'
export { INTENT_DIVERGENCE_KIND_SPEC } from './intent-divergence'
export { KNOWLEDGE_GAP_KIND_SPEC } from './knowledge-gap'
export { KNOWLEDGE_POISONING_KIND_SPEC } from './knowledge-poisoning'

import type { TraceAnalystDefinition } from '../kind-factory'
import { FAILURE_MODE_KIND_SPEC } from './failure-mode'
import { IMPROVEMENT_KIND_SPEC } from './improvement'
import { INTENT_DIVERGENCE_KIND_SPEC } from './intent-divergence'
import { KNOWLEDGE_GAP_KIND_SPEC } from './knowledge-gap'
import { KNOWLEDGE_POISONING_KIND_SPEC } from './knowledge-poisoning'

/**
 * The default kind suite. Order is the run order operators should use:
 * failure-mode and intent-divergence first (neither reads upstream
 * findings), gap + poisoning next (both explain the problems those two
 * found), improvement last (chains all four). Intent-divergence sits
 * ahead of improvement deliberately — a proposed edit should be able to
 * act on a priced divergence, and it is the only kind whose findings
 * carry a burned-turn cost to rank against.
 */
export const DEFAULT_TRACE_ANALYST_KINDS: readonly TraceAnalystDefinition[] = [
  FAILURE_MODE_KIND_SPEC,
  INTENT_DIVERGENCE_KIND_SPEC,
  KNOWLEDGE_GAP_KIND_SPEC,
  KNOWLEDGE_POISONING_KIND_SPEC,
  IMPROVEMENT_KIND_SPEC,
] as const
