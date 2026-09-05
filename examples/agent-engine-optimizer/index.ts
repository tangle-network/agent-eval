/**
 * Let a coding agent — not a reflection LM — drive the optimization.
 *
 * GEPA's `autoresearch` engine runs a real `claude` CLI subprocess. With
 * `optimizer.anthropicEndpoint: true`, Agent Eval's loopback proxy also
 * serves the Anthropic Messages API, so every CLI call is admitted, metered,
 * and receipted like any other optimizer-model call. The CLI receives an
 * ephemeral loopback token; the provider key never reaches the child.
 *
 * The evaluator is deterministic: the score is computed from the produced
 * candidate text, with no LLM judge. The only paid traffic in the run is
 * the proxy-metered CLI session.
 *
 * Required:
 *   LLM_BASE_URL=...                # OpenAI-compatible endpoint
 *   LLM_API_KEY=...
 *   LLM_MODEL=deepseek-v4-flash     # the model the endpoint serves
 *   GEPA_PRICE_IN_PER_M=0.168 GEPA_PRICE_OUT_PER_M=0.336  # exact rates
 *
 * Run: pnpm tsx examples/agent-engine-optimizer/index.ts
 */

// IN-REPO: relative imports so the example typechecks against the workspace.
// COPY-PASTE INTO YOUR OWN PROJECT: change these to
//   import { gepaOptimizationMethod } from '@tangle-network/agent-eval/campaign'
//   import { selfImprove } from '@tangle-network/agent-eval/contract'
// The public subpaths expose these names with the same shapes.
import { gepaOptimizationMethod, type JudgeConfig, type Scenario } from '../../src/campaign'
import { selfImprove } from '../../src/contract'
import { positiveIntegerEnv, positiveNumberEnv } from '../_shared/env'
import { loadOptimizerExecutionOwner } from '../_shared/optimizer-execution-owner'
import { optimizerModelBudgetFromEnv } from '../_shared/optimizer-model-budget'

// ── Environment, validated before any paid call ─────────────────────────
// Agent engines pass `--model` to the CLI, and gepaOptimizationMethod
// requires engineConfig.model === optimizer.model, so the id must be the
// exact model the endpoint serves.
const MODEL = requiredModelEnv()
const OPTIMIZER_PYTHON = process.env.OPTIMIZER_PYTHON?.trim() || 'python'
const MAX_PROPOSER_COST_USD = positiveNumberEnv('GEPA_MAX_PROPOSER_COST_USD', 1)
const MAX_TOTAL_COST_USD = positiveNumberEnv('MAX_TOTAL_COST_USD', 2)

// Throws unless GEPA_PRICE_IN_PER_M and GEPA_PRICE_OUT_PER_M carry the exact
// endpoint rates, so CLI spend is never a guessed zero. The default
// maxOutputTokensPerRequest (32,768) is deliberate headroom: a reasoning
// model bills hidden reasoning tokens against max_tokens, and a low cap
// such as 4,096 starves it mid-thought on every call.
const optimizerBudget = optimizerModelBudgetFromEnv('GEPA', MAX_PROPOSER_COST_USD)

// ── Task: a fixed-length slogan, scored from produced state ─────────────
interface SloganScenario extends Scenario {
  targetLength: number
}

interface SloganArtifact {
  text: string
}

const TARGET_LENGTH = 42

const scenarios: SloganScenario[] = Array.from({ length: 10 }, (_, index) => ({
  id: `slogan-${index}`,
  kind: 'slogan',
  targetLength: TARGET_LENGTH,
}))

// Deterministic judge: the score is a pure function of the artifact text.
// No LLM judges anything, so a score change traces to the candidate alone.
const judge: JudgeConfig<SloganArtifact, SloganScenario> = {
  name: 'length-closeness',
  judgeVersion: 'length-closeness-v1',
  dimensions: [{ key: 'length', description: 'closeness of slogan length to the target' }],
  score: ({ artifact, scenario }) => {
    const length = artifact.text.trim().length
    const distance = Math.abs(length - scenario.targetLength)
    const score = Math.max(0, 1 - distance / scenario.targetLength)
    return {
      dimensions: { length: score },
      composite: score,
      notes: `length=${length} target=${scenario.targetLength} distance=${distance}`,
    }
  },
}

// With holdoutFraction 0.4 over 10 scenarios, the method receives a
// 6-case training pool. One registering aggregate eval scores the FULL
// pool, so it consumes 6 evaluations at once. A maxEvaluations below the
// train-set size lets zero evaluations register and GEPA scores every
// candidate -inf. 14 holds two full passes plus slack.
const TRAIN_SET_SIZE = 6
const MAX_EVALUATIONS = positiveIntegerEnv('GEPA_MAX_EVALUATIONS', 14)
if (MAX_EVALUATIONS < TRAIN_SET_SIZE) {
  throw new Error(
    `GEPA_MAX_EVALUATIONS must be at least the train-set size (${TRAIN_SET_SIZE}); ` +
      'one aggregate eval costs the whole training pool',
  )
}

async function main() {
  // The default owner wraps LLM_BASE_URL + LLM_API_KEY as the metered model
  // call. Every CLI request the engine makes becomes one call on this owner,
  // reserved and receipted by the loopback proxy before it executes.
  const owner = await loadOptimizerExecutionOwner(MODEL)

  const gepa = gepaOptimizationMethod<SloganScenario, SloganArtifact>({
    name: 'gepa-autoresearch',
    objective:
      'The candidate in candidate.txt is a one-line marketing slogan. ' +
      `Rewrite it so its trimmed character length is exactly ${TARGET_LENGTH} ` +
      'while it stays one line of plain text. ' +
      'Evaluate ONLY by running ./eval.sh <candidate_file> with no extra flags (full training set); ' +
      'never call the eval server directly and never use --ids.',
    evaluationId: 'agent-engine-slogan-length',
    recipe: {
      kind: 'engine',
      run: {
        engine: 'autoresearch',
        maxEvaluations: MAX_EVALUATIONS,
        maxProposerCostUsd: MAX_PROPOSER_COST_USD,
        // Isolate the CLI session in the engine's sandbox working directory.
        sandbox: true,
        engineConfig: {
          // Must equal optimizer.model: the engine passes `--model` and the
          // flag beats the injected ANTHROPIC_MODEL environment.
          model: MODEL,
          // One CLI session; the restart-loop mode multiplies CLI calls
          // without adding evaluations on a task this small.
          ralph: false,
          // Kill a session that stops calling ./eval.sh for 5 minutes.
          max_no_eval_seconds: 300,
        },
      },
    },
    optimizer: {
      model: MODEL,
      call: owner.call,
      callRef: owner.callRef,
      // Serve the Anthropic Messages API on the loopback proxy so the
      // `claude` CLI subprocess is admitted and metered. Without this flag,
      // agent engines stay rejected in proxied mode.
      anthropicEndpoint: true,
      budget: optimizerBudget,
    },
    describeScenario: (scenario) => ({ targetLength: scenario.targetLength }),
    describeArtifact: (artifact) => ({
      output: artifact.text,
      length: artifact.text.trim().length,
    }),
    runner: { command: OPTIMIZER_PYTHON },
    // Bound the whole bridge process tree well below the 30-minute default;
    // a wedged CLI session dies here instead of running out the clock.
    timeoutMs: 12 * 60 * 1000,
  })

  const result = await selfImprove<SloganScenario, SloganArtifact>({
    // The artifact IS the surface: scoring a candidate costs nothing and is
    // exactly reproducible. All improvement must come from the agent engine.
    agent: async (surface) => ({ text: String(surface) }),
    // A deterministic agent reports no paid-call receipt, so the run needs an
    // explicit model identity for provenance.
    model: 'deterministic:identity-agent@v1',
    scenarios,
    judge,
    baselineSurface: 'Ship it now.',
    method: gepa,
    budget: { dollars: MAX_TOTAL_COST_USD, maxConcurrency: 2, holdoutFraction: 0.4 },
    dispatchTimeoutMs: 30_000,
    // selfImprove defaults expectUsage to 'assert', which fails any cell with
    // zero tokens and zero cost. This evaluator makes no LLM calls by design,
    // so zero usage is correct — the only paid path is the metered CLI.
    expectUsage: 'off',
  })

  console.log(`Gate decision: ${result.gateDecision}`)
  if (result.baseline === null || result.winner.compositeMean === null) {
    throw new Error('This example requires a measured final comparison')
  }
  console.log(`Baseline:      ${result.baseline.compositeMean.toFixed(3)} (held-out composite)`)
  console.log(`Winner:        ${result.winner.compositeMean.toFixed(3)} (held-out composite)`)
  console.log(`Lift:          ${result.lift === undefined ? 'not measured' : signed(result.lift)}`)
  console.log(`Total cost:    $${result.totalCostUsd.toFixed(4)}`)

  if (result.optimization) {
    const { cost, provenance } = result.optimization
    console.log()
    console.log('Receipts (every claim below is proxy-metered, not self-reported):')
    console.log(
      `  optimizer spend:  $${cost.totalCostUsd.toFixed(4)} ` +
        `(accounting complete: ${cost.accountingComplete})`,
    )
    if (provenance) {
      if (provenance.anthropicEndpoint) {
        console.log(
          `  CLI wire:         ${provenance.anthropicEndpoint.requestAttempts} calls admitted, ` +
            `${provenance.anthropicEndpoint.successfulCompletions} completed`,
        )
      }
      console.log(`  evaluations:      ${provenance.evaluationCount} (callback-metered)`)
      if (provenance.upstreamReportedEvaluations !== undefined) {
        console.log(
          `  upstream count:   ${provenance.upstreamReportedEvaluations} (engine-reported)`,
        )
      }
      console.log(`  seed applied:     ${provenance.seedApplied}`)
      console.log(`  execution owner:  ${provenance.optimizerCallRef}`)
    }
  }

  console.log()
  console.log('Baseline -> winner diff:')
  console.log(result.diff || '(the winner is the baseline)')
}

function requiredModelEnv(): string {
  const model = process.env.LLM_MODEL?.trim()
  if (!model) throw new Error('Set LLM_MODEL to the exact model id your endpoint serves.')
  return model
}

function signed(n: number): string {
  return `${n >= 0 ? '+' : ''}${n.toFixed(3)}`
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
