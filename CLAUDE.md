# @tangle-network/agent-eval

Two docs, two audiences:

- **Humans onboarding** → [`docs/concepts.md`](./docs/concepts.md) (mental model, 5 min) and [`README.md`](./README.md) (entry points + quickstart).
- **LLM agents writing integration code** → [`.claude/skills/agent-eval/SKILL.md`](./.claude/skills/agent-eval/SKILL.md). Auto-discovered by Claude Code as `/agent-eval`. Encodes shipped-bug directives that prevent regression — skipping one reintroduces the bug class.

Wire-protocol consumers (any language other than TypeScript) → [`docs/wire-protocol.md`](./docs/wire-protocol.md) and [`clients/python/README.md`](./clients/python/README.md).

Update the doc closest to the change. Don't duplicate content across docs; cross-link.

## Tech stack (unchanging)

- TypeScript strict, no semicolons, single quotes, 2-space indent
- tsup (bundling), vitest (tests)
- `@tangle-network/tcloud` for LLM calls (judges, driver)

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

