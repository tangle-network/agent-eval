import type { HarborBenchmarkAdapter, HarborTaskItem } from '../../src/benchmarks'
import { assertMinted, writeRolloutLedger, type RolloutLine } from '../../src/rollout'

/** Caller owns admitted Harbor execution and verification; no sampling or training here. */
export async function scriptedHarborDryRun(options: {
  adapter: HarborBenchmarkAdapter<RolloutLine>
  execute: (item: HarborTaskItem, policy: 'scripted', signal: AbortSignal) => Promise<RolloutLine>
  output: string
  signal: AbortSignal
}) {
  const source = options.adapter.id
  if (!source) throw new Error('Harbor verifier identity is required')
  const tasks = await options.adapter.loadAll()
  if (tasks.length !== 20 || new Set(tasks.map((item) => item.id)).size !== 20 ||
      new Set(tasks.map((item) => item.payload.taskDir)).size !== 20) {
    return { status: 'blocked' as const, loaded: tasks.length, executed: 0, reason: 'requires20 distinct actual Harbor tasks' }
  }
  const lines: RolloutLine[] = []
  const failures: Array<{ task: string; error: string }> = []
  let executed = 0
  for (const item of tasks) {
    options.signal.throwIfAborted()
    executed++
    try {
      const line = await options.execute(item, 'scripted', options.signal)
      // Preserve an ungraded attempt while the independent real verifier runs. Never persist a
      // positive training reward merely because the execution callback claimed one.
      const index = lines.push({ ...line, outcome: { ...line.outcome, reward: null, reward_source: null } }) - 1
      await writeRolloutLedger(options.output, lines)
      const graded = await options.adapter.evaluate(item, line)
      if (line.task.instance_id !== item.id || line.task.split !== (item.split ?? options.adapter.assignSplit(item.id))) {
        throw new Error('canonical task/split does not match the actual Harbor task')
      }
      lines[index] = assertMinted({
        ...line, outcome: { ...line.outcome, reward: graded.score, reward_source: source },
      }, 'scripted Harbor outcome')
      await writeRolloutLedger(options.output, lines)
    } catch (error) {
      failures.push({ task: item.id, error: error instanceof Error ? error.message : String(error) })
    }
  }
  return {
    status: failures.length === 0 ? 'completed' as const : 'failed' as const,
    loaded: tasks.length, executed, recorded: lines.length,
    verifiedRewards: lines.filter((line) => line.outcome.reward !== null).length, failures,
    trainingDatums: 0, trainingCalls: 0,
  }
}
