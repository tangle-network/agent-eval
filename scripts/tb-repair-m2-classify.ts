/** Offline check: which recorded findings the action budget admits, and why.
 *  Pure — no container, no model — so it can run beside a live measurement. */
import { readFileSync } from 'node:fs'
import { classifyActionPayload } from '../src/trace-repair'

interface Answer {
  arm: string
  rowId: string
  status: string
  interventionKind: string | null
  action: string | null
  actionBytes: number | null
}
for (const file of process.argv.slice(2)) {
  const doc = JSON.parse(readFileSync(file, 'utf8')) as { answers: Answer[] }
  for (const answer of doc.answers) {
    if (answer.status !== 'finding' || answer.action === null) continue
    const payload = classifyActionPayload(answer.action)
    process.stdout.write(
      [
        answer.arm,
        answer.rowId.split('::')[0],
        String(answer.actionBytes),
        `declared=${answer.interventionKind}`,
        `payload=${payload}`,
        payload === answer.interventionKind ? 'label-matches' : 'label-mismatch',
      ].join('\t') + '\n',
    )
  }
}
