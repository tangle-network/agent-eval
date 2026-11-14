/** Inspect actual downloaded metadata and inputs. No checker or agent is invoked. */
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createHarborBenchmarkAdapter } from '../../../src/benchmarks/index'
import { loadMkaShowcase } from './mka'

const [tbsRoot, mkaRoot, output] = process.argv.slice(2)
if (!tbsRoot || !mkaRoot || !output) throw new Error('Usage: tsx inspect-inputs.ts TBS_ROOT MKA_ROOT OUTPUT_JSON')
const pins = JSON.parse(await readFile(new URL('./sources.json', import.meta.url), 'utf8'))
const tbs = createHarborBenchmarkAdapter<never>({
  id: 'terminal-bench-science-v0.1.0-source-inspection', datasetDir: tbsRoot,
  source: {name: 'Terminal-Bench-Science', revision: pins.recipes['terminal-bench-science'].source.revision,
    version: 'v0.1.0', url: pins.recipes['terminal-bench-science'].source.url},
  assignSplit: () => 'dev',
  grade: async () => {throw new Error('Input inspection does not grade.')},
})
const tasks = await tbs.loadAll()
if (JSON.stringify(tasks.map((task) => task.id).sort()) !== JSON.stringify(pins.recipes['terminal-bench-science'].taskIds)) {
  throw new Error('Loaded TBS roster differs from pinned v0.1.0 task roster')
}
const mkaPackage = await loadMkaShowcase({root: mkaRoot, split: 'dev', inputPolicy: 'metadata-only'})
const mka = mkaPackage.items
if (JSON.stringify(mka.map((task) => task.id).sort()) !== JSON.stringify(pins.recipes['mka-showcase'].taskIds)) {
  throw new Error('Loaded MKA public showcase roster differs from pinned ten tasks')
}
const rfPackage = await loadMkaShowcase({root: mkaRoot, split: 'dev', inputPolicy: 'require',
  taskIds: ['task_143a5623f26c404baaeb63ccd891e196']})
const rf = rfPackage.items
const receipt = {
  purpose: 'Public upstream data import and content inspection; no grading',
  benchmarkExecuted: false, officialScoresComputed: false,
  command: [process.execPath, ...process.argv.slice(1)],
  terminalBenchScience: {
    revision: pins.recipes['terminal-bench-science'].source.revision, tasks: tasks.length,
    taskIds: tasks.map((task) => task.id),
    domains: [...new Set(tasks.map((task) => task.payload.metadata?.domain))],
    artifactDeclarations: tasks.reduce((n, task) => n + (task.payload.artifactMappings?.length ?? 0), 0),
    sourceCheckout: 'partial; task import is not environment hydration or executable readiness',
  },
  mkaShowcase: {
    revision: pins.recipes['mka-showcase'].source.revision, tasks: mka.length, officialGraderIncluded: false,
    completeInputTasks: mka.filter((task) => task.payload.inputsComplete).map((task) => task.id),
    rows: mka.map((task) => ({id: task.id, tags: task.tags,
      rubricCriteria: Object.keys(mkaPackage.gradingReferences.get(task.id)!.rubrics).length, inputsComplete: task.payload.inputsComplete,
      sourceHashes: {metadataSha256: task.metadata!.metadataSha256, rubricsSha256: task.metadata!.rubricsSha256}})),
    realMultimodalInputs: rf[0]!.payload.inputs,
  },
}
await writeFile(resolve(output), `${JSON.stringify(receipt, null, 2)}\n`)
console.log(JSON.stringify({tbsTasks: tasks.length, mkaTasks: mka.length,
  mkaCompleteInputTasks: receipt.mkaShowcase.completeInputTasks.length,
  rfImages: rf[0]!.payload.inputs.length, officialScoresComputed: false}))
