/**
 * Load generator for the hash-chained ledger journal.
 *
 * Appends entries to a real final-evidence ledger (`openFinalEvidenceLedger`,
 * pinned and `requireTrustedHead`, so every call reads the pin) and counts the
 * bytes each append reads from the journal, its pin, and its lock, by wrapping
 * the `node:fs` read calls. It reports those bytes per append across the run,
 * so a change to the journal can show what one append costs at a given length.
 *
 *   node --import tsx scripts/ledger-journal-load.ts --entries 20000 [--dir DIR]
 *   node --import tsx scripts/ledger-journal-load.ts --entries 4000 --writers 2
 *   node --import tsx scripts/ledger-journal-load.ts --entries 20 --dir DIR --append-only
 *
 * `--writers W` runs W processes that append to one ledger at once, retrying a
 * held cross-process lock. After they finish, each compares the projection its
 * long-lived journal instance reaches by reading only the rows it has not seen
 * with the projection a new instance builds from the whole file. `--tamper`
 * (one writer) then rewrites the head row and a middle row in place and reports
 * which instances refuse the file. `--append-only` appends to an existing
 * ledger in DIR, which measures an append at that ledger's length.
 *
 * Output is one JSON document on stdout. Exit 1 when a check fails.
 */

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline'

type Category = 'journal' | 'pin' | 'lock' | 'other'

const bytesRead: Record<Category, number> = { journal: 0, pin: 0, lock: 0, other: 0 }
const openPaths = new Map<number, string>()
let journalPath = ''

function category(path: string | undefined): Category {
  if (path === journalPath) return 'journal'
  if (path === `${journalPath}.head`) return 'pin'
  if (path?.startsWith(`${journalPath}.lock`)) return 'lock'
  return 'other'
}

// Wrap the synchronous fs calls the journal uses, then publish the wrappers to
// every ESM named import of node:fs.
const { openSync, closeSync, readSync, readFileSync } = fs
fs.openSync = ((path: fs.PathLike, ...rest: unknown[]) => {
  const fd = (openSync as (...args: unknown[]) => number)(path, ...rest)
  openPaths.set(fd, resolve(String(path)))
  return fd
}) as typeof fs.openSync
fs.closeSync = ((fd: number) => {
  openPaths.delete(fd)
  closeSync(fd)
}) as typeof fs.closeSync
fs.readSync = ((fd: number, ...rest: unknown[]) => {
  const read = (readSync as (...args: unknown[]) => number)(fd, ...rest)
  bytesRead[category(openPaths.get(fd))] += read
  return read
}) as typeof fs.readSync
fs.readFileSync = ((path: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
  const contents = (readFileSync as (...args: unknown[]) => string | Buffer)(path, ...rest)
  const key = typeof path === 'number' ? openPaths.get(path) : resolve(String(path))
  bytesRead[category(key)] +=
    typeof contents === 'string' ? Buffer.byteLength(contents) : contents.byteLength
  return contents
}) as typeof fs.readFileSync
syncBuiltinESMExports()

const { openFinalEvidenceLedger } = await import('../src/experiment/final-evidence')
const { canonicalString, hashCanonical } = await import('../src/ledger-core/canonical')

type Ledger = ReturnType<typeof openFinalEvidenceLedger>

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? undefined : process.argv[index + 1]
}

const entries = Number(argument('entries') ?? '20000')
const writers = Number(argument('writers') ?? '1')
const child = argument('child')
const directory = resolve(argument('dir') ?? fs.mkdtempSync(join(tmpdir(), 'ledger-load-')))
journalPath = join(directory, 'final-evidence.jsonl')
if (!Number.isSafeInteger(entries) || entries < 2 || entries % 2 !== 0) {
  throw new Error('--entries must be an even integer of at least 2')
}

function snapshot(): Record<Category, number> {
  return { ...bytesRead }
}

function delta(before: Record<Category, number>): Record<Category, number> {
  return {
    journal: bytesRead.journal - before.journal,
    pin: bytesRead.pin - before.pin,
    lock: bytesRead.lock - before.lock,
    other: bytesRead.other - before.other,
  }
}

function digestOf(text: string): string {
  return hashCanonical(text)
}

interface AppendSample {
  sequence: number
  journal: number
  pin: number
  lock: number
  ms: number
  cpuMs: number
  lockRetries: number
}

/** One reserve or expose, retried while another process holds the lock. */
async function appendOne(
  ledger: Ledger,
  index: number,
  prefix: string,
): Promise<Omit<AppendSample, 'sequence'>> {
  const requestId = `${prefix}-${Math.floor(index / 2)}`
  const before = snapshot()
  const started = performance.now()
  const cpu = process.cpuUsage()
  for (let retries = 0; ; retries += 1) {
    const result =
      index % 2 === 0
        ? await ledger.reserve({
            requestId,
            claimDigest: digestOf(`claim:${requestId}`),
            populationId: 'load',
            inputDigest: digestOf(`input:${requestId}`),
            unitIds: [`${requestId}-a`, `${requestId}-b`],
          })
        : await ledger.expose(requestId, {
            evaluatorDigest: digestOf('evaluator'),
            candidateDigests: [digestOf(`candidate:${requestId}`)],
          })
    if (result.succeeded) {
      const read = delta(before)
      const { user, system } = process.cpuUsage(cpu)
      return {
        ...read,
        ms: performance.now() - started,
        cpuMs: (user + system) / 1000,
        lockRetries: retries,
      }
    }
    if (!result.error.message.includes('lock is held') || retries > 10_000) {
      throw new Error(`append ${index} failed: ${result.error.message}`)
    }
    await new Promise((done) => setTimeout(done, Math.random() * 3))
  }
}

async function readAll(ledger: Ledger): Promise<{ digest: string; journalBytes: number }> {
  const before = snapshot()
  const result = await ledger.read()
  if (!result.succeeded) throw new Error(`read failed: ${result.error.message}`)
  return { digest: digestOf(canonicalString(result.value)), journalBytes: delta(before).journal }
}

function fileEntries(): number {
  if (!fs.existsSync(journalPath)) return 0
  return fs.readFileSync(journalPath, 'utf8').split('\n').length - 1
}

function quantile(values: number[], q: number): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0
}

function summarize(samples: AppendSample[]) {
  const fileBytes = fs.statSync(journalPath).size
  const rows = fileEntries()
  const windowSize = Math.max(1, Math.floor(samples.length / 5))
  const windows = []
  for (let start = 0; start < samples.length; start += windowSize) {
    const window = samples.slice(start, start + windowSize)
    const journal = window.map((sample) => sample.journal)
    windows.push({
      sequences: `${window[0]!.sequence}-${window.at(-1)!.sequence}`,
      journalBytesPerAppend: {
        mean: Math.round(journal.reduce((sum, value) => sum + value, 0) / window.length),
        p99: quantile(journal, 0.99),
        max: Math.max(...journal),
      },
      pinBytesPerAppend: Math.round(
        window.reduce((sum, sample) => sum + sample.pin, 0) / window.length,
      ),
      msPerAppend: {
        wallP50: +quantile(window.map((sample) => sample.ms), 0.5).toFixed(2),
        cpuP50: +quantile(window.map((sample) => sample.cpuMs), 0.5).toFixed(2),
      },
    })
  }
  return {
    appends: samples.length,
    ledgerEntries: rows,
    ledgerBytes: fileBytes,
    meanRowBytes: Math.round(fileBytes / rows),
    lastAppendJournalBytes: samples.at(-1)!.journal,
    windows,
  }
}

async function runSingle(): Promise<number> {
  const appendOnly = process.argv.includes('--append-only')
  const existing = appendOnly ? fileEntries() : 0
  if (!appendOnly && fs.existsSync(journalPath)) throw new Error(`${journalPath} already exists`)
  const ledger = openFinalEvidenceLedger({ path: journalPath })
  const samples: AppendSample[] = []
  const prefix = appendOnly ? `more-${Date.now()}` : 'load'
  const started = performance.now()
  for (let index = 0; index < entries; index += 1) {
    samples.push({ sequence: existing + index, ...(await appendOne(ledger, index, prefix)) })
  }
  const elapsedMs = performance.now() - started
  const incremental = await readAll(ledger)
  const full = await readAll(openFinalEvidenceLedger({ path: journalPath }))
  const report: Record<string, unknown> = {
    mode: appendOnly ? 'append-only' : 'single-writer',
    journalPath,
    elapsedMs: Math.round(elapsedMs),
    firstCallOfInstanceJournalBytes: samples[0]!.journal,
    ...summarize(samples),
    incrementalProjection: incremental,
    newInstanceProjection: full,
    projectionsEqual: incremental.digest === full.digest,
    newInstanceReadsWholeFile: full.journalBytes === fs.statSync(journalPath).size,
  }
  let failed = !report.projectionsEqual || !report.newInstanceReadsWholeFile
  if (process.argv.includes('--tamper')) {
    const tamper = await tamperChecks(ledger)
    report.tamper = tamper
    failed ||= !tamper.every((check) => check.asExpected)
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  return failed ? 1 : 0
}

/** Flip one hex digit of a row's entryHash in place, keeping its length. */
function rewriteRow(sequence: number): () => void {
  const text = fs.readFileSync(journalPath, 'utf8')
  const rows = text.split('\n')
  const original = rows[sequence]!
  const marker = original.lastIndexOf('"entryHash":"sha256:') + '"entryHash":"sha256:'.length
  const digit = original[marker] === '0' ? '1' : '0'
  rows[sequence] = `${original.slice(0, marker)}${digit}${original.slice(marker + 1)}`
  fs.writeFileSync(journalPath, rows.join('\n'))
  return () => {
    rows[sequence] = original
    fs.writeFileSync(journalPath, rows.join('\n'))
  }
}

async function tamperChecks(ledger: Ledger) {
  const checks: { case: string; instance: string; outcome: string; asExpected: boolean }[] = []
  const outcome = async (run: () => Promise<{ succeeded: boolean; error?: { message: string } }>) => {
    const result = await run()
    return result.succeeded ? 'accepted' : `refused: ${result.error!.message.slice(0, 160)}`
  }
  const count = fileEntries()

  const restoreHead = rewriteRow(count - 1)
  const headOutcome = await outcome(() => ledger.read())
  checks.push({
    case: 'head row rewritten in place, same length',
    instance: 'open instance',
    outcome: headOutcome,
    asExpected: headOutcome.startsWith('refused'),
  })
  restoreHead()
  const restoredOutcome = await outcome(() => ledger.read())
  checks.push({
    case: 'head row restored',
    instance: 'open instance',
    outcome: restoredOutcome,
    asExpected: restoredOutcome === 'accepted',
  })

  rewriteRow(Math.floor(count / 2))
  const openOutcome = await outcome(() => ledger.read())
  checks.push({
    case: 'middle row rewritten in place, same length',
    instance: 'open instance (documented limit: it reads only past its verified head)',
    outcome: openOutcome,
    asExpected: openOutcome === 'accepted',
  })
  const freshOutcome = await outcome(() => openFinalEvidenceLedger({ path: journalPath }).read())
  checks.push({
    case: 'middle row rewritten in place, same length',
    instance: 'new instance',
    outcome: freshOutcome,
    asExpected: freshOutcome.startsWith('refused'),
  })
  return checks
}

async function runChild(index: number): Promise<void> {
  const ledger = openFinalEvidenceLedger({ path: journalPath })
  const samples: AppendSample[] = []
  for (let offset = 0; offset < entries; offset += 1) {
    const sample = await appendOne(ledger, offset, `w${index}`)
    samples.push({ sequence: offset, ...sample })
  }
  const journal = samples.map((sample) => sample.journal)
  process.stdout.write(
    `${JSON.stringify({
      done: index,
      appends: samples.length,
      lockRetries: samples.reduce((sum, sample) => sum + sample.lockRetries, 0),
      journalBytesPerAppend: {
        mean: Math.round(journal.reduce((sum, value) => sum + value, 0) / journal.length),
        p50: quantile(journal, 0.5),
        p99: quantile(journal, 0.99),
        max: Math.max(...journal),
      },
    })}\n`,
  )
  // Wait until every writer is done, so the file no longer changes.
  for await (const line of createInterface({ input: process.stdin })) {
    if (line === 'verify') break
  }
  const incremental = await readAll(ledger)
  const full = await readAll(openFinalEvidenceLedger({ path: journalPath }))
  process.stdout.write(`${JSON.stringify({ verified: index, incremental, full })}\n`)
}

async function runWriters(): Promise<number> {
  const perWriter = entries / writers
  if (!Number.isSafeInteger(perWriter) || perWriter % 2 !== 0) {
    throw new Error('--entries / --writers must be an even integer')
  }
  const script = process.argv[1]!
  const children = Array.from({ length: writers }, (_, index) =>
    spawn(
      process.execPath,
      [
        ...process.execArgv,
        script,
        '--child',
        String(index),
        '--entries',
        String(perWriter),
        '--dir',
        directory,
      ],
      { stdio: ['pipe', 'pipe', 'inherit'] },
    ),
  )
  const messages: Record<string, unknown>[] = []
  const done = new Set<number>()
  const verified: Record<string, unknown>[] = []
  await Promise.all(
    children.map(
      (process_, index) =>
        new Promise<void>((finish, fail) => {
          createInterface({ input: process_.stdout! }).on('line', (line) => {
            const message = JSON.parse(line) as Record<string, unknown>
            messages.push(message)
            if ('done' in message) {
              done.add(index)
              if (done.size === writers) for (const each of children) each.stdin!.write('verify\n')
            }
            if ('verified' in message) verified.push(message)
          })
          process_.on('exit', (code) =>
            code === 0 ? finish() : fail(new Error(`writer ${index} exited ${code}`)),
          )
        }),
    ),
  )
  const digests = new Set(
    verified.flatMap((message) => [
      (message.incremental as { digest: string }).digest,
      (message.full as { digest: string }).digest,
    ]),
  )
  const report = {
    mode: 'concurrent-writers',
    journalPath,
    writers,
    ledgerEntries: fileEntries(),
    ledgerBytes: fs.statSync(journalPath).size,
    writerReports: messages.filter((message) => 'done' in message),
    verification: verified,
    everyProjectionEqual: digests.size === 1 && verified.length === writers,
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  return report.everyProjectionEqual && report.ledgerEntries === entries ? 0 : 1
}

if (child !== undefined) {
  await runChild(Number(child))
} else {
  process.exitCode = writers > 1 ? await runWriters() : await runSingle()
}
