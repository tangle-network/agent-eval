/**
 * Layered findings through the public `./analyst` export: schema 1.1.0 beside
 * 1.0.0, the domain taxonomy, promotion, the findings ledger, and the
 * team-shape, failure-modes and rollup analysts.
 *
 * The team-shape records under `tests/fixtures/team-shape` are four recorded
 * Magnetar runs reduced to structure by `extract.py` (ids, kinds, times,
 * statuses, settlement receivers, message endpoints; no prompts, briefs,
 * paths or message text). `labels.json` holds the lead's gold labels.
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  type AnalystFinding,
  attachToTaxonomy,
  classifyTeamShape,
  createFailureModesAnalyst,
  type DomainTaxonomy,
  defineDomainTaxonomy,
  diffFindingsOverTime,
  FAILURE_MODES_MIN_KAPPA,
  type FindingEvidenceUnit,
  makeFinding,
  NOT_OBSERVABLE,
  openFindingsLedger,
  parseAnalystFinding,
  promote,
  queryFindings,
  readFindingScope,
  rollupFindings,
  TEAM_SHAPE_VERSION,
  teamShapeAnalyst,
} from '../src/analyst/index'

const FIXTURES = join(process.cwd(), 'tests', 'fixtures', 'team-shape')
const context = { runId: 'finding-layers', correlationId: 'finding-layers' }
const WINDOW = { from: '2026-10-12T00:00:00.000Z', to: '2026-10-20T00:00:00.000Z' }
const PATH = ['build-systems', 'cryptographic', 'zk-proving', 'binary-fields']

function ok<T>(
  outcome: { succeeded: true; value: T } | { succeeded: false; error: { message: string } },
): T {
  if (!outcome.succeeded) throw new Error(outcome.error.message)
  return outcome.value
}

/** build-systems > cryptographic > zk-proving > {binary-fields, prime-fields}; two problems
 *  under binary-fields, one under prime-fields; each problem holds two plays of two runs. */
function labTaxonomy(): DomainTaxonomy {
  let taxonomy = ok(
    defineDomainTaxonomy({
      version: '2026-10-20',
      nodes: [
        { id: 'build-systems', label: 'Building systems', layer: 'domain', parent: null },
        {
          id: 'cryptographic',
          label: 'Cryptographic systems',
          layer: 'domain',
          parent: 'build-systems',
        },
        {
          id: 'zk-proving',
          label: 'Zero-knowledge proving',
          layer: 'domain',
          parent: 'cryptographic',
        },
        { id: 'binary-fields', label: 'Binary fields', layer: 'domain', parent: 'zk-proving' },
        { id: 'prime-fields', label: 'Prime fields', layer: 'domain', parent: 'zk-proving' },
      ],
    }),
  )
  const problems: Array<[string, string[]]> = [
    ['magnetar', PATH],
    ['binius-port', PATH],
    ['plonky-port', [...PATH.slice(0, 3), 'prime-fields']],
  ]
  for (const [problem, path] of problems) {
    taxonomy = ok(
      attachToTaxonomy(taxonomy, {
        id: problem,
        label: problem,
        layer: 'problem',
        path,
        tags: ['rust'],
      }),
    )
    for (const play of ['a', 'b']) {
      const playId = `${problem}/${play}`
      taxonomy = ok(
        attachToTaxonomy(taxonomy, { id: playId, label: playId, layer: 'play', parent: problem }),
      )
      for (const run of [1, 2]) {
        taxonomy = ok(
          attachToTaxonomy(taxonomy, {
            id: `${playId}/r${run}`,
            label: `run ${run}`,
            layer: 'run',
            parent: playId,
          }),
        )
      }
    }
  }
  return taxonomy
}

/** A problem-layer claim measured on the problem's four runs, each an independent start. */
function problemFinding(
  problem: string,
  interval: [number, number],
  units?: FindingEvidenceUnit[],
): AnalystFinding {
  const population = ['a/r1', 'a/r2', 'b/r1', 'b/r2'].map((run) => `${problem}/${run}`)
  const evidence =
    units ?? population.map((id) => ({ id, layer: 'run' as const, derived_from: null }))
  return makeFinding({
    analyst_id: 'team-shape-comparison',
    area: 'team-shape',
    severity: 'info',
    confidence: 0.8,
    subject: problem,
    claim: 'A flat team of one-task workers beats a deep hierarchy of component leads',
    claim_id: 'flat-beats-hive',
    evidence_refs: [{ kind: 'metric', uri: `metric://${problem}/pass-rate-delta` }],
    layer: 'problem',
    scope: {
      population: evidence.map((unit) => unit.id),
      n: evidence.length,
      window: WINDOW,
      domain_path: problem === 'plonky-port' ? [...PATH.slice(0, 3), 'prime-fields'] : PATH,
    },
    method: { kind: 'measured', name: 'paired-pass-rate', version: '1' },
    measure: {
      name: 'pass-rate delta (flat − hive)',
      value: (interval[0] + interval[1]) / 2,
      unit: 'share',
      interval,
      level: 0.95,
    },
    evidence_units: evidence,
    produced_at: WINDOW.to,
  })
}

describe('team-shape classifies the recorded Magnetar runs as the lead labelled them', () => {
  const labels = JSON.parse(readFileSync(join(FIXTURES, 'labels.json'), 'utf8')) as {
    runs: Record<string, { class: string; depth: number; agents: number }>
  }
  const input = (run: string) => ({
    runRef: run,
    spawnJournal: readFileSync(join(FIXTURES, `${run}.spawn.jsonl`), 'utf8'),
    coordinationLog: readFileSync(join(FIXTURES, `${run}.coord.jsonl`), 'utf8'),
  })

  it.each(Object.entries(labels.runs))('%s', (run, label) => {
    const shape = ok(classifyTeamShape(input(run)))
    expect({ class: shape.class, depth: shape.depth, agents: shape.features.agents }).toEqual({
      class: label.class,
      depth: label.depth,
      agents: label.agents,
    })
    expect(shape.invalidRows).toEqual({ spawn: 0, coordination: 0 })
    expect(shape.features.unplacedAgents).toBe(0)
    // Steers are sent from owner digests, which no record joins to an agent.
    expect(shape.features.lateralCShare).toBe(NOT_OBSERVABLE)
  })

  it('names the depth of a hive and the reasons behind each check', () => {
    const shape = ok(classifyTeamShape(input('magnetar-rust-20261017c')))
    expect(shape.label).toBe('hive depth 2')
    expect(shape.features).toMatchObject({ fanOut: { root: 5 }, delegatingShare: 3 / 5 })
    expect(shape.checks.partition).toMatchObject({ result: 'no' })
    expect(shape.checks.hive.reason).toBe('depth 2; 3 of 5 root children delegate')
  })

  it('reports a flat star as fleet-unobservable and qualifies root integration', async () => {
    const run = 'magnetar-rust-20261020b'
    const unknown = ok(classifyTeamShape(input(run)))
    expect(unknown.label).toBe('flat-star (integration unknown)')
    expect(unknown.checks.fleet.result).toBe(NOT_OBSERVABLE)
    expect(unknown.features.settlementsByReceiver).toEqual({ R: 19 })
    expect(unknown.features.nonParentGShare).toBe(NOT_OBSERVABLE)

    const integrations = [
      { commit: 'c1', by: 'R' },
      { commit: 'c2', by: 'R' },
      { commit: 'c3', by: 'R:s4' },
    ]
    const integrated = ok(classifyTeamShape({ ...input(run), integrations }))
    expect(integrated.label).toBe('flat-star (root integrates)')
    expect(integrated.features.rootIntegrationShare).toBe(2 / 3)

    const [finding] = await teamShapeAnalyst().analyze({ ...input(run), integrations }, context)
    expect(finding).toMatchObject({
      schema_version: '1.1.0',
      layer: 'team',
      claim: 'Team shape is flat-star (root integrates)',
      claim_id: 'team-shape:flat-star',
      method: { kind: 'computed', name: 'team-shape', version: TEAM_SHAPE_VERSION },
    })
    expect(TEAM_SHAPE_VERSION).toContain('provisional')
    expect(parseAnalystFinding(finding).succeeded).toBe(true)
    expect(readFindingScope(finding!).labels).toEqual(['anecdote'])
  })
})

describe('promote lifts a claim only on independent agreeing children', () => {
  const taxonomy = labTaxonomy()

  it('keeps a claim seen in one problem at the problem layer', () => {
    const magnetar = problemFinding('magnetar', [0.1, 0.3])
    const result = promote([magnetar], taxonomy)
    expect(result.promoted).toEqual([])
    expect(result.untestedAbove).toEqual([
      {
        finding_id: magnetar.finding_id,
        claim_id: 'flat-beats-hive',
        node: 'magnetar',
        reason: '1 independent agreeing child of 2 required',
      },
    ])
  })

  it('lifts it to the parent domain node when two child problems agree', () => {
    const magnetar = problemFinding('magnetar', [0.1, 0.3])
    const binius = problemFinding('binius-port', [0.2, 0.4])
    const result = promote([magnetar, binius], taxonomy, { produced_at: WINDOW.to })
    expect(result.promoted).toHaveLength(1)
    const lifted = result.promoted[0]!
    expect(lifted).toMatchObject({
      schema_version: '1.1.0',
      layer: 'domain',
      subject: 'binary-fields',
      claim_id: 'flat-beats-hive',
      scope: { n: 8, domain_path: PATH },
      method: { kind: 'computed', name: 'promote' },
      measure: { interval: [0.2, 0.3], level: 0.95 },
    })
    expect(lifted.evidence_refs.map((ref) => ref.uri).sort()).toEqual(
      [`finding://${magnetar.finding_id}`, `finding://${binius.finding_id}`].sort(),
    )
    expect(parseAnalystFinding(lifted).succeeded).toBe(true)
    // binary-fields is the only child of zk-proving carrying the claim, so it stops there.
    expect(result.untestedAbove.map((hold) => hold.node)).toEqual(['binary-fields'])
  })

  it('does not lift when the children disagree', () => {
    const result = promote(
      [problemFinding('magnetar', [0.1, 0.3]), problemFinding('binius-port', [-0.4, -0.1])],
      taxonomy,
    )
    expect(result.promoted).toEqual([])
    expect(new Set(result.untestedAbove.map((hold) => hold.reason))).toEqual(
      new Set(['child intervals do not agree']),
    )
  })

  it('counts two problems that share lineage as one child', () => {
    const magnetar = problemFinding('magnetar', [0.1, 0.3])
    // Every binius-port run built on magnetar's first run.
    const inherited = ['a/r1', 'a/r2', 'b/r1', 'b/r2'].map((run) => ({
      id: `binius-port/${run}`,
      layer: 'run' as const,
      derived_from: 'magnetar/a/r1',
    }))
    const result = promote(
      [magnetar, problemFinding('binius-port', [0.2, 0.4], inherited)],
      taxonomy,
    )
    expect(result.promoted).toEqual([])
    expect(result.untestedAbove[0]?.reason).toBe(
      '2 children agree but share lineage, leaving 1 independent of 2 required',
    )
  })

  it('refuses a claim stored above the layer its population reaches', () => {
    const runs = ['magnetar/a/r1', 'magnetar/a/r2']
    const overreach = makeFinding({
      analyst_id: 'manual',
      area: 'team-shape',
      severity: 'info',
      confidence: 0.5,
      claim: 'Flat teams win everywhere',
      claim_id: 'flat-beats-hive',
      evidence_refs: [],
      layer: 'lab',
      scope: { population: runs, n: 2, window: WINDOW },
      method: { kind: 'judged', name: 'operator-read', version: '1' },
    })
    expect(readFindingScope(overreach).labels).toEqual(['uncalibrated'])
    expect(promote([overreach], taxonomy).unplaced[0]?.reason).toBe(
      "stated at lab but its population sits within play 'magnetar/a'",
    )
  })
})

describe('AnalystFinding 1.0.0 and 1.1.0', () => {
  it('still parses a 1.0.0 finding and reads it as unscoped', () => {
    const legacy = {
      schema_version: '1.0.0',
      finding_id: 'f_0123456789abcdef0123',
      analyst_id: 'failure-mode',
      produced_at: '2026-10-01T12:00:00.000Z',
      severity: 'high',
      area: 'verification',
      claim: 'Worker delivered without running the tests',
      evidence_refs: [{ kind: 'span', uri: 'trace://t1/span/s9', excerpt: 'skipping tests' }],
      confidence: 0.7,
      subject: 'workflow:verify',
    }
    const parsed = parseAnalystFinding(legacy)
    expect(parsed.succeeded).toBe(true)
    const reading = readFindingScope(parsed.succeeded ? parsed.value : (legacy as never))
    expect(reading).toEqual({
      layer: 'unknown',
      n: 'unknown',
      independent_n: 'unknown',
      domain_path: null,
      labels: ['unscoped'],
    })
    const plain = makeFinding({
      analyst_id: 'a',
      area: 'b',
      severity: 'low',
      claim: 'c',
      evidence_refs: [],
      confidence: 1,
    })
    expect(plain.schema_version).toBe('1.0.0')
  })

  it('refuses 1.1.0 fields on a 1.0.0 finding and a population that disagrees with its units', () => {
    const base = problemFinding('magnetar', [0.1, 0.3])
    expect(parseAnalystFinding({ ...base, schema_version: '1.0.0' })).toMatchObject({
      succeeded: false,
      error: { path: 'layer' },
    })
    expect(parseAnalystFinding({ ...base, scope: { ...base.scope!, n: 9 } })).toMatchObject({
      succeeded: false,
      error: { path: 'scope.n' },
    })
    expect(
      parseAnalystFinding({
        ...base,
        layer: 'run',
        evidence_units: base.evidence_units!.map((unit) => ({ ...unit, layer: 'play' as const })),
      }),
    ).toMatchObject({
      succeeded: false,
      error: { message: 'a run finding cannot rest on a play unit' },
    })
  })
})

describe('findings ledger', () => {
  const dir = mkdtempSync(join(tmpdir(), 'findings-ledger-'))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  it('stores findings append-only and answers layer, domain, analyst and time-series queries', async () => {
    const ledger = openFindingsLedger({ path: join(dir, 'findings.jsonl') })
    const magnetar = problemFinding('magnetar', [0.1, 0.3])
    const plonky = problemFinding('plonky-port', [0.0, 0.2])
    expect(ok(await ledger.append('2026-10-14', [magnetar]))).toEqual({ appended: 1, replayed: 0 })
    expect(ok(await ledger.append('2026-10-14', [magnetar]))).toEqual({ appended: 0, replayed: 1 })
    expect(ok(await ledger.append('2026-10-20', [magnetar, plonky]))).toEqual({
      appended: 2,
      replayed: 0,
    })
    const bad = await ledger.append('2026-10-20', [
      { ...magnetar, scope: { ...magnetar.scope!, n: 1 } },
    ])
    expect(bad).toMatchObject({ succeeded: false, error: { kind: 'invalid' } })

    const read = ok(await ledger.read())
    expect(read.findings.map((row) => row.sequence)).toEqual([0, 1, 2])
    expect(read.merkleRoot).toMatch(/^sha256:[a-f0-9]{64}$/)
    const reopened = ok(await openFindingsLedger({ path: join(dir, 'findings.jsonl') }).read())
    expect(reopened.merkleRoot).toBe(read.merkleRoot)

    expect(queryFindings(read.findings, { domainPath: PATH }).map((row) => row.subject)).toEqual([
      'magnetar',
      'magnetar',
    ])
    expect(
      queryFindings(read.findings, { domainPath: ['build-systems'], layer: 'problem' }),
    ).toHaveLength(3)
    expect(queryFindings(read.findings, { layer: 'run' })).toEqual([])
    expect(
      queryFindings(read.findings, { analystId: 'team-shape-comparison', runId: '2026-10-20' }),
    ).toHaveLength(2)

    const steps = diffFindingsOverTime(read.findings)
    expect(steps).toHaveLength(1)
    expect(steps[0]!.diff.appeared.map((row) => row.subject)).toEqual(['plonky-port'])
    expect(steps[0]!.diff.persisted.map((row) => row.subject)).toEqual(['magnetar'])
  })
})

describe('failure-modes calibration gate', () => {
  // Live calibration against the public AgentRx set plus a caller's gold file
  // runs after release (`loadFailureModeGold`, `calibrateFailureModes`); the
  // gate checks only that a recorded calibration decides whether the rubric reports.
  const options = {
    model: 'judge-model',
    layer: 'run' as const,
    evaluate: async () => {
      throw new Error('construction must not call the judge')
    },
    renderState: () => 'trajectory',
    scope: () => ({ population: ['run-1'], n: 1, window: WINDOW }),
  }

  it(`refuses to report a rubric whose kappa is below ${FAILURE_MODES_MIN_KAPPA}`, () => {
    const calibration = { gold_n: 120, agreement: 0.7, kappa: 0.59 }
    expect(createFailureModesAnalyst({ ...options, calibration })).toMatchObject({
      succeeded: false,
      error: { kind: 'uncalibrated' },
    })
    const undefinedKappa = { gold_n: 0, agreement: Number.NaN, kappa: Number.NaN }
    expect(createFailureModesAnalyst({ ...options, calibration: undefinedKappa })).toMatchObject({
      succeeded: false,
      error: { kind: 'uncalibrated' },
    })
  })

  it(`builds the analyst at kappa ${FAILURE_MODES_MIN_KAPPA} or above`, () => {
    const calibration = { gold_n: 120, agreement: 0.75, kappa: FAILURE_MODES_MIN_KAPPA }
    const built = createFailureModesAnalyst({ ...options, calibration })
    expect(built.succeeded && built.value.id).toBe('failure-modes')
  })
})

describe('rollup', () => {
  it('aggregates runs per play with lineage-clustered intervals and lifts only through promote', () => {
    const taxonomy = labTaxonomy()
    const runs: AnalystFinding[] = []
    const values: Record<string, number> = {}
    for (const problem of ['magnetar', 'binius-port']) {
      for (const play of ['a', 'b']) {
        for (const run of [1, 2]) {
          const id = `${problem}/${play}/r${run}`
          values[id] = 0.2 + 0.05 * run
          runs.push(
            makeFinding({
              analyst_id: 'pass-rate',
              area: 'outcome',
              severity: 'info',
              confidence: 1,
              claim: 'Pass rate',
              claim_id: 'pass-rate',
              subject: id,
              evidence_refs: [],
              layer: 'run',
              scope: { population: [id], n: 1, window: WINDOW },
              method: { kind: 'measured', name: 'tests', version: '1' },
              measure: { name: 'pass rate', value: values[id]!, unit: 'share' },
              // Run 2 of magnetar/a inherited run 1's code; everything else starts fresh.
              evidence_units: [
                { id, layer: 'run', derived_from: id === 'magnetar/a/r2' ? 'magnetar/a/r1' : null },
              ],
            }),
          )
        }
      }
    }
    const result = rollupFindings(runs, taxonomy, { seed: 7, resamples: 200 })
    const plays = result.findings.filter((finding) => finding.layer === 'play')
    expect(plays).toHaveLength(4)
    const inherited = plays.find((finding) => finding.subject === 'magnetar/a')!
    expect(inherited.measure?.interval).toBeUndefined()
    expect(inherited.metadata?.denominators).toEqual({ observations: 2, independent_clusters: 1 })
    const fresh = plays.find((finding) => finding.subject === 'magnetar/b')!
    expect(fresh.measure?.interval).toHaveLength(2)

    const problems = result.findings.filter((finding) => finding.layer === 'problem')
    // magnetar has one voting play (magnetar/a has no interval); binius-port has two.
    expect(problems.map((finding) => finding.subject)).toEqual(['binius-port'])
    expect(problems[0]!.metadata?.denominators).toEqual({
      observations: 4,
      independent_clusters: 4,
    })
    for (const finding of result.findings) expect(parseAnalystFinding(finding).succeeded).toBe(true)
  })
})
