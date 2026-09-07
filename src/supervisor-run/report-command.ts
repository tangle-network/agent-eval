/**
 * `agent-eval supervisor-run report <runDir>` takes one run directory and
 * prints the report the module already renders. The command reads through
 * `analyzeSupervisorRun`, so a Runtime run dir and a loops run dir take the
 * same path and the status comes from the record `terminal-record.ts` names.
 *
 * Exit codes follow the other self-parsing subcommands: 2 for a usage error,
 * 1 when the directory cannot be read (missing, not a directory, or a corrupt
 * journal or terminal record), 0 after the report was written to stdout.
 */

import { stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { analyzeSupervisorRun } from './loops-reader'
import { renderSupervisorRunHeadline, renderSupervisorRunMarkdown } from './render'

export type SupervisorRunReportFormat = 'headline' | 'markdown' | 'json'

const FORMATS: readonly SupervisorRunReportFormat[] = ['headline', 'markdown', 'json']

export const SUPERVISOR_RUN_USAGE =
  'usage: agent-eval supervisor-run report <runDir> [--format headline|markdown|json]'

/** Output sinks, injectable so tests read the exact bytes a terminal would. */
export interface SupervisorRunCommandIo {
  readonly stdout: (text: string) => void
  readonly stderr: (text: string) => void
}

const PROCESS_IO: SupervisorRunCommandIo = {
  stdout: (text) => {
    process.stdout.write(text)
  },
  stderr: (text) => {
    process.stderr.write(text)
  },
}

interface ReportArgs {
  readonly runDir: string
  readonly format: SupervisorRunReportFormat
}

function isFormat(value: string): value is SupervisorRunReportFormat {
  return (FORMATS as readonly string[]).includes(value)
}

function parseReportArgs(argv: readonly string[]): ReportArgs {
  let runDir: string | null = null
  let format: SupervisorRunReportFormat = 'headline'
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string
    if (arg === '--format') {
      const raw = argv[++i]
      if (raw === undefined || !isFormat(raw)) {
        throw new Error(
          `--format expects one of ${FORMATS.join('|')}, got ${JSON.stringify(raw ?? '')}`,
        )
      }
      format = raw
    } else if (arg.startsWith('--format=')) {
      const raw = arg.slice('--format='.length)
      if (!isFormat(raw)) {
        throw new Error(`--format expects one of ${FORMATS.join('|')}, got ${JSON.stringify(raw)}`)
      }
      format = raw
    } else if (arg.startsWith('--')) {
      throw new Error(`unknown flag "${arg}"`)
    } else if (runDir === null) {
      runDir = arg
    } else {
      throw new Error(`unexpected argument "${arg}"`)
    }
  }
  if (runDir === null) throw new Error(SUPERVISOR_RUN_USAGE)
  return { runDir, format }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * CLI driver for `agent-eval supervisor-run`. `argv` is everything after the
 * command name, so `['report', runDir, ...flags]`. Returns the process exit code.
 */
export async function runSupervisorRunCommand(
  argv: readonly string[],
  io: SupervisorRunCommandIo = PROCESS_IO,
): Promise<number> {
  const [verb, ...rest] = argv
  if (verb === undefined || verb === '--help' || verb === '-h' || verb === 'help') {
    io.stdout(`${SUPERVISOR_RUN_USAGE}\n`)
    return verb === undefined ? 2 : 0
  }
  if (verb !== 'report') {
    io.stderr(`unknown supervisor-run subcommand "${verb}"\n${SUPERVISOR_RUN_USAGE}\n`)
    return 2
  }
  if (rest.includes('--help') || rest.includes('-h')) {
    io.stdout(`${SUPERVISOR_RUN_USAGE}\n`)
    return 0
  }

  let args: ReportArgs
  try {
    args = parseReportArgs(rest)
  } catch (error) {
    io.stderr(`${errorMessage(error)}\n`)
    return 2
  }

  const runDir = resolve(args.runDir)
  // A path that is not a directory is a caller error, not a run with every
  // measurement missing: reporting an absent-shaped run for a typo would read
  // as evidence about a run that never existed.
  const entry = await stat(runDir).catch(() => null)
  if (entry === null || !entry.isDirectory()) {
    io.stderr(`[agent-eval] supervisor-run report: ${runDir} is not a directory\n`)
    return 1
  }

  try {
    const report = await analyzeSupervisorRun(runDir)
    switch (args.format) {
      case 'headline':
        io.stdout(`${renderSupervisorRunHeadline(report)}\n`)
        break
      case 'markdown':
        io.stdout(renderSupervisorRunMarkdown(report))
        break
      case 'json':
        io.stdout(`${JSON.stringify(report, null, 2)}\n`)
        break
    }
    return 0
  } catch (error) {
    io.stderr(`[agent-eval] supervisor-run report failed for ${runDir}: ${errorMessage(error)}\n`)
    return 1
  }
}
