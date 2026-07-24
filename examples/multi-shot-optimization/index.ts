import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  defaultProductionGate,
  type JudgeConfig,
  runImprovementLoop,
  type Scenario,
  type SurfaceProposer,
} from '../../src/contract'

type DemoArtifact = { text: string }

// Training scenarios the optimizer may select against.
const SCENARIOS: Scenario[] = [
  { id: 'brief', kind: 'chat' },
  { id: 'code-review', kind: 'chat' },
]
// Only the release rule scores this disjoint holdout. A candidate ships
// only if it beats baseline HERE, not just on the search set it was selected on.
const HOLDOUT: Scenario[] = [
  { id: 'holdout-brief', kind: 'chat' },
  { id: 'holdout-code-review', kind: 'chat' },
  { id: 'holdout-research', kind: 'chat' },
]

// The directive the optimizer is meant to introduce. The weak baseline lacks it
// (scores 0); any surface carrying it scores 1. A real judge would call a model
// or another semantic check. This deterministic string check keeps the example
// visible offline.
const COMPLETION_MARKER = 'VERIFY_EVERY_STEP'

const judge: JudgeConfig<DemoArtifact> = {
  name: 'completion',
  dimensions: [{ key: 'completion', description: 'surface enforces step verification' }],
  score: ({ artifact }) => {
    const ok = artifact.text.includes(COMPLETION_MARKER) ? 1 : 0
    return { dimensions: { completion: ok }, composite: ok, notes: '' }
  },
}

// A caller-owned candidate generator can be deterministic, model-backed, or
// delegated to agent-runtime. This one appends a known directive so it runs offline.
const proposer: SurfaceProposer = {
  kind: 'append-completion-directive',
  async propose({ currentSurface, populationSize }) {
    const base = String(currentSurface)
    const surface = base.includes(COMPLETION_MARKER) ? base : `${base} ${COMPLETION_MARKER}`
    return Array.from({ length: populationSize }, (_, index) => ({
      surface,
      label: `completion-directive-${index + 1}`,
      rationale: 'Require explicit step verification.',
    }))
  },
}

const runDir = mkdtempSync(join(tmpdir(), 'multi-shot-'))
try {
  const result = await runImprovementLoop<Scenario, DemoArtifact>({
    scenarios: SCENARIOS,
    holdoutScenarios: HOLDOUT,
    baselineSurface: 'Complete the user task.',
    // The worker echoes the surface it was given; the judge keys on the marker.
    dispatchWithSurface: async (surface) => ({ text: String(surface) }),
    judges: [judge],
    proposer,
    populationSize: 1,
    maxGenerations: 1,
    // Ship only when the held-out lift meets this release rule.
    gate: defaultProductionGate<DemoArtifact, Scenario>({
      holdoutScenarios: HOLDOUT,
      deltaThreshold: 0.5,
    }),
    autoOnPromote: 'none',
    runDir,
    seed: 7,
  })

  console.log({
    decision: result.gateResult.decision,
    delta: result.gateResult.delta, // ~1
    winnerShipped: String(result.winnerSurface).includes(COMPLETION_MARKER),
    promotedDiff: result.promotedDiff,
  })
} finally {
  rmSync(runDir, { recursive: true, force: true })
}
