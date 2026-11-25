/**
 * Skill usage over a directory of Claude Code transcripts, from a checkout:
 *
 *   pnpm skill-usage ~/.claude/projects --since 7d
 *
 * The same command ships in the package as `agent-eval skill-usage`. This entry
 * loads only the report, so it starts without the rest of the CLI.
 */

import { runSkillUsageCommand } from '../src/skill-usage/command'

runSkillUsageCommand(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code
  },
  (error: unknown) => {
    console.error(error)
    process.exitCode = 1
  },
)
