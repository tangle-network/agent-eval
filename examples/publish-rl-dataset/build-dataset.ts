#!/usr/bin/env tsx
/**
 * Package graded agent-eval RunRecord[] → a publishable RL dataset bundle.
 *
 * This is the step AFTER `examples/fine-tune-with-prime-rl/export-sft.ts`:
 * instead of one trainer file, it emits the whole publishable/sellable
 * artifact via `buildRlDataset` — the trainer JSONL (GRPO + SFT) plus a
 * `manifest.json` and a "Datasheet for Datasets" card whose reward-provenance
 * section is the credibility axis a buyer checks first (deterministic
 * verifiable reward vs probabilistic judge).
 *
 * Usage:
 *   pnpm tsx examples/publish-rl-dataset/build-dataset.ts \\
 *     --runs ./taxcalc-runs.jsonl \\
 *     --out ./bundle \\
 *     --name tax-1040-rl --version 0.1.0 --domain tax-1040-ty24 \\
 *     --license "Tangle Commercial" \\
 *     --reward-kind deterministic \\
 *     --reward-source "TaxCalcBench XPath line-match" \\
 *     --reward-desc "fraction of 1040 lines matching ground truth"
 *
 * The load-bearing pieces (everything else is CLI plumbing):
 *   1. Read `RunRecord`s that carry trajectory text.
 *   2. Build `{promptOf, completionOf}` lookups that resolve text by runId.
 *   3. `buildRlDataset(records, lookups, config)` (in `src/rl/dataset`).
 *   4. Write `bundle.files` to a directory.
 */

import { promises as fs } from 'node:fs'
import { resolve as resolvePath } from 'node:path'
import { type RewardKind, buildRlDataset, type DatasetFormat } from '../../src/rl/dataset'
import type { RunRecord } from '../../src/run-record'

interface CliArgs {
  runs: string
  out: string
  name: string
  version: string
  domain: string
  license: string
  rewardKind: RewardKind
  rewardSource: string
  rewardDesc: string
  intendedUse: string
  outOfScope: string
  limitations: string
  formats: DatasetFormat[]
  createdAtIso: string
  /** Top-level record keys holding the trajectory text. */
  promptKey: string
  completionKey: string
}

function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = {
    runs: 'taxcalc-runs.jsonl',
    out: 'bundle',
    name: 'example-rl',
    version: '0.1.0',
    domain: 'example',
    license: 'Tangle Commercial',
    rewardKind: 'deterministic',
    rewardSource: 'verifiable scorer',
    rewardDesc: 'objective, decidable reward (not judge-noise)',
    intendedUse: 'SFT / GRPO on the task domain',
    outOfScope: 'production advice to end users',
    limitations: 'small sample; hosted-model generations',
    formats: ['grpo', 'sft'],
    // Allowed here — this is a runnable script, not substrate code (the
    // substrate forbids Date.now() so callers pass the timestamp in).
    createdAtIso: new Date().toISOString(),
    promptKey: 'prompt',
    completionKey: 'completion',
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    const next = (): string => argv[++i]!
    switch (a) {
      case '--runs':
        out.runs = next()
        break
      case '--out':
        out.out = next()
        break
      case '--name':
        out.name = next()
        break
      case '--version':
        out.version = next()
        break
      case '--domain':
        out.domain = next()
        break
      case '--license':
        out.license = next()
        break
      case '--reward-kind':
        out.rewardKind = next() as RewardKind
        break
      case '--reward-source':
        out.rewardSource = next()
        break
      case '--reward-desc':
        out.rewardDesc = next()
        break
      case '--intended-use':
        out.intendedUse = next()
        break
      case '--out-of-scope':
        out.outOfScope = next()
        break
      case '--limitations':
        out.limitations = next()
        break
      case '--formats':
        out.formats = next().split(',') as DatasetFormat[]
        break
      case '--created-at':
        out.createdAtIso = next()
        break
      case '--prompt-key':
        out.promptKey = next()
        break
      case '--completion-key':
        out.completionKey = next()
        break
      case '--help':
      case '-h':
        printHelp()
        process.exit(0)
    }
  }
  return out
}

function printHelp(): void {
  process.stdout.write(
    'Usage: pnpm tsx examples/publish-rl-dataset/build-dataset.ts [options]\n\n' +
      '  --runs <path>          NDJSON of RunRecords carrying trajectory text (default: taxcalc-runs.jsonl)\n' +
      '  --out <dir>            output directory for the bundle (default: bundle)\n' +
      '  --name <id>            dataset name\n' +
      '  --version <semver>     dataset version\n' +
      '  --domain <id>          task domain, e.g. tax-1040-ty24\n' +
      '  --license <id>         SPDX id or named commercial license (required to publish)\n' +
      '  --reward-kind <k>      deterministic | probabilistic | mixed\n' +
      '  --reward-source <s>    where the reward came from (e.g. an XPath line-match)\n' +
      '  --reward-desc <s>      one line describing what the reward measures\n' +
      '  --intended-use <s>     recommended uses\n' +
      '  --out-of-scope <s>     out-of-scope uses\n' +
      '  --limitations <s>      known limitations\n' +
      '  --formats <a,b>        comma list of grpo,sft,dpo (default: grpo,sft)\n' +
      '  --created-at <iso>     ISO timestamp (default: now)\n' +
      '  --prompt-key <key>     top-level record key holding the prompt (default: prompt)\n' +
      '  --completion-key <key> top-level record key holding the completion (default: completion)\n',
  )
}

type WithText = RunRecord & Record<string, unknown>

async function readNdjson(path: string): Promise<WithText[]> {
  const body = await fs.readFile(path, 'utf8')
  const out: WithText[] = []
  for (const line of body.split('\n')) {
    if (!line.trim()) continue
    out.push(JSON.parse(line) as WithText)
  }
  return out
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const records = await readNdjson(args.runs)
  process.stdout.write(`✓ read ${records.length} runs from ${args.runs}\n`)

  // The capture step persists prompt/completion at the record top level (see
  // tax-agent's run_taxcalc.py). A real consumer storing text in a TraceStore
  // would swap these two functions for `iterateRawCalls` lookups — a 5-line
  // change. Fail loud if a record is missing the text rather than silently
  // shipping an empty completion into a paid dataset.
  const text = new Map<string, { prompt: string; completion: string }>()
  for (const r of records) {
    const prompt = r[args.promptKey]
    const completion = r[args.completionKey]
    if (typeof prompt !== 'string' || typeof completion !== 'string') {
      throw new Error(
        `run ${r.runId} is missing string "${args.promptKey}"/"${args.completionKey}" — ` +
          'capture trajectory text before packaging (see README)',
      )
    }
    text.set(r.runId, { prompt, completion })
  }
  const lookups = {
    promptOf: (id: string) => text.get(id)!.prompt,
    completionOf: (id: string) => text.get(id)!.completion,
  }

  const bundle = await buildRlDataset(records, lookups, {
    name: args.name,
    version: args.version,
    domain: args.domain,
    license: args.license,
    reward: { kind: args.rewardKind, source: args.rewardSource, description: args.rewardDesc },
    intendedUse: args.intendedUse,
    outOfScope: args.outOfScope,
    limitations: args.limitations,
    formats: args.formats,
    createdAtIso: args.createdAtIso,
    qualityGates: { contaminationProbe: 'not-run', dedup: true, verifiableRewardFilter: true },
  })

  const outDir = resolvePath(args.out)
  await fs.mkdir(outDir, { recursive: true })
  for (const [name, content] of Object.entries(bundle.files)) {
    await fs.writeFile(resolvePath(outDir, name), content, 'utf8')
  }
  process.stdout.write(`✓ wrote bundle to ${outDir}\n`)
  process.stdout.write(`  files: ${Object.keys(bundle.files).join(', ')}\n`)
  const s = bundle.manifest.stats
  process.stdout.write(
    `  ${s.records} records · reward mean=${s.reward.mean.toFixed(3)} · holdout=${s.splits.holdout} · cost=$${s.totalCostUsd.toFixed(2)}\n`,
  )
  process.stdout.write(`\n--- DATASHEET.md ---\n${bundle.files['DATASHEET.md']}`)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`)
    process.exit(1)
  })
}
