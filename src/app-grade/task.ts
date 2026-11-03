/**
 * A declarative App Grade task on disk, and one grading run of it against its real product.
 *
 *   <task dir>/task.json                 the contestant leaf, its suite, the product and the grader spec
 *   <task dir>/solutions/<plant>/…       calibration submissions written over the contestant scaffold
 *
 * A grading run starts the product's pinned image fresh, runs the spec's admin setup, puts
 * the recording proxy between the app and the product, serves the app with only the product
 * URL and the app's own scoped key, and grades it with `spec-leaf.ts`. Building a submission
 * (the contestant scaffold, a solution over it, install) is the caller's.
 */
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { TASK_SCHEMA, taskMaterialDigest } from './admission'
import { type GradeResult, grade } from './grade'
import type { AppGradeJudge } from './judge'
import { drawProbes, redact, runSetup, startEventRelay, startProduct, startRecordingProxy, type ProductContext } from './product'
import { specLeaf } from './spec-leaf'
import { lintAppGradeSpec, lintProductSpec, render, type AppGradeSpec, type ProductSpec } from './spec'

export interface AppGradeTask {
  schema: typeof TASK_SCHEMA
  id: string
  /** The suite fields the caller builds the contestant's scaffold and prompt from. */
  suite: Record<string, unknown>
  /** What the contestant sees. It never carries the grader spec. */
  leaf: { id: string } & Record<string, unknown>
  product: ProductSpec
  spec: AppGradeSpec
}

export interface LoadedTask extends AppGradeTask {
  dir: string
  /** Digest of the complete task material (suite, leaf, product, spec). */
  digest: string
}

export function taskProblems(task: AppGradeTask): string[] {
  const problems: string[] = []
  if (task.schema !== TASK_SCHEMA) problems.push(`schema must be ${TASK_SCHEMA}`)
  if (!/^[a-z0-9][a-z0-9-]{1,50}$/.test(task.id ?? '')) problems.push('id must be a lowercase slug')
  if (task.leaf?.id !== task.id) problems.push('leaf.id must equal the task id')
  if ('appGrade' in (task.leaf ?? {})) problems.push('the contestant leaf must not carry the grader spec')
  problems.push(...lintProductSpec(task.product ?? ({} as ProductSpec)))
  problems.push(...lintAppGradeSpec(task.spec ?? ({} as AppGradeSpec), task.product))
  return problems
}

export function loadTask(dir: string): LoadedTask {
  const task = JSON.parse(readFileSync(join(dir, 'task.json'), 'utf8')) as AppGradeTask
  const problems = taskProblems(task)
  if (problems.length > 0) throw new Error(`task ${dir} is invalid:\n${problems.join('\n')}`)
  return { ...task, dir, digest: taskDigest(task) }
}

export function taskDigest(task: AppGradeTask): string {
  return taskMaterialDigest({ id: task.id, suite: task.suite, leaf: task.leaf, product: task.product, spec: task.spec })
}

/** One grading run of a served submission against a fresh instance of the task's product. */
export async function gradeTask(input: {
  task: AppGradeTask & { digest: string }
  workdir: string
  engineeringPath: string
  out: string
  port: number
  judge: AppGradeJudge
}): Promise<GradeResult & { probes: Record<string, unknown> }> {
  const { task } = input
  mkdirSync(input.out, { recursive: true })
  const product = await startProduct(task.product, { logPath: join(input.out, 'product.log') })
  let proxy: Awaited<ReturnType<typeof startRecordingProxy>> | null = null
  const relay = startEventRelay(product, `http://127.0.0.1:${input.port}`, join(input.out, 'product-events.jsonl'))
  try {
    const context: ProductContext = { probe: drawProbes(task.spec.probes), vars: {} }
    await runSetup(product, task.spec.setup, context, (entry) => appendFileSync(join(input.out, 'setup.jsonl'), `${redact(JSON.stringify(entry), product.secrets())}\n`))
    const appKey = product.appKey ?? (task.product.appKey === undefined ? null : String(render(task.product.appKey, { ...context })))
    if (appKey) product.addSecret(appKey)
    proxy = await startRecordingProxy(product, appKey, join(input.out, 'product-requests.jsonl'))
    const requests = proxy.requests
    const appEnv: Record<string, string> = { ...product.appEnv, [task.product.appEnv.url]: proxy.url }
    if (task.product.appEnv.key && appKey) appEnv[task.product.appEnv.key] = appKey
    writeFileSync(join(input.out, 'run-context.json'), JSON.stringify({ task: task.id, taskDigest: task.digest, productVersion: product.reportedVersion, image: task.product.image ?? task.product.hosted.origin, probes: context.probe, appEnv: Object.keys(appEnv) }, null, 1))
    const leaf = specLeaf({
      id: task.id,
      specDigest: task.digest,
      spec: task.spec,
      product,
      context,
      requests: () => requests,
      readText: (path) => readFileSync(join(input.out, path), 'utf8'),
    })
    const result = await grade({ ...input, leaf, appEnv })
    return { ...result, probes: context.probe }
  } finally {
    await relay.stop()
    await proxy?.close()
    await product.stop()
  }
}
