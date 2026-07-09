# Improvement glossary + proposer chooser + composition

> **In plain terms:** this is the dictionary for the *improvement* half of the stack — the words that show up when you optimize an agent (proposer, surface, candidate, generation, holdout, lift, gate…) rather than when you *run* one (driver, worker, iteration — those live in [`agent-runtime/docs/glossary.md`](../../agent-runtime/docs/glossary.md)).
> Read this once and you can read any improvement result, pick a proposer, and wire two of them together.

**Who this is for.**
A **novice** (never seen the repo) should be able to read a `CampaignResult`, a `ProposeContext`, and a proposer chooser table without opening the source.
An **expert** who knows DSPy/GEPA should be able to map their existing mental model onto our names in about a minute — every core term below carries a *"if you know DSPy/GEPA"* line.
If code and this file disagree, the code wins — fix this file the same turn (the anti-staleness law).

Neighbors, so this page does not duplicate them: [`concepts.md`](./concepts.md) (eval mental model), [`self-improvement-map.md`](./self-improvement-map.md) (one loop / four roles / proposer catalog), [`campaign-proposers.md`](./campaign-proposers.md) (proposer ELI5), [`eval-surface-map.md`](./eval-surface-map.md) (which `run*` primitive), [`design/loop-taxonomy.md`](./design/loop-taxonomy.md) (execution vs proposer layering).

## The 60-second mental model

One loop improves one **surface**.
Every generation: a **proposer** reads what failed and emits **candidate** surfaces; a **campaign** measures each candidate by running the agent over **scenarios × reps** and **judging** every run; the loop ranks candidates and re-scores the best on a **holdout**; a **gate** decides whether that beat the **baseline** for real; if yes, it is **promoted**.

```text
baseline surface
   └─► PROPOSER: read findings ─► N candidate surfaces          (one GENERATION)
          └─► CAMPAIGN: run agent on scenarios × reps ─► JUDGE each ─► composite
                 └─► rank candidates ─► re-score best on HOLDOUT
                        └─► GATE: did it beat baseline (significance)?  ship / hold
   repeat for maxGenerations
```

## Glossary — one plain sentence each

Grounded to `agent-eval/src/campaign/types.ts` unless noted.

| Term | Plain sentence | If you know DSPy/GEPA |
|---|---|---|
| **surface** | The one thing being changed this run — a prompt string, a JSON config string, or a code/worktree ref (`MutableSurface = string \| CodeSurface`, `types.ts:158`). | The optimized artifact: a signature/predictor's instruction text, or the module config. |
| **proposer** | The strategy that, given the current surface + what failed, proposes the next batch of candidate surfaces to measure — it does **not** run the agent or score anything (`SurfaceProposer.propose`, `types.ts:286`). | The optimizer / teleprompter (MIPRO, BootstrapFewShot, GEPA's reflective proposer). |
| **candidate** | One proposed surface plus its human `label` and `rationale`, ready to be measured (`ProposedCandidate`, `types.ts:166`). | One trial instruction/program the optimizer wants to evaluate. |
| **generation** | One round of *propose → measure → rank → promote*; the loop runs up to `maxGenerations` of them (`GenerationRecord`, `types.ts:549`). | One GEPA iteration / optimization step. |
| **populationSize** | BREADTH — how many candidate surfaces the proposer returns *this* generation (`ProposeContext.populationSize`, `types.ts:237`). Paired with `maxGenerations` (DEPTH) as the search budget. | Beam width / number of minibatch candidates per step. |
| **population budget** | Informal name for the pair `{ populationSize, maxGenerations }` — the total candidates the search may evaluate (breadth × depth). | Optimizer trial budget. |
| **campaign** | One measurement: run a dispatch over scenarios × seeds × reps, judge each output, aggregate → `CampaignResult` (`runCampaign`; a "campaign" = a coordinated batch of measurements). | One evaluation pass of a candidate over a valset. |
| **cell** | The atomic measurement unit — exactly one `(scenario, rep)` execution producing one artifact + its judge scores + its cost (`CampaignCellResult`, `types.ts:509`; `DispatchContext.cellId/rep`). | One (example, seed) evaluation datapoint. |
| **scenario** | One input case with a stable `id` + `kind` (consumers attach their payload: persona, task, requirement) (`Scenario`, `types.ts:23`). | One dataset example / `dspy.Example`. |
| **rep** | The repetition index — the same scenario run more than once so noise/variance is measurable rather than mistaken for signal (`ctx.rep`). | Repeated sampling of the same example (temperature/seed variance). |
| **judge** | A scorer: given an artifact, return dimensions + a single `composite` + free-form `notes`; it throws on failure rather than silently scoring 0 (`JudgeConfig` → `JudgeScore`, `types.ts:94/116`). | The metric function, but pluggable (LLM-judge, deterministic checks, or an ensemble). |
| **composite** | The single 0..1 number that combines all judge dimensions — the number you rank and gate on (`JudgeScore.composite`, `types.ts:116`). | The scalar metric value. |
| **findings** | The failure analysis handed to the proposer so it edits from evidence, not guesses — worst cells + judge reasons, or a trace-analyst's clusters (`ProposeContext.findings`). | GEPA's reflective feedback / the "textual gradient". |
| **baseline** | The starting surface (the current prompt/config) every candidate is measured against (`baselineSurface`). | The unoptimized program you compare lift against. |
| **holdout** | A separate scenario split the winner is re-scored on and that the proposer is *never* allowed to see — a compile-time firewall (`ProposeContext.judgeScores: never`, `types.ts:265`) keeps held-out verdicts out of proposal so the optimizer can't game the acceptance axis. | The held-out valset/testset — but here it is *write-only* to the optimizer. |
| **lift** | Winner minus baseline `composite` on the holdout — the actual improvement, reported with a bootstrap confidence interval (`ImproveResult.lift`, `ProposerScore.lift`). | Δ metric between optimized and baseline program. |
| **MDE** | Minimum Detectable Effect — the smallest lift your budget could statistically distinguish from noise, computed up front from baseline cells; a structurally-hopeless budget warns before you spend (surfaced as `result.power` / "power preflight", `agent-optimization-map.md`). Not spelled "MDE" in code yet — this is the standard name for it. | Power analysis on the eval set; the reason a tiny valset can't certify a small gain. |
| **Pareto frontier** | The set of surfaces that are non-dominated across the per-scenario score vectors — a candidate worse on the mean but uniquely best on one hard scenario survives, so its lesson is not discarded (`ParetoParent`, `types.ts:198`; GEPA, arXiv:2507.19457). | Exactly GEPA's Pareto candidate pool — same paper, same idea. |
| **gate** | The promotion decision: does the winner beat baseline on the holdout with significance, returning one of five verdicts `ship / hold / need_more_work / model_ceiling / arch_ceiling` (`Gate`, `GateDecision`, `types.ts:315/340`). | The accept/reject rule on the held-out valset, plus a significance test and ceiling diagnosis. |
| **promotion** | What happens on a `ship` verdict — the winning surface is written back into the profile field it came from (`GenerationRecord.promoted`; `applyWinnerToProfile`, `improve.ts`). | Committing the optimized program as the new default. |

## Which proposer — the chooser

Every optimizer is a factory `xProposer(opts): SurfaceProposer`, all exported from `@tangle-network/agent-eval/campaign`.
Start at the top row and only move down when the row's *"reach for it when"* matches your failure mode.

| Proposer factory | Reach for it when | Surface it edits | Wired to the paved path? |
|---|---|---|---|
| `gepaProposer` | You want the strong default: reflective full-surface prompt rewrites, grounded in findings, keeping a Pareto frontier of complementary winners. | prompt string | **Yes — `improve({ surface: 'prompt' })` default.** Proven live. |
| `skillOptProposer` | You are editing a structured `SKILL.md`/runbook and want small anchored add/delete/replace patches that preserve earlier rules. | skill/prompt string | **Yes — `improve({ surface: 'skills' })` default.** Not yet proven live. |
| `parameterSweepProposer` | The likely fix is a config knob, not words — `retrieval.k`, `temperature`, `max_tokens`. You give it candidate patches; it applies them to a JSON surface. | JSON config string | Yes, but you supply the candidate list. |
| `fapoProposer` | You want *evidence to decide when to escalate*: try prompt edits first, move to parameters, then to structural code — one scoped change per cycle, only escalating when the cheaper level is exhausted. | whatever its level proposers return | Exported; you wire the level proposers. |
| `compositeProposer` | You want several proposers to share one candidate-generation budget in the same round. It allocates the population by declared weights, preserves member provenance, deduplicates surfaces, and isolates a member failure unless every member fails. | whatever its member proposers return | Exported; you wire the member proposers. |
| `aceProposer` | You are accumulating hard-won lessons into a playbook and must **never** summarize an old lesson away (append-only, provenance-tagged). | playbook string | Exported. |
| `memoryCurationProposer` | Same as ACE but you want a compact, deduped, re-ranked memory instead of append-only growth. | memory string | Exported. |
| `evolutionaryProposer` | You want blind population search (mutate → measure → select) with no reflection over findings — a cheap control or a baseline to beat. | any string | Exported. |
| `traceAnalystProposer` | Bench-only: race our trace-analysis evidence engine head-to-head inside `compareProposers`. | prompt string | Bench-only. |
| `haloProposer` | Bench-only: race the external `halo-engine` analysis against ours. | prompt string | Bench-only, external. |

Default path: `gepaProposer` for prompts; add `parameterSweepProposer` when a config knob is the suspect; wrap levels in `fapoProposer` when the loop should decide *when* to escalate, or use `compositeProposer` when multiple proposer families must split one fixed population budget.

## Composing proposers — four distinct shapes

Choose the shape that matches the experiment:

1. **Portfolio** — `compositeProposer` splits one generation's population across member proposers by fixed weights and returns one provenance-labelled pool.
2. **Escalate** — `fapoProposer` wraps prompt + parameter + structural levels into one proposer and spends on the cheapest level until evidence says to escalate.
3. **Race** — `compareProposers` gives proposers separate loops, then re-scores their winners on one holdout and returns per-proposer lift intervals plus pairwise results.
4. **Plug in** — hand any proposer to `runImprovementLoop({ proposer })`, or use `improve({ surface, generator })` in `@tangle-network/agent-runtime`.

### 2 + 4 — compose by escalation, then run the improvement loop

```ts
import {
  fapoProposer,
  gepaProposer,
  parameterSweepProposer,
  defaultProductionGate,
  runImprovementLoop,
} from '@tangle-network/agent-eval/campaign'

const llm = { baseUrl: process.env.TANGLE_BASE_URL, apiKey: process.env.TANGLE_API_KEY }
const model = 'deepseek-v4-flash'

// Compose: prompt edits first (GEPA), escalate to a config knob only when
// prompt-level search plateaus. `fapoProposer` IS the composite proposer.
const proposer = fapoProposer({
  scope: { allowedLevels: ['prompt', 'parameter'] },   // no structural/code tier here
  promptProposer: gepaProposer({ llm, model, target: 'agent system prompt' }),
  parameterProposer: parameterSweepProposer({
    candidates: [
      {
        label: 'raise-retrieval-k',
        rationale: 'retrieval-miss findings suggest the search budget is too low',
        changes: [{ path: 'retrieval.k', value: 10 }],
      },
    ],
  }),
})

// dispatchWithSurface scores ONE surface on ONE scenario — this is the topology-
// opaque seam (one LLM call, one worker, or a whole fleet — the loop can't tell).
const dispatchWithSurface = async (surface, scenario, ctx) =>
  runYourAgent({ surface, scenario, signal: ctx.signal })   // returns the artifact to judge

const result = await runImprovementLoop({
  scenarios: trainScenarios,          // proposer trains on these
  holdoutScenarios,                   // winner is re-scored here; proposer never sees them
  baselineSurface: currentPromptString,
  dispatchWithSurface,
  judges,                             // JudgeConfig[]
  proposer,
  gate: defaultProductionGate({ holdoutScenarios, deltaThreshold: 0 }),
  populationSize: 2,                  // BREADTH per generation
  maxGenerations: 6,                  // DEPTH
  autoOnPromote: 'none',              // 'pr' to open a PR on ship
  runDir: '/tmp/improve-run',         // a REAL path makes the run durable
})

result.winnerSurface   // the promoted surface
result.gateDecision    // 'ship' | 'hold' | 'need_more_work' | 'model_ceiling' | 'arch_ceiling'
```

Same thing, one line, when you have an `AgentProfile` (facade in `@tangle-network/agent-runtime`):

```ts
import { improve } from '@tangle-network/agent-runtime'

// surface 'prompt'/'skills' pick their proposer automatically; pass `generator`
// to plug the composed FAPO proposer above into the gated loop instead.
const out = await improve(profile, findings, {
  surface: 'prompt',
  generator: proposer,               // any SurfaceProposer, incl. the composed one
  scenarios, judge, agent, runDir: '/tmp/improve-run',
})
if (out.shipped) deploy(out.profile)  // out.lift is the held-out winner − baseline
```

### 2 — race proposers head-to-head for a lift CI

```ts
import {
  compareProposers,
  gepaParetoEntry,
  fapoEscalationEntry,
} from '@tangle-network/agent-eval/campaign'

const config = {
  baselineSurface: currentPromptString,
  trainScenarios,
  holdoutScenarios,
  dispatchWithSurface,
  judges,
  llm, model,
  target: 'agent system prompt',
  runDir: '/tmp/compare-run',
}

const comparison = await compareProposers({
  proposers: [
    gepaParetoEntry(config),                        // GEPA + Pareto frontier
    fapoEscalationEntry({                            // FAPO escalation policy
      ...config,
      parameterCandidates: [
        { label: 'raise-retrieval-k', rationale: 'retrieval misses', changes: [{ path: 'retrieval.k', value: 10 }] },
      ],
    }),
  ],
  baselineSurface: currentPromptString,
  holdoutScenarios,
  dispatchWithSurface,
  judges,
  runDir: '/tmp/compare-run',
})

comparison.best          // highest-lift proposer
comparison.scores        // per-proposer { lift, liftCi:{low,high}, cost } — low>0 ⇒ real gain
comparison.pairwise      // best vs each other, paired-bootstrap: 'a' | 'b' | 'tie'
```

Every entrant is re-scored on the **same** holdout with the **same** judges, so the comparison never trusts how a proposer measured itself — the only variable is proposal quality.

## Common traps (they cost the most)

- Do not put eval logic inside a proposer — scoring lives in `dispatch` + `judges`, proposing lives in the proposer.
- Do not let a proposer read held-out judge scores — `ProposeContext` makes that a compile error on purpose; a proposer that games the acceptance axis is an oracle, not an optimizer.
- Do not read `lift` without `result.power`/MDE — a "+4" on a valset too small to detect +4 is noise wearing a number.
- Do not confuse `compositeProposer` with `fapoProposer`: the former allocates one fixed population across peers, while the latter escalates through ordered levels from cheaper to more structural changes.

### neutralizationGate — the placebo / content-causality control

Standard gates prove a candidate *beat baseline*. `neutralizationGate` proves the candidate's **content** caused the lift, not the extra prompt bytes: it blanks the candidate's added content to byte-length-matched filler, holds everything else fixed, and requires the lift to vanish. A fully-neutralized candidate that still scores is decorative and is rejected. Exports: `neutralizationGate` (`src/campaign/gates/neutralization-gate.ts`), `neutralizeText` (`src/campaign/neutralize.ts`). Since 0.107.0. Pair it with `heldOutGate` in any loop that promotes authored artifacts (prompts, tool docs, knowledge) so a lift that is really just added prompt size cannot be shipped.
