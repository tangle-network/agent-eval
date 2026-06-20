# The self-improvement engine

How the pieces compose into a closed loop that improves an agent over time.
This builds on [`loop-taxonomy.md`](./loop-taxonomy.md) (the role vocabulary)
— read that first. Here we describe the *engine*: the phases, the data flow,
and where each existing primitive plugs in.

## The closed loop, by phase

```
PHASE 1 — RUN
  execution driver ↔ workers (sandbox) over scenarios
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
  SurfaceProposer.propose(input) → MutableSurface[]
  input carries:
    - currentSurface      the current best surface (prompt string or CodeSurface)
    - history             prior generations + their scores
    - report              the Phase-2 research report (findings + diff)
    - traces              all traces (read access) — "all the data"
    - dataset             the LabeledScenarioStore handle
    - populationSize      BREADTH: how many candidate surfaces to return
    - maxImprovementShots DEPTH: how many runLoop iterations each candidate
                          generation may take (1..MAX_IMPROVEMENT_SHOTS)
  For the code-tier (autoresearch) proposer, propose() runs a FULL sandbox
  runLoop: an execution driver ↔ worker(s) loop that reads report+traces+codebase and
  produces the improvement as commits in ONE worktree per candidate.
  Output: CodeSurface{ worktreeRef }[] (or string[] for prompt-tier).

PHASE 4 — MEASURE
  each candidate → runCampaign on the holdout set
  (checks out the candidate's worktree, runs the worker against the changed
   code/prompt, judges, scores). The measurement is proposer-agnostic.

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
candidate surfaces to measure next.

There is ONE proposer, not several. agent-runtime ships a single
`improvementDriver` that implements this contract and owns the candidate
lifecycle (worktree create → generate → finalize/discard, × `populationSize`);
it delegates the only thing that varies — *how* a candidate change is produced
— to a pluggable `CandidateGenerator`. The generators span a cost spectrum:

| Generator | mechanism | sandbox? | output |
|---|---|---|---|
| `evolutionaryDriver` (agent-eval) | mutate current surface text into N variants | no | `string[]` |
| `reflectiveGenerator` (agent-runtime) | LLM drafts patches from the report → applies them | LLM call | `CodeSurface` |
| `agenticGenerator` (agent-runtime) | a real coding harness in the worktree (≤ `maxImprovementShots`) reads report+codebase → edits in place | **yes** | `CodeSurface` |

`evolutionaryDriver` is a standalone `SurfaceProposer` (pure, agent-eval).
The reflective + agentic paths are two *generators* of the one
`improvementDriver` — the same operation at two settings of the cost dial, not
two separate proposers.

The recursion: generating *one* candidate (the agentic generator) is itself a
harness-agent editing a worktree, nested inside the *measurement* of that
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
| `SurfaceProposer` / historical `ImprovementDriver` contract | agent-eval | the shared interface; everyone implements it |
| widened `propose()` input (report/traces/dataset) | agent-eval | part of the contract |
| `evolutionaryDriver` | agent-eval | pure: dataset → surface, no sandbox |
| **VCS-pluggable worktree adapter** | agent-eval | pure git/FS, no sandbox; produces `CodeSurface` |
| `runOptimization` / `runImprovementLoop` | agent-eval | proposer-agnostic loop body + gated shell |
| `defaultProductionGate` | agent-eval | measurement-side safety |
| **`improvementDriver`** + `reflectiveGenerator` / `agenticGenerator` | agent-runtime | needs the coding-harness runner + worktree on a real FS |
| trace analysts / `runAnalystLoop` (Phase 2) | agent-runtime | runs agents to analyze |

## The worktree adapter (VCS-pluggable)

One improvement = one worktree, PR-like (multiple commits allowed). The
adapter abstracts the VCS so proposer code is VCS-agnostic:

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

1. **agent-eval 0.40.2** ✅: widen `propose()` input (additive optional
   `report` / `dataset` / `maxImprovementShots`); VCS-pluggable worktree
   adapter with a git impl.
2. **agent-runtime 0.25.0** ✅: `improvementDriver` (the one driver) +
   `reflectiveGenerator` (shots=1, no sandbox) + `agenticGenerator` (coding
   harness in the worktree, ≤ `maxImprovementShots`), all fed the Phase-2
   report. Default tracing was descoped — the flywheel's production capture is
   already served by agent-runtime's OTEL export + `runCampaign`'s labeledStore.
3. Wire one consumer end-to-end (Phase 4 of the broader rollout), prove it,
   then fan out.
