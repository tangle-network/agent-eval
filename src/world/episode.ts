// The multi-session driver. It opens one session per `sessionEveryDays`, hands
// the agent the brief, the tools and the notes the agent saved earlier, then
// advances the clock. The driver carries nothing else between sessions: no
// transcript, no tool results, no summary. What an agent wants to remember, it
// saves.

import { ValidationError } from '../errors'
import { scoreWorldEpisode } from './score'
import { callWorldTool, type WorldToolCall, worldTools } from './tools'
import type {
  WorldAgent,
  WorldEpisode,
  WorldLogEntry,
  WorldScenario,
  WorldSession,
  WorldSessionRecord,
} from './types'
import { World } from './world'

export interface RunWorldEpisodeOptions {
  scenario: WorldScenario
  seed: number
  agent: WorldAgent
  /** Tool calls one session may make before the world refuses more. Default 64. */
  maxCallsPerSession?: number
  /** Called after each session, before the clock moves. */
  onSession?: (record: WorldSessionRecord, world: World) => Promise<void> | void
}

function loggable(input: unknown): unknown {
  try {
    return JSON.parse(JSON.stringify(input ?? {}))
  } catch {
    return '[unserializable input]'
  }
}

/** Run one agent through one episode of a scenario. */
export async function runWorldEpisode(opts: RunWorldEpisodeOptions): Promise<WorldEpisode> {
  const { scenario, seed } = opts
  const maxCalls = opts.maxCallsPerSession ?? 64
  if (!Number.isSafeInteger(maxCalls) || maxCalls < 1) {
    throw new ValidationError('runWorldEpisode: maxCallsPerSession must be a positive integer')
  }
  const world = new World(scenario, seed)
  const tools = worldTools(scenario)
  const log: WorldLogEntry[] = []
  const sessions: WorldSessionRecord[] = []

  for (let index = 0; !world.over; index++) {
    const record: WorldSessionRecord = { index, day: world.day, calls: 0 }
    let open = true
    const session: WorldSession = {
      index,
      day: world.day,
      date: world.date(),
      daysLeft: world.daysLeft,
      brief: scenario.brief,
      notes: world.notes,
      tools,
      call(name, input) {
        let call: WorldToolCall
        if (!open) {
          call = {
            result: { ok: false, refused: 'session_closed', message: 'This session has ended.' },
          }
        } else if (record.calls >= maxCalls) {
          call = {
            result: {
              ok: false,
              refused: 'call_limit',
              message: `A session allows ${maxCalls} tool calls.`,
            },
          }
        } else {
          call = callWorldTool(world, name, input)
        }
        // A call on a closed session belongs to no session's count, and is
        // stamped with the day it was made on.
        if (open) record.calls += 1
        log.push({
          seq: log.length,
          session: index,
          day: world.day,
          tool: name,
          input: loggable(input),
          result: call.result,
          ...(call.action ? { action: call.action } : {}),
          ...(call.evidence ? { evidence: call.evidence } : {}),
        })
        // The agent gets a copy: the log's record is not the agent's to edit.
        return structuredClone(call.result)
      },
    }
    try {
      await opts.agent(session)
    } catch (error) {
      // The agent's failure is recorded and the quarter goes on without it:
      // a missed session is a consequence, and the caller can see which
      // sessions failed.
      record.error = error instanceof Error ? error.message : String(error)
    }
    open = false
    sessions.push(record)
    await opts.onSession?.(record, world)
    world.advance(scenario.sessionEveryDays)
  }

  const end = world.end()
  return {
    scenarioId: scenario.id,
    scenarioDigest: world.scenarioDigest,
    seed,
    sessions,
    log,
    notes: { ...world.notes },
    end,
    score: scoreWorldEpisode(scenario, sessions, log, end),
  }
}
