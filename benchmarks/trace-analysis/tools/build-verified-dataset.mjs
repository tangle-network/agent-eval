#!/usr/bin/env node
// Build a verified-findings dataset from a replay-verify batch run.
//
// Joins batch-report.json (executed verdicts + fix arms) with the gold label
// corpora and the normalized trajectories, then writes:
//   <out>/rows.jsonl      one VerifiedFindingRow per replayable case
//   <out>/manifest.json   summary + full source provenance + emitted-file shas
//
// Imports the package's own join from dist/ (build first: pnpm build).
//
// Usage:
//   build-verified-dataset.mjs --report PATH --run-id ID --out DIR \
//     --corpus NAME=LABELS_PATH::PREPARED_DIR [--corpus ...] \
//     [--run-dir DIR] [--max-obs N]
//
// --run-dir points at the batch run directory holding per-case
// `<corpus>--<trajId>/replay-verdict.json`; when given, every case must have
// one (divergence detail + arm A command + run ids join into the rows).
// Every join failure is fatal — a partially joined dataset is never written.

import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const dist = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..', 'dist', 'rl.js')
const { loadVerifiedFindingsDataset, verifiedFindingsToJsonl, VERIFIED_FINDING_SCHEMA } = await import(dist)

function parseArgs(argv) {
  const args = { corpora: {}, maxObservationChars: undefined, runDir: undefined }
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    const value = () => {
      const v = argv[++i]
      if (v === undefined) throw new Error(`missing value for ${flag}`)
      return v
    }
    if (flag === '--report') args.batchReportPath = value()
    else if (flag === '--run-id') args.runId = value()
    else if (flag === '--out') args.out = value()
    else if (flag === '--run-dir') args.runDir = value()
    else if (flag === '--max-obs') args.maxObservationChars = Number(value())
    else if (flag === '--corpus') {
      const spec = value()
      const eq = spec.indexOf('=')
      const sep = spec.indexOf('::')
      if (eq < 1 || sep < eq) throw new Error(`--corpus expects NAME=LABELS_PATH::PREPARED_DIR, got: ${spec}`)
      args.corpora[spec.slice(0, eq)] = {
        labelsPath: spec.slice(eq + 1, sep),
        preparedDir: spec.slice(sep + 2),
      }
    } else throw new Error(`unknown flag: ${flag}`)
  }
  for (const required of ['batchReportPath', 'runId', 'out']) {
    if (!args[required]) throw new Error(`--${required.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)} is required`)
  }
  if (Object.keys(args.corpora).length === 0) throw new Error('at least one --corpus is required')
  return args
}

const args = parseArgs(process.argv.slice(2))
const dataset = loadVerifiedFindingsDataset({
  batchReportPath: args.batchReportPath,
  runId: args.runId,
  corpora: args.corpora,
  runDir: args.runDir,
  maxObservationChars: args.maxObservationChars,
})

mkdirSync(args.out, { recursive: true })
const jsonl = verifiedFindingsToJsonl(dataset.rows)
const rowsPath = join(args.out, 'rows.jsonl')
writeFileSync(rowsPath, jsonl)
const rowsSha256 = createHash('sha256').update(readFileSync(rowsPath)).digest('hex')

const manifest = {
  schema: VERIFIED_FINDING_SCHEMA,
  generatedAt: new Date().toISOString(),
  summary: dataset.summary,
  provenance: dataset.provenance,
  files: { 'rows.jsonl': { sha256: rowsSha256, bytes: Buffer.byteLength(jsonl) } },
}
writeFileSync(join(args.out, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)

const s = dataset.summary
console.log(`verified-findings dataset → ${args.out}`)
console.log(`rows: ${s.rows} | reproduced: ${s.reproduced} | signature-strict: ${s.signatureStrict}`)
console.log(
  `fix: flipped ${s.fix.flipped}, not-flipped ${s.fix['not-flipped']}, generation-failed ${s.fix['generation-failed']}, not-attempted ${s.fix['not-attempted']}`,
)
for (const [corpus, c] of Object.entries(s.byCorpus)) {
  console.log(`  ${corpus}: rows ${c.rows}, reproduced ${c.reproduced}, fix-flipped ${c.fixFlipped}`)
}
console.log(`rows.jsonl sha256 ${rowsSha256}`)
