/**
 * The ONE mapping from agent-eval's human-readable ids (run ids, span labels)
 * to W3C/OTLP wire ids. Every exporter in this package MUST route through
 * these two functions — two exporters with private paddings once produced
 * DIFFERENT trace ids for the same run, and one emitted invalid hex embedding
 * the raw run id in the wire id (tangle-network/agent-runtime#694).
 *
 * Semantics:
 *  - an id that is ALREADY a valid W3C id passes through unchanged, so a
 *    trace id received from an inbound `traceparent` survives the round-trip
 *    and cross-process correlation is preserved;
 *  - anything else is derived with the contract's `deriveHexId`, the only
 *    legal derivation — deterministic, so every process that derives from the
 *    same human id mints the SAME wire id.
 */

import { deriveHexId, isW3CSpanId, isW3CTraceId } from '@tangle-network/agent-trace-contract'

/** 32-hex W3C trace id for any id string. */
export function traceIdForWire(id: string): string {
  return isW3CTraceId(id) ? id : deriveHexId(id, 16)
}

/** 16-hex W3C span id for any id string. */
export function spanIdForWire(id: string): string {
  return isW3CSpanId(id) ? id : deriveHexId(id, 8)
}
