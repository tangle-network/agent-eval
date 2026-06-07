# @tangle-network/agent-eval

Two docs, two audiences:

- **Humans onboarding** → [`docs/concepts.md`](./docs/concepts.md) (mental model, 5 min) and [`README.md`](./README.md) (entry points + quickstart).
- **LLM agents writing integration code** → [`.claude/skills/agent-eval/SKILL.md`](./.claude/skills/agent-eval/SKILL.md). Auto-discovered by Claude Code as `/agent-eval`. Encodes shipped-bug directives that prevent regression — skipping one reintroduces the bug class.

Wire-protocol consumers (any language other than TypeScript) → [`docs/wire-protocol.md`](./docs/wire-protocol.md) and [`clients/python/README.md`](./clients/python/README.md).

How fleet agents that consume this substrate are built (reachable defaults, platform-first debugging, experiment integrity) → [`docs/building-doctrine.md`](./docs/building-doctrine.md).

Update the doc closest to the change. Don't duplicate content across docs; cross-link.

## Tech stack (unchanging)

- TypeScript strict, no semicolons, single quotes, 2-space indent
- tsup (bundling), vitest (tests)
- `@tangle-network/tcloud` for LLM calls (judges, driver)

## Repo layering — this package is the substrate

```
agent-knowledge ─┐
                 ├──► agent-eval  (this repo — the bottom)
agent-runtime ───┘
```

**Rule: agent-eval has zero upward dependencies on agent-runtime or agent-knowledge.** Both consumer packages depend on agent-eval; the reverse is forbidden. This applies to runtime deps, devDeps, and peerDeps. Type-only `import type` from a consumer package is the smell that hides the inversion — reject it in review.

If a type that "feels like" it belongs in a consumer is actually a substrate primitive (validator verdict, run record, scenario, judge score), move it INTO agent-eval. Examples that already moved this direction:
- `DefaultVerdict` lives in `src/verdict.ts` here. agent-runtime's `Validator<Output, Verdict = DefaultVerdict>` defaults to it.
- `RunRecord` lives in `src/run-record.ts` here. Every consumer imports it from agent-eval.

If a type is genuinely runtime-shaped (`ValidationCtx` with iteration + signal + traceEmitter; `AgentRunSpec` with sandbox profile) it stays in agent-runtime. The test: "does this concept make sense WITHOUT a running agent loop?" If yes, it's substrate. If no, it's runtime.

When in doubt, lean substrate. Subtracting a consumer dep is always cheaper than adding one.

## Commands

```bash
pnpm build        # tsup
pnpm test         # vitest
pnpm typecheck    # tsc --noEmit
```

## Authorship

Do not add `Co-Authored-By:` trailers (or any other AI-attribution lines) to commits, PR descriptions, or other artifacts in this repo. Author = the human running the session. This applies even when the default Claude Code template suggests it.

## Comment & doc discipline (no historical narrative)

Comments describe **what the code does and why** — never what it used to do, what it replaced, which audit found a bug, or what the prior version looked like. History belongs in commit messages and PR descriptions, not the source tree.

- Bad: `// replaces the inline retry loop`, `// fix for the silent-zero bug`, `// the 2yr rewrite added this`, `// audit fix`
- Good: `// value: null when retries exhaust — callers must inspect succeeded`

Applies to docstrings, README sections, SKILL.md, AGENTS.md, CLAUDE.md — anywhere the source tree carries prose.

## No fallbacks. Fail loud.

Sloppy fallbacks corrupt every signal downstream. No silent zeros, no `?? default` on required fields, no `try/catch { return null }` that erases diagnostic info, no legacy back-compat mode defaulted on for new code.

External-boundary calls (LLM, network, FS, subprocess) return *typed outcomes* (`{ succeeded, value, error }`). Callers MUST inspect `succeeded` before using `value`. Named, opted-in fallback rotations (`policy.fallbackModels: [...]`) are fine; deep `?? "kimi"` helpers are not.

Full doctrine: `~/dotfiles/claude/AGENTS.md` → "No fallbacks. Fail loud."

