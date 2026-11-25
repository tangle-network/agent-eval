/**
 * `agent-eval procedure-registry <sessions-dir>` prints the procedure registry
 * for a directory of Claude Code transcripts and any number of search ledgers.
 *
 * `--outcomes <file>` names a JSON array of {@link ChangeOutcome}: what the
 * caller knows of each change the sessions produced. Without it every change is
 * joined and none has an outcome. The JSON registry goes to stdout and the
 * short table to stderr, as `skill-usage` does.
 *
 * Exit codes: 2 for a usage error, 1 when a directory or ledger cannot be
 * read, 0 after the registry was written.
 */

import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { replaySearchLedgerText } from '../campaign/search-ledger'
import type { SearchStateView } from '../campaign/search-state'
import type { CustomTokenPricing } from '../cost-ledger/contract'
import { errorMessage } from '../errors'
import { claudeCodeSkillSessions } from '../skill-usage/claude-code'
import { parseSince, readPricingFile } from '../skill-usage/command'
import { readSkillFile } from '../skill-usage/skill-file'
import type { ChangeOutcome } from './change-outcome'
import { buildProcedureRegistry } from './registry'
import { renderProcedureRegistryTable } from './render'

type Format = 'both' | 'json' | 'table'
const FORMATS: readonly Format[] = ['both', 'json', 'table']

const USAGE =
  'usage: agent-eval procedure-registry <sessions-dir> [--ledger <search-ledger.jsonl>]... [--since <7d|36h|90m|ISO time>] [--outcomes <changes.json>] [--format both|json|table] [--limit <rows>] [--pricing <rates.json>]'

export interface ProcedureRegistryCommandIo {
  readonly stdout: (text: string) => void
  readonly stderr: (text: string) => void
  /** The instant `--since 30d` counts back from. */
  readonly now?: () => number
}

const PROCESS_IO: ProcedureRegistryCommandIo = {
  stdout: (text) => {
    process.stdout.write(text)
  },
  stderr: (text) => {
    process.stderr.write(text)
  },
}

interface Args {
  directory: string
  ledgers: string[]
  since: string | null
  outcomes: string | null
  format: Format
  limit: number
  pricing: string | null
}

function parseArgs(argv: readonly string[]): Args {
  const args: Args = {
    directory: '',
    ledgers: [],
    since: null,
    outcomes: null,
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
    if (arg === '--ledger') args.ledgers.push(value(arg, ++i))
    else if (arg === '--since') args.since = value(arg, ++i)
    else if (arg === '--outcomes') args.outcomes = value(arg, ++i)
    else if (arg === '--pricing') args.pricing = value(arg, ++i)
    else if (arg === '--format') {
      const raw = value(arg, ++i)
      if (!(FORMATS as readonly string[]).includes(raw)) {
        throw new Error(`--format expects one of ${FORMATS.join('|')}, got ${JSON.stringify(raw)}`)
      }
      args.format = raw as Format
    } else if (arg === '--limit') {
      const raw = Number(value(arg, ++i))
      if (!Number.isInteger(raw) || raw < 1) throw new Error('--limit expects a positive integer')
      args.limit = raw
    } else if (arg.startsWith('--')) {
      throw new Error(`unknown flag "${arg}"`)
    } else if (args.directory === '') {
      args.directory = arg
    } else {
      throw new Error(`unexpected argument "${arg}"`)
    }
  }
  if (args.directory === '') throw new Error('a sessions directory is required')
  return args
}

/** An outcomes file: a JSON array of change outcomes; each field is checked, so a typo is not read as unknown. */
function readOutcomes(path: string): ChangeOutcome[] {
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
  if (!Array.isArray(parsed)) throw new Error(`--outcomes ${path}: expected a JSON array`)
  const tri = (item: Record<string, unknown>, field: string, index: number): boolean | null => {
    const raw = item[field]
    if (raw === null || typeof raw === 'boolean') return raw
    throw new Error(`--outcomes ${path}: entry ${index} ${field} must be true, false or null`)
  }
  return parsed.map((entry: unknown, index) => {
    const item = (typeof entry === 'object' && entry !== null ? entry : {}) as Record<
      string,
      unknown
    >
    if (typeof item.ref !== 'string' || item.ref === '') {
      throw new Error(`--outcomes ${path}: entry ${index} needs a ref`)
    }
    if (typeof item.hotfixWindowDays !== 'number') {
      throw new Error(`--outcomes ${path}: entry ${index} needs hotfixWindowDays`)
    }
    return {
      ref: item.ref,
      merged: tri(item, 'merged', index),
      gateGreenFirstTry: tri(item, 'gateGreenFirstTry', index),
      hotfixed: tri(item, 'hotfixed', index),
      hotfixWindowDays: item.hotfixWindowDays,
    }
  })
}

async function readLedger(path: string): Promise<SearchStateView> {
  const text = await readFile(path, 'utf8')
  const first = JSON.parse(text.slice(0, Math.max(0, text.indexOf('\n')))) as { searchId?: unknown }
  if (typeof first.searchId !== 'string') throw new Error(`${path} line 1 names no searchId`)
  return replaySearchLedgerText(text, first.searchId, path)
}

export async function runProcedureRegistryCommand(
  argv: readonly string[],
  io: ProcedureRegistryCommandIo = PROCESS_IO,
): Promise<number> {
  if (argv.includes('--help') || argv.includes('-h')) {
    io.stdout(`${USAGE}\n`)
    return 0
  }
  let args: Args
  let sinceMs: number | undefined
  let rates: Map<string, CustomTokenPricing> | undefined
  let outcomes: ChangeOutcome[] = []
  try {
    args = parseArgs(argv)
    rates = args.pricing === null ? undefined : readPricingFile(resolve(args.pricing))
    sinceMs = args.since === null ? undefined : parseSince(args.since, (io.now ?? Date.now)())
    if (args.outcomes !== null) outcomes = readOutcomes(resolve(args.outcomes))
  } catch (error) {
    io.stderr(`${errorMessage(error)}\n${USAGE}\n`)
    return 2
  }
  try {
    const searches = await Promise.all(args.ledgers.map((path) => readLedger(resolve(path))))
    const registry = await buildProcedureRegistry(
      {
        searches,
        sessions: claudeCodeSkillSessions(
          resolve(args.directory),
          sinceMs === undefined ? {} : { sinceMs },
        ),
        outcomes,
      },
      {
        ...(sinceMs === undefined ? {} : { sinceMs }),
        ...(rates === undefined ? {} : { pricing: (model: string) => rates?.get(model) }),
        readSkillFile,
      },
    )
    const table = renderProcedureRegistryTable(registry, args.limit)
    if (args.format === 'table') {
      io.stdout(table)
    } else {
      io.stdout(`${JSON.stringify(registry, null, 2)}\n`)
      if (args.format === 'both') io.stderr(table)
    }
    return 0
  } catch (error) {
    io.stderr(`agent-eval procedure-registry: ${errorMessage(error)}\n`)
    return 1
  }
}
