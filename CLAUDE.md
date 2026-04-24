# @tangle-network/agent-eval

Claude Code agents working in this repo: the usage directives are in
**[`.claude/skills/agent-eval/SKILL.md`](./.claude/skills/agent-eval/SKILL.md)**
and are auto-discovered by Claude Code as the `/agent-eval` skill.

That file is the sole source of truth for:
- minimal builder-of-builders integration path
- the seven muffled-gate footguns (from shipped bugs)
- three-layer eval contract (`BuilderSession` → `app-build` → `app-runtime`)
- regression tests every consumer should carry
- "when to use what" index of the 100+ exports

Do not duplicate content from SKILL.md here. Update SKILL.md; this file is
a pointer.

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
