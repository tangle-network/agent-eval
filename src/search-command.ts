/**
 * `agent-eval search <subcommand>`: work with a search ledger from a terminal.
 *
 *   agent-eval search ship <search-ledger.jsonl> --run-kind optimization|eval [--content full|digests]
 *   agent-eval search show <search-ledger.jsonl>
 *
 * `ship` sends the ledger to the hosted store named by `TANGLE_INGEST_URL`,
 * `TANGLE_INGEST_API_KEY` and `TANGLE_TENANT_ID`, starting from the store's
 * head, so it finishes or resumes a ship that a loop could not complete.
 *
 * `show` verifies the ledger and prints `renderSearchSummary`: the same
 * compact text a proposer reads, on the search's own ranking split (the
 * selection split when the search declares one, else train). There is no
 * local HTML renderer; the hosted store's page is the visual view (§5 of the
 * search-tree design).
 */

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { open, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { replaySearchLedgerText } from './campaign/search-ledger'
import type { SearchCandidateSurface } from './campaign/search-ledger-types'
import { renderSearchSummary } from './campaign/search-summary'
import { hostedTenantFromEnv } from './hosted/client'
import { SEARCH_LEDGER_BATCH_MAX_BYTES, SearchRunKindSchema } from './hosted/search-ledger-wire'
import { SearchShipConflictError, shipSearchLedger } from './hosted/search-shipper'
import { formatLandscape, landscape, surfaceTextEdits } from './search/lenses/landscape'
import { formatSkillManifold, skillManifold } from './search/lenses/skill-manifold'

const USAGE = `usage: agent-eval search <subcommand> ...

  ship <search-ledger.jsonl> --run-kind optimization|eval [--content full|digests]
        Ships the ledger's entries, and the blobs they name, to the hosted store in
        TANGLE_INGEST_URL (or TANGLE_ORCHESTRATOR_URL) as tenant TANGLE_TENANT_ID with
        TANGLE_INGEST_API_KEY (or TANGLE_API_KEY). It starts from the store's head, so
        running it again sends only what the store lacks. Prints the result as JSON.
        Exits 1 when the store holds a different chain for the search.

  show <search-ledger.jsonl> [--landscape] [--skill-manifold]
        Verifies the ledger and prints its search summary: the leading nodes
        against the root, the most recently discarded nodes and why, and a log
        of recent proposals. The same text a proposer reads as context, on the
        search's own ranking split. Each flag adds one lens's text form
        (search-tree design §12) below the summary: the numbers Intelligence
        draws, as text an agent reads.
        --landscape       nodes placed by line edits between their profile
                          surfaces (read from blobs/ beside the ledger), the
                          interpolated score, its basins and the plateau score
        --skill-manifold  the node x unit score matrix factored into skill
                          axes, its intrinsic dimension, and the unit that
                          best separates the leaders`

export async function runSearchCommand(argv: string[]): Promise<number> {
  const [subcommand, ...rest] = argv
  if (subcommand === undefined || subcommand === '--help' || subcommand === '-h') {
    process.stdout.write(`${USAGE}\n`)
    return 0
  }
  if (subcommand === 'show') return await runShowCommand(rest)
  if (subcommand !== 'ship') {
    process.stderr.write(`unknown search subcommand: ${subcommand}\n${USAGE}\n`)
    return 1
  }
  if (rest.some((arg) => arg === undefined || arg === '--help' || arg === '-h')) {
    process.stdout.write(`${USAGE}\n`)
    return 0
  }
  const { path, flags } = parseShipArgs(rest)
  const runKind = SearchRunKindSchema.safeParse(flags['run-kind'])
  if (!runKind.success) throw new Error(`--run-kind must be optimization or eval\n${USAGE}`)
  const content = flags.content ?? 'full'
  if (content !== 'full' && content !== 'digests') {
    throw new Error(`--content must be full or digests\n${USAGE}`)
  }
  const tenant = hostedTenantFromEnv()
  if (!tenant) {
    throw new Error(
      'set TANGLE_INGEST_URL, TANGLE_INGEST_API_KEY and TANGLE_TENANT_ID to name the store',
    )
  }
  const searchId = await firstLineSearchId(path)
  try {
    const shipped = await shipSearchLedger({
      tenant,
      ledger: { path, searchId },
      runKind: runKind.data,
      content,
    })
    process.stdout.write(`${JSON.stringify(shipped, null, 2)}\n`)
    return shipped.head.nextSequence === shipped.localLines ? 0 : 1
  } catch (error) {
    if (!(error instanceof SearchShipConflictError)) throw error
    process.stderr.write(`${error.message}\n`)
    return 1
  }
}

const SHOW_LENS_FLAGS = ['landscape', 'skill-manifold'] as const
type ShowLensFlag = (typeof SHOW_LENS_FLAGS)[number]

async function runShowCommand(argv: string[]): Promise<number> {
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
    process.stdout.write(`${USAGE}\n`)
    return argv.length === 0 ? 1 : 0
  }
  const [path, ...flagArgs] = argv as [string, ...string[]]
  const lenses = new Set<ShowLensFlag>()
  for (const arg of flagArgs) {
    const name = arg.startsWith('--') ? arg.slice(2) : null
    if (name === null || !(SHOW_LENS_FLAGS as readonly string[]).includes(name)) {
      throw new Error(`unknown show flag ${arg}\n${USAGE}`)
    }
    lenses.add(name as ShowLensFlag)
  }
  const searchId = await firstLineSearchId(path)
  const text = await readFile(path, 'utf8')
  const state = replaySearchLedgerText(text, searchId, path)
  const split =
    state.header && state.header.splits.selection.tasks.length > 0 ? 'selection' : 'train'
  const sections = [renderSearchSummary(state, { split })]
  if (lenses.has('landscape')) {
    sections.push(formatLandscape(landscape(state, surfaceTextEdits(blobReader(path)))))
  }
  if (lenses.has('skill-manifold')) sections.push(formatSkillManifold(skillManifold(state)))
  process.stdout.write(`${sections.join('\n\n')}\n`)
  return 0
}

/**
 * Reads a surface's content from `blobs/` beside the ledger, where
 * `SearchRecorder` writes it by default. Bytes that do not hash to the
 * surface's digest and length are not the surface, so they read as null and
 * the landscape leaves that node unplaced rather than measuring other text.
 */
function blobReader(ledgerPath: string): (surface: SearchCandidateSurface) => unknown {
  const directory = join(dirname(ledgerPath), 'blobs')
  return (surface) => {
    const hex = surface.artifact.sha256.slice('sha256:'.length)
    let bytes: Buffer
    try {
      bytes = readFileSync(join(directory, `${hex}.json`))
    } catch {
      return null
    }
    const digest = createHash('sha256').update(bytes).digest('hex')
    if (digest !== hex || bytes.byteLength !== surface.artifact.byteLength) return null
    return JSON.parse(bytes.toString('utf8')) as unknown
  }
}

function parseShipArgs(argv: string[]): { path: string; flags: Record<string, string> } {
  const flags: Record<string, string> = {}
  const positional: string[] = []
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index]!
    if (!token.startsWith('--')) {
      positional.push(token)
      continue
    }
    const [name, inline] = token.slice(2).split('=', 2) as [string, string | undefined]
    if (name !== 'run-kind' && name !== 'content') throw new Error(`unknown flag --${name}`)
    const value = inline ?? argv[++index]
    if (value === undefined) throw new Error(`--${name} needs a value`)
    flags[name] = value
  }
  if (positional.length !== 1) throw new Error(USAGE)
  return { path: positional[0]!, flags }
}

/** The ledger names its search on every line; read the first. */
async function firstLineSearchId(path: string): Promise<string> {
  const handle = await open(path, 'r')
  try {
    // A line longer than one request's limit cannot ship anyway.
    const bytes = Buffer.alloc(SEARCH_LEDGER_BATCH_MAX_BYTES + 1)
    const { bytesRead } = await handle.read(bytes, 0, bytes.byteLength, 0)
    const newline = bytes.subarray(0, bytesRead).indexOf(0x0a)
    if (newline < 0) throw new Error(`${path} holds no complete ledger line`)
    const first = JSON.parse(bytes.toString('utf8', 0, newline)) as { searchId?: unknown }
    if (typeof first.searchId !== 'string') throw new Error(`${path} line 1 names no searchId`)
    return first.searchId
  } finally {
    await handle.close()
  }
}
