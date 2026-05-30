/**
 * `selfImprove()` provenance emission — the LAND-tier one-shot must surface +
 * persist the full auditable chain, not just the lift number it returns.
 *
 * These tests drive the real `selfImprove` with a deterministic custom driver
 * (no network) that returns a `ProposedCandidate` carrying a rationale, an
 * objective marker-keyed judge, and a real-on-disk runDir. They assert:
 *
 *   1. the winner carries its rationale to `result.winner.rationale`,
 *   2. the explicit baseline→winner diff is on `result.diff`,
 *   3. the structured provenance record + OTel spans are written durably
 *      (default fs storage for a real runDir — durable BY DEFAULT),
 *   4. backend provenance is captured from caller-supplied worker records,
 *   5. the +lift RECOMPUTES from the persisted record (not the live return).
 *
 * Regressions guarded: gepa/driver dropping rationale; selfImprove defaulting
 * to mem:// + inMemory so nothing persists; the +lift only living in memory.
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  type LoopProvenanceRecord,
  provenanceRecordPath,
  provenanceSpansPath,
  surfaceContentHash,
} from '../src/campaign/provenance'
import type {
  DispatchContext,
  ImprovementDriver,
  JudgeConfig,
  MutableSurface,
  Scenario,
} from '../src/campaign/types'
import { selfImprove } from '../src/contract/self-improve'
import type { RunRecord } from '../src/run-record'

interface S extends Scenario {
  id: string
  kind: string
}

interface A {
  text: string
}

const MARKER = 'STRICT_SCHEMA'
const RATIONALE = 'baseline under-specifies output; pin the strict schema'
const LABEL = 'pin-schema'

// Eight scenarios so the 0.25 holdout split yields a non-empty train + holdout.
const SCENARIOS: S[] = Array.from({ length: 8 }, (_, i) => ({ id: `s${i}`, kind: 'chat' }))

const judge: JudgeConfig<A, S> = {
  name: 'has-marker',
  dimensions: [{ key: 'marker', description: 'surface enforces the marker' }],
  score: ({ artifact }) => {
    const ok = artifact.text.includes(MARKER) ? 1 : 0
    return { dimensions: { marker: ok }, composite: ok, notes: '' }
  },
}

// Deterministic driver: one candidate that introduces the marker, carrying the
// rationale. This is what gepaDriver does with a real router; here it is fixed.
const driver: ImprovementDriver = {
  kind: 'fake:marker',
  async propose({ currentSurface, populationSize }) {
    const base = typeof currentSurface === 'string' ? currentSurface : ''
    return new Array(populationSize).fill(0).map(() => ({
      surface: `${base} ${MARKER}`.trim(),
      label: LABEL,
      rationale: RATIONALE,
    }))
  },
}

// The agent echoes the surface; the judge keys on the marker.
const agent = async (surface: MutableSurface, _s: S, _ctx: DispatchContext): Promise<A> => ({
  text: String(surface),
})

let runDir: string
beforeEach(() => {
  runDir = mkdtempSync(join(tmpdir(), 'self-improve-prov-'))
})
afterEach(() => {
  rmSync(runDir, { recursive: true, force: true })
})

describe('selfImprove provenance emission (durable by default)', () => {
  it('threads rationale + diff + durable provenance, and the +lift recomputes from disk', async () => {
    const workerRecords: RunRecord[] = [
      {
        runId: 'w1',
        experimentId: 'self-improve',
        candidateId: 'winner',
        seed: 1,
        model: 'anthropic/claude-haiku-4-5@2025-01-01',
        promptHash: 'sha256:a',
        configHash: 'sha256:b',
        commitSha: 'local',
        wallMs: 5,
        costUsd: 0.002,
        tokenUsage: { input: 200, output: 80 },
        outcome: { holdoutScore: 1, raw: {} },
        splitTag: 'holdout',
      },
    ]

    let captured: LoopProvenanceRecord | undefined
    const result = await selfImprove<S, A>({
      agent,
      scenarios: SCENARIOS,
      judge,
      baselineSurface: 'BASE',
      driver,
      budget: { generations: 1, populationSize: 1 },
      gate: undefined,
      runDir, // real path ⇒ durable by default (fs storage)
      collectWorkerRecords: () => workerRecords,
      onProvenance: (r) => {
        captured = r
      },
    })

    // (1) winner rationale + label threaded all the way to the result.
    expect(result.winner.rationale).toBe(RATIONALE)
    expect(result.winner.label).toBe(LABEL)

    // (2) explicit baseline→winner diff present + meaningful.
    expect(result.diff).toContain(MARKER)
    expect(result.diff).toContain('--- baseline')

    // Lift: winner scores 1 on holdout, baseline 0.
    expect(result.lift).toBeCloseTo(1, 9)
    expect(result.gateDecision).toBe('ship')

    // (3) the provenance record is on the result AND fired through onProvenance.
    expect(captured).toBeDefined()
    expect(result.provenance.schema).toBe('tangle.loop-provenance.v1')
    expect(result.provenance.winnerRationale).toBe(RATIONALE)

    // real content hashes distinguish baseline from winner + verify bytes.
    expect(result.provenance.baselineContentHash).toBe(surfaceContentHash('BASE'))
    expect(result.provenance.winnerContentHash).toBe(surfaceContentHash(result.winner.surface))
    expect(result.provenance.baselineContentHash).not.toBe(result.provenance.winnerContentHash)

    // (4) backend provenance from the caller-supplied real records.
    expect(result.provenance.backend.verdict).toBe('real')
    expect(result.provenance.backend.workerCallCount).toBe(1)
    expect(result.provenance.backend.models).toEqual(['anthropic/claude-haiku-4-5@2025-01-01'])

    // (3, durable) — the record + spans are on DISK (fs storage by default).
    const recordOnDisk = JSON.parse(
      readFileSync(provenanceRecordPath(runDir), 'utf8'),
    ) as LoopProvenanceRecord
    const spansOnDisk = readFileSync(provenanceSpansPath(runDir), 'utf8').trim().split('\n')
    expect(spansOnDisk.length).toBeGreaterThanOrEqual(3) // root + gen + candidate (+ gate)
    expect(recordOnDisk.candidates.some((c) => c.rationale === RATIONALE)).toBe(true)

    // (5) the +lift RECOMPUTES from the persisted record, never the live return.
    const recomputed = recordOnDisk.winnerHoldoutComposite - recordOnDisk.baselineHoldoutComposite
    expect(recomputed).toBeCloseTo(result.lift, 9)
    expect(recordOnDisk.heldOutLift).toBeCloseTo(result.lift, 9)
  })

  it('a mem:// runDir keeps everything in-memory (explicit opt-out path)', async () => {
    const result = await selfImprove<S, A>({
      agent,
      scenarios: SCENARIOS,
      judge,
      baselineSurface: 'BASE',
      driver,
      budget: { generations: 1, populationSize: 1 },
      // no runDir ⇒ mem://… ⇒ in-memory storage ⇒ nothing on disk
    })
    // The provenance record is still produced in-memory + on the result.
    expect(result.provenance.schema).toBe('tangle.loop-provenance.v1')
    expect(result.provenance.runDir.startsWith('mem://')).toBe(true)
  })
})
