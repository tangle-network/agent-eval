import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { Session } from 'node:inspector/promises'
import { fileURLToPath } from 'node:url'
import { replaySearchLedgerText } from '../src/campaign/index'
import { taskMatrix } from '../src/search/index'

// Replay real ledgers through the library and built CLI, including piped output.
// V8 call counts guard the distance bound independently of host contention.
const ledgers = process.argv.slice(2)
assert(ledgers.length > 0, 'Usage: pnpm exec tsx scripts/prove-task-matrix.mts <ledger.jsonl...>')
const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url))
const profiler = new Session()
profiler.connect()
await profiler.post('Profiler.enable')

try {
  for (const path of ledgers) {
    const text = readFileSync(path, 'utf8')
    const searchId = JSON.parse(text.split('\n')[0]!).searchId as string
    const state = replaySearchLedgerText(text, searchId, path)
    await profiler.post('Profiler.startPreciseCoverage', { callCount: true, detailed: false })
    const started = performance.now()
    const matrix = taskMatrix(state)
    const milliseconds = performance.now() - started
    const coverage = await profiler.post('Profiler.takePreciseCoverage')
    await profiler.post('Profiler.stopPreciseCoverage')
    const source = coverage.result.find((entry) =>
      entry.url.endsWith('/search/lenses/task-matrix.ts'),
    )
    assert(source, 'V8 did not capture the task matrix source')
    const calls = (name: string, maximum: number): number => {
      const fn = source.functions.find((entry) => entry.functionName === name)
      if (!fn && maximum === 0) return 0
      assert(fn, `V8 did not capture ${name}`)
      return fn.ranges[0]!.count
    }
    const nodes = matrix.data.nodeIds.length
    const units = matrix.data.unitIds.length
    const maximumCalls = { nodes: nodes * (nodes - 1), units: units * (units - 1) }
    const distanceCalls = {
      nodes: calls('nodeDistance', maximumCalls.nodes),
      units: calls('unitDistance', maximumCalls.units),
    }
    const output = spawnSync(
      process.execPath,
      [cli, 'search', 'show', path, '--task-matrix', '--json'],
      {
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
        timeout: 60_000,
      },
    )
    assert.ifError(output.error)
    assert.equal(output.status, 0, output.stderr)
    assert.deepEqual(JSON.parse(output.stdout).taskMatrix, matrix)
    console.log(
      JSON.stringify({
        path,
        ledgerSha256: createHash('sha256').update(text).digest('hex'),
        nodes,
        units,
        milliseconds,
        distanceCalls,
        maximumCalls,
        cliBytes: Buffer.byteLength(output.stdout),
        cliMatchesLibrary: true,
      }),
    )
    assert(distanceCalls.nodes <= maximumCalls.nodes, 'Node distances exceed two calls per pair')
    assert(distanceCalls.units <= maximumCalls.units, 'Unit distances exceed two calls per pair')
  }
} finally {
  await profiler.post('Profiler.disable')
  profiler.disconnect()
}
