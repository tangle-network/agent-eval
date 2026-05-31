# Empirical artifact — analyzeRuns over real on-disk RunRecords (2026-05-28)

The one number that converts "infrastructure" → "result": the shipped `analyzeRuns`
primitive (agent-eval/src/contract/analyze-runs.ts) run over REAL consumer RunRecord
corpora already on disk. No mocks, no LLM calls, no fabricated data, no ground-truth labels.

## agent-builder — n=32 (eval/.runs/canonical-*/records.jsonl)
- composite: mean **0.608**, p50 **0.903**, p95 1.000, stddev 0.443 (high median, heavy failure tail)
- dominant failure modes: **forge_build_unsatisfied 28.1% (9/32)**, forge_chat_no_text 12.5% (4/32)
- single candidate ("canonical") → no pairwise lift; composite + Pareto + failure breakdown only
- This is the citable result: real distribution + real dominant-failure signal from the substrate.

### Cost axis (verified 2026-05-29, agent-eval 0.58.2)
All 32 records carry `tokenUsage {input:0, output:0}` and `costUsd 0` → the
backend-integrity verdict is **stub** (32/32 stub-mode). `analyzeRuns` now
reports this precisely: "all 32 records are stub-mode (zero token usage). The
backend never reported real LLM activity, so cost cannot be computed." The
0.58.1 pricing fix is correct but cannot help a corpus with zero tokens — the
residual cost-axis blocker is UPSTREAM (the cli-bridge backend for
`claude-code/sonnet` never captured Claude Code CLI usage into
`outcome.tokenUsage`). Fix belongs in agent-runtime / the consumer harness,
not the substrate.

## legal-agent — n=40 (tests/eval/.runs/*/records.jsonl)
- composite: mean ~0.0018 (effectively all-zero); 4 candidates, none sharing paired scenarios → lift undefined (n=1)
- Finding: this corpus is degenerate (failed/zero-scored runs, consistent with legal's pre-existing
  ESM harness bug). Not usable as an anchor number until legal produces real scored runs.

## Reproduce
`npx tsx` over the loader in this dir's sibling script: collect records.jsonl from each repo's
`.runs/*/`, call `analyzeRuns({ runs, baselineCandidateId?, candidateCandidateId? })`. Output: report.json.

## Next
- agent-builder result is real → use as the n=/composite/dominant-failure exemplar (#106/#112).
- Legal needs real scored runs (fix the harness ESM bug + a real backend) before its number means anything.
- Lift CI requires ≥2 candidates sharing scenarios+seed; neither corpus has that yet — produce a
  paired baseline-vs-candidate campaign to get a real lift number.
