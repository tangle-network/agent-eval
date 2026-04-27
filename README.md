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

## v0.15 highlights — paper-grade primitives

- `PromotionGate` — held-out paired-delta gate with `few_runs` /
  `negative_delta` / `overfit_gap` rejection codes and a full evidence
  block on every decision.
- `RunRecord` — JSON-friendly run schema with mandatory paper fields
  (`runId`, snapshot-versioned `model`, `promptHash`, `configHash`,
  `commitSha`, `costUsd`, `splitTag`). Runtime validator throws on
  missing fields.
- `Researcher` — stable four-method hook (`inspectFailures` →
  `proposeChange` → `applyChange` → `evaluateChange`) for autonomous
  research drivers; `NoopResearcher` fails loud as a placeholder.
- `paperTable`, `paretoFigure`, `gainDistributionFigure` — Table 1,
  cost-vs-quality scatter, gain-distribution histogram. Returns data
  specs, not images. Render with vega-lite, plotly, matplotlib, or
  inline Canvas.
- `runCanaries` — silent judge-fallback, calibration drift (KS test),
  distribution shift (chi-square).
- `pairedBootstrap` (+ `pairedWilcoxon`, `bhAdjust` aliases) — the
  paired-bootstrap CI primitive that powers `PromotionGate` and
  `gainDistributionFigure`.
- `benchmarks/` — `gsm8k`, `swebench-lite`, `routing` reference
  wrappers behind one `BenchmarkAdapter` shape.

See `CHANGELOG.md` for the full list. `.claude/skills/agent-eval/SKILL.md`
covers usage directives and pitfalls.

## Related

- [`@tangle-network/agent-gateway`](https://github.com/tangle-network/agent-gateway)
- [`@tangle-network/agent-client`](https://github.com/tangle-network/agent-client)
- [`@tangle-network/tcloud`](https://github.com/tangle-network/tcloud)

## License

MIT
