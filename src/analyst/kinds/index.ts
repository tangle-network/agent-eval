/**
 * Default analyst kinds focused on agent failure + recursive
 * self-improvement.
 *
 * The four kinds chain: failure-mode classifies; knowledge-gap and
 * knowledge-poisoning explain *why* in two orthogonal ways; improvement
 * proposes concrete edits. Register all four against the same trace
 * store in this order and run the registry with `chainFindings: true`
 * to pass each completed kind's findings to the kinds that follow it.
 */

export { FAILURE_MODE_KIND_SPEC } from './failure-mode'
export { IMPROVEMENT_KIND_SPEC } from './improvement'
export { KNOWLEDGE_GAP_KIND_SPEC } from './knowledge-gap'
export { KNOWLEDGE_POISONING_KIND_SPEC } from './knowledge-poisoning'

import type { TraceAnalystKindSpec } from '../kind-factory'
import { FAILURE_MODE_KIND_SPEC } from './failure-mode'
import { IMPROVEMENT_KIND_SPEC } from './improvement'
import { KNOWLEDGE_GAP_KIND_SPEC } from './knowledge-gap'
import { KNOWLEDGE_POISONING_KIND_SPEC } from './knowledge-poisoning'

/**
 * The default kind suite. Order is the run order operators should
 * use: failure-mode first (no upstream deps), gap + poisoning next
 * (both depend on failures), improvement last (chains all three).
 */
export const DEFAULT_TRACE_ANALYST_KINDS: readonly TraceAnalystKindSpec[] = [
  FAILURE_MODE_KIND_SPEC,
  KNOWLEDGE_GAP_KIND_SPEC,
  KNOWLEDGE_POISONING_KIND_SPEC,
  IMPROVEMENT_KIND_SPEC,
] as const
