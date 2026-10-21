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







/** One agent-callable tool. `parameters` is a JSON Schema (draft-07+) object. */
export interface EvalToolDef {
  name: string
  description: string
  parameters: Record<string, unknown>
  handler: (args: unknown, ctx?: { signal?: AbortSignal }) => Promise<unknown>
}







// ── run_judges ───────────────────────────────────────────────────────────



// ── verify_completion ────────────────────────────────────────────────────



// ── analyze_runs ─────────────────────────────────────────────────────────






