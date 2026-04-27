/**
 * GSM8K wrapper — exact-match grading on the final numeric answer.
 *
 * The dataset itself is NOT bundled. `loadDataset` will:
 *   1. read from `process.env.AGENT_EVAL_GSM8K_PATH` if set (a JSONL
 *      file with `{ id, question, answer }` records — the standard
 *      HF mirror layout converted to JSONL);
 *   2. otherwise throw a clearly-marked error pointing to the loader.
 *
 * `evaluate` parses the final number out of the response (last
 * occurrence of a signed-decimal-or-integer literal, optionally after
 * `####`, the GSM8K answer convention) and compares to the ground-
 * truth integer. Floating-point comparisons use a 1e-6 tolerance.
 */

import { existsSync, readFileSync } from 'node:fs'

import type {
  BenchmarkAdapter,
  BenchmarkDatasetItem,
  BenchmarkEvaluation,
} from '../types'
import { deterministicSplit } from '../types'
import type { RunSplitTag } from '../../run-record'

export interface Gsm8kPayload {
  question: string
  /** Reference answer, post-#### normalization. May be a number or
   *  a numeric string ("72", "1.5"). */
  answer: string
}

export type Gsm8kItem = BenchmarkDatasetItem<Gsm8kPayload>

class Gsm8kAdapter implements BenchmarkAdapter<Gsm8kItem, Gsm8kPayload> {
  async loadDataset(split: RunSplitTag): Promise<Gsm8kItem[]> {
    const path = process.env.AGENT_EVAL_GSM8K_PATH
    if (!path) {
      throw new Error(
        'GSM8K dataset not provided. Set AGENT_EVAL_GSM8K_PATH to a JSONL file ' +
          'with {id, question, answer} records (the HF GSM8K mirror converted to JSONL).',
      )
    }
    if (!existsSync(path)) {
      throw new Error(`AGENT_EVAL_GSM8K_PATH=${path} does not exist`)
    }
    const items = parseJsonl(path).filter((it) => assignSplitImpl(it.id) === split)
    return items
  }

  async evaluate(item: Gsm8kItem, response: string): Promise<BenchmarkEvaluation> {
    const expected = parseGsm8kAnswer(item.payload.answer)
    const observed = parseGsm8kAnswer(response)
    if (expected === null) {
      // Defensive: the dataset should never ship a non-numeric ref.
      return { score: 0, raw: { reason: 'reference_not_numeric', expected: item.payload.answer } }
    }
    if (observed === null) {
      return { score: 0, raw: { reason: 'no_numeric_in_response', expected, observed: null } }
    }
    const ok = Math.abs(expected - observed) < 1e-6
    return { score: ok ? 1 : 0, raw: { expected, observed, exactMatch: ok } }
  }

  assignSplit(itemId: string): RunSplitTag {
    return assignSplitImpl(itemId)
  }
}

function assignSplitImpl(itemId: string): RunSplitTag {
  return deterministicSplit(`gsm8k::${itemId}`)
}

function parseJsonl(path: string): Gsm8kItem[] {
  const raw = readFileSync(path, 'utf8')
  const out: Gsm8kItem[] = []
  let lineNo = 0
  for (const line of raw.split('\n')) {
    lineNo++
    const trimmed = line.trim()
    if (!trimmed) continue
    let row: Record<string, unknown>
    try {
      row = JSON.parse(trimmed) as Record<string, unknown>
    } catch (e) {
      throw new Error(`GSM8K JSONL parse error at line ${lineNo}: ${(e as Error).message}`)
    }
    const id = String(row.id ?? `gsm8k_${lineNo}`)
    const question = String(row.question ?? '')
    const answer = String(row.answer ?? '')
    if (!question || !answer) {
      throw new Error(`GSM8K JSONL line ${lineNo} missing question/answer`)
    }
    out.push({ id, payload: { question, answer } })
  }
  return out
}

/**
 * Parse a GSM8K-style answer. Honors the dataset's `#### N`
 * convention (the canonical answer comes after `####`); otherwise
 * returns the LAST signed numeric literal in the string.
 */
export function parseGsm8kAnswer(text: string): number | null {
  if (!text) return null
  const afterMarker = text.match(/####\s*(-?\d[\d,]*\.?\d*)/)
  if (afterMarker) {
    const cleaned = afterMarker[1]!.replace(/,/g, '')
    const v = Number(cleaned)
    if (Number.isFinite(v)) return v
  }
  // Last numeric literal anywhere in the string.
  const matches = text.match(/-?\d[\d,]*\.?\d*/g)
  if (!matches || matches.length === 0) return null
  const last = matches[matches.length - 1]!
  const cleaned = last.replace(/,/g, '')
  const v = Number(cleaned)
  return Number.isFinite(v) ? v : null
}

const adapter = new Gsm8kAdapter()

export const loadDataset = adapter.loadDataset.bind(adapter)
export const evaluate = adapter.evaluate.bind(adapter)
export const assignSplit = adapter.assignSplit.bind(adapter)
export { Gsm8kAdapter }
