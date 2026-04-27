/**
 * LockedJsonlAppender — mutex-serialized JSONL append helper for arbitrary
 * payloads. The reference-replay store does the same thing for typed
 * `ReferenceReplayRun` rows; this is the generic version used by
 * `MutationTelemetry`, `TrialTelemetry`, and any other consumer that wants
 * append-only durable telemetry without rolling its own lock.
 *
 * Locks are per absolute file path (process-local). Cross-process
 * concurrency is NOT addressed — that's an fcntl/flock problem.
 */

import { appendFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { Mutex } from './concurrency'

const mutexes = new Map<string, Mutex>()

function getMutex(path: string): Mutex {
  let m = mutexes.get(path)
  if (!m) {
    m = new Mutex()
    mutexes.set(path, m)
  }
  return m
}

export class LockedJsonlAppender {
  private readonly mutex: Mutex
  constructor(public readonly path: string) {
    this.mutex = getMutex(path)
    if (!existsSync(dirname(path))) {
      mkdirSync(dirname(path), { recursive: true })
    }
  }

  async append(entry: unknown): Promise<void> {
    const line = `${JSON.stringify(entry)}\n`
    await this.mutex.runExclusive(() => {
      appendFileSync(this.path, line)
    })
  }
}

/** Reset all internal mutex state — tests only. */
export function resetLockedAppendersForTesting(): void {
  mutexes.clear()
}
