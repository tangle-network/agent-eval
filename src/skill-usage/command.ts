/**
 * `agent-eval skill-usage <sessions-dir>` reads a directory of Claude Code
 * transcripts (or, with `--harness codex`, Codex rollouts) and prints the
 * skill-usage report.
 *
 * By default the JSON report goes to stdout and the short table to stderr, so
 * `> report.json` keeps the report while the table stays on the terminal.
 *
 * `--pricing <file>` names a JSON object of per-million rates by model id, for a
 * model the cost ledger has no rate for or prices too coarsely (its table has no
 * cache-read rate).
 *
 * Exit codes follow the other self-parsing subcommands: 2 for a usage error, 1
 * when the directory cannot be read, 0 after the report was written.
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { CustomTokenPricing } from '../cost-ledger/contract'
import { costForTokenPricing } from '../cost-ledger/pricing'
import { errorMessage } from '../errors'
import { claudeCodeSkillSessions } from './claude-code'
import { codexSkillSessions } from './codex'
import { buildSkillUsageReport, renderSkillUsageTable } from './report'
import type { SkillSessionSource } from './session-record'
import { readSkillFile } from './skill-file'

type SkillUsageFormat = 'both' | 'json' | 'table'

const FORMATS: readonly SkillUsageFormat[] = ['both', 'json', 'table']

const USAGE =
  'usage: agent-eval skill-usage <sessions-dir> [--harness claude-code|codex] [--since <7d|36h|90m|ISO time>] [--format both|json|table] [--limit <rows>] [--pricing <rates.json>]'

/** Output sinks, injectable so a test reads the exact bytes a terminal would. */
export interface SkillUsageCommandIo {
  readonly stdout: (text: string) => void
  readonly stderr: (text: string) => void
  /** The instant `--since 7d` counts back from. */
  readonly now?: () => number
}

const PROCESS_IO: SkillUsageCommandIo = {
  stdout: (text) => {
    process.stdout.write(text)
  },
  stderr: (text) => {
    process.stderr.write(text)
  },
}

/** The harnesses whose session stores the commands read. */
export const SESSION_HARNESSES = ['claude-code', 'codex'] as const
export type SessionHarness = (typeof SESSION_HARNESSES)[number]

/** The sessions under a harness's store: Claude Code's projects directory, or Codex's sessions directory. */
export function harnessSkillSessions(
  harness: SessionHarness,
  directory: string,
  options: { sinceMs?: number },
): SkillSessionSource {
  return harness === 'codex'
    ? codexSkillSessions(directory, options)
    : claudeCodeSkillSessions(directory, options)
}

/** The value of `--harness`, checked. */
export function parseHarness(raw: string): SessionHarness {
  if (!(SESSION_HARNESSES as readonly string[]).includes(raw)) {
    throw new Error(
      `--harness expects one of ${SESSION_HARNESSES.join('|')}, got ${JSON.stringify(raw)}`,
    )
  }
  return raw as SessionHarness
}

interface SkillUsageArgs {
  directory: string
  harness: SessionHarness
  since: string | null
  format: SkillUsageFormat
  limit: number
  pricing: string | null
}

const DURATION = /^(\d+(?:\.\d+)?)([dhm])$/
const UNIT_MS = { d: 86_400_000, h: 3_600_000, m: 60_000 } as const

/** `7d`, `36h` or `90m` back from `nowMs`, or an ISO instant. */
export function parseSince(raw: string, nowMs: number): number {
  const duration = DURATION.exec(raw)
  if (duration !== null) {
    return nowMs - Number(duration[1]) * UNIT_MS[duration[2] as keyof typeof UNIT_MS]
  }
  const at = Date.parse(raw)
  if (!Number.isFinite(at)) {
    throw new Error(
      `--since expects a duration such as 7d or an ISO time, got ${JSON.stringify(raw)}`,
    )
  }
  return at
}

function parseArgs(argv: readonly string[]): SkillUsageArgs {
  const args: SkillUsageArgs = {
    directory: '',
    harness: 'claude-code',
    since: null,
    format: 'both',
    limit: 30,
    pricing: null,
  }
  const value = (flag: string, index: number): string => {
    const raw = argv[index]
    if (raw === undefined) throw new Error(`${flag} expects a value`)
    return raw
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string
    if (arg === '--harness') {
      args.harness = parseHarness(value(arg, ++i))
    } else if (arg === '--since') {
      args.since = value(arg, ++i)
    } else if (arg === '--format') {
      const raw = value(arg, ++i)
      if (!(FORMATS as readonly string[]).includes(raw)) {
        throw new Error(`--format expects one of ${FORMATS.join('|')}, got ${JSON.stringify(raw)}`)
      }
      args.format = raw as SkillUsageFormat
    } else if (arg === '--limit') {
      const raw = Number(value(arg, ++i))
      if (!Number.isInteger(raw) || raw < 1) throw new Error('--limit expects a positive integer')
      args.limit = raw
    } else if (arg === '--pricing') {
      args.pricing = value(arg, ++i)
    } else if (arg.startsWith('--')) {
      throw new Error(`unknown flag "${arg}"`)
    } else if (args.directory === '') {
      args.directory = arg
    } else {
      throw new Error(`unexpected argument "${arg}"`)
    }
  }
  if (args.directory === '') throw new Error('a transcripts directory is required')
  return args
}

const RATE_FIELDS = [
  'inputUsdPerMillion',
  'cachedInputUsdPerMillion',
  'cacheWriteUsdPerMillion',
  'outputUsdPerMillion',
] as const

/** A rates file: `{ "<model id>": { inputUsdPerMillion, outputUsdPerMillion, ... } }`. */
export function readPricingFile(path: string): Map<string, CustomTokenPricing> {
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`--pricing ${path}: expected a JSON object of rates by model id`)
  }
  const rates = new Map<string, CustomTokenPricing>()
  for (const [model, value] of Object.entries(parsed)) {
    const fields = typeof value === 'object' && value !== null ? value : {}
    for (const field of RATE_FIELDS) {
      const rate = (fields as Record<string, unknown>)[field]
      const required = field === 'inputUsdPerMillion' || field === 'outputUsdPerMillion'
      if (typeof rate !== 'number' && (required || rate !== undefined)) {
        throw new Error(`--pricing ${path}: ${JSON.stringify(model)}.${field} must be a number`)
      }
    }
    const pricing = fields as CustomTokenPricing
    // The cost ledger owns what a valid rate is; price nothing to have it check these.
    costForTokenPricing(pricing, { inputTokens: 0, outputTokens: 0 })
    rates.set(model, pricing)
  }
  return rates
}

export async function runSkillUsageCommand(
  argv: readonly string[],
  io: SkillUsageCommandIo = PROCESS_IO,
): Promise<number> {
  if (argv.includes('--help') || argv.includes('-h')) {
    io.stdout(`${USAGE}\n`)
    return 0
  }
  let args: SkillUsageArgs
  let sinceMs: number | undefined
  let rates: Map<string, CustomTokenPricing> | undefined
  try {
    args = parseArgs(argv)
    rates = args.pricing === null ? undefined : readPricingFile(resolve(args.pricing))
    sinceMs = args.since === null ? undefined : parseSince(args.since, (io.now ?? Date.now)())
  } catch (error) {
    io.stderr(`${errorMessage(error)}\n${USAGE}\n`)
    return 2
  }
  try {
    const report = await buildSkillUsageReport(
      harnessSkillSessions(
        args.harness,
        resolve(args.directory),
        sinceMs === undefined ? {} : { sinceMs },
      ),
      {
        ...(sinceMs === undefined ? {} : { sinceMs }),
        ...(rates === undefined ? {} : { pricing: (model: string) => rates?.get(model) }),
        readSkillFile,
      },
    )
    const table = renderSkillUsageTable(report, args.limit)
    if (args.format === 'table') {
      io.stdout(table)
    } else {
      io.stdout(`${JSON.stringify(report, null, 2)}\n`)
      if (args.format === 'both') io.stderr(table)
    }
    return 0
  } catch (error) {
    io.stderr(`agent-eval skill-usage: ${errorMessage(error)}\n`)
    return 1
  }
}
