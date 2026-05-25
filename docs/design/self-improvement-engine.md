# The self-improvement engine

How the pieces compose into a closed loop that improves an agent over time.
This builds on [`loop-taxonomy.md`](./loop-taxonomy.md) (the role vocabulary)
— read that first. Here we describe the *engine*: the phases, the data flow,
and where each existing primitive plugs in.

## The closed loop, by phase

```
PHASE 1 — RUN
  driver ↔ workers (sandbox) over scenarios
  → traces emitted → TraceStore + LabeledScenarioStore (the dataset)
  Every run feeds the dataset regardless of why it ran (see the flywheel
  section in loop-taxonomy.md). This is the only source of improvement signal.

PHASE 2 — ANALYZE                                  ← the research report is born here
  trace analysts run over the accumulated traces
  (today: runAnalystLoop steps 2–4 in agent-runtime)
    - run the analyst registry over traces → findings
    - persist findings to the ledger
    - diff the new findings vs the baseline → research report
  Output: a research report = { findings, diff } grounded in real traces.

PHASE 3 — PROPOSE
  ImprovementDriver.propose(input) → MutableSurface[]
  input carries:
    - currentSurface      the current best surface (prompt string or CodeSurface)
    - history             prior generations + their scores
    - report              the Phase-2 research report (findings + diff)
    - traces              all traces (read access) — "all the data"
    - dataset             the LabeledScenarioStore handle
    - populationSize      BREADTH: how many candidate surfaces to return
    - maxImprovementShots DEPTH: how many runLoop iterations each candidate
                          generation may take (1..MAX_IMPROVEMENT_SHOTS)
  For the code-tier (autoresearch) driver, propose() runs a FULL sandbox
  runLoop: a driver↔worker(s) loop that reads report+traces+codebase and
  produces the improvement as commits in ONE worktree per candidate.
  Output: CodeSurface{ worktreeRef }[] (or string[] for prompt-tier).

PHASE 4 — MEASURE
  each candidate → runCampaign on the holdout set
  (checks out the candidate's worktree, runs the worker against the changed
   code/prompt, judges, scores). The measurement is driver-agnostic.

PHASE 5 — GATE + PROMOTE
  defaultProductionGate(winner vs baseline on holdout) → ship | hold | …
  on ship → open a PR from the winning worktree (one worktree = one PR).

  ↺ loop back to PHASE 1 with the promoted surface as the new baseline.
```

The improvement loop body (`runOptimization`) owns Phases 3–4; the gated
shell (`runImprovementLoop`) adds Phase 5. Phases 1–2 are upstream — the
run that produces traces, and the analysts that turn traces into a report.

## `propose()` — the plan step, recursively agentic

`propose()` does NOT run the worker and does NOT measure. It returns N
candidate surfaces to measure next. *How* it produces them is per-driver and
spans a cost spectrum:

| Driver | `propose()` mechanism | Sandbox? | Output |
|---|---|---|---|
| `evolutionaryDriver` | mutate current surface text into N variants | no | `string[]` |
| `analystDriver` (reflective) | LLM reads the report → drafts edits | LLM call | `string[]` / `CodeSurface[]` |
| `autoresearchDriver` (code-tier) | **full sandbox runLoop** (≤ `maxImprovementShots`) reads report+traces+codebase → commits in one worktree | **yes** | `CodeSurface[]` |

The recursion: generating *one* candidate (autoresearch `propose`) is itself a
driver↔worker-in-a-sandbox loop, nested inside the *measurement* of that
candidate (Phase 4), nested inside the improvement loop. "A loop whose step
contains a loop."

Two knobs, not one:
- **`populationSize`** — breadth: how many candidates `propose()` returns.
- **`maxImprovementShots`** — depth: how many runLoop iterations the
  generating agent gets per candidate (N=1 → single-shot; N>1 → it can
  iterate on its own change before handing it back to be measured).

## Package boundaries (respecting the leaf direction)

agent-eval is the leaf (imports nothing upstream). agent-runtime imports it.
So:

| Piece | Package | Why |
|---|---|---|
| `ImprovementDriver` contract | agent-eval | the shared interface; everyone implements it |
| widened `propose()` input (report/traces/dataset) | agent-eval | part of the contract |
| `evolutionaryDriver` | agent-eval | pure: dataset → surface, no sandbox |
| **VCS-pluggable worktree adapter** | agent-eval | pure git/FS, no sandbox; produces `CodeSurface` |
| `runOptimization` / `runImprovementLoop` | agent-eval | driver-agnostic loop body + gated shell |
| `defaultProductionGate` | agent-eval | measurement-side safety |
| **`autoresearchDriver`** (sandbox-spawning `propose`) | agent-runtime | needs the sandbox SDK + `runLoop` |
| `analystDriver` (wraps the improvement adapter) | agent-runtime | depends on `runAnalystLoop` machinery |
| trace analysts / `runAnalystLoop` (Phase 2) | agent-runtime | runs agents to analyze |

## The worktree adapter (VCS-pluggable)

One improvement = one worktree, PR-like (multiple commits allowed). The
adapter abstracts the VCS so the driver code is VCS-agnostic:

```ts
interface WorktreeAdapter {
  create(opts: { baseRef: string; label: string }): Promise<Worktree>
  // ... agent commits into worktree.path ...
  finalize(wt: Worktree, summary: string): Promise<CodeSurface>  // → { kind:'code', worktreeRef, baseRef, summary }
  discard(wt: Worktree): Promise<void>
}
```

- **git** impl ships first (`git worktree add` / branch / commit).
- **jj** ([jj-vcs](https://github.com/jj-vcs/jj)) is a candidate second impl —
  not built now; the interface exists so it can slot in without touching
  driver code.

The measurement (Phase 4) consumes a `CodeSurface` by checking out
`worktreeRef` before running the worker; on promotion (Phase 5) the worktree
becomes the PR branch.

## Build sequence

1. **agent-eval 0.40.2**: widen `propose()` input (additive optional
   `report` / `traces` / `dataset` / `maxImprovementShots`); add the
   VCS-pluggable worktree adapter with a git impl; multi-sink trace fan-out
   helper.
2. **agent-runtime 0.25.0**: `analystDriver` (wraps the improvement adapter,
   fed the Phase-2 report); `autoresearchDriver` (sandbox runLoop `propose`);
   default-on multi-sink tracing in `handleChatTurn`.
3. Wire one consumer end-to-end (Phase 4 of the broader rollout), prove it,
   then fan out.
