#!/usr/bin/env tsx
/**
 * Export agent-eval RunRecord[] → prime-rl SFT JSONL.
 *
 * Reads `--runs <ndjson-file>` of `RunRecord`s, filters to high-quality
 * completions, projects through `toSftRows` into the messages-list format
 * prime-rl's SFT trainer consumes, and writes:
 *   - `<out>` — the JSONL training file
 *   - `prime-rl-sft.toml` — a runnable prime-rl SFT config
 *
 * Usage:
 *   pnpm tsx examples/fine-tune-with-prime-rl/export-sft.ts \\
 *     --runs ./synthetic-runs.jsonl \\
 *     --out ./sft-data.jsonl \\
 *     --min-score 0.7 \\
 *     --model-name Qwen/Qwen3-0.6B
 *
 * The script is intentionally small (~150 LoC). Adapt freely; the
 * load-bearing pieces are:
 *   1. Reading `RunRecord`s
 *   2. `toSftRows(...)` (already in `@tangle-network/agent-eval/rl`)
 *   3. `toSftJsonl(...)` (same)
 *   4. Writing a templated TOML
 */

import { promises as fs } from 'node:fs'
import { resolve as resolvePath } from 'node:path'
import { toSftJsonl, toSftRows } from '../../src/rl/exporters'
import type { RunRecord } from '../../src/run-record'

interface CliArgs {
  runs: string
  out: string
  minScore: number
  modelName: string
  promptKey: string
  completionKey: string
  systemKey: string | null
}

function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = {
    runs: 'synthetic-runs.jsonl',
    out: 'sft-data.jsonl',
    minScore: 0.7,
    modelName: 'Qwen/Qwen3-0.6B',
    promptKey: 'prompt',
    completionKey: 'completion',
    systemKey: null,
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    const next = (): string => argv[++i]!
    switch (a) {
      case '--runs': out.runs = next(); break
      case '--out': out.out = next(); break
      case '--min-score': out.minScore = Number(next()); break
      case '--model-name': out.modelName = next(); break
      case '--prompt-key': out.promptKey = next(); break
      case '--completion-key': out.completionKey = next(); break
      case '--system-key': out.systemKey = next(); break
      case '--help':
      case '-h':
        printHelp(); process.exit(0)
    }
  }
  return out
}

function printHelp(): void {
  process.stdout.write(
    'Usage: pnpm tsx examples/fine-tune-with-prime-rl/export-sft.ts [options]\n\n' +
    '  --runs <path>          NDJSON of RunRecords (default: synthetic-runs.jsonl)\n' +
    '  --out <path>           output JSONL path (default: sft-data.jsonl)\n' +
    '  --min-score <float>    drop runs scoring below this (default: 0.7)\n' +
    '  --model-name <id>      HuggingFace model id for the TOML (default: Qwen/Qwen3-0.6B)\n' +
    '  --prompt-key <key>     where prompt text lives in outcome.raw (default: prompt)\n' +
    '  --completion-key <key> where completion text lives in outcome.raw (default: completion)\n' +
    '  --system-key <key>     optional system message key in outcome.raw\n',
  )
}

async function readNdjson<T>(path: string): Promise<T[]> {
  const body = await fs.readFile(path, 'utf8')
  const out: T[] = []
  for (const line of body.split('\n')) {
    if (!line.trim()) continue
    out.push(JSON.parse(line) as T)
  }
  return out
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const runs = await readNdjson<RunRecord>(args.runs)
  process.stdout.write(`✓ read ${runs.length} runs from ${args.runs}\n`)

  // Filter to high-quality runs (rejection-sampling SFT). The score floor
  // is the most important hyperparameter — too low and the model learns to
  // mimic mediocre completions; too high and you starve it of data.
  const filtered = runs.filter((r) => {
    const s = r.outcome.holdoutScore ?? r.outcome.searchScore
    return typeof s === 'number' && s >= args.minScore
  })
  process.stdout.write(`✓ filtered to ${filtered.length} high-quality (score ≥ ${args.minScore}) runs\n`)

  if (filtered.length === 0) {
    process.stderr.write('error: no runs passed the score filter; lower --min-score or check your data\n')
    process.exit(1)
  }

  // Project to SFT rows. The lookups here read prompt/completion text out
  // of `outcome.raw`. Real consumers usually store the text in a
  // `TraceStore` and recover it via `iterateRawCalls`; that's a 5-line
  // change to the lookups below.
  const rows = await toSftRows(filtered, {
    promptOf: (runId) => {
      const run = filtered.find((r) => r.runId === runId)!
      const text = run.outcome.raw[args.promptKey]
      return typeof text === 'string' ? text : `<no prompt for ${runId}>`
    },
    completionOf: (runId) => {
      const run = filtered.find((r) => r.runId === runId)!
      const text = run.outcome.raw[args.completionKey]
      return typeof text === 'string' ? text : `<no completion for ${runId}>`
    },
    systemOf: args.systemKey
      ? (run) => {
        const text = run.outcome.raw[args.systemKey!]
        return typeof text === 'string' ? text : null
      }
      : undefined,
  })

  const jsonl = toSftJsonl(rows)
  await fs.writeFile(args.out, jsonl, 'utf8')
  process.stdout.write(`✓ wrote ${rows.length} SFT rows to ${args.out}\n`)

  // Write the prime-rl SFT TOML alongside.
  const tomlPath = resolvePath(args.out.replace(/\.jsonl$/, '') + '.prime-rl-sft.toml')
  const toml = `# Generated by export-sft.ts — edit freely
max_steps = 100

[model]
name = "${args.modelName}"

[data]
name = "${resolvePath(args.out)}"
seq_len = 4096
batch_size = 32

[optim]
lr = 2e-5

[ckpt]
# leave default; prime-rl writes to outputs/weights/
`
  await fs.writeFile(tomlPath, toml, 'utf8')
  process.stdout.write(`✓ wrote prime-rl config to ${tomlPath}\n`)
  process.stdout.write(`\nNext: cd into your prime-rl clone and run:\n  uv run sft @ ${tomlPath}\n`)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`)
    process.exit(1)
  })
}
