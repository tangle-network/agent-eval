/**
 * The pull requests a shell tool call opened or merged, as `owner/repo#number`.
 *
 * A session produced a change when one of its shell commands created or merged
 * a pull request. `gh pr create` prints the pull request's URL, so the URL in
 * the call's result names it; `gh pr merge <number>` prints none, so the number
 * and the `-R owner/repo` flag in the command name it. A command that names a
 * number but no repository names no change: the repository is unknown, and a
 * guess would join the session to another repository's pull request.
 */

import type { SessionToolCall } from '@tangle-network/harness-sessions'
import { record } from '../contract/intake/code-agent-fields'

const SHELL_TOOLS: ReadonlySet<string> = new Set(['Bash'])
/** `gh pr create`, or a wrapper named `gh-<identity>`, including its flags up to the subcommand. */
const PR_COMMAND = /\bgh(?:-[\w-]+)?\s+(?:-\S+\s+\S+\s+)*pr\s+(create|merge)\b/g
const PULL_URL = /https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/g
const MERGE_ARGS = /\bpr\s+merge\s+(?:(?:https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/)?(\d+))/
const REPO_FLAG = /(?:-R|--repo)[\s=]+([\w.-]+\/[\w.-]+)/

export function githubPullRequestRefs(call: SessionToolCall): string[] {
  if (!SHELL_TOOLS.has(call.name)) return []
  const command = record(call.input)?.command
  if (typeof command !== 'string') return []
  const kinds = new Set<string>()
  for (const match of command.matchAll(PR_COMMAND)) kinds.add(match[1] as string)
  if (kinds.size === 0) return []
  const refs = new Set<string>()
  if (call.result !== null && call.result.isError !== true) {
    const text = call.result.text ?? ''
    for (const match of text.matchAll(PULL_URL)) refs.add(`${match[1]}#${match[2]}`)
  }
  if (kinds.has('merge')) {
    const merge = MERGE_ARGS.exec(command)
    const repository = merge?.[1] ?? REPO_FLAG.exec(command)?.[1]
    if (merge?.[2] !== undefined && repository !== undefined) refs.add(`${repository}#${merge[2]}`)
  }
  return [...refs]
}
