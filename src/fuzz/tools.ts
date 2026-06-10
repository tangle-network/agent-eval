/**
 * Agent-drivable surface over a live exploration session.
 *
 * Framework-neutral tool defs ({name, description, parameters: JSON Schema,
 * handler}) so the on-demand agent — not a batch script — drives the search:
 * step it, read coverage, inspect findings, render the capsule. Transport
 * encodings (OpenAI function shape, MCP) are one-line mappings the host owns.
 */

import { renderCapsuleHtml } from './capsule'
import type { BehaviorExplorer } from './explorer'

export interface ExploreToolDef {
  name: string
  description: string
  /** JSON Schema (draft-07+) for the arguments. */
  parameters: Record<string, unknown>
  handler: (args: unknown, ctx?: { signal?: AbortSignal }) => Promise<unknown>
}

const NO_ARGS = { type: 'object', properties: {}, additionalProperties: false }

export function makeExploreTools<S>(explorer: BehaviorExplorer<S>): ExploreToolDef[] {
  return [
    {
      name: 'explore_step',
      description:
        'Run one exploration round: allocate budget across cells, propose + evaluate scenarios, archive elites, admit gate-verified findings. Returns runs spent and new findings.',
      parameters: NO_ARGS,
      handler: async () => {
        const { runs, findings } = await explorer.step()
        return { runs, newFindings: findings.length, findings }
      },
    },
    {
      name: 'explore_coverage',
      description:
        'Read the live coverage map: per planned cell — runs, robustness (null = uncovered), finding rate, per-dimension means.',
      parameters: NO_ARGS,
      handler: async () => explorer.coverage(),
    },
    {
      name: 'explore_findings',
      description: 'List gate-verified findings so far, sorted by descending interest.',
      parameters: {
        type: 'object',
        properties: { limit: { type: 'number', description: 'max findings to return' } },
        additionalProperties: false,
      },
      handler: async (args) => {
        const limit = (args as { limit?: number } | undefined)?.limit
        const all = explorer.findings()
        return typeof limit === 'number' ? all.slice(0, limit) : all
      },
    },
    {
      name: 'explore_capsule',
      description:
        'Build the capsule artifact from the current session state. format "data" returns the structured CapsuleData; "html" returns the standalone page.',
      parameters: {
        type: 'object',
        properties: {
          format: { type: 'string', enum: ['data', 'html'] },
          generatedAt: { type: 'string', description: 'ISO timestamp to stamp into the page' },
        },
        additionalProperties: false,
      },
      handler: async (args) => {
        const a = (args ?? {}) as { format?: string; generatedAt?: string }
        const capsule = explorer.capsule()
        if (a.format === 'html') return renderCapsuleHtml(capsule, { generatedAt: a.generatedAt })
        return capsule
      },
    },
  ]
}
