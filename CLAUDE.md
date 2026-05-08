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
