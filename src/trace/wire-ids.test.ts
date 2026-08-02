/**
 * One run id → ONE wire derivation, valid W3C hex, validator-clean.
 *
 * This package used to ship TWO private `padTraceId` paddings that produced
 * DIFFERENT trace ids for the same run — and one emitted invalid hex embedding
 * the raw run id in the wire id (a leak the contract's own validator flags).
 * Both are retired for the contract's `deriveHexId`
 * (tangle-network/agent-runtime#694).
 *
 * DISCRIMINATING: the two retired derivations are frozen below and asserted
 * NO LONGER PRODUCED by either real export path — if either padding returns,
 * the equality assertions here fail. A suite that stays green when the old
 * path returns is not evidence.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type ContractSpan,
  deriveHexId,
  isW3CSpanId,
  isW3CTraceId,
  validateTraceSpans,
} from '@tangle-network/agent-trace-contract'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { exportRunAsOtlp } from './otel'
import { createOtelExporter } from './otel-export'
import { InMemoryTraceStore } from './store'
import { convertTraceStoresToOtlp } from './store-to-otlp'
import { spanIdForWire, traceIdForWire } from './wire-ids'

/** A real-shaped human run id — the class of id the retired paddings mangled. */
const RUN_ID = 'vb-web-grounded-2026-08-01-cell-a'

// ── The RETIRED derivations, frozen for the discriminating assertions ──────
// (1) store-to-otlp's hex-strip + FNV fold family.
function retiredFnvFoldTraceId(id: string): string {
  const cleaned = id.replace(/[^a-f0-9]/gi, '').toLowerCase()
  if (cleaned.length >= 32) return cleaned.slice(0, 32)
  return retiredFoldTo16Hex(id) + retiredFoldTo16Hex(`${id}::trace`).slice(0, 16)
}
function retiredFoldTo16Hex(s: string): string {
  let h1 = 0x811c9dc5
  for (const ch of s) {
    h1 ^= ch.charCodeAt(0)
    h1 = Math.imul(h1, 0x01000193) >>> 0
  }
  const part = h1.toString(16).padStart(8, '0')
  return (part + part).slice(0, 16)
}
// (2) otel-export's strip-dashes + zero-pad family — emitted INVALID hex that
// embedded the raw run id in the wire id.
function retiredStripPadTraceId(id: string): string {
  const cleaned = id.replace(/-/g, '')
  return cleaned.slice(0, 32).padEnd(32, '0')
}

describe('wire-ids — the one legal derivation', () => {
  it('derives valid, non-equal-to-retired W3C ids from a human run id', () => {
    const traceId = traceIdForWire(RUN_ID)
    expect(traceId).toBe(deriveHexId(RUN_ID, 16))
    expect(isW3CTraceId(traceId)).toBe(true)

    const spanId = spanIdForWire(`run-${RUN_ID}`)
    expect(spanId).toBe(deriveHexId(`run-${RUN_ID}`, 8))
    expect(isW3CSpanId(spanId)).toBe(true)
  })

  it('passes an already-valid W3C id through unchanged (inbound traceparent survives)', () => {
    const inbound = deriveHexId('some-remote-root', 16)
    expect(traceIdForWire(inbound)).toBe(inbound)
    const inboundSpan = deriveHexId('some-remote-span', 8)
    expect(spanIdForWire(inboundSpan)).toBe(inboundSpan)
  })

  it('the retired strip+pad derivation is REJECTED by the contract validator', () => {
    const leaked = retiredStripPadTraceId(RUN_ID)
    // The retired output literally embeds the run id in the wire id…
    expect(leaked).toBe('vbwebgrounded20260801cella000000')
    // …and is not a W3C id at all.
    expect(isW3CTraceId(leaked)).toBe(false)

    const span: ContractSpan = {
      trace_id: leaked,
      span_id: retiredStripPadTraceId(RUN_ID).slice(0, 16),
      parent_span_id: null,
      name: 'run',
      start_time: new Date(0).toISOString(),
      end_time: new Date(0).toISOString(),
      status: { code: 'STATUS_CODE_OK' },
      attributes: {},
    }
    const validation = validateTraceSpans([span])
    expect(validation.findings.some((f) => f.code === 'non-hex-id')).toBe(true)
  })
})

describe('one run id → ONE derivation across ALL real export paths', () => {
  let root: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'wire-ids-'))
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
    vi.unstubAllGlobals()
  })

  it('store-to-otlp, otel-export, and exportRunAsOtlp emit the SAME valid trace id; no retired output appears', async () => {
    // Path A — convertTraceStoresToOtlp (the retired FNV-fold site).
    const cellDir = join(root, 'cell-a')
    mkdirSync(cellDir, { recursive: true })
    writeFileSync(
      join(cellDir, 'runs.ndjson'),
      `${JSON.stringify({
        runId: RUN_ID,
        scenarioId: 'scn',
        variantId: 'variant-a',
        status: 'completed',
        startedAt: 1_700_000_000_000,
        endedAt: 1_700_000_001_000,
      })}\n`,
    )
    writeFileSync(
      join(cellDir, 'spans.ndjson'),
      `${JSON.stringify({
        spanId: 'span-1',
        runId: RUN_ID,
        kind: 'llm',
        name: 'chat.completion',
        startedAt: 1_700_000_000_100,
        endedAt: 1_700_000_000_500,
        status: 'ok',
      })}\n`,
    )
    const outPath = join(root, 'traces.otlp.jsonl')
    convertTraceStoresToOtlp(root, outPath)
    const flatLines = readFileSync(outPath, 'utf8')
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as { trace_id: string; span_id: string })
    expect(flatLines.length).toBeGreaterThan(0)
    const storeTraceIds = new Set(flatLines.map((l) => l.trace_id))
    expect(storeTraceIds.size).toBe(1)
    const [storeTraceId] = storeTraceIds

    // Path B — createOtelExporter (the retired strip+pad site).
    const bodies: Array<Record<string, unknown>> = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>)
        return new Response('', { status: 200 })
      }),
    )
    const exporter = createOtelExporter({ endpoint: 'http://localhost:4318', batchSize: 1 })!
    exporter.exportSpan({
      traceId: RUN_ID,
      spanId: `run-${RUN_ID}`,
      name: 'run',
      kind: 'agent',
      startedAt: 1_700_000_000_000,
      endedAt: 1_700_000_001_000,
      status: 'ok',
    })
    await exporter.shutdown()
    const exported = bodies.flatMap(
      (b) =>
        (
          b as {
            resourceSpans: Array<{
              scopeSpans: Array<{ spans: Array<{ traceId: string; spanId: string }> }>
            }>
          }
        ).resourceSpans[0]!.scopeSpans[0]!.spans,
    )
    expect(exported).toHaveLength(1)
    const otelTraceId = exported[0]!.traceId

    // Path C — exportRunAsOtlp (the retired runToTraceId strip+pad site).
    const memStore = new InMemoryTraceStore()
    await memStore.appendRun({
      runId: RUN_ID,
      scenarioId: 'scn',
      startedAt: 1_700_000_000_000,
      status: 'completed',
    })
    await memStore.appendSpan({
      spanId: 'span-1',
      runId: RUN_ID,
      kind: 'llm',
      name: 'chat.completion',
      startedAt: 1_700_000_000_100,
      endedAt: 1_700_000_000_500,
      status: 'ok',
      model: 'm',
      messages: [],
    } as never)
    const runExport = await exportRunAsOtlp(memStore, RUN_ID)
    const runExportTraceIds = new Set(
      runExport.resourceSpans[0]!.scopeSpans[0]!.spans.map((s) => s.traceId),
    )
    expect(runExportTraceIds.size).toBe(1)
    const [runExportTraceId] = runExportTraceIds

    // ONE derivation: all three paths agree, all are the contract derivation.
    const canonical = deriveHexId(RUN_ID, 16)
    expect(storeTraceId).toBe(canonical)
    expect(otelTraceId).toBe(canonical)
    expect(runExportTraceId).toBe(canonical)
    expect(isW3CTraceId(canonical)).toBe(true)

    // The retired derivations are no longer produced by any path.
    for (const emitted of [storeTraceId, otelTraceId, runExportTraceId]) {
      expect(emitted).not.toBe(retiredFnvFoldTraceId(RUN_ID))
      expect(emitted).not.toBe(retiredStripPadTraceId(RUN_ID))
    }

    // Validator-clean: the emitted ids survive the contract validator with no
    // id findings (store path: run anchor + llm span, real parentage).
    const spans: ContractSpan[] = flatLines.map((l, i) => ({
      trace_id: l.trace_id,
      span_id: l.span_id,
      parent_span_id:
        (flatLines[i] as unknown as { parent_span_id?: string }).parent_span_id || null,
      name: `span-${i}`,
      start_time: new Date(1_700_000_000_000 + i).toISOString(),
      end_time: new Date(1_700_000_001_000 + i).toISOString(),
      status: { code: 'STATUS_CODE_OK' },
      attributes: {},
    }))
    const validation = validateTraceSpans(spans)
    const idFindings = validation.findings.filter(
      (f) => f.code === 'non-hex-id' || f.code === 'missing-trace-id' || f.code === 'invalid-span',
    )
    expect(idFindings).toEqual([])
  })
})
