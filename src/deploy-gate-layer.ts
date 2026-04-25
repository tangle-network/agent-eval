/**
 * Deploy gate layer — would the agent's build actually publish?
 *
 * The product Blueprint Agent fronts promises "go from idea to live URL."
 * Pre-Gen-48 the eval stopped at install/typecheck/build/serve — every
 * one of which can pass while `vite build` (or `next build`, etc) fails
 * on a production-only constraint (env-var requirement, dynamic import
 * not statically resolvable, missing public asset).
 *
 * Deploy gate runs the production build via the supplied {@link DeployRunner}
 * and asserts:
 *   - command exited 0
 *   - artifact dir contains an entry point (index.html for static SPAs,
 *     equivalent per framework family)
 *
 * Shipped in 0.11 with the canonical `vite` runner. Future generations
 * add wrangler-deploy --dry-run, next-build, etc — each as another
 * runner factory.
 */

import type { Layer, LayerResult } from './multi-layer-verifier'

// ─── Types ──────────────────────────────────────────────────────────────

export type DeployFamily = 'frontend-static' | 'nextjs' | 'remix' | 'fullstack-ts'

export interface DeployRunResult {
  ok: boolean
  /** Stdout/stderr tail surfaced as evidence. Bounded in caller. */
  output?: string
  /** Wall-clock duration of the build command. */
  durationMs?: number
  /** Path to artifact directory the runner expects (dist/, .next/, build/, etc). */
  artifactDir?: string
  /** True iff artifactDir contains the family's expected entry point. */
  artifactValid?: boolean
}

export interface DeployRunner {
  /** Run the production build. The runner owns command + cwd. */
  run(): Promise<DeployRunResult>
}

export interface DeployGateLayerInput {
  /** Build the runner per call. */
  runner: () => DeployRunner | Promise<DeployRunner>
  /** Family hint — for logging, surfaced in diagnostics. */
  family?: DeployFamily
  /** Layer name. Default `deploy`. */
  name?: string
  /** Layer dependencies — default `['build']`. */
  dependsOn?: string[]
  /** Weight in blendedScore. Default 1. */
  weight?: number
  /** Cap (ms). Default 120s — prod builds are slower than dev. */
  capMs?: number
  /** When true, treat artifactValid=false as a fail (default true). */
  requireArtifact?: boolean
}

// ─── Layer factory ──────────────────────────────────────────────────────

/**
 * Build a deploy gate layer that runs the production build and verifies
 * the artifact. Pass: ok && artifactValid. Score: 1.0 (pass) or 0 (fail).
 *
 * For families where artifact-validation isn't applicable (e.g. a
 * server-rendered build that prints a manifest), set `requireArtifact:
 * false` and rely on the runner's own ok signal.
 */
export function deployGateLayer<Env = unknown>(input: DeployGateLayerInput): Layer<Env> {
  const requireArtifact = input.requireArtifact ?? true
  return {
    name: input.name ?? 'deploy',
    dependsOn: input.dependsOn ?? ['build'],
    weight: input.weight ?? 1,
    capMs: input.capMs ?? 120_000,
    run: async (ctx) => {
      const start = Date.now()
      let runner: DeployRunner
      try {
        runner = await input.runner()
      } catch (err) {
        return {
          layer: input.name ?? 'deploy',
          status: 'error',
          durationMs: Date.now() - start,
          findings: [
            {
              severity: 'major',
              message: `deploy runner failed to start: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          reason: 'runner-init-failed',
        }
      }
      let result: DeployRunResult
      try {
        result = await runner.run()
      } catch (err) {
        return {
          layer: input.name ?? 'deploy',
          status: 'error',
          durationMs: Date.now() - start,
          findings: [
            {
              severity: 'major',
              message: `deploy command threw: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          reason: 'runner-throw',
        }
      }
      if (ctx.signal.aborted) {
        return {
          layer: input.name ?? 'deploy',
          status: 'timeout',
          durationMs: Date.now() - start,
          findings: [],
          reason: 'aborted by overall cap',
        }
      }

      const artifactOk = !requireArtifact || result.artifactValid === true
      const pass = result.ok && artifactOk
      const findings: LayerResult['findings'] = []
      if (!result.ok) {
        findings.push({
          severity: 'critical',
          message: 'deploy build exited non-zero',
          evidence: (result.output ?? '').slice(-1200),
        })
      }
      if (result.ok && requireArtifact && !result.artifactValid) {
        findings.push({
          severity: 'major',
          message: `deploy build succeeded but artifact ${result.artifactDir ?? '(unknown)'} is invalid or empty`,
        })
      }
      return {
        layer: input.name ?? 'deploy',
        status: pass ? 'pass' : 'fail',
        score: pass ? 1 : 0,
        durationMs: Date.now() - start,
        findings,
        reason: pass
          ? `deploy build OK${input.family ? ` (${input.family})` : ''}${result.artifactDir ? ` → ${result.artifactDir}` : ''}`
          : !result.ok
            ? 'build command failed'
            : 'artifact missing or invalid',
        diagnostics: {
          deployBuildOk: result.ok ? 1 : 0,
          deployArtifactOk: result.artifactValid === true ? 1 : 0,
          deployBuildMs: result.durationMs ?? null,
        },
      }
    },
  }
}

// ─── Canonical vite runner ──────────────────────────────────────────────

export interface ViteDeployRunnerInput {
  /** Workdir to build. The runner cd's here. */
  workdir: string
  /**
   * Function to run a shell command in `workdir`. Same shape as
   * agent-eval's CommandRunner.run for compositional reuse.
   */
  exec: (cmd: string, opts?: { cwd?: string; timeoutMs?: number }) => Promise<{ stdout: string; stderr: string; exitCode: number }>
  /**
   * Function to test whether a path exists in the workdir. Inject
   * `(p) => existsSync(join(workdir, p))` for host runs.
   */
  exists: (relativePath: string) => boolean | Promise<boolean>
  /** Build command. Default `npm run build`. */
  buildCommand?: string
  /** Artifact directory to validate. Default `dist`. */
  artifactDir?: string
  /** Entry-point file under artifactDir. Default `index.html`. */
  artifactEntry?: string
  /** Per-build cap (ms). Default 90s. */
  timeoutMs?: number
}

/**
 * Canonical runner for `frontend-static` family — runs the build script,
 * validates `<artifactDir>/<artifactEntry>` exists. Use as the `runner:`
 * factory for {@link deployGateLayer}.
 */
export function viteDeployRunner(input: ViteDeployRunnerInput): DeployRunner {
  return {
    run: async () => {
      const start = Date.now()
      const cmd = input.buildCommand ?? 'npm run build'
      const artifactDir = input.artifactDir ?? 'dist'
      const artifactEntry = input.artifactEntry ?? 'index.html'
      const timeoutMs = input.timeoutMs ?? 90_000
      const result = await input.exec(cmd, { cwd: input.workdir, timeoutMs })
      const ok = result.exitCode === 0
      let artifactValid = false
      try {
        const entryExists = await input.exists(`${artifactDir}/${artifactEntry}`)
        artifactValid = ok && Boolean(entryExists)
      } catch {
        artifactValid = false
      }
      const tail = ((result.stderr || result.stdout) ?? '').slice(-1500)
      return {
        ok,
        output: tail,
        durationMs: Date.now() - start,
        artifactDir,
        artifactValid,
      }
    },
  }
}
