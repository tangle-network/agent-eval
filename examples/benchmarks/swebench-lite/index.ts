/**
 * SWE-Bench Lite wrapper — 30-instance subset.
 *
 * The official grader needs a Docker host and repository cache, so this
 * wrapper keeps the package lightweight and delegates grading to a
 * caller-provided executable.
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
 * If the dataset or grader is not configured, public methods throw a
 * clearly-marked setup error. This adapter never silently scores zero.
 */

import { existsSync, readFileSync } from 'node:fs'
import { spawn } from 'node:child_process'

import type {
  BenchmarkAdapter,
  BenchmarkDatasetItem,
  BenchmarkEvaluation,
} from '../../../src/benchmarks/types'
import { deterministicSplit } from '../../../src/benchmarks/types'
import type { RunSplitTag } from '../../../src/run-record'

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
          'with the 30 lite instances. This wrapper does not bundle the dataset; ' +
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
          'This wrapper intentionally delegates Docker-based grading to the configured command.',
      )
    }
    const stdinPayload = JSON.stringify({ instance_id: item.payload.instanceId, patch: response })
    const timeoutMs = parsePositiveInt(process.env.AGENT_EVAL_SWEBENCH_GRADER_TIMEOUT_MS, 300_000)
    const result = await runGrader(cmd, stdinPayload, timeoutMs)
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
    const row = parseJsonRow(trimmed, lineNo)
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

function parseJsonRow(line: string, lineNo: number): Record<string, unknown> {
  try {
    return JSON.parse(line) as Record<string, unknown>
  } catch (e) {
    throw new Error(`swebench-lite JSONL parse error at line ${lineNo}: ${(e as Error).message}`)
  }
}

export function parseSweBenchGraderCommand(cmd: string): string[] {
  const parts: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null
  let escaping = false
  for (const ch of cmd.trim()) {
    if (escaping) {
      current += ch
      escaping = false
      continue
    }
    if (ch === '\\') {
      escaping = true
      continue
    }
    if (quote) {
      if (ch === quote) quote = null
      else current += ch
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      continue
    }
    if (/\s/.test(ch)) {
      if (current) {
        parts.push(current)
        current = ''
      }
      continue
    }
    current += ch
  }
  if (escaping) current += '\\'
  if (quote) throw new Error(`SWE-Bench grader command has an unterminated ${quote} quote`)
  if (current) parts.push(current)
  if (parts.length === 0) throw new Error('SWE-Bench grader command is empty')
  return parts
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback
  const parsed = Number(raw)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
}

function runGrader(cmd: string, stdin: string, timeoutMs: number): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    let parts: string[]
    try {
      parts = parseSweBenchGraderCommand(cmd)
    } catch (e) {
      reject(e)
      return
    }
    const child = spawn(parts[0]!, parts.slice(1), { stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let settled = false
    const timer = setTimeout(() => {
      settled = true
      child.kill('SIGTERM')
      reject(new Error(`SWE-Bench grader timed out after ${timeoutMs}ms`))
    }, timeoutMs)
    child.stdout.on('data', (b: Buffer) => (stdout += b.toString('utf8')))
    child.stderr.on('data', (b: Buffer) => (stderr += b.toString('utf8')))
    child.on('error', (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(err)
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
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
