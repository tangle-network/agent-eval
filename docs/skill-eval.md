# Skill usage and the skill eval recipe

A unit is anything an agent can be given and have taken away again: a skill, a block of instructions, a profile difference.
Two questions about a unit have two tools:

| Question | Tool | Reads |
|---|---|---|
| Which units do agents use, how often, and what does the session do afterwards? | `agent-eval skill-usage` | Recorded sessions |
| Does the unit make the work better? | `runSkillEval` | Runs you start for the purpose |

The usage report says what happened. It cannot say the unit caused it; the recipe runs the comparison that can.

## Skill usage

```sh
pnpm skill-usage ~/.claude/projects --since 7d          # from a checkout
agent-eval skill-usage ~/.claude/projects --since 7d    # from the installed package
```

The JSON report goes to stdout and a short table to stderr. `--format json|table|both`, `--limit <rows>` and `--pricing <rates.json>` are the other flags.

The report has one row per skill and version:

- **Invocations**, counted once per call id across every file, by who started them: the agent (a `Skill` tool call), a person (a typed command that expands to a prompt) or the harness (a preload).
  A resumed session's copy of an earlier call, and a request snapshot that quotes one, add nothing.
- **Version**: the hash of the text the session loaded, so two versions of one skill are two rows whatever the skill file holds today.
  `skillFile` then says whether that file is still this version (`current`), a different one (`changed`) or cannot be read.
- **Sessions and subagent share**: how many sessions invoked it and what share of invocations came from subagents.
- **After the first invocation**: tool calls, tool errors, tokens, wall time and cost from the first counted invocation to the end of that session, summed over sessions, with a per-session median.

Three things never print as zero: a transcript that could not be read (`unreadable`), a version the session did not record (`version: null`), and a measure with no reading (`null`, with the count of what is missing beside it).

Cost uses the cost ledger's model table in `src/cost-ledger/pricing.ts`. It prices cache reads and writes only at a rate the table names for that model; a call with cache tokens on a model without one, or a model with no row, is not priced and stays out of the total.
A model the table does not know is `not priced`, not free.
`--pricing` takes a JSON object of per-million rates by model id (`inputUsdPerMillion`, `cachedInputUsdPerMillion`, `cacheWriteUsdPerMillion`, `outputUsdPerMillion`) and prices those models with it.

A session that invokes several skills counts its later work under each of them, so the after-invocation columns overlap across rows and do not add up.

### Other session sources

`buildSkillUsageReport(source, options)` reads any iterable of `SkillSessionRead`: a session's events in recorded order (skill invocations, tool calls, model calls), or the reason it could not be read.
`claudeCodeSkillSessions(directory)` is the adapter for a Claude Code projects directory.
`skillSessionFromHarnessSession(session, markers)` maps any session `@tangle-network/harness-sessions` normalizes; `markers` says which tool calls or messages invoke a skill, because that is the one thing that differs by harness.

`codexSkillSessions(directory)` is the adapter for a Codex sessions directory (`~/.codex/sessions`, or one account's), and `--harness codex` selects it in `skill-usage` and `procedure-registry`.
Codex has no skill tool: the agent uses a skill by reading its `SKILL.md` with a shell command (`cat`, `sed`, `head`), so the reader counts a shell call that views a file named `skills/<name>/SKILL.md` as that skill's invocation.
The read is often partial, so the session gives no version; the report reads the skill file as it is when it runs, and marks the version `file`, which can be newer than the call.
A script run by Codex's code-mode `exec` tool makes several shell commands under one call. The change ledger's hook names such a command by its own `exec-<id>`; the rollout names the same id on the command's completion between the call and its output, which places the change in the turn that ran the script. When several scripts are open at once the id names none of them, the session says so in its gaps, and a ledger change that cannot be placed makes the whole session's changes unknown rather than none.

A gateway that runs the harness for a caller can write change ledger rows with no hook in the harness: it sees turns, not tool calls.
Its rows carry the gateway's `sessionId`, the harness's `nativeSessionId` (the reader keys by it, so the row joins that harness's transcript), a `turnId`, and `turnStartedAt`; the change belongs to the last tool call of the session record whose time lies between `turnStartedAt` and the row's `at`.
Each turn also writes a `turn` row with the repository's HEAD before and after, and a `push` row for each remote branch it pushed.
A `turn` row whose `incomplete` is set (a checkout shared with another running turn, a failed pull request read, more commits than the list holds) leaves the session's changes unknown, with a gap that names the reason.
The field list is the header of `src/skill-usage/change-ledger.ts`.

Both readers also record the instruction files the harness loaded into the session, on `instructions`: Claude Code's `instructions` and `nested_memory` attachments name each file, its scope and its text; Codex names only the directory it loaded AGENTS.md text for, since it joins the files it found.
A block of that text is a unit like a skill: the sessions that loaded it are its usage, and the recipe below measures it.

Both session readers and the ledger are exported from `@tangle-network/agent-eval/analyst`: `readChangeLedger(paths)` reads one or more ledger files, `parseChangeLedger(text)` reads ledger text, and `withChangeLedger(source, ledger)` joins the ledger to any session source, so a caller reads `withChangeLedger(codexSkillSessions(directory), await readChangeLedger([file]))` as the command does.

## The recipe

Use `runSkillEval` before adopting a unit, before cutting one the usage report shows is rare or costly, and when a unit's text changes materially.
It needs real cases with a pass check the baseline neither always passes nor always fails, a judge you have checked against human verdicts ([judge calibration](./concepts.md#judge-calibration)), and a way to run the agent with and without the unit.

```ts
import { runSkillEval, skillEvalTraceFromRun } from '@tangle-network/agent-eval'

const report = await runSkillEval({
  unit: { name: 'run-the-checks', text: skillText },
  cases, // each with an id
  run: async (testCase, arm) => {
    // arm.arm is 'with' | 'without' | 'control'; arm.text is the text to add, or null
    const { answer, pass, runId } = await myAgent(testCase, arm.text)
    return { answer, pass, trace: await skillEvalTraceFromRun(store, runId) }
  },
  judge: async ({ case: testCase, first, second }) => myJudge(testCase, first, second), // 'first' | 'second' | 'tie'
  control: true, // a third arm with neutral text of the unit's length
  seed: 7,
})
report.decision // 'keep' | 'cut' | 'inconclusive'
report.reason // the clause that decided, with its numbers
```

`trace` is four numbers, each null when it was not read: `toolCalls`, `toolErrors`, `wallMs`, `costUsd`.
`skillEvalTraceFromRun` reads them from a run recorded in a `TraceStore`.
[`examples/skill-eval`](../examples/skill-eval/) runs the whole recipe offline.

What it does, in order:

1. Runs `without` on every case and checks headroom (`capabilityHeadroom`). When the baseline passes at least 90% or at most 10% of the cases with a known outcome, it stops: no other arm runs.
2. Runs `with`, then `control` when asked for.
3. Gives the judge each pair of answers once, with no arm label, in an order drawn from the seed.
4. Reports, for `with` against each other arm: wins, losses and ties; the win rate with its Wilson interval; the paired decision on net preference (`decidePairedPromotion`); and the paired change in tool calls, tool errors, wall time and cost (`comparePairedArms`).
5. Applies one rule, which the report carries in `rule`:
   - A suite that passes 100% is not evidence: a headroom stop is inconclusive.
   - Cut when blind judges reliably prefer `without`, or the control, over `with`.
   - Keep when blind judges reliably prefer `with` over `without`, and over the control when one ran.
   - Cut when the comparison rules out a net preference for `with` of `smallestBenefit` (default 10% of cases) and no process measure is reliably lower.
   - Otherwise inconclusive.

A `run` or `judge` callback that throws is listed in `failures` and its case is left out of that comparison; it is never scored as a tie.

## What the recipe does not prove

- **That the judge is right.** The win rate is the judge's preference. Blinding and a seeded order remove arm and position effects, not a judge that prefers the wrong thing.
- **That the result holds elsewhere.** It covers these cases, this model and this harness.
- **That the agent would use the unit.** `run` applies it. Whether an agent loads a skill unprompted is a usage question.
- **Run-to-run stability.** Each case runs once per arm, so a case that flips between runs counts as a win or a loss. Repeat the eval to see how much the decision moves.
- **That a unit is worth its cost.** Process changes are reported. A unit that answers no better but reliably costs less is inconclusive, and the call is yours.
- **That there is no effect.** Inconclusive means these cases could not tell. A no-benefit cut rules out only a net preference of `smallestBenefit` or more.
- **Every non-specific effect.** A neutral text of equal length controls for added reading, not for where the text sits in the prompt.
- **Several units at once.** Each eval is one comparison. Evaluating many units on the same cases makes some pass by chance; correct for that with `holm` from `./statistics`.

Pass outcomes decide headroom and are reported as a paired comparison; they do not enter the keep or cut rule.
