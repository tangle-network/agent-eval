import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { Session } from 'node:inspector/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  developmentClaim,
  inMemoryCampaignStorage,
  openSearchLedger,
  replaySearchLedgerText,
  SearchRecorder,
  type SearchExecutionIdentity,
  type SearchTask,
} from '../src/campaign/index'
import { hashCanonical } from '../src/ledger-core/canonical'
import { taskMatrix } from '../src/search/index'
import { mulberry32 } from '../src/statistics/random'

// node --import tsx scripts/prove-task-matrix.mts [ledger.jsonl...]
// The generated ledgers and any supplied ledgers use the same verified replay,
// public lens and built CLI. V8 counts also guard work independently of timing.
const CAP = 200
const SCALE = 2000
const SEARCH_ID = 'synthetic:task-matrix-proof'
const UNITS = ['a0', 'a1', 'a2', 'b0', 'b1', 'b2', 'c0', 'c1', 'c2']
const OMITTED_UNIT = 'omitted-only'
const SOURCE = {
  uri: 'synthetic://task-matrix-proof-v1',
  revision: hashCanonical({ fixture: 'task-matrix-proof', version: 1 }),
}
const IDENTITY: SearchExecutionIdentity = {
  model: { provider: 'synthetic', snapshot: 'task-matrix-proof-v1@1' },
  agent: SOURCE,
  benchmark: SOURCE,
}
// Captured with the pre-sampling implementation at dc1fa69f2c1948eab32f07590c90a573924a8f06.
// These digest the complete lens output, including method text and key presence.
const SMALL_MATRIX_SHA256 = {
  selection: '313cb1d3deb85b4880e96ad12b95d236d373941b7fe5e77d2fdf143f49b59627',
  train: '2f1db9efc2696ef1338a1e0ba648ad5d26597c03da70edd9a90ae0d60aa3c7ab',
}
const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url))

/** Like generate-synthetic-search-ledger.ts: three families of three units,
 * four operator uplift patterns, both splits, seeded scores and invalid nodes.
 * A missing unit prevents an otherwise best node from contributing; a unit
 * scored only by omitted node 1 detects accidental full-ledger unit clustering.
 * Use the existing memory ledger and recorder, then flush its canonical bytes
 * once, so fixture construction does not need an fsync for every event. */
async function syntheticLedger(path: string, ordinals: readonly number[]): Promise<string[]> {
  const storage = inMemoryCampaignStorage()
  const task = (unitId: string, split: 'train' | 'selection'): SearchTask => ({
    taskId: `${unitId}.${split}`,
    unitId,
    source: SOURCE,
  })
  const recorder = await SearchRecorder.open(
    {
      ledger: openSearchLedger({ path, searchId: SEARCH_ID, store: storage }),
      storage,
      blobDir: '/task-matrix-proof/blobs',
      now: () => Date.parse('2026-10-01T00:00:00Z'),
    },
    {
      subject: 'synthetic/task-matrix-proof',
      process: { name: 'task-matrix-proof', executionRef: SOURCE },
      artifactKind: 'prompt',
      objective: {
        metric: 'synthetic-score',
        direction: 'maximize',
        judge: { unknown: 'synthetic fixture: no judge' },
        claim: developmentClaim('task-matrix-proof'),
      },
      splits: {
        train: [...UNITS, OMITTED_UNIT].map((unit) => task(unit, 'train')),
        selection: [...UNITS, OMITTED_UNIT].map((unit) => task(unit, 'selection')),
        test: [],
        heldOutUnits: true,
      },
      policy: { expansion: 'synthetic', allocation: 'synthetic', seed: 1 },
      budget: {
        maxUsd: null,
        maxCells: null,
        maxNodes: null,
        deadline: null,
        maxConcurrency: null,
        reservedClaimUsd: 0,
      },
      containment: null,
      derivedFrom: null,
      identity: IDENTITY,
    },
  )
  const operators = ['draft', 'improve', 'debug', 'merge'] as const
  const uplift = {
    draft: [0.01, 0, 0],
    improve: [0.03, 0.18, 0.02],
    debug: [0.02, 0.02, 0.01],
    merge: [0.28, 0.05, 0],
  }
  const nodeIds: string[] = []
  const parents: string[] = []
  for (const ordinal of ordinals) {
    const artifact = recorder.blob('prompt', { ordinal })
    const { nodeId } = await recorder.registerNode({
      artifactDigest: artifact.sha256,
      artifact,
      surfaces: [{ surfaceId: 'prompt', kind: 'prompt', artifact }],
    })
    nodeIds.push(nodeId)
    const operator = operators[Math.floor(ordinal / 500) % operators.length]!
    const ownParents = ordinal === 0 ? [] : parents.slice(0, operator === 'merge' ? 2 : 1)
    await recorder.recordEdge({
      childNodeId: nodeId,
      parents: ownParents,
      operator: ordinal === 0 ? 'seed' : operator,
      attribution: 'explicit',
      proposer:
        ordinal === 0
          ? null
          : { kind: 'trace', name: 'synthetic', operationId: null, source: SOURCE },
      proposalKey: `node-${ordinal}`,
      rationale: { unknown: 'synthetic family uplift' },
      diffs: ownParents.map(() => ({ unknown: 'synthetic fixture writes no diff' })),
    })
    const invalid = ordinal > 0 && ordinal % 17 === 0
    const missing = ordinal > 0 && ordinal % 11 === 0
    const noise = (mulberry32(ordinal + 1)() - 0.5) * 0.02
    for (const split of ['train', 'selection'] as const) {
      for (const [index, unitId] of [...UNITS, OMITTED_UNIT].entries()) {
        if (unitId === OMITTED_UNIT && ordinal !== 1) continue
        if (unitId === 'b2' && missing) continue
        const score =
          ordinal === 0
            ? 0
            : invalid || missing || unitId === OMITTED_UNIT
              ? 1
              : 0.5 + uplift[operator][Math.floor(index / 3)]! + noise
        const cellId = await recorder.allocateCell({
          nodeId,
          taskId: `${unitId}.${split}`,
          split,
          rep: 0,
          stage: split === 'train' ? 'train' : 'screen',
          lane: 'synthetic',
        })
        await recorder.settleCell({
          cellId,
          outcome: { status: 'passed', score, metrics: { score } },
          accounting: {
            tokens: { status: 'unknown', reason: 'synthetic fixture records no tokens' },
            cost: { status: 'known', usd: 0, source: 'free' },
          },
          identity: IDENTITY,
          wallMs: 1,
        })
      }
    }
    if (ordinal !== 0) {
      await recorder.decideNode({
        nodeId,
        decision: { status: invalid ? 'invalid' : 'pruned' },
        rule: 'synthetic',
        reason: 'deterministic fixture decision',
      })
    }
    if (!invalid) parents.push(nodeId)
  }
  await recorder.decideNode({
    nodeId: nodeIds[0]!,
    decision: { status: 'selected' },
    rule: 'synthetic',
    reason: 'keep the root as the synthetic control',
  })
  await recorder.close({ reason: 'max-nodes', claim: null })
  const text = storage.read(path)
  assert(text, 'Synthetic ledger bytes are missing')
  writeFileSync(path, text)
  return nodeIds
}

function runCli(path: string, json: boolean): string {
  const output = spawnSync(
    process.execPath,
    [cli, 'search', 'show', path, '--task-matrix', ...(json ? ['--json'] : [])],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 60_000 },
  )
  assert.ifError(output.error)
  assert.equal(output.status, 0, output.stderr)
  return output.stdout
}

async function prove(path: string, profiler: Session, timed = false) {
  const text = readFileSync(path, 'utf8')
  const searchId = JSON.parse(text.split('\n')[0]!).searchId as string
  const state = replaySearchLedgerText(text, searchId, path)
  await profiler.post('Profiler.startPreciseCoverage', { callCount: true, detailed: false })
  const started = performance.now()
  const matrix = taskMatrix(state)
  const milliseconds = performance.now() - started
  const coverage = await profiler.post('Profiler.takePreciseCoverage')
  await profiler.post('Profiler.stopPreciseCoverage')
  const source = coverage.result.find((entry) => entry.url.endsWith('/search/lenses/task-matrix.ts'))
  assert(source, 'V8 did not capture the task matrix source')
  const calls = (name: string, maximum: number): number => {
    const fn = source.functions.find((entry) => entry.functionName === name)
    if (!fn && maximum === 0) return 0
    assert(fn, `V8 did not capture ${name}`)
    return fn.ranges[0]!.count
  }
  const nodes = matrix.data.nodeIds.length
  const total = state.nodeIds().length
  const units = matrix.data.unitIds.length
  assert.equal(nodes, Math.min(total, CAP))
  const maximumCalls = { nodes: nodes * (nodes - 1), units: units * (units - 1) }
  const distanceCalls = {
    nodes: calls('nodeDistance', maximumCalls.nodes),
    units: calls('unitDistance', maximumCalls.units),
  }
  assert(distanceCalls.nodes <= maximumCalls.nodes, 'Node distances exceed two calls per pair')
  assert(distanceCalls.units <= maximumCalls.units, 'Unit distances exceed two calls per pair')
  const secondStarted = performance.now()
  const repeated = taskMatrix(state)
  const repeatedMilliseconds = performance.now() - secondStarted
  assert.deepEqual(repeated, matrix, 'Repeated lens output changed')
  if (timed) {
    assert(milliseconds < 10_000, `First 2000-node lens run took ${milliseconds} ms`)
    assert(repeatedMilliseconds < 10_000, `Second 2000-node lens run took ${repeatedMilliseconds} ms`)
  }
  const cliStarted = performance.now()
  const output = runCli(path, true)
  const cliMilliseconds = performance.now() - cliStarted
  if (timed) assert(cliMilliseconds < 10_000, `2000-node CLI replay and lens took ${cliMilliseconds} ms`)
  assert.deepEqual(JSON.parse(output).taskMatrix, matrix)
  const rendered = runCli(path, false)
  if (total > CAP) {
    assert.deepEqual(matrix.data.sampling, { nodesClustered: CAP, nodesTotal: total, cap: CAP })
    assert.match(matrix.data.method, /cap 200\b/)
    assert(rendered.includes(`clustered ${CAP} of ${total} nodes (cap ${CAP})`))
  } else {
    assert(!Object.hasOwn(matrix.data, 'sampling'), 'An unsampled ledger changed shape')
  }
  console.log(
    JSON.stringify({
      path,
      ledgerSha256: createHash('sha256').update(text).digest('hex'),
      nodes,
      total,
      units,
      milliseconds,
      repeatedMilliseconds,
      cliMilliseconds,
      distanceCalls,
      maximumCalls,
      cliBytes: Buffer.byteLength(output),
      deterministic: true,
      cliMatchesLibrary: true,
    }),
  )
  return { matrix, state }
}

const directory = mkdtempSync(join(tmpdir(), 'task-matrix-proof-'))
const profiler = new Session()
profiler.connect()
await profiler.post('Profiler.enable')
try {
  const smallPath = join(directory, 'small.jsonl')
  await syntheticLedger(smallPath, Array.from({ length: 29 }, (_, index) => index))
  const small = await prove(smallPath, profiler)
  for (const split of ['selection', 'train'] as const) {
    assert.equal(
      createHash('sha256').update(JSON.stringify(taskMatrix(small.state, { split }))).digest('hex'),
      SMALL_MATRIX_SHA256[split],
      `${split} small-ledger output differs from the pre-sampling implementation`,
    )
  }

  const largePath = join(directory, '2000-nodes.jsonl')
  const largeIds = await syntheticLedger(largePath, Array.from({ length: SCALE }, (_, index) => index))
  const large = await prove(largePath, profiler, true)
  // For 2000 / 200 the helper's registration spacing is exactly ten. This
  // independent recorded subset detects a different sampler or mixed scopes.
  const subsetPath = join(directory, '200-clustered-nodes.jsonl')
  const subsetIds = await syntheticLedger(subsetPath, Array.from({ length: CAP }, (_, index) => index * 10))
  assert.deepEqual(subsetIds, largeIds.filter((_, index) => index % 10 === 0))
  const subset = await prove(subsetPath, profiler)
  const { sampling, method, ...sampledData } = large.matrix.data
  const { method: subsetMethod, ...subsetData } = subset.matrix.data
  assert(method.startsWith(subsetMethod), 'Sampling removed the specialist gain method')
  assert.deepEqual(sampledData, subsetData, 'Matrix calculations used nodes outside the sample')
  assert.deepEqual(large.matrix.signal, subset.matrix.signal)
  assert.deepEqual(large.matrix.data.unitClusters, [{ id: 'a0', members: UNITS }])
  assert(large.matrix.data.cells.some((cell) => cell.mean === null), 'Missing score fixture absent')
  assert(large.matrix.data.cells.some((cell) => cell.mean === 0), 'Measured zero fixture absent')
  const gain = large.matrix.data.specialistGain[0]!
  // Among ordinals 0,10,...1990: 11 invalid nodes, 18 missing b2, one both.
  assert.equal(gain.nodesContributing, 172)
  assert(gain.gain !== null && gain.gain > 0, 'Fixture must exercise a measured specialist gain')
  assert.equal(gain.insufficient, null)
  assert(gain.bestNodeId !== null)
  assert.notEqual(large.state.node(gain.bestNodeId)!.status, 'invalid')
  assert.equal(large.state.unitScores(gain.bestNodeId, 'selection').length, UNITS.length)
  console.log(JSON.stringify({
    syntheticNodes: SCALE,
    sampling,
    smallOutputUnchanged: true,
    subsetMatches: true,
    specialistGain: gain.gain,
    nodesContributing: gain.nodesContributing,
  }))
  for (const path of process.argv.slice(2)) await prove(path, profiler)
} finally {
  await profiler.post('Profiler.disable')
  profiler.disconnect()
  rmSync(directory, { recursive: true, force: true })
}
