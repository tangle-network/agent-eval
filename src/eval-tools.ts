/**
 * Eval primitives as agent tools — `makeEvalTools` packages the substrate's
 * judge / completion / analysis entry points as JSON-Schema tool definitions
 * an LLM agent loop can call. The host closes over the live config (judge
 * panels, the correctness checker, analyst registry); the agent passes only
 * data over the wire.
 *
 * Three tools, each present only when its config section is supplied:
 *   - `run_judges`        — score an artifact with the configured `JudgeConfig`s
 *   - `verify_completion` — gold-spec requirement check → `CompletionVerdict`
 *   - `analyze_runs`      — `RunRecord[]` (inline or from a file) → `InsightReport`
 *
 * `toOpenAiTool` converts a definition to the OpenAI function-tool wire shape.
 */

import { readFile } from 'node:fs/promises'
import type { JudgeConfig, JudgeScore, Scenario } from './campaign/types'
import {
  type CompletionVerdict,
  type CorrectnessChecker,
  type ProducedState,
  type TaskGold,
  verifyCompletion,
} from './completion-verifier'
import { type AnalyzeRunsOptions, analyzeRuns } from './contract/analyze-runs'
import type { RunRecord } from './run-record'

/** One agent-callable tool. `parameters` is a JSON Schema (draft-07+) object. */
export interface EvalToolDef {
  name: string
  description: string
  parameters: Record<string, unknown>
  handler: (args: unknown, ctx?: { signal?: AbortSignal }) => Promise<unknown>
}

export interface MakeEvalToolsConfig {
  /** Judges available to `run_judges`. Omit to exclude the tool. */
  judges?: Array<JudgeConfig<unknown>>
  /** Host-side correctness checker for `verify_completion` (the third
   *  `verifyCompletion` argument — a function, so it cannot cross the wire).
   *  Omit to exclude the tool. */
  completion?: { checkCorrectness: CorrectnessChecker }
  /** `analyzeRuns` options minus `runs` (runs arrive as tool args, inline or
   *  via `path`). Omit to exclude the tool. */
  analyze?: Omit<AnalyzeRunsOptions, 'runs'>
}

/** OpenAI function-tool wire shape for an `EvalToolDef`. */
export function toOpenAiTool(def: EvalToolDef): {
  type: 'function'
  function: { name: string; description: string; parameters: Record<string, unknown> }
} {
  return {
    type: 'function',
    function: { name: def.name, description: def.description, parameters: def.parameters },
  }
}

/**
 * Build the eval toolset for the supplied config. Only sections present in
 * `cfg` produce tools, so the agent's tool list mirrors what the host
 * actually wired. Handlers fail loud on malformed args — no silent defaults.
 */
export function makeEvalTools(cfg: MakeEvalToolsConfig): EvalToolDef[] {
  const tools: EvalToolDef[] = []
  if (cfg.judges) tools.push(runJudgesTool(cfg.judges))
  if (cfg.completion) tools.push(verifyCompletionTool(cfg.completion.checkCorrectness))
  if (cfg.analyze) tools.push(analyzeRunsTool(cfg.analyze))
  return tools
}

// ── run_judges ───────────────────────────────────────────────────────────

function runJudgesTool(judges: Array<JudgeConfig<unknown>>): EvalToolDef {
  if (judges.length === 0) {
    throw new Error('makeEvalTools: cfg.judges is empty — supply judges or omit the section')
  }
  const names = judges.map((j) => j.name)
  return {
    name: 'run_judges',
    description:
      `Score an artifact with the configured judges (${names.join(', ')}). ` +
      'Pass `judge` to run one judge by name; omit it to run all. ' +
      'Returns per-judge scores keyed by judge name.',
    parameters: {
      type: 'object',
      properties: {
        judge: {
          type: 'string',
          enum: names,
          description: 'Run only this judge. Omit to run every configured judge.',
        },
        artifact: {
          description: 'The artifact to score — any JSON value the judges understand.',
        },
        scenario: {
          description: 'Optional scenario context forwarded to the judges.',
        },
      },
      required: ['artifact'],
      additionalProperties: false,
    },
    handler: async (args, ctx) => {
      const a = requireObjectArgs('run_judges', args)
      if (!('artifact' in a)) {
        throw new Error('run_judges: args.artifact is required')
      }
      let selected = judges
      if (a.judge !== undefined) {
        if (typeof a.judge !== 'string') throw new Error('run_judges: args.judge must be a string')
        selected = judges.filter((j) => j.name === a.judge)
        if (selected.length === 0) {
          throw new Error(
            `run_judges: unknown judge '${a.judge}' — configured: ${names.join(', ')}`,
          )
        }
      }
      const signal = ctx?.signal ?? new AbortController().signal
      const scenario = a.scenario as Scenario
      const scores: Record<string, JudgeScore> = {}
      for (const judge of selected) {
        if (scenario !== undefined && judge.appliesTo && !judge.appliesTo(scenario)) continue
        scores[judge.name] = await judge.score({ artifact: a.artifact, scenario, signal })
      }
      return { scores }
    },
  }
}

// ── verify_completion ────────────────────────────────────────────────────

function verifyCompletionTool(checkCorrectness: CorrectnessChecker): EvalToolDef {
  return {
    name: 'verify_completion',
    description:
      'Verify produced state against a gold task spec: each gold requirement is ' +
      'matched to at most one produced artifact/proposal/tool-call, correctness-checked ' +
      'by the host, and reduced to a CompletionVerdict (completionRate, fullyComplete, ' +
      'per-requirement checks).',
    parameters: {
      type: 'object',
      properties: {
        gold: {
          type: 'object',
          description: 'TaskGold — taskId + requirements the produced state must satisfy.',
        },
        state: {
          type: 'object',
          description: 'ProducedState — artifacts, proposals, and tool calls the agent produced.',
        },
      },
      required: ['gold', 'state'],
      additionalProperties: false,
    },
    handler: async (args): Promise<CompletionVerdict> => {
      const a = requireObjectArgs('verify_completion', args)
      if (typeof a.gold !== 'object' || a.gold === null) {
        throw new Error('verify_completion: args.gold (TaskGold) is required')
      }
      if (typeof a.state !== 'object' || a.state === null) {
        throw new Error('verify_completion: args.state (ProducedState) is required')
      }
      return verifyCompletion(a.gold as TaskGold, a.state as ProducedState, checkCorrectness)
    },
  }
}

// ── analyze_runs ─────────────────────────────────────────────────────────

function analyzeRunsTool(analyzeOpts: Omit<AnalyzeRunsOptions, 'runs'>): EvalToolDef {
  return {
    name: 'analyze_runs',
    description:
      'Run analyzeRuns over a set of RunRecords and return the InsightReport ' +
      '(composite distribution, per-dimension stats, lift, failure clusters, ' +
      'recommendations). Pass the records inline via `runs`, or `path` to a ' +
      '.json (array) or .jsonl (one record per line) file on the host.',
    parameters: {
      type: 'object',
      properties: {
        runs: {
          type: 'array',
          items: { type: 'object' },
          description: 'RunRecord[] inline.',
        },
        path: {
          type: 'string',
          description: 'Host path to a JSON array or JSONL file of RunRecords.',
        },
      },
      additionalProperties: false,
    },
    handler: async (args) => {
      const a = requireObjectArgs('analyze_runs', args)
      const hasRuns = Array.isArray(a.runs)
      const hasPath = typeof a.path === 'string' && a.path.length > 0
      if (hasRuns === hasPath) {
        throw new Error('analyze_runs: pass exactly one of args.runs (array) or args.path (string)')
      }
      const runs = hasRuns ? (a.runs as RunRecord[]) : await loadRunRecords(a.path as string)
      if (runs.length === 0) {
        throw new Error('analyze_runs: no runs to analyze')
      }
      return analyzeRuns({ ...analyzeOpts, runs })
    },
  }
}

async function loadRunRecords(path: string): Promise<RunRecord[]> {
  const text = await readFile(path, 'utf8')
  const trimmed = text.trim()
  if (trimmed.length === 0) {
    throw new Error(`analyze_runs: file '${path}' is empty`)
  }
  if (trimmed.startsWith('[')) {
    const parsed = JSON.parse(trimmed) as unknown
    if (!Array.isArray(parsed)) {
      throw new Error(`analyze_runs: file '${path}' did not parse to an array`)
    }
    return parsed as RunRecord[]
  }
  // JSONL: one record per non-empty line. A malformed line throws with its
  // line number rather than being skipped.
  return trimmed.split('\n').flatMap((line, i) => {
    const l = line.trim()
    if (l.length === 0) return []
    try {
      return [JSON.parse(l) as RunRecord]
    } catch (err) {
      throw new Error(
        `analyze_runs: file '${path}' line ${i + 1} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  })
}

function requireObjectArgs(tool: string, args: unknown): Record<string, unknown> {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) {
    throw new Error(`${tool}: args must be an object`)
  }
  return args as Record<string, unknown>
}
