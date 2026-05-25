# Self-improvement primitives — integration spec

**Audience:** an engineer (or agent) wiring a product onto the Tangle
self-improvement stack. This is the authoritative "how to use the primitives"
reference. It is exact: every signature, every seam, every forbidden pattern.

**Packages (published):**
- `@tangle-network/agent-eval@^0.40.3` — measurement + improvement loop +
  worktree adapter + gates + dataset store. The leaf; depends on nothing
  upstream. Import the loop surface from `@tangle-network/agent-eval/campaign`.
- `@tangle-network/agent-runtime@^0.25.0` — the runtime-side improvement
  driver (`improvementDriver`) + generators (`reflectiveGenerator`,
  `agenticGenerator`). Import from `@tangle-network/agent-runtime/improvement`.

Read [`loop-taxonomy.md`](./loop-taxonomy.md) (vocabulary) and
[`self-improvement-engine.md`](./self-improvement-engine.md) (phases) first.
This doc is the contract-level detail under them.

---

## 0. The one-paragraph model

A **measurement** (`runCampaign`) runs your agent (behind a `dispatch` seam)
over `scenarios`, judges the outputs, and returns a scorecard with confidence
intervals. An **improvement loop** (`runImprovementLoop`) drives an
`ImprovementDriver` to propose candidate **surfaces** (a prompt string, or a
`CodeSurface` = a git worktree of code edits), measures each on a **holdout**,
runs a release **gate**, and opens a **PR** for the winner. Every run feeds a
**dataset** (`LabeledScenarioStore`) — the same corpus the optimizer learns
from. Three roles, fixed meaning: **driver** decides what's next; **worker** =
the agent in a sandbox (invoked behind `dispatch`); **measurement** runs the
worker and scores it.

---

## 1. The seams you implement (everything else is substrate)

You implement exactly three things. The substrate owns the rest.

| Seam | Type | What it is |
|---|---|---|
| `dispatch` | `(scenario, ctx) => Promise<TArtifact>` | invoke YOUR agent on one scenario → the artifact judges score. Topology-opaque: one LLM call, or a driver↔workers-in-a-sandbox loop — substrate doesn't care. |
| `judges` | `JudgeConfig<TArtifact, TScenario>[]` | score an artifact on named dimensions → composite. Your rubrics. |
| `scenarios` | `Scenario[]` | the inputs (`{ id, kind, ... }`). Your eval set. |

If you are also improving a surface, you additionally provide:

| Seam | Type | What it is |
|---|---|---|
| `dispatchWithSurface` | `(surface, scenario, ctx) => Promise<TArtifact>` | like `dispatch`, but takes the candidate surface (prompt string or `CodeSurface`) — swap it into your agent before running. |
| a **driver** | `ImprovementDriver` | how candidates are proposed (see §4). Use a shipped one; don't hand-roll. |
| a **gate** | `Gate` | ship/hold decision (use `defaultProductionGate`). |

**You never implement:** generation loops, population/top-K selection, seed
propagation, manifest hashing, cell caching, bootstrap CIs, worktree git
plumbing, PR-opening, or trace capture. Reimplementing any of these is the
anti-pattern this whole stack exists to delete.

---

## 2. `runCampaign` — the measurement primitive

```ts
import { runCampaign, type RunCampaignOptions } from '@tangle-network/agent-eval/campaign'

const result = await runCampaign<MyScenario, MyArtifact>({
  scenarios,                 // MyScenario[]
  dispatch,                  // (scenario, ctx) => Promise<MyArtifact>
  judges,                    // JudgeConfig<MyArtifact, MyScenario>[]  (optional)
  runDir: '/abs/run/dir',    // REQUIRED — where artifacts + traces land
  seed: 42,                  // default 42 — reproducibility
  reps: 1,                   // per-scenario replicates; raise to 5+ for tight CIs
  maxConcurrency: 2,         // parallel cells
  costCeiling: 5.0,          // optional USD soft-abort
  tracing: 'on',             // default on; 'off' refused by improvement loop w/ a driver
  labeledStore: store,       // optional capture (see §8); 'off' to disable
  captureSource: 'eval-run', // provenance for captured rows
})
```

Returns `CampaignResult<TArtifact, TScenario>`:
```ts
{
  manifestHash: string        // sha256(scenarios, judges, dispatch ref, seed, reps) — run identity
  seed: number
  startedAt, endedAt, durationMs
  cells: CampaignCellResult[] // one per scenario×rep: { cellId, scenarioId, rep, artifact, judgeScores, costUsd, cached, error? }
  aggregates: {
    byJudge:    Record<string, JudgeAggregate>     // { mean, stdev, ci95:[lo,hi], n } — bootstrap CIs
    byScenario: Record<string, ScenarioAggregate>
    totalCostUsd, cellsExecuted, cellsSkipped, cellsCached, cellsFailed
  }
  runDir, artifactsByPath, scenarios
}
```

**Rules:**
- `dispatch` must be a *named* function (`dispatch.name` feeds the manifest hash
  — anonymous arrows weaken reproducibility identity).
- Inspect `cell.error` before trusting `cell.artifact`. Cells fail-soft
  individually (one bad scenario doesn't kill the run) but the error is
  recorded, never swallowed.
- Re-running the same `runDir` with `resumable: true` (default) skips cached
  cells by `(manifestHash, scenarioId, rep)`.

`runEval(opts)` is a thin alias for the scorecard-only case (no improvement).

---

## 3. `JudgeConfig`, `Scenario` — the domain types you own

```ts
interface Scenario { id: string; kind: string; /* + your fields */ }

interface JudgeConfig<TArtifact, TScenario = Scenario> {
  name: string
  dimensions: { key: string; weight?: number }[]
  appliesTo?: (scenario: TScenario) => boolean   // scope a judge to some scenarios
  score(args: { artifact: TArtifact; scenario: TScenario; signal: AbortSignal })
    : Promise<JudgeScore> | JudgeScore
}
interface JudgeScore { composite: number; dimensions: Record<string, number>; notes: string }
```

Judges are where your rubric lives. They MUST fail loud: if the judge LLM call
fails, throw — do not return a `composite: 0` (a fake zero is indistinguishable
from a real zero and silently corrupts every aggregate downstream).

---

## 4. The improvement loop — `runImprovementLoop`

```ts
import {
  runImprovementLoop, defaultProductionGate, evolutionaryDriver,
} from '@tangle-network/agent-eval/campaign'

const result = await runImprovementLoop({
  // --- measurement config (same as runCampaign, minus dispatch) ---
  scenarios: trainScenarios,
  judges,
  runDir,
  // --- surface improvement ---
  baselineSurface,                 // string | CodeSurface — current best
  dispatchWithSurface,             // (surface, scenario, ctx) => artifact
  driver,                          // ImprovementDriver — see §5/§6
  populationSize: 4,               // BREADTH: candidates per generation
  maxGenerations: 3,
  promoteTopK: 2,
  maxImprovementShots: 3,          // DEPTH: forwarded to the driver's propose()
  // --- gated promotion ---
  holdoutScenarios,                // NEVER in the training pool — gate scores on these
  gate: defaultProductionGate({ holdoutScenarios, deltaThreshold: 0.02 }),
  autoOnPromote: 'pr',             // 'pr' | 'none'  (NO 'config' in v0.40 — throws)
  ghOwner: 'tangle-network',
  ghRepo: 'gtm-agent',             // required when autoOnPromote: 'pr'
})
// → { winnerSurface, winnerSurfaceHash, generations, baselineOnHoldout,
//     winnerOnHoldout, gateResult, prResult? }
```

`runOptimization(opts)` is the loop body without the gate/holdout/PR (use it
when you want candidates + a winner but will gate yourself).

**Hard refusals (by design — these throw):**
- `autoOnPromote: 'config'` → deferred to a later pass (live self-mutation
  needs the full safety stack). Use `'pr'` or `'none'`.
- `tracing: 'off'` while a `driver` is wired → an improvement loop that doesn't
  feed the dataset is unattributable.
- `autoOnPromote: 'pr'` without `ghOwner`/`ghRepo`.

---

## 5. `ImprovementDriver` + `ProposeContext` — the contract

```ts
interface ImprovementDriver<TFindings = unknown> {
  kind: string
  propose(ctx: ProposeContext<TFindings>): Promise<MutableSurface[]>   // PLAN
  decide?(args: { history: GenerationRecord[] }): { stop: boolean; reason?: string }
}

interface ProposeContext<TFindings = unknown> {
  currentSurface: MutableSurface
  history: GenerationRecord[]     // prior generations + scores
  findings: TFindings[]
  populationSize: number          // how many candidates to return
  generation: number
  signal: AbortSignal
  report?: unknown                // Phase-2 research report (analyst findings + diff)
  dataset?: LabeledScenarioStore  // handle to all captured data
  maxImprovementShots?: number    // DEPTH knob
}

type MutableSurface = string | CodeSurface
interface CodeSurface { kind: 'code'; worktreeRef: string; baseRef?: string; summary?: string }
```

`propose()` returns candidates; it does NOT measure (the loop measures). For a
code-tier driver, `propose()` may itself be agentic (spawn a harness, write a
worktree) — that's the recursion. Pick a shipped driver:

---

## 6. The shipped drivers (use these; don't hand-roll)

### `evolutionaryDriver` (agent-eval) — prompt mutation, no sandbox
```ts
import { evolutionaryDriver } from '@tangle-network/agent-eval/campaign'

const driver = evolutionaryDriver({
  mutator: {                       // YOUR Mutator (the only domain bit)
    kind: 'reflection',
    async mutate({ currentSurface, populationSize, findings, signal }) {
      // return N prompt-string variants of currentSurface
      return [...]
    },
  },
})
```
Use when the surface is a **prompt string** and you have a mutation strategy
(reflection, GEPA, AxGEPA). Cheap, deterministic-friendly.

### `improvementDriver` + generators (agent-runtime) — one driver, a cost dial
```ts
import {
  improvementDriver, reflectiveGenerator, agenticGenerator,
} from '@tangle-network/agent-runtime/improvement'
import { gitWorktreeAdapter } from '@tangle-network/agent-eval/campaign'

const worktree = gitWorktreeAdapter({ repoRoot: '/abs/repo' })

// cheap, no sandbox: drafts patches from findings, applies them
const cheap = improvementDriver({
  worktree,
  generator: reflectiveGenerator({ improvementAdapter }), // wraps proposeFromFindings
  baseRef: 'main',
})

// full agentic: a real coding harness edits the worktree, retries up to maxShots
const deep = improvementDriver({
  worktree,
  generator: agenticGenerator({ harness: 'claude' }),     // claude | codex | opencode
  baseRef: 'main',
})
```
One driver; the generator is the cost dial. Both emit `CodeSurface`s the loop
measures + gates. `agenticGenerator.generate()` runs the harness with
`cwd = worktree`, trusts the **git diff** (not harness stdout) to decide
"applied", and retries up to `maxImprovementShots` on a clean tree.

---

## 7. Gates — `defaultProductionGate`, `composeGate`, `heldOutGate`

```ts
import { defaultProductionGate, composeGate, heldOutGate } from '@tangle-network/agent-eval/campaign'

// opinionated default: heldout-delta + budget + red-team + reward-hacking + canary
const gate = defaultProductionGate({
  holdoutScenarios,
  deltaThreshold: 0.02,      // winner must beat baseline by this on holdout
  budgetUsd: 5,              // optional cost ceiling
  redTeamBattery: [...],     // optional adversarial probes
})

// compose your own: ALL must ship, else the worst verdict wins
const custom = composeGate(heldOutGate({ scenarios: holdoutScenarios, deltaThreshold: 0.02 }), myDomainGate)
```

`Gate.decide(ctx) → GateResult` with a 5-valued verdict:
`GateDecision = 'ship' | 'hold' | 'need_more_work' | 'model_ceiling' | 'arch_ceiling'`.
`composeGate` returns `ship` only if all sub-gates ship; otherwise the
precedence is `arch_ceiling > model_ceiling > hold > need_more_work`. Use the
non-ship verdicts to route: `need_more_work` → more data, `model_ceiling` →
try a stronger model, `arch_ceiling` → the surface can't fix it.

`openAutoPr({ result, gate, promotedDiff, ghOwner, ghRepo })` opens the PR —
**refuses unless `gate.decision === 'ship'`**, dry-runs without a GH token.

---

## 8. The dataset flywheel — `FsLabeledScenarioStore`

```ts
import { FsLabeledScenarioStore } from '@tangle-network/agent-eval/campaign'

const store = new FsLabeledScenarioStore({ root: '/abs/dataset', maxWritesPerMinutePerBucket: 60 })
// pass to runCampaign({ labeledStore: store, captureSource: 'production-trace' })
```
Every campaign cell captures `(scenario, artifact, judgeScore, source)`. This
corpus IS the optimizer's training set. Discipline enforced at the store:
- **provenance required** on every write (source / sourceVersionHash /
  capturedAt / redactionStatus).
- **temporal split**: `sample()` requires explicit `split` + `capturedBefore`.
- **`production-trace` is excluded from the train split by default** (no
  contamination of the holdout it's judged against).

---

## 9. The migration recipe (what to DELETE / KEEP / REWIRE)

For a product that already has eval + prompt-evolution wrappers:

**DELETE (orchestration the substrate now owns):**
- generation/population/top-K loops, trial-matrix construction, frontier
  tracking, seed plumbing, manifest hashing, cell caching, scorecard
  aggregation, CI math, PR-opening scaffolding, worktree git commands.
- any local `runProductionLoop` / `runPromptEvolution` / `runAnalystLoop`
  wrapper whose body is a loop over generations × candidates × reps.

**KEEP (domain logic — it does not move):**
- scenarios (your eval inputs) → become `scenarios`.
- judges/rubrics/dimension weights → become `judges`.
- the agent-invocation function → becomes `dispatch` / `dispatchWithSurface`.
- the mutation strategy (reflection prompt) → becomes a `Mutator` or a
  generator's `buildPrompt`.
- domain gates (e.g. anti-fabrication) → compose with `defaultProductionGate`.

**REWIRE:**
- `buildHoldoutRunner()` → `dispatchWithSurface`.
- `buildScorer()` → `judges`.
- `buildMutator()` → `evolutionaryDriver({ mutator })`.
- `runProductionLoop(...)` → `runImprovementLoop(...)`.
- `runPromptEvolution(...)` → `runImprovementLoop` (surface = prompt string).
- `runAnalystLoop(...)` improvement step → `improvementDriver` + a generator;
  its findings-ledger + knowledge-graph writes stay.

Net for a typical consumer: ~2,400 LOC of orchestration deleted, ~800 LOC
rewired into the three seams.

---

## 10. Forbidden anti-patterns (a review will reject these)

1. **No silent fallbacks.** No `catch { return null }`, no `?? 0` on a judge
   composite, no returning `false`/empty on an error you can't interpret.
   External-boundary calls return typed outcomes or throw. A git/LLM/subprocess
   failure is a *throw*, never a fold-into-a-default.
2. **Don't reimplement the loop.** If you write a `for (gen of generations)`
   that mutates + scores + selects, you've rebuilt the substrate. Stop; call
   `runImprovementLoop`.
3. **Don't conflate train and holdout.** Holdout scenarios never enter the
   training pool. The gate scores on holdout only.
4. **Don't trust harness stdout.** For code edits, the git diff is the truth,
   not what the agent says it did.
5. **Account for every worktree.** A created worktree is finalized into a
   surface or discarded — never leaked, even on throw (the shipped
   `improvementDriver` already guarantees this; preserve it if you extend).
6. **Don't auto-deploy.** Promotion opens a PR (`autoOnPromote: 'pr'`). Live
   self-mutation (`'config'`) is deferred behind the full safety stack.
7. **Tracing stays on when improving.** The loop refuses `tracing: 'off'` with
   a driver wired — the dataset must be fed.
8. **Name your `dispatch`.** Anonymous dispatch weakens the manifest-hash
   reproducibility identity.

---

## 11. Minimal end-to-end skeleton

```ts
import {
  runImprovementLoop, defaultProductionGate, evolutionaryDriver,
  FsLabeledScenarioStore,
} from '@tangle-network/agent-eval/campaign'

const store = new FsLabeledScenarioStore({ root: '.dataset' })

async function dispatchWithSurface(surface: string, scenario: MyScenario) {
  return runMyAgent({ systemPrompt: surface, input: scenario }) // → MyArtifact
}

const judges = [{
  name: 'quality',
  dimensions: [{ key: 'grounding' }, { key: 'actionability' }],
  async score({ artifact, scenario }) { /* → JudgeScore, throw on failure */ },
}]

const result = await runImprovementLoop<MyScenario, MyArtifact>({
  scenarios: train, holdoutScenarios: holdout, judges,
  baselineSurface: CURRENT_PROMPT,
  dispatchWithSurface,
  driver: evolutionaryDriver({ mutator: myReflectionMutator }),
  populationSize: 4, maxGenerations: 3, promoteTopK: 2,
  gate: defaultProductionGate({ holdoutScenarios: holdout, deltaThreshold: 0.02 }),
  autoOnPromote: 'pr', ghOwner: 'tangle-network', ghRepo: 'my-agent',
  runDir: '.runs/improve', labeledStore: store, captureSource: 'eval-run',
})

if (result.gateResult.decision === 'ship') console.log('PR:', result.prResult?.prUrl)
```

That is the whole integration. Everything not in this skeleton is substrate.
