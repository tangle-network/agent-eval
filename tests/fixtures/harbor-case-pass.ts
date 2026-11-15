/**
 * One improve pass over a shared Harbor case, as its own process: prepare the case, grade a fixing
 * patch and an empty one, release. `node --import tsx harbor-case-pass.ts <dataset> <coord> <i> <n>`
 * prints `{ pass, image, scores }`. Passes meet in `coord`: every pass prepares before any grades,
 * and pass 0 grades and releases before the others grade, the order a concurrent run reaches when
 * one pass finishes a case first.
 */
import { access, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

import {
  createHarborBenchmarkAdapter,
  gradeHarborPatch,
  prepareCaseEnvironment,
  releaseCaseEnvironment,
} from '../../src/benchmarks/index'

const [datasetDir, coord, index, count] = process.argv.slice(2) as [string, string, string, string]
const pass = Number(index)
const PATCH = `diff --git a/greeting.txt b/greeting.txt
--- a/greeting.txt
+++ b/greeting.txt
@@ -1 +1 @@
-hello
+world
`

const exists = (path: string) => access(path).then(() => true, () => false)
async function until(paths: string[]) {
  while (!(await Promise.all(paths.map(exists))).every(Boolean)) await sleep(100)
}

const adapter = createHarborBenchmarkAdapter<{ patch: string }>({
  id: 'case-env-concurrent',
  datasetDir,
  source: { name: 'synthetic-case-env', revision: 'local' },
  grade: gradeHarborPatch({ jobsDir: join(coord, `jobs-${pass}`), timeoutMs: 600_000, retries: 0 }),
})
const [task] = await adapter.loadAll()
const image = await prepareCaseEnvironment(task!)
await writeFile(join(coord, `prepared-${pass}`), image)
await until(Array.from({ length: Number(count) }, (_, i) => join(coord, `prepared-${i}`)))
if (pass !== 0) await until([join(coord, 'released-0')])
const scores: (number | string)[] = []
for (const patch of [PATCH, ''])
  scores.push(
    await adapter.evaluate(task!, { patch }).then(
      (evaluation) => evaluation.score,
      (error: Error) => error.message.slice(0, 400),
    ),
  )
await releaseCaseEnvironment(task!)
if (pass === 0) await writeFile(join(coord, 'released-0'), '')
console.log(JSON.stringify({ pass, image, scores }))
