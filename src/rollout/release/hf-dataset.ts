/**
 * One-command HuggingFace dataset release from rollout ledgers:
 *
 *   agent-eval rollout-release <ledger.jsonl...> --out <dir> \
 *     [--formats sft,verifiers,rft,raw] [--include-proposers] [--push <org/name>]
 *
 * Pipeline per input ledger: read + validate → fail-closed filters
 * (trainable split only; proposer sessions dropped unless
 * --include-proposers, they contain improvement-loop harness source) →
 * deterministic scrub → export the requested formats + scrub-report.json +
 * auto-generated README.md card. Deterministic: same inputs and flags →
 * byte-identical output dir.
 *
 * --push uploads the built dir with `huggingface-cli upload` only when the
 * CLI exists on PATH and HF_TOKEN is present in the env; the token is
 * never printed. Everything else runs fully offline.
 */

import { spawnSync } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { toJsonl, toRftItems, toSftRows, toVerifiersRolloutOutputs } from '../exporters'
import { readRolloutLedger, writeRolloutLedger } from '../ledger'
import { isTrainableSplit, type RolloutLine } from '../schema'
import { buildDatasetCard, FORMAT_FILES, RELEASE_FORMATS, type ReleaseFormat } from './card'
import { addScrubCounts, emptyScrubCounts, type ScrubCounts, scrubLines } from './scrub'

export interface BuildOptions {
  out: string
  formats: ReleaseFormat[]
  includeProposers: boolean
}

export interface ScrubReport {
  /** Input ledger path → rule → rewrite count (only shipped lines are scrubbed). */
  files: Record<string, ScrubCounts>
  totals: ScrubCounts
  excluded: { proposers: number; nonTrain: number }
}

export interface BuildSummary {
  inputs: string[]
  read: number
  kept: number
  scrub: ScrubReport
  formatCounts: Partial<Record<ReleaseFormat, number>>
  files: string[]
}

export async function buildHfDataset(
  inputs: string[],
  options: BuildOptions,
): Promise<BuildSummary> {
  if (inputs.length === 0) throw new Error('no input ledgers given')
  if (options.formats.length === 0) throw new Error('no formats selected')

  const report: ScrubReport = {
    files: {},
    totals: emptyScrubCounts(),
    excluded: { proposers: 0, nonTrain: 0 },
  }
  const kept: RolloutLine[] = []
  let read = 0

  for (const input of inputs) {
    const lines = await readRolloutLedger(input)
    read += lines.length
    const shippable = lines.filter((line) => {
      if (!isTrainableSplit(line.task.split)) {
        report.excluded.nonTrain += 1
        return false
      }
      if (!options.includeProposers && line.role === 'proposer') {
        report.excluded.proposers += 1
        return false
      }
      return true
    })
    const scrubbed = scrubLines(shippable)
    report.files[input] = scrubbed.counts
    addScrubCounts(report.totals, scrubbed.counts)
    kept.push(...scrubbed.lines)
  }

  const formatCounts: Partial<Record<ReleaseFormat, number>> = {}
  const files: string[] = []

  for (const format of options.formats) {
    const path = join(options.out, FORMAT_FILES[format])
    await mkdir(dirname(path), { recursive: true })
    if (format === 'raw') {
      // writeRolloutLedger re-validates every scrubbed line before it lands.
      await writeRolloutLedger(path, kept)
      formatCounts.raw = kept.length
    } else if (format === 'sft') {
      const rows = toSftRows(kept)
      await writeFile(path, toJsonl(rows))
      formatCounts.sft = rows.length
    } else if (format === 'verifiers') {
      const outputs = toVerifiersRolloutOutputs(kept)
      await writeFile(path, toJsonl(outputs))
      formatCounts.verifiers = outputs.length
    } else {
      const items = toRftItems(kept)
      await writeFile(path, toJsonl(items))
      formatCounts.rft = items.length
    }
    files.push(path)
  }

  const reportPath = join(options.out, 'scrub-report.json')
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`)
  files.push(reportPath)

  const cardPath = join(options.out, 'README.md')
  await writeFile(
    cardPath,
    buildDatasetCard({
      lines: kept,
      formats: options.formats,
      includeProposers: options.includeProposers,
      sourceFiles: inputs.map((input) => basename(input)),
      scrubTotals: report.totals,
      excluded: report.excluded,
      formatCounts,
    }),
  )
  files.push(cardPath)

  return { inputs, read, kept: kept.length, scrub: report, formatCounts, files }
}

export function planPushCommand(repo: string, outDir: string): string[] {
  return ['huggingface-cli', 'upload', repo, outDir, '.', '--repo-type', 'dataset']
}

export function pushDataset(repo: string, outDir: string): void {
  const found = spawnSync('which', ['huggingface-cli'], { stdio: 'ignore' })
  if (found.status !== 0) {
    throw new Error(
      'huggingface-cli not found on PATH — install huggingface_hub[cli] before --push',
    )
  }
  if (!process.env.HF_TOKEN) {
    throw new Error('HF_TOKEN not present in env — refusing to push')
  }
  const [command, ...args] = planPushCommand(repo, outDir) as [string, ...string[]]
  // Token stays in the inherited env; it is never echoed or interpolated.
  const run = spawnSync(command, args, { stdio: 'inherit' })
  if (run.status !== 0) throw new Error(`huggingface-cli upload exited ${String(run.status)}`)
}

export interface RolloutReleaseCliArgs extends BuildOptions {
  inputs: string[]
  push: string | null
}

export const ROLLOUT_RELEASE_USAGE =
  'usage: agent-eval rollout-release <ledger.jsonl...> --out <dir> [--formats sft,verifiers,rft,raw] [--include-proposers] [--push <org/name>]'

export function parseRolloutReleaseArgs(argv: string[]): RolloutReleaseCliArgs {
  const args: RolloutReleaseCliArgs = {
    inputs: [],
    out: '',
    formats: [...RELEASE_FORMATS],
    includeProposers: false,
    push: null,
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (arg === '--out') {
      args.out = argv[++i] ?? ''
    } else if (arg === '--formats') {
      const raw = (argv[++i] ?? '').split(',').filter(Boolean)
      for (const format of raw) {
        if (!RELEASE_FORMATS.includes(format as ReleaseFormat)) {
          throw new Error(
            `unknown format "${format}" — expected one of ${RELEASE_FORMATS.join(',')}`,
          )
        }
      }
      args.formats = raw as ReleaseFormat[]
    } else if (arg === '--include-proposers') {
      args.includeProposers = true
    } else if (arg === '--push') {
      args.push = argv[++i] ?? null
    } else if (arg.startsWith('--')) {
      throw new Error(`unknown flag "${arg}"`)
    } else {
      args.inputs.push(arg)
    }
  }
  if (args.inputs.length === 0 || !args.out) {
    throw new Error(ROLLOUT_RELEASE_USAGE)
  }
  if (args.push !== null && !/^[\w.-]+\/[\w.-]+$/.test(args.push)) {
    throw new Error(`--push expects <org/name>, got "${args.push}"`)
  }
  return args
}

/** CLI driver for `agent-eval rollout-release`. Returns the process exit code. */
export async function runRolloutReleaseCli(argv: string[]): Promise<number> {
  let args: RolloutReleaseCliArgs
  try {
    args = parseRolloutReleaseArgs(argv)
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    return 2
  }
  const summary = await buildHfDataset(args.inputs, args)
  process.stdout.write(
    `${JSON.stringify(
      {
        read: summary.read,
        kept: summary.kept,
        formatCounts: summary.formatCounts,
        scrub: summary.scrub,
      },
      null,
      2,
    )}\n`,
  )
  process.stdout.write(`dataset → ${args.out} (${summary.files.length} files)\n`)
  if (args.push !== null) {
    pushDataset(args.push, args.out)
    process.stdout.write(`pushed → ${args.push}\n`)
  }
  return 0
}
