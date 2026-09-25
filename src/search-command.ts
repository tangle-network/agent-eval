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

import { open, readFile } from 'node:fs/promises'
import { replaySearchLedgerText } from './campaign/search-ledger'
import { renderSearchSummary } from './campaign/search-summary'
import { hostedTenantFromEnv } from './hosted/client'
import { SEARCH_LEDGER_BATCH_MAX_BYTES, SearchRunKindSchema } from './hosted/search-ledger-wire'
import { SearchShipConflictError, shipSearchLedger } from './hosted/search-shipper'
import { type FrontData, front } from './search/lenses/front'
import { type OperatorYieldData, operatorYield } from './search/lenses/operator-yield'
import { INSUFFICIENT_FROM } from './search/lenses/shared'
import { type TaskMatrixData, taskMatrix } from './search/lenses/task-matrix'
import { type TreeData, type TreeNode, tree } from './search/lenses/tree'

const USAGE = `usage: agent-eval search <subcommand> ...

  ship <search-ledger.jsonl> --run-kind optimization|eval [--content full|digests]
        Ships the ledger's entries, and the blobs they name, to the hosted store in
        TANGLE_INGEST_URL (or TANGLE_ORCHESTRATOR_URL) as tenant TANGLE_TENANT_ID with
        TANGLE_INGEST_API_KEY (or TANGLE_API_KEY). It starts from the store's head, so
        running it again sends only what the store lacks. Prints the result as JSON.
        Exits 1 when the store holds a different chain for the search.

  show <search-ledger.jsonl> [--tree] [--operator-yield] [--front] [--task-matrix]
        Verifies the ledger and prints its search summary: the leading nodes
        against the root, the most recently discarded nodes and why, and a log
        of recent proposals. The same text a proposer reads as context, on the
        search's own ranking split. Each flag adds one lens's text form
        (search-tree-design §12) below the summary — the same JSON
        Intelligence, discovery lab, VerticalBench and agent-runtime read,
        rendered as text so an agent reads what a person sees.`

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

const SHOW_LENS_FLAGS = ['tree', 'operator-yield', 'front', 'task-matrix'] as const
type ShowLensFlag = (typeof SHOW_LENS_FLAGS)[number]

async function runShowCommand(argv: string[]): Promise<number> {
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
    process.stdout.write(`${USAGE}\n`)
    return argv.length === 0 ? 1 : 0
  }
  const [path, ...flagArgs] = argv
  const lenses = new Set<ShowLensFlag>()
  for (const arg of flagArgs) {
    const name = arg.startsWith('--') ? arg.slice(2) : null
    if (name === null || !(SHOW_LENS_FLAGS as readonly string[]).includes(name)) {
      throw new Error(`unknown show flag ${arg}\n${USAGE}`)
    }
    lenses.add(name as ShowLensFlag)
  }
  const searchId = await firstLineSearchId(path!)
  const text = await readFile(path!, 'utf8')
  const state = replaySearchLedgerText(text, searchId, path!)
  const split =
    state.header && state.header.splits.selection.tasks.length > 0 ? 'selection' : 'train'
  const sections = [renderSearchSummary(state, { split })]
  if (lenses.has('tree')) sections.push(renderTreeText(tree(state).data))
  if (lenses.has('operator-yield'))
    sections.push(renderOperatorYieldText(operatorYield(state).data))
  if (lenses.has('front')) sections.push(renderFrontText(front(state).data))
  if (lenses.has('task-matrix')) sections.push(renderTaskMatrixText(taskMatrix(state).data))
  process.stdout.write(`${sections.join('\n\n')}\n`)
  return 0
}

function renderTreeText(data: TreeData): string {
  const lines = [
    `tree: ${data.nodeCount} node${data.nodeCount === 1 ? '' : 's'}, ${data.edgeCount} edge${data.edgeCount === 1 ? '' : 's'}`,
  ]
  const walk = (node: TreeNode, prefix: string, isLast: boolean): void => {
    const branch = prefix === '' ? '' : isLast ? '└─ ' : '├─ '
    const op = node.operator ? `${node.operator} → ` : ''
    const rung = node.rung === null ? '' : ` rung ${node.rung}`
    const depth = node.depth === null ? ' depth unknown' : ''
    lines.push(
      `${prefix}${branch}${op}${node.nodeId} (${node.status ?? 'undecided'}${rung}${depth}) $${node.knownCostUsd.toFixed(2)}`,
    )
    const childPrefix = prefix + (prefix === '' ? '' : isLast ? '   ' : '│  ')
    node.children.forEach((child, index) => {
      walk(child, childPrefix, index === node.children.length - 1)
    })
  }
  data.roots.forEach((root, index) => {
    walk(root, '', index === data.roots.length - 1)
  })
  return lines.join('\n')
}

function renderOperatorYieldText(data: OperatorYieldData): string {
  const lines = [`operator yield (${data.split} split):`]
  if (data.rows.length === 0) lines.push('  no edges yet')
  for (const row of data.rows) {
    const y = row.yield
    const outcomes = Object.entries(row.outcomes)
      .filter(([, count]) => count > 0)
      .map(([status, count]) => `${status}=${count}`)
      .join(' ')
    const yieldText =
      y.method === 'none'
        ? 'yield: no measured children'
        : y.method === 'insufficient'
          ? `yield≈${y.mean!.toFixed(4)}/$ (${y.n} of ${INSUFFICIENT_FROM}, insufficient)`
          : `yield≈${y.mean!.toFixed(4)}/$ [${y.interval![0].toFixed(4)}, ${y.interval![1].toFixed(4)}] (${y.method}, n=${y.n})`
    lines.push(
      `  ${row.operator}: ${row.proposals} proposals (${outcomes || 'no decisions yet'}); ${yieldText}; ${row.excluded} excluded`,
    )
  }
  return lines.join('\n')
}

function renderFrontText(data: FrontData): string {
  const onFront = data.rows.filter((row) => row.onFront)
  const lines = [
    `front (${data.split} split, axes: ${data.axes.join(', ')}): ${data.frontierSize} of ${data.rows.length} node(s) on the frontier, ${data.excludedCount} excluded`,
  ]
  for (const row of onFront) {
    lines.push(
      `  ${row.nodeId}: score=${row.score!.toFixed(4)} knownCost=$${row.knownCostUsd.toFixed(2)}`,
    )
  }
  return lines.join('\n')
}

function renderTaskMatrixText(data: TaskMatrixData): string {
  const lines = [
    `task matrix (${data.split} split): ${data.nodeIds.length} node(s) × ${data.unitIds.length} unit(s), ${data.nodeClusters.length} node cluster(s), ${data.unitClusters.length} unit cluster(s)`,
  ]
  for (const row of data.specialistGain) {
    const gain =
      row.gain === null
        ? `insufficient (${row.nodesContributing} node${row.nodesContributing === 1 ? '' : 's'})`
        : `${row.gain.toFixed(4)} (n=${row.nodesContributing})`
    lines.push(`  cluster ${row.clusterId} [${row.unitIds.join(', ')}]: specialist gain ${gain}`)
  }
  return lines.join('\n')
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
