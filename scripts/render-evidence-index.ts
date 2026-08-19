/**
 * Render `evidence/INDEX.md` from `evidence/records/*.json`, or verify it.
 *
 *   pnpm run evidence:render   — validate every record and rewrite the index
 *   pnpm run evidence:check    — validate + fail when the committed index
 *                                differs from what the records render to
 *
 * The check runs inside `verify:package`, so a record that breaks the schema
 * or an index edited by hand fails the same local gate that guards releases.
 */

import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { renderEvidenceIndex } from '../src/experiment/evidence-record'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const recordsDir = resolve(repoRoot, 'evidence/records')
const indexPath = resolve(repoRoot, 'evidence/INDEX.md')
const checkMode = process.argv.includes('--check')

const files = readdirSync(recordsDir)
  .filter((name) => name.endsWith('.json'))
  .sort()

if (files.length === 0) {
  console.error(`no evidence records found in ${recordsDir}`)
  process.exit(1)
}

const raws = files.map((name) => {
  const path = resolve(recordsDir, name)
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    console.error(`evidence record is not valid JSON: ${path}`)
    console.error(String(error))
    process.exit(1)
  }
  const id = (parsed as { id?: unknown }).id
  if (id !== name.replace(/\.json$/, '')) {
    console.error(
      `evidence record filename must equal its id: ${name} declares id ${JSON.stringify(id)}`,
    )
    process.exit(1)
  }
  return parsed
})

let rendered: string
try {
  rendered = renderEvidenceIndex(raws)
} catch (error) {
  console.error('evidence registry validation failed:')
  console.error(String(error))
  process.exit(1)
}

if (checkMode) {
  let committed: string
  try {
    committed = readFileSync(indexPath, 'utf8')
  } catch {
    console.error(`evidence index is missing: ${indexPath} — run pnpm run evidence:render`)
    process.exit(1)
  }
  if (committed !== rendered) {
    console.error(
      'evidence/INDEX.md is stale: it does not match evidence/records/*.json.\n' +
        'Run pnpm run evidence:render and commit the result.',
    )
    process.exit(1)
  }
  console.log(`evidence index is fresh: ${files.length} records, index matches`)
} else {
  writeFileSync(indexPath, rendered)
  console.log(`rendered ${indexPath} from ${files.length} records`)
}
