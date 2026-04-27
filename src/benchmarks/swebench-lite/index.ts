/**
 * SWE-Bench Lite wrapper — 30-instance subset.
 *
 * Status: STUB. The actual SWE-Bench harness needs a Docker host and
 * is too heavy to ship inside this package. We expose the contract
 * (loadDataset, evaluate, assignSplit) so consumers can plug in their
 * own grader without touching call sites.
 *
 * Wire-up paths in priority order:
 *
 *   1. `process.env.AGENT_EVAL_SWEBENCH_PATH` → JSONL with the 30
 *      lite instances + per-instance metadata (instance_id,
 *      problem_statement, base_commit, repo, FAIL_TO_PASS,
 *      PASS_TO_PASS).
 *   2. `process.env.AGENT_EVAL_SWEBENCH_GRADER_CMD` → executable
 *      that reads `{instance_id, patch}` JSON on stdin and writes
 *      `{passed, fail_to_pass_passed, pass_to_pass_passed, log}`
 *      JSON on stdout. Implementations can shell out to the
 *      official `swebench` runner here.
 *
 * If neither is set, every public method throws a clearly-marked
 * "not implemented" error. The stub fails LOUD; it never silently
 * scores zero.
 */

import { existsSync, readFileSync } from 'node:fs'
import { spawn } from 'node:child_process'

import type {
  BenchmarkAdapter,
  BenchmarkDatasetItem,
  BenchmarkEvaluation,
} from '../types'
import { deterministicSplit } from '../types'
import type { RunSplitTag } from '../../run-record'

export interface SweBenchLitePayload {
  instanceId: string
  problemStatement: string
  baseCommit: string
  repo: string
  failToPass: string[]
  passToPass: string[]
}

export type SweBenchLiteItem = BenchmarkDatasetItem<SweBenchLitePayload>

class SweBenchLiteAdapter
  implements BenchmarkAdapter<SweBenchLiteItem, SweBenchLitePayload>
{
  async loadDataset(split: RunSplitTag): Promise<SweBenchLiteItem[]> {
    const path = process.env.AGENT_EVAL_SWEBENCH_PATH
    if (!path) {
      throw new Error(
        'SWE-Bench Lite dataset not provided. Set AGENT_EVAL_SWEBENCH_PATH to a JSONL file ' +
          'with the 30 lite instances. STUB: this wrapper does not bundle the dataset; ' +
          'see https://www.swebench.com/lite.html for the canonical source.',
      )
    }
    if (!existsSync(path)) {
      throw new Error(`AGENT_EVAL_SWEBENCH_PATH=${path} does not exist`)
    }
    const all = parseJsonl(path)
    return all.filter((it) => assignSplitImpl(it.id) === split)
  }

  async evaluate(item: SweBenchLiteItem, response: string): Promise<BenchmarkEvaluation> {
    const cmd = process.env.AGENT_EVAL_SWEBENCH_GRADER_CMD
    if (!cmd) {
      throw new Error(
        'SWE-Bench Lite grader not configured. Set AGENT_EVAL_SWEBENCH_GRADER_CMD to an ' +
          'executable that reads {instance_id, patch} JSON on stdin and writes ' +
          '{passed, fail_to_pass_passed, pass_to_pass_passed, log} JSON on stdout. ' +
          'TODO(swebench-lite): bundle a default Docker-based runner once the SDK ' +
          'stabilises (https://github.com/swe-bench/SWE-bench).',
      )
    }
    const stdinPayload = JSON.stringify({ instance_id: item.payload.instanceId, patch: response })
    const result = await runGrader(cmd, stdinPayload)
    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(result.stdout) as Record<string, unknown>
    } catch (e) {
      throw new Error(
        `SWE-Bench grader emitted non-JSON stdout: ${(e as Error).message}\n` +
          `stdout=${result.stdout.slice(0, 400)}\nstderr=${result.stderr.slice(0, 400)}`,
      )
    }
    const passed = Boolean(parsed.passed)
    return {
      score: passed ? 1 : 0,
      raw: {
        passed,
        failToPassPassed: Boolean(parsed.fail_to_pass_passed),
        passToPassPassed: Boolean(parsed.pass_to_pass_passed),
        graderLog: typeof parsed.log === 'string' ? parsed.log.slice(0, 4000) : '',
      },
    }
  }

  assignSplit(itemId: string): RunSplitTag {
    return assignSplitImpl(itemId)
  }
}

function assignSplitImpl(itemId: string): RunSplitTag {
  return deterministicSplit(`swebench-lite::${itemId}`)
}

function parseJsonl(path: string): SweBenchLiteItem[] {
  const raw = readFileSync(path, 'utf8')
  const out: SweBenchLiteItem[] = []
  let lineNo = 0
  for (const line of raw.split('\n')) {
    lineNo++
    const trimmed = line.trim()
    if (!trimmed) continue
    const row = JSON.parse(trimmed) as Record<string, unknown>
    const instanceId = String(row.instance_id ?? row.instanceId ?? '')
    if (!instanceId) {
      throw new Error(`swebench-lite line ${lineNo} missing instance_id`)
    }
    out.push({
      id: instanceId,
      payload: {
        instanceId,
        problemStatement: String(row.problem_statement ?? row.problemStatement ?? ''),
        baseCommit: String(row.base_commit ?? row.baseCommit ?? ''),
        repo: String(row.repo ?? ''),
        failToPass: asStringArray(row.FAIL_TO_PASS ?? row.failToPass),
        passToPass: asStringArray(row.PASS_TO_PASS ?? row.passToPass),
      },
    })
  }
  return out
}

function asStringArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string')
  if (typeof v === 'string') {
    try {
      const parsed = JSON.parse(v)
      if (Array.isArray(parsed)) return parsed.filter((x): x is string => typeof x === 'string')
    } catch {
      // Plain string; treat as a single-element list.
      return [v]
    }
  }
  return []
}

function runGrader(cmd: string, stdin: string): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const parts = cmd.split(/\s+/)
    const child = spawn(parts[0]!, parts.slice(1), { stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (b: Buffer) => (stdout += b.toString('utf8')))
    child.stderr.on('data', (b: Buffer) => (stderr += b.toString('utf8')))
    child.on('error', reject)
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`grader exited with code ${code}: ${stderr.slice(0, 400)}`))
        return
      }
      resolve({ stdout, stderr })
    })
    child.stdin.write(stdin)
    child.stdin.end()
  })
}

const adapter = new SweBenchLiteAdapter()

export const loadDataset = adapter.loadDataset.bind(adapter)
export const evaluate = adapter.evaluate.bind(adapter)
export const assignSplit = adapter.assignSplit.bind(adapter)
export { SweBenchLiteAdapter }
