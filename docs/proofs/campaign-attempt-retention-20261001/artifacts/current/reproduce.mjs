import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
const { runEval } = await import(pathToFileURL(process.env.EVAL_MODULE).href)
const root = process.env.PROOF_ROOT
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const save = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n')
const result = { module: { path: process.env.EVAL_MODULE, sha256: hash(readFileSync(process.env.EVAL_MODULE)) }, providerRequests: 0, researchUnits: 0 }
for (const mode of ['retry', 'resume']) {
  const runDir = join(root, 'reproduction-' + mode)
  let invocations = 0
  const observed = []
  let firstTrace
  const opts = {
    runDir, scenarios: [{ id: 'capture-retention', kind: 'operational' }], reps: 1, seed: 42,
    expectUsage: 'off', labeledStore: 'off', dispatchRef: 'operational-attempt-retention-baseline-v1', maxConcurrency: 1,
    dispatch: async (_scenario, ctx) => {
      const invocation = ++invocations
      const value = { cellId: ctx.cellId, runAttemptId: ctx.runAttemptId, invocation }
      const path = await ctx.artifacts.writeJson('captured-response.json', value)
      const tracePath = join(dirname(path), 'spans.jsonl')
      if (invocation === 2 && existsSync(tracePath)) firstTrace = { path: tracePath, bytes: readFileSync(tracePath, 'utf8'), sha256: hash(readFileSync(tracePath)) }
      ctx.trace.span('native.callback.capture', { invocation, runAttemptId: ctx.runAttemptId }).end()
      observed.push({ path, value, sha256: hash(readFileSync(path)) })
      save(join(runDir, 'observer-retained-captures.json'), observed)
      if (invocation === 1) throw new Error('Operational interruption after native artifact capture')
      return value
    },
  }
  const reports = mode === 'retry'
    ? [await runEval({ ...opts, cellRetry: { attempts: 2, retryable: () => true } })]
    : [await runEval(opts), await runEval(opts)]
  const firstContentStillPresent = hash(readFileSync(observed[0].path)) === observed[0].sha256
  const firstTraceStillPresent = firstTrace ? hash(readFileSync(firstTrace.path)) === firstTrace.sha256 : null
  result[mode] = { invocations, observed, reports, firstTrace, firstContentStillPresent, firstTraceStillPresent, finalTrace: readFileSync(join(dirname(observed[1].path), 'spans.jsonl'), 'utf8') }
}
save(join(root, 'reproduction-summary.json'), result)
console.log(JSON.stringify({ module: result.module, retry: { artifactRetained: result.retry.firstContentStillPresent, traceRetained: result.retry.firstTraceStillPresent }, resume: { artifactRetained: result.resume.firstContentStillPresent, traceRetained: result.resume.firstTraceStillPresent }, providerRequests: 0, researchUnits: 0 }))
