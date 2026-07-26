#!/usr/bin/env tsx
/**
 * Package graded agent-eval runs into a publishable RL dataset bundle.
 *
 * Build trainer JSONL, a manifest, and a datasheet from graded runs.
 * SFT is the default because it needs one scored completion per scenario.
 * Request GRPO only for corpora with multiple rewarded completions per
 * scenario.
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
 * Core steps:
 *   1. Read `RunRecord`s that carry trajectory text.
 *   2. Build `{promptOf, completionOf}` lookups that resolve text by runId.
 *   3. Mint canonical rollout lines with `mintRolloutRows`.
 *   4. `buildRlDataset(lines, lookups, config)` and write the bundle.
 */

import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { resolve as resolvePath } from 'node:path'
import {
  buildRlDataset,
  type DatasetFormat,
  type RewardKind,
  validateDatasetFormats,
} from '../../src/rl/dataset'
import { mintRolloutRows } from '../../src/rollout/mint'
import { type RunRecord, runTaskScore, validateRunRecord } from '../../src/run-record'
import { InMemoryTraceStore } from '../../src/trace/store'

export interface CliArgs {
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
  allowHeldOutTrainingData: boolean
}

export function parseArgs(argv: string[]): CliArgs {
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
    intendedUse: 'SFT on the task domain',
    outOfScope: 'production advice to end users',
    limitations: 'small sample; hosted-model generations',
    formats: ['sft'],
    // Allowed here — this is a runnable script, not substrate code (the
    // substrate forbids Date.now() so callers pass the timestamp in).
    createdAtIso: new Date().toISOString(),
    promptKey: 'prompt',
    completionKey: 'completion',
    allowHeldOutTrainingData: false,
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    const next = (): string => {
      const value = argv[++i]
      if (value === undefined || value.startsWith('--')) {
        throw new Error(`${a} requires a value`)
      }
      return value
    }
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
        {
          const value = next()
          if (value !== 'deterministic' && value !== 'probabilistic' && value !== 'mixed') {
            throw new Error(
              `--reward-kind must be deterministic, probabilistic, or mixed; received "${value}"`,
            )
          }
          out.rewardKind = value
        }
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
        {
          const formats = validateDatasetFormats(next().split(','))
          if (formats.includes('dpo')) {
            throw new Error(
              '--formats dpo requires preference triples; this CLI does not accept them',
            )
          }
          out.formats = formats
        }
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
      case '--allow-held-out-training-data':
        out.allowHeldOutTrainingData = true
        break
      case '--help':
      case '-h':
        printHelp()
        process.exit(0)
        break
      default:
        throw new Error(`unknown option "${a}"`)
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
      '  --formats <a,b>        comma list of grpo,sft (default: sft)\n' +
      '  --created-at <iso>     ISO timestamp (default: now)\n' +
      '  --prompt-key <key>     top-level record key holding the prompt (default: prompt)\n' +
      '  --completion-key <key> top-level record key holding the completion (default: completion)\n' +
      '  --allow-held-out-training-data  explicitly include holdout runs\n',
  )
}

export type WithText = RunRecord & Record<string, unknown>

export async function readNdjson(path: string): Promise<WithText[]> {
  const body = await fs.readFile(path, 'utf8')
  const out: WithText[] = []
  for (const [index, line] of body.split('\n').entries()) {
    if (!line.trim()) continue
    try {
      const parsed: unknown = JSON.parse(line)
      out.push(validateRunRecord(parsed) as WithText)
    } catch (error) {
      throw new Error(
        `invalid RunRecord at ${path}:${index + 1}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      )
    }
  }
  return out
}

export function collectTrajectoryText(
  records: WithText[],
  promptKey: string,
  completionKey: string,
): {
  text: Map<string, { prompt: string; completion: string }>
  dedupPassed: true
} {
  const text = new Map<string, { prompt: string; completion: string }>()
  const exampleHashes = new Map<string, string>()
  for (const record of records) {
    if (text.has(record.runId)) {
      throw new Error(`duplicate runId "${record.runId}"`)
    }

    const prompt = record[promptKey]
    const completion = record[completionKey]
    if (
      typeof prompt !== 'string' ||
      prompt.trim().length === 0 ||
      typeof completion !== 'string' ||
      completion.trim().length === 0
    ) {
      throw new Error(
        `run ${record.runId} is missing non-empty string "${promptKey}"/"${completionKey}"; ` +
          'capture trajectory text before packaging',
      )
    }

    const exampleHash = createHash('sha256')
      .update(prompt)
      .update('\0')
      .update(completion)
      .digest('hex')
    const duplicateRunId = exampleHashes.get(exampleHash)
    if (duplicateRunId !== undefined) {
      throw new Error(
        `duplicate prompt/completion in runs "${duplicateRunId}" and "${record.runId}"`,
      )
    }

    exampleHashes.set(exampleHash, record.runId)
    text.set(record.runId, { prompt, completion })
  }
  return { text, dedupPassed: true }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const records = await readNdjson(args.runs)
  const scoredRecords = records.filter((record) => runTaskScore(record) !== undefined)
  if (scoredRecords.length === 0) {
    throw new Error('no scored runs remain; grade the runs before packaging them')
  }
  const { text, dedupPassed } = collectTrajectoryText(
    scoredRecords,
    args.promptKey,
    args.completionKey,
  )
  const { rows: rolloutLines } = await mintRolloutRows(
    scoredRecords,
    new InMemoryTraceStore(),
  )
  const verifiableRewardFilterPassed =
    args.rewardKind === 'deterministic' &&
    rolloutLines.every((line) => line.outcome.reward !== null)
  process.stdout.write(`validated ${records.length} runs from ${args.runs}\n`)
  process.stdout.write(`minted ${rolloutLines.length} scored rollout lines\n`)

  const lookups = {
    promptOf: (id: string) => text.get(id)!.prompt,
    completionOf: (id: string) => text.get(id)!.completion,
    allowHeldOutTrainingData: args.allowHeldOutTrainingData,
  }

  const bundle = await buildRlDataset(rolloutLines, lookups, {
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
    qualityGates: {
      contaminationProbe: 'not-run',
      dedup: dedupPassed,
      verifiableRewardFilter: verifiableRewardFilterPassed,
    },
  })

  const outDir = resolvePath(args.out)
  await fs.mkdir(outDir, { recursive: true })
  for (const [name, content] of Object.entries(bundle.files)) {
    await fs.writeFile(resolvePath(outDir, name), content, 'utf8')
  }
  process.stdout.write(`✓ wrote bundle to ${outDir}\n`)
  process.stdout.write(`  files: ${Object.keys(bundle.files).join(', ')}\n`)
  const s = bundle.manifest.stats
  const rewardMean = s.reward.mean === null ? 'n/a' : s.reward.mean.toFixed(3)
  process.stdout.write(
    `  ${s.records} records · reward mean=${rewardMean} · holdout=${s.splits.holdout} · cost=$${s.totalCostUsd.toFixed(2)}\n`,
  )
  process.stdout.write(`\n--- DATASHEET.md ---\n${bundle.files['DATASHEET.md']}`)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`)
    process.exit(1)
  })
}
