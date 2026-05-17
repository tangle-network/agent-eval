/**
 * Flow layer — drive a previewed app through a scripted user walk.
 *
 * The MultiLayerVerifier already had a `flow` slot wired in
 * VerticalBench's verification-harness, but the layer module was
 * always-skipped ("flow layer module not yet wired"). This adds the
 * module: a Layer<Env> that takes a {@link FlowSpec} (URL + steps),
 * boots a preview server via the supplied {@link FlowRunner}, executes
 * each step, and returns a LayerResult whose `findings` enumerate
 * which step failed.
 *
 * The runner is injected so this module can swap between:
 *   - production: agent-browser CLI (a11y-tree based steps)
 *   - test: in-memory mock that returns canned step outcomes
 *   - future: Playwright, Puppeteer, custom scrapers
 *
 * Paired with {@link runIntentMatchJudge}: intent-match catches "wrong
 * app entirely"; flow-layer catches "right app but the buttons don't work."
 */

import type { Layer, LayerResult, Severity } from './multi-layer-verifier'

// ─── Types ──────────────────────────────────────────────────────────────

export type FlowAction =
  | 'navigate'
  | 'click'
  | 'fill'
  | 'expect-text'
  | 'expect-element'
  | 'expect-url'
  | 'wait'

export interface FlowStep {
  /** What this step does. */
  action: FlowAction
  /** Human-readable description for findings. */
  describe?: string
  /**
   * For navigate/expect-url: full URL. For click/fill/expect-element:
   * accessible-name selector or CSS selector.
   * For expect-text: substring expected on the page.
   * For wait: ignored (use `value` for ms).
   */
  target?: string
  /** For fill: text to enter. For wait: ms. */
  value?: string
  /** Severity of a failure. Default `major`. */
  severity?: Severity
}

export interface FlowSpec {
  /** Initial URL the runner should open. */
  url: string
  /** Ordered steps. Stops at the first failure unless `continueOnFail: true`. */
  steps: FlowStep[]
  /** When true, execute every step even after a failure (collect all findings). */
  continueOnFail?: boolean
  /** Per-step wall cap (ms). Default 15s. */
  stepTimeoutMs?: number
}

export interface FlowRunnerStepResult {
  ok: boolean
  /** Concrete observation: matched text snippet, captured URL, error message. */
  evidence?: string
  /** Wall-clock duration of the step. */
  durationMs?: number
}

export interface FlowRunner {
  /** Open the target URL. Returns when the page is interactable. */
  open(url: string): Promise<FlowRunnerStepResult>
  /** Execute one step. The runner owns interpretation of `target`. */
  step(step: FlowStep): Promise<FlowRunnerStepResult>
  /** Tear down browser, free resources. Always called once per layer.run. */
  close(): Promise<void>
}

export interface FlowLayerEnv {
  /** Optional override per-call. Defaults supplied by the layer factory. */
  flowSpec?: FlowSpec
}

export interface FlowLayerFactoryInput {
  /** Static spec (used when env doesn't supply one). */
  flowSpec?: FlowSpec
  /** Build the runner per call (lets the layer create + tear down per leaf). */
  runner: () => FlowRunner | Promise<FlowRunner>
  /** Layer name. Default `flow`. */
  name?: string
  /** Layer dependencies — default `['serve']` so a non-booting preview skips us. */
  dependsOn?: string[]
  /** Layer weight for blendedScore (0..1+). Default 1. */
  weight?: number
  /** Cap for the entire flow run (ms). Default 60s. */
  capMs?: number
}

// ─── Layer factory ──────────────────────────────────────────────────────

/**
 * Build a flow layer that scripts a user walk via the supplied runner.
 *
 * Score: 1.0 when every step passed; otherwise 1 - (failedSteps / totalSteps).
 * Status: `pass` iff every step passed; `fail` if any step failed; `error`
 * on runner setup error; `skipped` when no flowSpec is available.
 */
export function flowLayer<Env extends FlowLayerEnv = FlowLayerEnv>(
  input: FlowLayerFactoryInput,
): Layer<Env> {
  return {
    name: input.name ?? 'flow',
    dependsOn: input.dependsOn ?? ['serve'],
    weight: input.weight ?? 1,
    capMs: input.capMs ?? 60_000,
    run: async (ctx) => {
      const start = Date.now()
      const spec = ctx.env?.flowSpec ?? input.flowSpec
      if (!spec) {
        return {
          layer: input.name ?? 'flow',
          status: 'skipped',
          durationMs: 0,
          findings: [],
          reason: 'no flowSpec supplied',
        }
      }

      let runner: FlowRunner
      try {
        runner = await input.runner()
      } catch (err) {
        return {
          layer: input.name ?? 'flow',
          status: 'error',
          durationMs: Date.now() - start,
          findings: [
            {
              severity: 'major',
              message: `flow runner failed to start: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          reason: 'runner-init-failed',
        }
      }

      const findings: LayerResult['findings'] = []
      const stepResults: Array<{ step: FlowStep; result: FlowRunnerStepResult; index: number }> = []
      let openOk = false
      try {
        const opened = await runner.open(spec.url)
        openOk = opened.ok
        if (!opened.ok) {
          findings.push({
            severity: 'major',
            message: `flow.open(${spec.url}) failed${opened.evidence ? `: ${opened.evidence}` : ''}`,
          })
        }
        if (openOk || spec.continueOnFail) {
          for (let i = 0; i < spec.steps.length; i++) {
            const step = spec.steps[i]!
            if (ctx.signal.aborted) break
            const stepStart = Date.now()
            let result: FlowRunnerStepResult
            try {
              result = await runner.step(step)
            } catch (err) {
              result = {
                ok: false,
                evidence: err instanceof Error ? err.message : String(err),
                durationMs: Date.now() - stepStart,
              }
            }
            stepResults.push({ step, result, index: i })
            if (!result.ok) {
              findings.push({
                severity: step.severity ?? 'major',
                message: `step[${i}] ${step.action}${step.target ? `(${step.target})` : ''} failed${result.evidence ? `: ${result.evidence}` : ''}`,
              })
              if (!spec.continueOnFail) break
            }
          }
        }
      } finally {
        try {
          await runner.close()
        } catch {
          /* best effort */
        }
      }

      const totalSteps = spec.steps.length
      const ranSteps = stepResults.length
      const passedSteps = stepResults.filter((s) => s.result.ok).length
      const status: LayerResult['status'] = !openOk
        ? 'fail'
        : passedSteps === totalSteps
          ? 'pass'
          : 'fail'
      // Score: open + each passing step contribute equally. A flow with
      // 4 steps where 3 pass scores 4/5 = 0.8 (0.2 from the open + 3*0.2
      // from the steps when totalSteps=4). We weight open and steps
      // equally to avoid any single step dominating short specs.
      const denominator = 1 + totalSteps
      const numerator = (openOk ? 1 : 0) + passedSteps
      const score = denominator > 0 ? Number((numerator / denominator).toFixed(3)) : 0

      return {
        layer: input.name ?? 'flow',
        status,
        score,
        durationMs: Date.now() - start,
        findings,
        reason:
          status === 'pass'
            ? `${totalSteps}/${totalSteps} steps passed`
            : `${passedSteps}/${totalSteps} steps passed${ranSteps < totalSteps ? ` (stopped at step ${ranSteps})` : ''}`,
        diagnostics: {
          flowOpenOk: openOk ? 1 : 0,
          flowStepsTotal: totalSteps,
          flowStepsPassed: passedSteps,
          flowStepsRan: ranSteps,
        },
      }
    },
  }
}
