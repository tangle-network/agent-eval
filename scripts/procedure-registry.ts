/**
 * The procedure registry over a directory of Claude Code transcripts, from a
 * checkout:
 *
 *   pnpm procedure-registry ~/.claude/projects --since 30d --outcomes changes.json
 *
 * The same command ships in the package as `agent-eval procedure-registry`.
 */

import { runProcedureRegistryCommand } from '../src/procedure-registry/command'

runProcedureRegistryCommand(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code
  },
  (error: unknown) => {
    console.error(error)
    process.exitCode = 1
  },
)
