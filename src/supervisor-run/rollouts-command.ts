/**
 * `agent-eval supervisor-run rollouts` writes one rollout ledger from the
 * places the fleet's work is recorded:
 *
 *   <runDir...>              Discovery / Runtime run directories (`discoveryRunRolloutLines`)
 *   --sessions [<harness>:]<path>  a HOME, store directory, session file or OpenCode .db;
 *                            the prefix limits a directory to one harness and names a file's
 *   --since <ISO>            limit --sessions to stores changed since then
 *   --gate-receipts <file>   beelink-gate receipts.jsonl, as verifiable labels
 *   --denylist <file>        literal private terms, one per line
 *
 * Every row passes the privacy screen before it is written: a row with any
 * secret or private detail is dropped whole and counted by rule, so the
 * ledger never holds one. Rows are written under the write policy and read
 * back with `readRolloutJournal`; their rewards are unscreened.
 */

import { readFile, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { errorMessage } from '../errors'
import { appendRolloutLines } from '../rollout/ledger'
import { gateReceiptRolloutLines } from '../rollout/readers/gate-receipts'
import {
  harnessSessionRefs,
  harnessSessionRolloutLines,
} from '../rollout/readers/harness-session-lines'
import { PRIVACY_RULE_NAMES, privacyHit } from '../rollout/release/scrub'
import type { RolloutLine } from '../rollout/schema'
import { discoveryRunRolloutLines } from './discovery-rollouts'
import type { SupervisorRunCommandIo } from './report-command'

export const ROLLOUTS_USAGE =
  'usage: agent-eval supervisor-run rollouts [<runDir>...] [--sessions [<harness>:]<path>]... [--since <ISO>] [--gate-receipts <file>]... [--denylist <file>] --out <ledger.jsonl>'

interface RolloutsArgs {
  runDirs: string[]
  sessions: Array<{ path: string; harness?: string }>
  sinceMs?: number
  gateReceipts: string[]
  denylist: string | null
  out: string
}

function parseArgs(argv: readonly string[]): RolloutsArgs {
  const args: RolloutsArgs = {
    runDirs: [],
    sessions: [],
    gateReceipts: [],
    denylist: null,
    out: '',
  }
  const value = (i: number, flag: string): string => {
    const v = argv[i]
    if (v === undefined || v.startsWith('--')) throw new Error(`${flag} expects a value`)
    return v
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string
    if (arg === '--out') args.out = value(++i, arg)
    else if (arg === '--sessions') {
      const raw = value(++i, arg)
      const prefixed = /^([a-z][a-z-]*):(.+)$/u.exec(raw)
      args.sessions.push(prefixed ? { harness: prefixed[1]!, path: prefixed[2]! } : { path: raw })
    } else if (arg === '--since') {
      const ms = Date.parse(value(++i, arg))
      if (Number.isNaN(ms)) throw new Error(`--since expects an ISO time, got ${argv[i]}`)
      args.sinceMs = ms
    } else if (arg === '--gate-receipts') args.gateReceipts.push(value(++i, arg))
    else if (arg === '--denylist') args.denylist = value(++i, arg)
    else if (arg.startsWith('--')) throw new Error(`unknown flag "${arg}"`)
    else args.runDirs.push(arg)
  }
  if (!args.out) throw new Error(ROLLOUTS_USAGE)
  if (args.runDirs.length + args.sessions.length + args.gateReceipts.length === 0) {
    throw new Error(`no sources given\n${ROLLOUTS_USAGE}`)
  }
  return args
}

export interface RolloutsSummary {
  out: string
  written: number
  dropped: Record<string, number>
  sources: Array<{ source: string; kind: string; read: number; written: number; errors: string[] }>
}

export async function runRolloutsCommand(
  argv: readonly string[],
  io: SupervisorRunCommandIo,
): Promise<number> {
  let args: RolloutsArgs
  try {
    args = parseArgs(argv)
  } catch (error) {
    io.stderr(`${errorMessage(error)}\n`)
    return 2
  }
  const out = resolve(args.out)
  const denylist =
    args.denylist === null
      ? []
      : (await readFile(args.denylist, 'utf8'))
          .split('\n')
          .map((line) => line.replace(/#.*/u, '').trim())
          .filter(Boolean)
  const capturedAt = new Date().toISOString()
  const summary: RolloutsSummary = {
    out,
    written: 0,
    dropped: Object.fromEntries(PRIVACY_RULE_NAMES.map((name) => [name, 0])),
    sources: [],
  }
  await rm(out, { force: true })

  const write = async (source: RolloutsSummary['sources'][number], lines: RolloutLine[]) => {
    source.read += lines.length
    const kept = lines.filter((line) => {
      const hit = privacyHit(line, denylist)
      if (hit !== null) summary.dropped[hit] = (summary.dropped[hit] ?? 0) + 1
      return hit === null
    })
    await appendRolloutLines(out, kept)
    source.written += kept.length
    summary.written += kept.length
  }

  for (const runDir of args.runDirs) {
    const source = { source: runDir, kind: 'run-dir', read: 0, written: 0, errors: [] as string[] }
    summary.sources.push(source)
    try {
      const run = await discoveryRunRolloutLines(resolve(runDir), { capturedAt })
      source.errors.push(...run.gaps.map((gap) => `${gap.code}: ${gap.message}`), ...run.notes)
      await write(source, run.lines)
    } catch (error) {
      source.errors.push(errorMessage(error))
    }
  }
  for (const target of args.sessions) {
    const source = {
      source: target.path,
      kind: `sessions:${target.harness ?? 'all'}`,
      read: 0,
      written: 0,
      errors: [] as string[],
    }
    summary.sources.push(source)
    try {
      const refs = await harnessSessionRefs(resolve(target.path), {
        ...(target.harness === undefined ? {} : { harness: target.harness }),
        ...(args.sinceMs === undefined ? {} : { sinceMs: args.sinceMs }),
      })
      let batch: RolloutLine[] = []
      for await (const item of harnessSessionRolloutLines(refs, capturedAt)) {
        if (item.line) batch.push(item.line)
        else source.errors.push(`${item.ref.path}: ${item.error}`)
        if (batch.length >= 100) {
          await write(source, batch)
          batch = []
        }
      }
      await write(source, batch)
    } catch (error) {
      source.errors.push(errorMessage(error))
    }
  }
  for (const path of args.gateReceipts) {
    const source = {
      source: path,
      kind: 'gate-receipts',
      read: 0,
      written: 0,
      errors: [] as string[],
    }
    summary.sources.push(source)
    try {
      const { lines, skipped } = await gateReceiptRolloutLines(path, capturedAt)
      if (skipped > 0) source.errors.push(`${skipped} receipts carried no verdict`)
      await write(source, lines)
    } catch (error) {
      source.errors.push(errorMessage(error))
    }
  }
  io.stdout(`${JSON.stringify(summary, null, 2)}\n`)
  return summary.sources.some((s) => s.read === 0 && s.errors.length > 0) ? 1 : 0
}
