// The tools an agent reads and acts on the world with. A binding may rename
// them or wrap them in a product's own tools; whatever reaches the world goes
// through `callWorldTool`, so every call lands in one log.

import type {
  WorldAction,
  WorldDecisionEvidence,
  WorldScenario,
  WorldToolDefinition,
  WorldToolResult,
} from './types'
import type { World, WorldActionOutcome } from './world'

export interface WorldToolCall {
  result: WorldToolResult
  action?: WorldAction
  evidence?: WorldDecisionEvidence
}

/** Tool definitions for a scenario. Built from its public half only. */
export function worldTools(scenario: WorldScenario): WorldToolDefinition[] {
  const leverIds = scenario.levers.map((lever) => lever.id)
  const lever = { type: 'string', enum: leverIds, description: 'Lever id.' }
  return [
    {
      name: 'status',
      description:
        "Today's date, days left, budget left, every lever with its current daily rate, guideline and approval state, and every approval request.",
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    {
      name: 'results',
      description: `Spend and landed ${scenario.outcome.unit} for each finished period. Outcomes are counted in the period they landed in, which is later than the spend that caused them.`,
      inputSchema: {
        type: 'object',
        properties: {
          lever: { ...lever, description: 'Limit to one lever. Default: all.' },
          by: {
            type: 'string',
            enum: ['week', 'day'],
            description: 'Period length. Default: week.',
          },
        },
        additionalProperties: false,
      },
    },
    {
      name: 'set_rate',
      description: `Set a lever's standing daily spend in ${scenario.currency}, from today on. Zero stops it.`,
      inputSchema: {
        type: 'object',
        properties: { lever, dailyRate: { type: 'number', minimum: 0 } },
        required: ['lever', 'dailyRate'],
        additionalProperties: false,
      },
    },
    {
      name: 'spend_once',
      description: `Spend an extra amount in ${scenario.currency} on a lever today only, on top of its standing rate.`,
      inputSchema: {
        type: 'object',
        properties: { lever, amount: { type: 'number', exclusiveMinimum: 0 } },
        required: ['lever', 'amount'],
        additionalProperties: false,
      },
    },
    {
      name: 'request_approval',
      description: `Ask for approval to run a lever up to a daily rate. Levers marked requiresApproval refuse spend that no granted approval covers. A decision takes ${scenario.approvalDelayDays} day(s).`,
      inputSchema: {
        type: 'object',
        properties: {
          lever,
          maxDailyRate: { type: 'number', exclusiveMinimum: 0 },
          reason: { type: 'string' },
        },
        required: ['lever', 'maxDailyRate', 'reason'],
        additionalProperties: false,
      },
    },
    {
      name: 'save_note',
      description:
        'Save a note under a key. Notes are the only thing carried into later sessions; saving an empty text deletes the key.',
      inputSchema: {
        type: 'object',
        properties: { key: { type: 'string' }, text: { type: 'string' } },
        required: ['key', 'text'],
        additionalProperties: false,
      },
    },
  ]
}

function refusedInput(message: string): WorldToolCall {
  return { result: { ok: false, refused: 'invalid_input', message } }
}

function fromOutcome(outcome: WorldActionOutcome): WorldToolCall {
  if (!outcome.ok) {
    return { result: { ok: false, refused: outcome.refused, message: outcome.message } }
  }
  return {
    result: { ok: true, message: outcome.message },
    action: outcome.action,
    ...(outcome.evidence ? { evidence: outcome.evidence } : {}),
  }
}

/** Run one tool call against the world. Never throws on agent input. */
export function callWorldTool(world: World, name: string, input: unknown): WorldToolCall {
  const args = (input ?? {}) as Record<string, unknown>
  if (typeof args !== 'object' || Array.isArray(args)) {
    return refusedInput('Tool input must be an object.')
  }
  switch (name) {
    case 'status':
      return { result: { ok: true, message: 'Current state.', data: world.status() } }
    case 'results': {
      if (args.lever !== undefined && typeof args.lever !== 'string') {
        return refusedInput('lever must be a lever id.')
      }
      if (args.by !== undefined && args.by !== 'week' && args.by !== 'day') {
        return refusedInput("by must be 'week' or 'day'.")
      }
      const rows = world.results({ lever: args.lever, by: args.by })
      return { result: { ok: true, message: `${rows.length} period(s).`, data: rows } }
    }
    case 'set_rate':
      if (typeof args.lever !== 'string' || typeof args.dailyRate !== 'number') {
        return refusedInput('set_rate takes { lever, dailyRate }.')
      }
      return fromOutcome(world.setRate(args.lever, args.dailyRate))
    case 'spend_once':
      if (typeof args.lever !== 'string' || typeof args.amount !== 'number') {
        return refusedInput('spend_once takes { lever, amount }.')
      }
      return fromOutcome(world.spendOnce(args.lever, args.amount))
    case 'request_approval':
      if (typeof args.lever !== 'string' || typeof args.maxDailyRate !== 'number') {
        return refusedInput('request_approval takes { lever, maxDailyRate, reason }.')
      }
      return fromOutcome(
        world.requestApproval(
          args.lever,
          args.maxDailyRate,
          typeof args.reason === 'string' ? args.reason : '',
        ),
      )
    case 'save_note': {
      if (typeof args.key !== 'string' || typeof args.text !== 'string') {
        return refusedInput('save_note takes { key, text }.')
      }
      const saved = world.saveNote(args.key, args.text)
      return saved.ok
        ? { result: { ok: true, message: `Saved '${args.key}'.` } }
        : refusedInput(saved.message)
    }
    default:
      return { result: { ok: false, refused: 'unknown_tool', message: `No tool '${name}'.` } }
  }
}
