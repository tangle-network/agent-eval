/**
 * Rollout-ledger file API — append-only JSONL of validated `tangle.rollout.v1`
 * lines. Writes validate BEFORE touching disk (a bad line never lands);
 * reads validate line-by-line and fail loud with the line number, because a
 * silently-skipped rollout is a corrupted dataset.
 *
 * "Validate" includes the anti-Goodhart invariant (a realness-gated line may
 * not carry a positive reward), so a poisoned line can neither enter a ledger
 * nor leave one.
 *
 * Two read modes, matching the two write-side row classes: `readRolloutLedger`
 * re-validates under the mint policy (training data), `readRolloutJournal`
 * under the write policy (supervision journals, whose unscreened positive
 * rewards are writable and must stay readable).
 */

import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { assertMinted, assertRolloutLine, type MintedRolloutLine, type RolloutLine } from './schema'

function serialize(lines: RolloutLine[]): string {
  for (const [i, line] of lines.entries()) assertRolloutLine(line, `rollout line [${i}]`)
  return lines.map((line) => JSON.stringify(line)).join('\n') + (lines.length > 0 ? '\n' : '')
}

/** Replace the ledger file with exactly `lines`. */
export async function writeRolloutLedger(path: string, lines: RolloutLine[]): Promise<void> {
  const payload = serialize(lines)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, payload)
}

/** Append `lines` to the ledger file (created if absent). */
export async function appendRolloutLines(path: string, lines: RolloutLine[]): Promise<void> {
  if (lines.length === 0) return
  const payload = serialize(lines)
  await mkdir(dirname(path), { recursive: true })
  await appendFile(path, payload)
}

/**
 * Read and validate every line. Throws on the first malformed/invalid line
 * (with its 1-based line number) — fail-closed, never a silent drop.
 *
 * Validation includes the anti-Goodhart invariant, which is why the result is
 * `MintedRolloutLine[]`: a ledger file is the main way a rollout reaches this
 * process from outside the type system (another run, another machine, a
 * hand-edited JSONL), so this read is the runtime boundary where a poisoned
 * line is refused rather than exported.
 */
export async function readRolloutLedger(path: string): Promise<MintedRolloutLine[]> {
  return readLines(path, (parsed, context) => assertMinted(parsed, context))
}

/**
 * Read a ledger under the WRITE-side policy (`validateRolloutLine`), which
 * omits the unscreened-reward check. `writeRolloutLedger` accepts a
 * supervision-journal row (`realness_screened: false` with a positive reward
 * — the documented `unscreenedRewardFields` shape), and `GATE_POLICIES` says
 * such rows "must stay writable, readable and reportable"; a read API that
 * only re-validated under `assertMinted` made every such file unreadable —
 * write-accepted but read-refused is a data-loss trap.
 *
 * The result is `RolloutLine[]`, NOT `MintedRolloutLine[]`: nothing read here
 * can reach a training exporter without passing `assertMinted`, so the
 * promotion gate (which DOES enforce unscreened-reward) is exactly as closed
 * as before. Use `readRolloutLedger` when the file is training data.
 */
export async function readRolloutJournal(path: string): Promise<RolloutLine[]> {
  return readLines(path, (parsed, context): RolloutLine => {
    assertRolloutLine(parsed, context)
    return parsed
  })
}

async function readLines<T>(
  path: string,
  admit: (parsed: unknown, context: string) => T,
): Promise<T[]> {
  const raw = await readFile(path, 'utf8')
  const lines: T[] = []
  const rawLines = raw.split('\n')
  for (let i = 0; i < rawLines.length; i++) {
    const text = rawLines[i]
    if (!text?.trim()) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch (error) {
      throw new Error(
        `${path}:${i + 1}: malformed JSON — ${error instanceof Error ? error.message : String(error)}`,
      )
    }
    lines.push(admit(parsed, `${path}:${i + 1}`))
  }
  return lines
}
