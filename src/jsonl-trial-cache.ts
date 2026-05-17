/**
 * JsonlTrialCache — `TrialCache` backed by a JSONL append-only file so a
 * crashed `runPromptEvolution` can resume without re-running expensive
 * trials. Last write wins on key collision; the file is forward-swept at
 * construction.
 *
 * Tail corruption (partial line at the bottom from a hard kill) is
 * tolerated — we skip unparseable lines and continue.
 *
 * The cache surface (`get` / `set`) is synchronous because `TrialCache`
 * is. Writes are mutex-serialised through a `LockedJsonlAppender`
 * (kicked off with `void`) so two in-process callers can't tear a long
 * line that exceeds POSIX `PIPE_BUF`. Cross-process safety still
 * requires fcntl/flock and is deliberately out of scope.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { LockedJsonlAppender } from './locked-jsonl-appender'
import type { TrialCache, TrialResult } from './prompt-evolution'

interface CacheLine {
  key: string
  result: TrialResult
  writtenAt: number
}

export class JsonlTrialCache implements TrialCache {
  private readonly map = new Map<string, TrialResult>()
  private readonly path: string
  private readonly appender: LockedJsonlAppender

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
    this.appender = new LockedJsonlAppender(path)
  }

  get(key: string): TrialResult | undefined {
    return this.map.get(key)
  }

  set(key: string, value: TrialResult): void {
    // Update the in-memory map synchronously so subsequent get() calls
    // see the value immediately. Persist asynchronously through the
    // shared appender — a hard kill in the gap between map.set and disk
    // write costs at most one redundant trial run on resume.
    this.map.set(key, value)
    const line: CacheLine = { key, result: value, writtenAt: Date.now() }
    void this.appender.append(line)
  }

  size(): number {
    return this.map.size
  }

  /**
   * Synchronous fallback path for tests / CLI tools that want to be sure
   * the line is on disk before returning. Bypasses the mutex (single-
   * threaded callers only).
   */
  setSync(key: string, value: TrialResult): void {
    this.map.set(key, value)
    const line: CacheLine = { key, result: value, writtenAt: Date.now() }
    appendFileSync(this.path, `${JSON.stringify(line)}\n`)
  }
}
