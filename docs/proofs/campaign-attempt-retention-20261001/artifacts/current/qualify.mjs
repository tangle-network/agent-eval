import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, readdirSync, mkdirSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'

const root = process.env.PROOF_ROOT
const modulePath = process.env.EVAL_MODULE
if (!root || !modulePath) throw new Error('PROOF_ROOT and EVAL_MODULE are required')
const { runEval, runOptimization } = await import(pathToFileURL(modulePath).href)
const { CostLedger } = await import(pathToFileURL(process.env.EVAL_COST_MODULE).href)
const hash = data => createHash('sha256').update(data).digest('hex')
const json = path => JSON.parse(readFileSync(path, 'utf8'))
const save = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n')
const scenarios = [{ id: 'capture-retention', kind: 'operational', scenarioDigest: 'sha256:' + hash('attempt-artifact-retention') }]
const base = { scenarios, reps: 1, seed: 42, expectUsage: 'off', labeledStore: 'off', dispatchRef: 'operational-attempt-retention-v1', maxConcurrency: 1 }
const interruption = 'Operational interruption after native artifact capture'

async function qualify(mode) {
  const runDir = join(root, 'after-' + mode)
  const observed = []
  let invocations = 0
  const costLedger = new CostLedger()
  const opts = { ...base, runDir, costLedger, dispatch: async (_scenario, ctx) => {
    const invocation = ++invocations
    const value = { cellId: ctx.cellId, runAttemptId: ctx.runAttemptId, invocation, content: 'Actual filesystem capture from invocation ' + invocation }
    ctx.trace.span('native.callback.capture', { invocation, runAttemptId: ctx.runAttemptId }).end()
    const path = await ctx.artifacts.writeJson('captured-response.json', value)
    observed.push({ invocation, path, sha256: hash(readFileSync(path)), value })
    const metered = await ctx.cost.runPaidCall({
      actor: 'operational-file-read',
      execute: async () => readFileSync(path, 'utf8'),
      receipt: () => ({ model: 'not-an-inference', inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 }),
    })
    assert.equal(metered.succeeded, true)
    if (invocation === 1) throw new Error(interruption)
    return value
  }}
  const reports = []
  if (mode === 'retry') reports.push(await runEval({ ...opts, cellRetry: { attempts: 2, retryable: f => f.error.message === interruption } }))
  else {
    reports.push(await runEval(opts))
    reports.push(await runEval(opts))
  }
  assert.equal(invocations, 2)
  assert.notEqual(observed[0].path, observed[1].path)
  const attempts = observed.map(item => {
    assert.equal(hash(readFileSync(item.path)), item.sha256)
    const attemptDir = dirname(dirname(item.path))
    const identity = json(join(attemptDir, 'identity.json'))
    const result = json(join(attemptDir, 'result.json'))
    const trace = readFileSync(join(attemptDir, 'trace/spans.jsonl'), 'utf8').split('\n').filter(Boolean).map(JSON.parse)
    assert.equal(identity.runAttemptId, item.value.runAttemptId)
    assert.deepEqual(result.attempt, { runAttemptId: identity.runAttemptId, number: identity.number })
    assert.equal(identity.cellId, item.value.cellId)
    assert.equal(identity.manifestHash, result.manifestHash)
    assert.equal(trace[0].invocation, item.invocation)
    return { identity, result, trace, path: relative(root, attemptDir) }
  })
  const cellDir = dirname(dirname(dirname(dirname(dirname(observed[1].path)))))
  const pointer = json(join(cellDir, 'latest-attempt.json'))
  assert.deepEqual(pointer, reports.at(-1).cells[0].attempt)
  assert.equal(attempts[0].identity.number, 1)
  assert.equal(attempts[1].identity.number, mode === 'retry' ? 2 : 1)
  assert.equal(attempts[0].identity.runAttemptId === attempts[1].identity.runAttemptId, mode === 'retry')
  const receipt = json(join(root, attempts[0].path, 'failure-receipt.json'))
  assert.equal(receipt.failure.error.message, interruption)
  assert.deepEqual(receipt.cell.attempt, attempts[0].result.attempt)
  const reused = await runEval(opts)
  assert.equal(invocations, 2)
  assert.equal(reused.cells[0].cached, true)
  assert.deepEqual(reused.cells[0].attempt, pointer)
  const ledgerReceipts = costLedger.list()
  assert.equal(ledgerReceipts.length, 2)
  ledgerReceipts.forEach((call, index) => {
    assert.equal(call.tags.runAttemptId, attempts[index].identity.runAttemptId)
    assert.equal(call.tags.attemptNumber, String(attempts[index].identity.number))
  })
  assert.equal(reports.at(-1).cells[0].costCallIds.length, mode === 'retry' ? 2 : 1)
  const result = { invocations, observed, attempts, receipt, pointer, reports, ledgerReceipts, cacheReuse: reused, firstContentStillPresent: true, modelInference: false, researchUnits: 0 }
  save(join(runDir, 'observation.json'), result)
  return result
}

const summary = { module: { path: modulePath, sha256: hash(readFileSync(modulePath)) }, retry: await qualify('retry'), resume: await qualify('resume') }

// Use a copied historical cell to prove new execution never writes its legacy capture paths.
const legacyRun = join(root, 'after-legacy')
const legacyCell = join(legacyRun, 'capture-retention_0')
mkdirSync(legacyCell, { recursive: true })
const originalCell = join(process.env.BASELINE_ROOT, 'before-resume/capture-retention_0')
const legacySnapshot = {}
for (const name of readdirSync(originalCell)) {
  const bytes = readFileSync(join(originalCell, name))
  writeFileSync(join(legacyCell, name), bytes)
  legacySnapshot[name] = hash(bytes)
}
const legacyReport = await runEval({ ...base, runDir: legacyRun, resumable: false, dispatch: async (_scenario, ctx) => {
  await ctx.artifacts.writeJson('captured-response.json', { continuation: true, runAttemptId: ctx.runAttemptId })
  ctx.trace.span('legacy.continuation').end()
  return { continuation: true }
}})
for (const [name, sha] of Object.entries(legacySnapshot)) assert.equal(hash(readFileSync(join(legacyCell, name))), sha)
summary.legacy = { originalCell, legacySnapshot, report: legacyReport, allHistoricalCellFilesUnchanged: true }

// Exercise the public artifact scope while a real attempt identity exists.
const guardRun = join(root, 'after-path-guard')
let guard
const guardReport = await runEval({ ...base, runDir: guardRun, dispatch: async (_scenario, ctx) => {
  const own = await ctx.artifacts.writeJson('capture.json', { own: true })
  const identityPath = join(dirname(dirname(own)), 'identity.json')
  const before = hash(readFileSync(identityPath))
  let rejection
  try { await ctx.artifacts.writeJson('../identity.json', { overwritten: true }) }
  catch (error) { rejection = error.message }
  const after = hash(readFileSync(identityPath))
  assert.equal(rejection, 'Artifact path must remain inside this execution attempt')
  assert.equal(before, after)
  guard = { rejection, identityBefore: before, identityAfter: after }
  return guard
}})
summary.pathGuard = { ...guard, report: guardReport }

// Interrupt after a failed candidate settles. Reopen the native search ledger,
// then observe its prior candidate through runOptimization's stored-cell reader.
const optimizationDir = join(root, 'after-optimization')
let proposals = 0
const histories = []
const optimizationOpts = {
  ...base, runDir: optimizationDir,
  judges: [{ name: 'operational-quality', dimensions: [{ key: 'captured', description: 'Artifact was returned' }], judgeVersion: 'operational-v1', score: () => ({ dimensions: { captured: 1 }, composite: 1, notes: 'Operational artifact only; no research outcome.' }) }],
  baselineSurface: 'baseline', populationSize: 1, maxGenerations: 2,
  dispatchWithSurface: async (surface, _scenario, ctx) => {
    await ctx.artifacts.writeJson('captured-response.json', { surface, runAttemptId: ctx.runAttemptId })
    ctx.trace.span('native.optimization.capture', { surface }).end()
    if (surface === 'failed-candidate') throw new Error('Operational candidate interruption')
    return { surface }
  },
  proposer: {
    kind: 'operational-retention-qualification',
    async propose(ctx) {
      proposals++
      histories.push({ proposal: proposals, history: ctx.history })
      if (proposals === 1) return ['failed-candidate']
      if (proposals === 2) throw new Error('Operational stop after candidate settlement')
      return ['resumed-candidate']
    },
  },
}
let firstError
try { await runOptimization(optimizationOpts) }
catch (error) { firstError = error.message }
save(join(optimizationDir, 'first-interruption.json'), { firstError, proposals, histories })
assert.match(firstError ?? '', /Operational stop after candidate settlement/)
const optimized = await runOptimization(optimizationOpts)
const resumedHistory = histories.find(h => h.proposal === 3)?.history
assert.ok(resumedHistory)
const failed = resumedHistory.flatMap(g => g.candidates).find(c => c.coverage?.unscorableCells?.length)
assert.ok(failed, 'Reopened optimization must retain its failed candidate')
assert.equal(failed.coverage.expectedCells, 1)
assert.equal(failed.coverage.scorableCells, 0)
assert.match(JSON.stringify(failed.coverage.unscorableCells), /Operational candidate interruption/)
summary.optimization = { firstError, proposals, histories, failedCandidateRecovered: true, optimized }
save(join(root, 'after-summary.json'), summary)
console.log(JSON.stringify({ module: summary.module, retryRetained: summary.retry.firstContentStillPresent, resumeRetained: summary.resume.firstContentStillPresent, legacyFilesPreserved: Object.keys(legacySnapshot).length, pathGuard: guard.rejection, optimizationFailedCandidateRecovered: true, providerRequests: 0, operationalLedgerReceipts: 4, researchUnits: 0 }))
