# @tangle-network/agent-eval

Trace-first evaluation framework for Tangle agents. Core (spans, pipelines, sandbox harness, OTLP export), trust (dataset, red-team, calibration, behavior DSL), builder-of-builders (three-layer eval, resumable sessions, meta-runtime correlation), and frontier (meta-eval correlation study, Process Reward Modeling, bisector).

## Install

```bash
pnpm add @tangle-network/agent-eval
```

## Usage

**→ [`.claude/skills/agent-eval/SKILL.md`](./.claude/skills/agent-eval/SKILL.md)** — single source of truth for every usage pattern. Covers: minimal builder-of-builders path, the seven muffled-gate footguns paid for in shipped bugs, the three-layer eval contract, regression tests worth writing, and "when to use what" for the 100+ exports.

If you're an LLM or agent reading this, load the skill file before writing integration code — it encodes 10+ incident-driven directives that will save you from rediscovering them.

## Dev

```bash
pnpm build        # tsup
pnpm test         # vitest
pnpm typecheck    # tsc --noEmit
```

## Related

- [`@tangle-network/agent-gateway`](https://github.com/tangle-network/agent-gateway)
- [`@tangle-network/agent-client`](https://github.com/tangle-network/agent-client)
- [`@tangle-network/tcloud`](https://github.com/tangle-network/tcloud)

## License

MIT
