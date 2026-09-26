/**
 * `agent-eval search <subcommand>`: work with a search ledger from a terminal.
 *
 *   agent-eval search ship <search-ledger.jsonl> --run-kind optimization|eval [--content full|digests]
 *   agent-eval search show <search-ledger.jsonl>
 *   agent-eval search show <search-ledger.jsonl> [<search-ledger.jsonl> ...] --meta
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
 *
 * `show --meta` prints the `metaSearch` lens over every ledger it is given:
 * each search as one node scored by its held-out lift per known dollar, the
 * configurations best first, and the searches arranged by derivation and
 * containment. It is the lens JSON the hosted page draws, as text.
 */

import { open, readFile } from 'node:fs/promises'
import { replaySearchLedgerText } from './campaign/search-ledger'
import { renderSearchSummary } from './campaign/search-summary'
import { hostedTenantFromEnv } from './hosted/client'
import { SEARCH_LEDGER_BATCH_MAX_BYTES, SearchRunKindSchema } from './hosted/search-ledger-wire'
import { SearchShipConflictError, shipSearchLedger } from './hosted/search-shipper'
import { metaSearch, renderMetaSearchText } from './search/lenses/meta-search'

const USAGE = `usage: agent-eval search <subcommand> ...

  ship <search-ledger.jsonl> --run-kind optimization|eval [--content full|digests]
        Ships the ledger's entries, and the blobs they name, to the hosted store in
        TANGLE_INGEST_URL (or TANGLE_ORCHESTRATOR_URL) as tenant TANGLE_TENANT_ID with
        TANGLE_INGEST_API_KEY (or TANGLE_API_KEY). It starts from the store's head, so
        running it again sends only what the store lacks. Prints the result as JSON.
        Exits 1 when the store holds a different chain for the search.

  show <search-ledger.jsonl>
        Verifies the ledger and prints its search summary: the leading nodes
        against the root, the most recently discarded nodes and why, and a log
        of recent proposals. The same text a proposer reads as context, on the
        search's own ranking split.

  show <search-ledger.jsonl> [<search-ledger.jsonl> ...] --meta [--objective <key>]
        Verifies every ledger and prints the meta-search lens over them: each
        search as one node, scored by its claim's held-out lift per known
        dollar (unscored searches say why), configurations best first with
        their interval, method and n, and the searches arranged by derivation
        and containment. --objective names the objective the best
        configuration is chosen within when the searches span several.`

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

async function runShowCommand(argv: string[]): Promise<number> {
  if (argv.includes('--meta')) return await runShowMetaCommand(argv)
  if (argv.length !== 1 || argv[0] === '--help' || argv[0] === '-h') {
    process.stdout.write(`${USAGE}\n`)
    return argv.length === 1 ? 0 : 1
  }
  const path = argv[0]!
  const searchId = await firstLineSearchId(path)
  const text = await readFile(path, 'utf8')
  const state = replaySearchLedgerText(text, searchId, path)
  const split =
    state.header && state.header.splits.selection.tasks.length > 0 ? 'selection' : 'train'
  process.stdout.write(`${renderSearchSummary(state, { split })}\n`)
  return 0
}

async function runShowMetaCommand(argv: string[]): Promise<number> {
  const paths: string[] = []
  let objective: string | undefined
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index]!
    if (token === '--meta') continue
    if (token === '--help' || token === '-h') {
      process.stdout.write(`${USAGE}\n`)
      return 0
    }
    if (token === '--objective') {
      objective = argv[++index]
      if (objective === undefined) throw new Error(`--objective needs a value\n${USAGE}`)
      continue
    }
    if (token.startsWith('--')) throw new Error(`unknown flag ${token}\n${USAGE}`)
    paths.push(token)
  }
  if (paths.length === 0) throw new Error(`show --meta needs at least one ledger\n${USAGE}`)
  const states = []
  for (const path of paths) {
    const searchId = await firstLineSearchId(path)
    states.push(replaySearchLedgerText(await readFile(path, 'utf8'), searchId, path))
  }
  const lens = metaSearch(states, objective === undefined ? {} : { objective })
  process.stdout.write(`${renderMetaSearchText(lens)}\n`)
  return 0
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
