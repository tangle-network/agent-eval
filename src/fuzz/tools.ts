/**
 * Agent-drivable surface over a live exploration session.
 *
 * Framework-neutral tool defs ({name, description, parameters: JSON Schema,
 * handler}) so the on-demand agent — not a batch script — drives the search:
 * step it, read coverage, inspect findings, render the capsule. Transport
 * encodings (OpenAI function shape, MCP) are one-line mappings the host owns.
 */




export interface ExploreToolDef {
  name: string
  description: string
  /** JSON Schema (draft-07+) for the arguments. */
  parameters: Record<string, unknown>
  handler: (args: unknown, ctx?: { signal?: AbortSignal }) => Promise<unknown>
}




