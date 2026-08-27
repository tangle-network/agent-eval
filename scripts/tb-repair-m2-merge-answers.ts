/**
 * Collapse the passes of phase 2 into the ONE answer set phase 4 grades.
 *
 * A reissue writes its own file beside the pass before it, so an arm can hold
 * two records for the same row: the carrier fault, and the answer the reissue
 * got. Grading both would enter one arm twice for one row and quietly double
 * that arm's denominator, which is the failure this script exists to make
 * impossible.
 *
 * Later files win. The merge then asserts what the grader depends on — one
 * answer per arm and row, and the exact row count the subset pre-registered —
 * and fails loudly rather than writing a set nobody checked.
 *
 * Usage: tb-repair-m2-merge-answers.ts <out.json> <in.json...>
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { AnswerRecord } from './tb-repair-m2-analyze'

interface AnswerDoc {
  arms?: { id: string; execution: string }[]
  provenance?: { arm: string; rowId: string; source: string }[]
  answers: AnswerRecord[]
}

function main(): void {
  const [outPath, ...inputs] = process.argv.slice(2)
  if (!outPath || inputs.length === 0) {
    throw new Error('usage: tb-repair-m2-merge-answers.ts <out.json> <in.json...>')
  }
  const answers = new Map<string, AnswerRecord>()
  const provenance = new Map<string, { arm: string; rowId: string; source: string }>()
  const arms = new Map<string, { id: string; execution: string }>()
  const superseded: string[] = []
  for (const input of inputs) {
    const doc = JSON.parse(readFileSync(input, 'utf8')) as AnswerDoc
    for (const arm of doc.arms ?? []) arms.set(arm.id, arm)
    for (const entry of doc.provenance ?? []) provenance.set(`${entry.arm}::${entry.rowId}`, entry)
    for (const answer of doc.answers) {
      const key = `${answer.arm}::${answer.rowId}`
      const previous = answers.get(key)
      if (previous) superseded.push(`${key} (${previous.status}/${previous.failure ?? 'ok'} -> ${answer.status})`)
      answers.set(key, answer)
    }
  }

  const subsetPath = join(dirname(outPath), 'row-subset.json')
  const subset = new Set(JSON.parse(readFileSync(subsetPath, 'utf8')) as string[])
  const merged = [...answers.values()]
  for (const arm of arms.keys()) {
    const rows = merged.filter((answer) => answer.arm === arm)
    const missing = [...subset].filter((rowId) => !rows.some((answer) => answer.rowId === rowId))
    if (missing.length > 0) {
      throw new Error(`arm ${arm} is missing ${missing.length} of the ${subset.size} pre-registered rows`)
    }
    if (rows.length !== subset.size) {
      throw new Error(`arm ${arm} carries ${rows.length} answers for ${subset.size} rows`)
    }
  }

  writeFileSync(
    outPath,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        mergedFrom: inputs,
        superseded,
        arms: [...arms.values()],
        provenance: [...provenance.values()],
        answers: merged,
      },
      null,
      2,
    ),
  )
  process.stdout.write(
    `merged ${merged.length} answers across ${arms.size} arms -> ${outPath}\n` +
      `superseded ${superseded.length}: ${superseded.join(', ') || 'none'}\n`,
  )
}

main()
