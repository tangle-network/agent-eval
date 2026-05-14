/**
 * Node-only file sink. Imports `node:fs` — DO NOT import this from a Worker
 * or edge runtime; use `./sink-fetch` instead.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import type { TelemetryEnvelope } from './schema'
import type { TelemetrySink } from './sink-fetch'

/** Append envelopes to a JSONL file, partitioned by repo + date. */
export class FileTelemetrySink implements TelemetrySink {
  private streams = new Map<string, fs.WriteStream>()

  constructor(private readonly baseDir: string) {
    fs.mkdirSync(baseDir, { recursive: true })
  }

  emit(envelope: TelemetryEnvelope): void {
    const date = envelope.timestamp.slice(0, 10) // YYYY-MM-DD
    const repo = envelope.source.repo || 'unknown'
    const key = `${repo}/${date}`
    let stream = this.streams.get(key)
    if (!stream) {
      const dir = path.join(this.baseDir, repo)
      fs.mkdirSync(dir, { recursive: true })
      stream = fs.createWriteStream(path.join(dir, `${date}.jsonl`), {
        flags: 'a',
        encoding: 'utf-8',
      })
      this.streams.set(key, stream)
    }
    stream.write(`${JSON.stringify(envelope)}\n`)
  }

  async close(): Promise<void> {
    const closes = Array.from(this.streams.values()).map(
      (s) => new Promise<void>((resolve) => s.end(() => resolve())),
    )
    this.streams.clear()
    await Promise.all(closes)
  }
}

/** Default location for local telemetry, mirroring bad CLI's convention. */
export function defaultTelemetryDir(homeDir: string, override?: string): string {
  return override || path.join(homeDir, '.agent-eval', 'telemetry')
}
