# The self-improvement map

One loop. Four roles. A proposer catalog of pluggable strategies. A bench rig that
proves the loop produces real lift. Nothing here is duplicated — it is one engine
pointed at different surfaces. This map exists because the surface count makes it
*look* like many competing systems when it is one.

Neighbors: [`concepts.md`](./concepts.md) (the mental model), [`trace-analysis.md`](./trace-analysis.md)
(the evidence engine), [`distributed-driver.md`](./distributed-driver.md) (running the loop across cells).

## The one loop

`runImprovementLoop()` (wrapped by `selfImprove()` for the one-call surface). Every
product imports the same function. Each generation it does four things:

```
   run AGENT on SCENARIOS ──► JUDGE scores each run
                                      │
                          PROPOSER reads the failures and
                          proposes better SURFACE versions
                                      │
                  GATE: did a candidate beat the parent on a
                  HELD-OUT split, for real (significance test)?
                        │ yes → promote      │ no → discard
                                      │
                              repeat N generations
```

## The four roles — keep them separate and the confusion clears

| Role | What it is | Plain meaning |
|---|---|---|
| **Surface** | a *string* — an agent directive, a `SKILL.md`, a playbook, a memory, a judge rubric | **what** gets improved |
| **Proposer** | a `SurfaceProposer` (the catalog below) | **how** candidate surfaces are proposed |
| **Gate** | held-out split + significance (`paretoSignificanceGate` / `heldOutGate` / `defaultProductionGate`) | **did it actually get better**, vs noise |
| **Judge** | scores a run | **how good** any version is |

## The proposer catalog (one loop, multiple strategies)

The package intentionally exposes named proposer factories instead of a hidden
auto-selector. The split that matters: **production proposers** mutate a live
surface; **bench-only proposers** exist solely to be raced inside
`compareProposers`.

| Proposer factory | Surface | Strategy | Role | Notes |
|---|---|---|---|---|
| `gepaProposer` | prompt | reflective full-surface rewrite + Pareto frontier | **production default** | consumes trace-analysis findings — see below |
| `fapoProposer` | prompt/config/code | reviewed escalation policy over prompt → parameter → structural proposers | production, benchmark | encodes FAPO's scope + reviewer + prompt-first escalation rules; structural generator is injected |
| `parameterSweepProposer` | config | JSON config patch/sweep | production, benchmark | middle FAPO level for parameter/config edits such as `retrieval.k`, `temperature`, `max_tokens` |
| `skillOptProposer` | skill-doc | anchored add/delete/replace patch | production | preserves earlier rules; edit budget = "textual learning rate" |
| `aceProposer` | playbook | append-only, provenance-tagged | production | accumulate hard-won lessons, never summarize away |
| `memoryCurationProposer` | memory | dedup + rank + graft | production | compact alternative to `ace` |
| `evolutionaryProposer` | any | population mutate → measure → select | production | blind search; no reflection over findings |
| `traceAnalystProposer` | prompt | analysis → one LLM edit | **bench-only** | our evidence engine, wrapped as a proposer |
| `haloProposer` | prompt | analysis → one LLM edit | **bench-only**, external | wraps `pip install halo-engine` (Inference.net) |

Default choice: start with `gepaProposer` for prompt surfaces, add
`parameterSweepProposer` when config knobs are the likely failure mode, and wrap
them with `fapoProposer` when evidence should decide when to escalate.

## Trace analysis — what it is and the three places it is used

"Trace analysis" is the **evidence layer**: it turns raw OTLP traces into "here is
exactly *why* the agent failed" (failure clusters → findings). The engine is
`analyzeRuns()` + the analyst registry (`src/contract/analyze-runs.ts`). It is used in
three places — this is the answer to "if GEPA does its own thing, what is trace
analysis *for*?":

1. **Ships to customers** — `analyzeRuns()` → `InsightReport`, the Intelligence product.
2. **Feeds the proposer** — `gepaProposer` calls `renderAnalystEvidence(ctx.findings,
   ctx.report)` (`src/campaign/proposers/gepa.ts`). GEPA's rewrites are grounded
   in the diagnosis instead of guessing blind. Trace analysis
   **is** on the GEPA side.
3. **Races HALO** — wrapped as `traceAnalystProposer` so our analysis competes
   head-to-head with the external SOTA inside `compareProposers`.

## Where HALO fits (and why it feels "removed")

`haloProposer` is alive (`src/campaign/proposers/halo.ts`, exported from the campaign
barrel) but it is **never in the product loop**. It shells out to an *external* engine
(`halo-engine`) — so the analysis genuinely lives outside this repo; we only wrap it.

Its only job is the **bake-off**. HALO's real opponent is **not** `gepaProposer` — it is
`traceAnalystProposer`. `compareProposers` holds the apply step identical (same
`APPLY_SYSTEM`, same `traces.jsonl`, same held-out scoring) so the only variable is
**analysis quality: HALO vs ours.** A measuring stick, like a benchmark baseline.

## `gepa-refine.ts` is the loop on a test bench, not a second loop

`agent-runtime/bench/src/gepa-refine.ts` runs **this same loop** against a *public
benchmark* (AppWorld, CAD, …) instead of product data. Why a separate rig:

- On product traces, "+4 lift" can be model noise or a judge flattering itself — no
  ground truth.
- On a benchmark the score is **objective and ungameable** (AppWorld runs the agent's
  code against its own unit tests). If a GEPA-optimized directive beats a deliberately
  weak baseline **on held-out tasks it never trained on**, with a CI excluding zero,
  that is a *certified* proof the loop produces real lift.

Products run the loop to get **better**. `gepa-refine` runs the identical loop to
**prove the loop works at all**.

## Where the "mess" feeling actually comes from

The code is well-factored; the confusion is narrative:

- **Surface sprawl reads as chaos.** Several proposers with overlapping shapes *look* like
  competing loops. They are exported factories for one loop; this map makes that
  explicit.
- **The real gap is the missing proof, not the design.** The loop kept being proved on
  benchmarks too easy to show value: when a capable model ceilings an extraction task,
  **0 findings fire** and the whole trace-analysis→optimizer apparatus is inert. It
  earns its keep only on **hard agentic tasks** — which is why the AppWorld REPL run
  (multi-turn, real tool execution, unbounded turns) is the one that can finally
  separate the evidence-grounded optimizer from baseline.
