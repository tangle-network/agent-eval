# Pass A — Substrate 0.40 consolidation

Status: **proposed implementation track**
Date: 2026-05-25
Supersedes: `runcampaign-1.0.md` (the v4 design, downgraded from "v1.0" per 4-reviewer synthesis at `.evolve/reviews/2026-05-25-SYNTHESIS.md`)
Mean reviewer score on v4: 5.0/10 — wrapper collapse correct, several blockers + table-stakes gaps. Pass A addresses them.

## TL;DR

Same primitive (`runCampaign`) as v4 — but with:
- A defined return schema (`CampaignResult`)
- Determinism (seed + cell-level resumability)
- Safety primitives wired into defaults (red-team / reward-hacking / canary / heldout-auditor existing modules go from archaeology to default `composeGate`)
- `LabeledScenarioStore` train/test contamination + data-poisoning closed
- Three named public presets (`runEval` / `runOptimization` / `runProductionLoop`)
- `autoOnPromote: 'config'` (Shape B — live-production self-mutation) DEFERRED to Pass B

Result: **safe + reviewable + reproducible substrate that 5 products can adopt in 3-4 weeks**. Reserves the "1.0" stamp for after Pass B safety stack (shadow / canary / rollback / ensemble judges) lands.

---

## The shape (Pass A)

### Internal primitive

```ts
// agent-eval/src/campaign/run-campaign.ts
runCampaign<TScenario extends Scenario, TArtifact>(opts: {
  // ── Input ──
  scenarios: TScenario[]
  dispatch: (scenario: TScenario, ctx: DispatchContext) => Promise<TArtifact>
  sessions?: SessionScript<TScenario, TArtifact>[]   // multi-session state-carrying

  // ── Scoring ──
  judges?: JudgeConfig<TArtifact, TScenario>[]

  // ── Improvement ──
  optimizer?: {
    mutator: Mutator
    populationSize: number
    maxGenerations: number
    surfaceExtractor: (profile: AgentProfile) => MutableSurface
  }
  gate?: Gate<TArtifact>
  autoOnPromote?: 'pr' | 'none'                       // 'config' DEFERRED to Pass B

  // ── Data accumulation ──
  labeledStore?: LabeledScenarioStore | 'off'         // capture default ON, training source default OFF

  // ── Tracing (default ON) ──
  tracing?: TraceStore | 'off'                         // NOT off-able when autoOnPromote != 'none'

  // ── Reproducibility ──
  seed: number                                         // REQUIRED. Default 42.
  reps?: number                                        // default 5 for CI bands
  resumable?: boolean                                  // default true; cell-level cache
  manifestHash?: string                                // auto-computed if absent

  // ── Knobs ──
  costCeiling?: number
  maxConcurrency?: number
  runDir: string
}): Promise<CampaignResult<TArtifact, TScenario>>
```

### Public presets (3 named, wrap `runCampaign`)

```ts
// agent-eval/src/campaign/presets.ts
runEval(opts: RunEvalOpts) → CampaignResult       // no optimizer, no gate, no autoOnPromote
runOptimization(opts: RunOptimizationOpts) → CampaignResult  // optimizer + judges, no gate
runProductionLoop(opts: RunProductionLoopOpts) → CampaignResult  // optimizer + DEFAULT composeGate + autoOnPromote: 'pr' | 'none'
```

Each preset is ~40 LOC. They're the documented public surface.

### `CampaignResult` schema (defined)

```ts
interface CampaignResult<TArtifact, TScenario> {
  // Reproducibility identity
  manifestHash: string                       // sha256 of (scenarios, judges, dispatch source, optimizer config, seed)
  seed: number
  startedAt: string                          // ISO timestamp
  endedAt: string

  // Per-cell results
  cells: Array<{
    cellId: string                           // `<scenarioId>:<rep>:<generation?>`
    scenarioId: string
    rep: number
    generation?: number                      // present in optimization runs
    artifact: TArtifact
    judgeScores: Record<string, JudgeScore>  // by judge.name
    costUsd: number
    durationMs: number
    seed: number                             // cell-level seed = parent seed + cell index
    cached: boolean                          // resumed from prior run?
    error?: string
  }>

  // Statistical aggregates
  aggregates: {
    byJudge: Record<string, {
      mean: number
      stdev: number
      ci95: [number, number]                // bootstrap
      n: number
    }>
    byScenario: Record<string, { meanComposite: number; ci95: [number, number] }>
    totalCostUsd: number
    cellsExecuted: number
    cellsSkipped: number                     // includes cached + cost-ceiling skips
  }

  // Optional improvement-loop output
  optimization?: {
    generations: Array<{
      generationIndex: number
      candidates: Array<{ surfaceHash: string; composite: number; ci95: [number, number] }>
      promoted: string[]                     // surfaceHashes promoted to next gen
    }>
    winnerSurfaceHash?: string
  }

  // Gate decision
  gate?: {
    decision: 'ship' | 'hold' | 'need_more_work' | 'model_ceiling' | 'arch_ceiling'
    reasons: string[]
    contributingGates: Array<{ name: string; passed: boolean; detail: unknown }>
  }

  // Auto-PR output (when autoOnPromote: 'pr')
  prUrl?: string

  // Pointers for downstream tools
  runDir: string
  artifactsByPath: Record<string, string>    // cellId → path to written artifact
}
```

### Default `composeGate` for `runProductionLoop` (wires existing modules)

```ts
// agent-eval/src/campaign/default-gates.ts
import { detectRewardHacking } from '../rl/reward-hacking'      // EXISTS
import { runRedTeamProbe } from '../red-team'                    // EXISTS
import { checkCanaries } from '../canary'                        // EXISTS
import { HoldoutAuditor } from '../holdout-auditor'              // EXISTS

export function defaultProductionGate(args: {
  holdoutScenarios: Scenario[]
  budgetUsd: number
  redTeamBattery?: Scenario[]
}): Gate {
  return composeGate(
    heldOutGate({ scenarios: args.holdoutScenarios, deltaThreshold: 0.5 }),
    costBudgetGate(args.budgetUsd),
    rewardHackingDetector({ minJudgesAgreement: 0.7 }),       // wraps existing rl/reward-hacking.ts
    redTeamProbe({ battery: args.redTeamBattery ?? DEFAULT_RED_TEAM_BATTERY }),  // wraps red-team.ts
    canaryCheck(),                                              // wraps canary.ts
    holdoutAuditCheck()                                         // wraps HoldoutAuditor
  )
}
```

All five referenced modules already exist. The wiring is a ~150-LOC composition file.

### `LabeledScenarioStore` discipline

```ts
interface LabeledScenarioWrite {
  scenario: Scenario
  artifact: unknown
  judgeScores: Record<string, JudgeScore>
  // Required provenance:
  source: 'production-trace' | 'eval-run' | 'manual' | 'red-team' | 'synthetic'
  sourceVersionHash: string                  // git sha or substrate version
  capturedAt: string                          // ISO
  redactionStatus: 'raw' | 'redacted-pii' | 'redacted-secrets' | 'fully-redacted'
  rateLimitBucket?: string                    // per-source rate limit key
}

interface LabeledScenarioStore {
  observe(write: LabeledScenarioWrite): Promise<void>
  // Capture is default ON, used during normal traces.

  sample(args: {
    count: number
    filter?: ScenarioFilter
    split: 'train' | 'test'                  // REQUIRED — no default
    capturedBefore: string                    // REQUIRED — temporal split discipline
  }): Promise<LabeledScenario[]>
  // Sampling REQUIRES split + temporal-cutoff. Default-off-for-training-source
  // means consumer must explicitly call .sample({ split: 'train' }) — store
  // does not auto-feed mutator unless asked.

  size(): Promise<{ train: number; test: number; bySource: Record<string, number> }>
}
```

### Tracing (default ON, force-on for safety-relevant configs)

`runCampaign` defaults to `FileSystemTraceStore` at `<runDir>/traces/`. OTEL exporter auto-attached when `OTEL_EXPORTER_OTLP_ENDPOINT` is set. `tracing: 'off'` is hard-refused when `autoOnPromote !== 'none'` — a self-mutating system without traces is unauditable.

---

## What's OUT of Pass A (deferred to Pass B)

| Capability | Why deferred | Estimate to land in Pass B |
|---|---|---|
| `autoOnPromote: 'config'` (live runtime self-mutation) | Needs full safety stack — shadow deploy, canary cohort, rollback API, behavioral-diff floor, ensemble judges, spec-gaming probe | 4-6 weeks |
| Multi-objective optimizer (Pareto fronts, fitness aggregation) | Current grid loop is sufficient for first 5 products | 2 weeks |
| Public benchmark adapter (SWE-bench, HELM) | Not a v1 blocker | 1-2 weeks |
| Judge-vs-human IRR calibration helper | Useful but not blocking 5 product migrations | 1 week |
| Online A/B canary infrastructure | Only needed when `autoOnPromote: 'config'` ships | Couples with Shape B work |
| YAML scenario loader | TypeScript-first; YAML is a nice-to-have | Days |

---

## Migration target

| Product | Before | After | Δ |
|---|---|---|---|
| gtm-agent | 1606 LOC wrappers | ~150 LOC | -1456 |
| legal-agent | 2464 | ~180 | -2284 |
| tax-agent | 3371 | ~200 | -3171 |
| creative-agent | 2015 | ~150 | -1865 |
| agent-builder | 1098 | ~150 | -948 |
| **Total** | **10,554** | **~830** | **-9,724** |

Substrate add: ~600 LOC across `run-campaign.ts` + 3 preset files + `CampaignResult` schema + `LabeledScenarioStore` (FS adapter) + `defaultProductionGate` composition.

---

## Ship plan (3-4 weeks honest)

### Week 1 — substrate primitives + schema
- Day 1-2: `runCampaign` core in agent-eval with seed / determinism / resumability
- Day 3: `CampaignResult` defined + bootstrap CIs / cell cache
- Day 4: `LabeledScenarioStore` with FS adapter + provenance + temporal split
- Day 5: `defaultProductionGate` composition wiring existing safety primitives

### Week 2 — presets + autonomous loops
- Day 1: `runEval` / `runOptimization` / `runProductionLoop` preset wrappers
- Day 2: `openAutoPr` helper
- Day 3: `runProductionLoop` scheduler in agent-runtime (Shape A only)
- Day 4: Tests for `runCampaign` + presets (target ~50 new tests)
- Day 5: Publish `agent-eval@0.40.0` + `agent-runtime@0.25.0`

### Week 3 — consumer migrations
- Day 1: DIFF the 4 product `run-prompt-evolution.ts` (1436 / 1882 / 1890 / 1921) — identify drift, fold unique fixes into substrate
- Day 2: gtm-agent migration + smoke
- Day 3: legal + tax migrations in parallel
- Day 4: creative + agent-builder migrations
- Day 5: Live smokes across 5; close PRs

### Week 4 — buffer + Pass A wrap
- Buffer for unknowns from day-1 diff
- Update `agent-stack-adoption` skill to reflect Pass A surface
- Update agent-eval-adoption skill
- Write 1-page "what's new in 0.40" announcement
- Tag releases

---

## Sign-off for Pass A start

- (a) Pass A scope acceptable — wrapper collapse + safety wire-up + schema + stats + 3 presets + Shape A only?
- (b) `autoOnPromote: 'config'` deferred to Pass B (4-6 weeks out) — accepted?
- (c) 3-4 week sizing realistic, or do we discover unknowns in the day-1 4-file diff?
- (d) Drew approves "Pass A 0.40 consolidation" naming — not "v1.0" — so the 1.0 stamp is reserved for after Pass B?

When you sign off, we open the implementation track. PR #91 either gets retitled to "Pass A" or closed and replaced with the implementation PRs.

## Pass B preview (out of scope here)

Pass B is the safety-stack initiative that makes `autoOnPromote: 'config'` shippable. Contains:

1. Shadow deploy infrastructure (new candidate runs in shadow alongside production, compared but not user-visible)
2. Canary cohort routing (small % of traffic to the new candidate, observed for drift / regression / safety signals)
3. Rollback API + diff history (every promotion is undoable, full chain of mutator → gate → ship is auditable)
4. Ensemble judges (multiple judges with disagreement detection)
5. Spec-gaming probe battery (injected negative-control candidates that should NOT promote)
6. Per-source rate limits on `LabeledScenarioStore` writes
7. Multi-objective optimizer (Pareto-front candidate selection)
8. Online A/B canary infrastructure
9. Behavioral-diff floor (refuse promotion if candidate's outputs diverge too far from baseline)

Estimated: 4-6 weeks after Pass A lands. Tracked separately, not in scope for this doc.
