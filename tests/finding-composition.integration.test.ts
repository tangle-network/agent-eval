import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  type AnalystFinding,
  defineDomainTaxonomy,
  type FindingConditions,
  type FindingTreatment,
  makeFinding,
  openFindingsLedger,
  parseAnalystFinding,
  promote,
  rollupFindings,
} from '../src/analyst/index'
import { type ArmAssignment, comparePairedArms, type PairedArmRow } from '../src/experiment/index'
import { canonicalString, hashCanonical } from '../src/ledger-core/index'

let directory: string
let memory: FindingTreatment
let oversight: FindingTreatment
const at = '2026-10-23T00:00:00Z'
const scopeWindow = { from: at, to: at }
function ok<T>(
  result: { succeeded: true; value: T } | { succeeded: false; error: { message: string } },
): T {
  if (!result.succeeded) throw new Error(result.error.message)
  return result.value
}
function conditions(id: string, runtime = 'integration-runtime-v1'): FindingConditions {
  return {
    id: `conditions:${id}`,
    population: [id],
    observed_at: at,
    evidence_refs: [{ kind: 'artifact', uri: `artifact://${id}/conditions.json` }],
    runtime_version: runtime,
    lab_commit: 'integration-lab-commit',
    model_version: null,
    provider_version: null,
    seat: 'integration-seat',
    host_load: 0,
    started_at: null,
    operator_steers: [],
  }
}
function finding(
  run: string,
  treatment?: FindingTreatment[],
  value = 1,
  snapshots?: FindingConditions[],
): AnalystFinding {
  return makeFinding({
    analyst_id: 'composition-integration',
    area: 'integration-source-measure',
    claim: 'Recorded measure for a declared bundle',
    claim_id: 'declared-bundle-measure',
    subject: run,
    severity: 'info',
    confidence: 1,
    produced_at: at,
    evidence_refs: [{ kind: 'artifact', uri: `artifact://${run}/measurement.json` }],
    layer: 'run',
    scope: { population: [run], n: 1, window: scopeWindow },
    method: { kind: 'computed', name: 'recorded-metric-reader', version: '1' },
    measure: { name: 'score', value, unit: 'points' },
    evidence_units: [{ id: run, layer: 'run', derived_from: null }],
    ...(treatment === undefined ? {} : { treatment }),
    ...(snapshots === undefined ? {} : { conditions: snapshots }),
  })
}
function taxonomy() {
  return ok(
    defineDomainTaxonomy({
      version: 'integration-v1',
      nodes: [
        { id: 'domain', label: 'domain', layer: 'domain', parent: null },
        { id: 'problem', label: 'problem', layer: 'problem', parent: 'domain' },
        ...['a', 'b'].flatMap((play) => [
          { id: play, label: play, layer: 'play' as const, parent: 'problem' },
          ...['1', '2'].map((rep) => ({
            id: `${play}/${rep}`,
            label: rep,
            layer: 'run' as const,
            parent: play,
          })),
        ]),
      ],
    }),
  )
}
async function jsonFile<T>(name: string, value: T): Promise<T> {
  const path = join(directory, name)
  await writeFile(path, canonicalString(value))
  return JSON.parse(await readFile(path, 'utf8'))
}
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'finding-composition-'))
  const bundle = {
    name: 'integration-memory',
    instructions: 'Read the shared source before deciding.',
  }
  const path = join(directory, 'memory-treatment.json')
  await writeFile(path, canonicalString(bundle))
  memory = {
    id: 'integration-memory',
    definition_digest: hashCanonical(JSON.parse(await readFile(path, 'utf8'))),
    definition_refs: [{ kind: 'artifact', uri: 'artifact://integration/memory-treatment.json' }],
    layers: ['Tools', 'Memory', 'Roles'],
  }
  oversight = {
    id: 'integration-oversight',
    definition_digest: hashCanonical({ instructions: 'Escalate uncertain observations.' }),
    definition_refs: [{ kind: 'artifact', uri: 'artifact://integration/oversight-treatment.json' }],
    layers: ['Oversight', 'Process'],
  }
})
afterAll(async () => {
  if (directory) await rm(directory, { recursive: true, force: true })
})

describe('finding composition and arm populations through public SDK and file boundaries', () => {
  it('round-trips many-to-many composition and preserves unknown versus observed empty fields', async () => {
    const ledger = openFindingsLedger({ path: join(directory, 'composition.jsonl') })
    const first = finding('a/1', [memory, oversight], 0, [conditions('a/1'), conditions('a/2')])
    const reversed = finding(
      'a/1',
      [
        { ...oversight, layers: [...oversight.layers].reverse() },
        { ...memory, layers: [...memory.layers].reverse() },
      ],
      0,
      [conditions('a/2'), conditions('a/1')],
    )
    expect(first.finding_id).toBe(reversed.finding_id)
    const noComposition = finding('a/1')
    const knownEmpty = finding('a/1', [], 0, [])
    expect(noComposition.finding_id).not.toBe(knownEmpty.finding_id)
    const unknown = conditions('unknown')
    unknown.operator_steers = null
    unknown.host_load = null
    const unknownFinding = finding('unknown', [memory], 0, [unknown])
    expect(
      ok(await ledger.append('source', [first, noComposition, knownEmpty, unknownFinding]))
        .appended,
    ).toBe(4)
    expect(ok(await ledger.append('source', [reversed])).replayed).toBe(1)
    const reopened = ok(await openFindingsLedger({ path: ledger.path }).read()).findings
    const restored = reopened.find((f) => f.finding_id === first.finding_id)!
    expect(restored.treatment).toHaveLength(2)
    expect(restored.conditions).toHaveLength(2)
    expect(restored.measure!.value).toBe(0)
    expect(restored.conditions![0]!.operator_steers).toEqual([])
    expect(
      reopened.find((f) => f.finding_id === unknownFinding.finding_id)!.conditions![0],
    ).toMatchObject({ operator_steers: null, host_load: null })
    expect(
      Object.hasOwn(reopened.find((f) => f.finding_id === noComposition.finding_id)!, 'conditions'),
    ).toBe(false)
    expect(reopened.find((f) => f.finding_id === knownEmpty.finding_id)!.conditions).toEqual([])
  }, 30_000)

  it('refuses malformed composition without appending or laundering legacy schema versions', async () => {
    const ledger = openFindingsLedger({ path: join(directory, 'invalid-composition.jsonl') })
    const valid = finding('a/1', [memory], 0, [conditions('a/1')])
    const bad: unknown[] = [
      { ...valid, treatment: [{ ...memory, layers: ['event'] }] },
      { ...valid, treatment: [memory, memory] },
      { ...valid, conditions: [{ ...conditions('a/1'), host_load: -1 }] },
      { ...valid, schema_version: '1.0.0' },
      { ...valid, conditions: [{ ...conditions('a/1'), runtime_version: undefined }] },
    ]
    for (const candidate of bad) {
      expect(parseAnalystFinding(candidate).succeeded).toBe(false)
      expect((await ledger.append('source', [candidate as AnalystFinding])).succeeded).toBe(false)
    }
    expect(ok(await ledger.read()).findings).toHaveLength(0)
  }, 30_000)

  it('includes missing and nonformed assigned seeds while preserving measured zeroes', async () => {
    const assignments: ArmAssignment[] = ['off', 'on'].flatMap((arm) =>
      [1, 2, 3].map((seed) => ({ arm, pairKey: `seed-${seed}`, treatment: [memory, oversight] })),
    )
    const observations: PairedArmRow[] = [
      {
        arm: 'off',
        pairKey: 'seed-1',
        pass: true,
        metrics: { score: 1 },
        formation: { formed: true },
      },
      {
        arm: 'off',
        pairKey: 'seed-2',
        pass: false,
        metrics: { score: 0 },
        formation: { formed: false, reason: 'team-not-formed' },
      },
      {
        arm: 'on',
        pairKey: 'seed-1',
        pass: true,
        metrics: { score: 2 },
        formation: { formed: true },
      },
      {
        arm: 'on',
        pairKey: 'seed-2',
        pass: null,
        metrics: { score: null },
        formation: { formed: null, reason: 'capture-unavailable' },
      },
    ]
    const roster = await jsonFile('assignments.json', assignments)
    const rows = await jsonFile('observations.json', observations)
    const report = comparePairedArms(rows, {
      baselineArm: 'off',
      treatmentArm: 'on',
      assignments: roster,
      metricNames: ['score'],
      bootstrap: { seed: 7, resamples: 50 },
    })
    expect(report.nPairs).toBe(3)
    const off = report.armPopulations!.find((r) => r.arm === 'off')!
    expect(off).toMatchObject({
      missingObservations: 1,
      formation: { formed: 1, notFormed: 1, unknown: 1 },
      asAssigned: {
        n: 3,
        passed: 1,
        failed: 1,
        missingOutcomes: 1,
        passRate: null,
        metrics: { score: { n: 2, missing: 1, sum: 1, mean: 0.5 } },
      },
      asFormed: { n: 1, passed: 1, failed: 0, missingOutcomes: 0, passRate: 1 },
    })
    expect(off.assignments.every((r) => r.treatment!.length === 2)).toBe(true)
    const on = report.armPopulations!.find((r) => r.arm === 'on')!
    expect(on.formation).toEqual({ formed: 1, notFormed: 0, unknown: 2 })
    expect(on.asAssigned.missingOutcomes).toBe(2)
    expect(
      comparePairedArms(rows, { baselineArm: 'off', treatmentArm: 'on' }).armPopulations,
    ).toBeUndefined()
  }, 30_000)

  it('reports an entirely absent observed arm from its roster and rejects unassigned results', async () => {
    const roster = await jsonFile('missing-arm-roster.json', [
      { arm: 'off', pairKey: 'seed' },
      { arm: 'on', pairKey: 'seed' },
    ])
    const rows = await jsonFile('missing-arm-results.json', [
      { arm: 'off', pairKey: 'seed', pass: false, metrics: { score: 0 } },
    ])
    const report = comparePairedArms(rows, {
      baselineArm: 'off',
      treatmentArm: 'on',
      assignments: roster,
      metricNames: ['score'],
    })
    expect(report.correctness).toBeNull()
    expect(report.metricDeltas[0]).toMatchObject({ n: 0, nMissing: 1, meanDelta: null })
    expect(report.armPopulations![1]).toMatchObject({
      missingObservations: 1,
      asAssigned: {
        n: 1,
        missingOutcomes: 1,
        passRate: null,
        metrics: { score: { n: 0, missing: 1, sum: null, mean: null } },
      },
      asFormed: { n: 0 },
    })
    const invalid = await jsonFile('unassigned.json', [
      { arm: 'off', pairKey: 'unassigned', pass: true },
    ])
    expect(() =>
      comparePairedArms(invalid, { baselineArm: 'off', treatmentArm: 'on', assignments: roster }),
    ).toThrow(/outside/)
    expect(() =>
      comparePairedArms(rows, {
        baselineArm: 'off',
        treatmentArm: 'on',
        assignments: [...roster, roster[0]!],
      }),
    ).toThrow(/Duplicate/)
  }, 30_000)

  it('keeps treatment compositions separate through ledger, rollup and promoted re-pooling', async () => {
    const ledger = openFindingsLedger({ path: join(directory, 'rollup-composition.jsonl') })
    const sources = ['a/1', 'a/2', 'b/1', 'b/2'].flatMap((run) => [
      finding(run, [memory], 1, [conditions(run)]),
      finding(run, [oversight], 9, [conditions(run)]),
    ])
    expect(new Set(sources.map((f) => f.finding_id)).size).toBe(8)
    ok(await ledger.append('source', sources))
    const loaded = ok(await openFindingsLedger({ path: ledger.path }).read()).findings
    const result = rollupFindings(loaded, taxonomy(), { resamples: 50, seed: 7, produced_at: at })
    const promoted = result.findings.filter((f) => f.layer === 'problem')
    expect(promoted).toHaveLength(2)
    expect(promoted.map((f) => f.measure!.value).sort((a, b) => a - b)).toEqual([1, 9])
    expect(new Set(result.findings.map((f) => f.finding_id)).size).toBe(result.findings.length)
    expect(promoted.every((f) => f.conditions!.length === 4 && f.treatment!.length === 1)).toBe(
      true,
    )
    expect(promoted.every((f) => f.scope!.n === 4 && f.metadata!.denominators !== undefined)).toBe(
      true,
    )
    ok(await ledger.append('rollup', result.findings))
    expect(ok(await ledger.read()).findings).toHaveLength(8 + result.findings.length)
    const reordered = rollupFindings([...loaded].reverse(), taxonomy(), {
      resamples: 50,
      seed: 7,
      produced_at: at,
    })
    expect(reordered.findings.map((f) => f.finding_id).sort()).toEqual(
      result.findings.map((f) => f.finding_id).sort(),
    )
  }, 30_000)

  it('partitions changed fixed conditions without splitting ordinary load and time covariates', async () => {
    const left = conditions('a/1')
    const right = conditions('a/2')
    right.host_load = 10
    right.observed_at = '2026-10-23T00:00:01Z'
    const sources = await jsonFile('conditions-covariates.json', [
      finding('a/1', [memory], 1, [left]),
      finding('a/2', [memory], 3, [right]),
    ])
    const combined = rollupFindings(sources, taxonomy(), {
      resamples: 50,
      seed: 7,
      produced_at: at,
    })
    expect(combined.findings.filter((f) => f.layer === 'play')).toHaveLength(1)
    expect(
      combined.findings[0]!.conditions!.map((c) => c.host_load).sort((a, b) => a! - b!),
    ).toEqual([0, 10])
    const changed = conditions('a/2', 'integration-runtime-v2')
    const divided = rollupFindings(
      await jsonFile('conditions-runtime-change.json', [
        sources[0]!,
        finding('a/2', [memory], 3, [changed]),
      ]),
      taxonomy(),
      { resamples: 50, seed: 7, produced_at: at },
    )
    expect(divided.findings.filter((f) => f.layer === 'play')).toHaveLength(2)
    expect(
      divided.findings.every((f) => f.scope!.n === 1 && f.measure!.interval === undefined),
    ).toBe(true)
    const conflicting = finding('a/2', [memory], 3, [
      { ...left, runtime_version: 'conflicting-runtime' },
    ])
    const conflictInputs = await jsonFile('conflicting-snapshot.json', [sources[0]!, conflicting])
    expect(() => rollupFindings(conflictInputs, taxonomy())).toThrow(
      /Conflicting immutable condition/,
    )
    expect(() => promote(conflictInputs, taxonomy())).toThrow(/Conflicting immutable condition/)
  }, 30_000)
})
