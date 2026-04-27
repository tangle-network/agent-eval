/**
 * JsonlTrialCache — `TrialCache` backed by a JSONL append-only file so a
 * crashed `runPromptEvolution` can resume without re-running expensive
 * trials. Last write wins on key collision; the file is forward-swept at
 * construction.
 *
 * Tail corruption (partial line at the bottom from a hard kill) is
 * tolerated — we skip unparseable lines and continue. Writers are
 * append-only for crash safety; concurrent in-process writers should wrap
 * this in a `Mutex.runExclusive` (or use `LockedJsonlTrialCache` if/when
 * that's needed).
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { TrialCache, TrialResult } from './prompt-evolution'

interface CacheLine {
  key: string
  result: TrialResult
  writtenAt: number
}

/**
 * `appendFileSync` blocks the Node event loop, so two in-process callers
 * can never interleave their writes — atomicity holds at the JS-runtime
 * level even when the line exceeds POSIX `PIPE_BUF`. The cross-process
 * race is genuinely cross-process and would need fcntl/flock, which
 * `runPromptEvolution` deliberately doesn't take on (single-process loop).
 */

export class JsonlTrialCache implements TrialCache {
  private readonly map = new Map<string, TrialResult>()
  private readonly path: string

  constructor(path: string) {
    this.path = path
    if (existsSync(path)) {
      for (const line of readFileSync(path, 'utf-8').split('\n')) {
        if (!line.trim()) continue
        try {
          const entry = JSON.parse(line) as CacheLine
          this.map.set(entry.key, entry.result)
        } catch {
          // Tolerate trailing partial lines from a hard kill.
        }
      }
    } else {
      mkdirSync(dirname(path), { recursive: true })
    }
  }

  get(key: string): TrialResult | undefined {
    return this.map.get(key)
  }

  set(key: string, value: TrialResult): void {
    this.map.set(key, value)
    const line: CacheLine = { key, result: value, writtenAt: Date.now() }
    appendFileSync(this.path, `${JSON.stringify(line)}\n`)
  }

  size(): number {
    return this.map.size
  }
}
