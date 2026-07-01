# Eval Fixtures Quickstart

Folder-per-eval UX on top of `runCampaign`.

```sh
pnpm tsx examples/eval-fixtures-quickstart/index.ts
```

This example is offline. The dispatch is a deterministic stand-in for a coding
agent, and the judge is a deterministic stand-in for a real checker. Replace
the dispatch with your `agent-runtime` or sandbox call; keep the fixture loading
and dry-run planning.

Expected shape:

```text
Before: 2 to run / 0 cached
After:  0 to run / 2 cached
Mean:   1.000
```

## Files

- `evals/*/PROMPT.md` — task prompt for one eval.
- `evals/*/EVAL.ts` — deterministic validation file. The fixture loader
  validates it exists; your dispatch decides how to execute it.
- `index.ts` — loads fixtures, previews the run, executes `runCampaign`, then
  previews cache reuse.
