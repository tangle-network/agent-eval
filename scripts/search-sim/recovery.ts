import { spawn } from 'node:child_process'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { type SimOptions } from './types'
import { unit } from './objective'

// ── kill-resume ──────────────────────────────────────────────────────

/** Facts two runs of one search must share, apart from attempt and operation numbering. */
function finalFacts(dir: string): Record<string, unknown> {
  const rows = readFileSync(join(dir, 'ledger.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as { event: Record<string, unknown> & { kind: string } })
  const events = rows.map((row) => row.event)
  const of = (kind: string) => events.filter((event) => event.kind === kind)
  const allocated = of('cell-allocated').map((event) => event.cellId as string)
  const decided = new Map<string, string>()
  for (const event of of('node-decided')) {
    decided.set(event.nodeId as string, (event.decision as { status: string }).status)
  }
  const scores = new Map<string, number>()
  for (const event of of('cell-settled')) {
    const outcome = event.outcome as { status: string; score?: number }
    if (outcome.score !== undefined) scores.set(event.cellId as string, outcome.score)
  }
  return {
    nodes: of('node-registered')
      .map((event) => event.nodeId as string)
      .sort(),
    edges: of('edge-recorded')
      .map((event) =>
        JSON.stringify([event.childNodeId, event.parents, event.operator, event.attribution]),
      )
      .sort(),
    cells: [...new Set(allocated)].sort(),
    duplicateCellAllocations: allocated.length - new Set(allocated).size,
    scores: [...scores.entries()].sort(),
    decisions: [...decided.entries()].sort(),
    close: of('search-closed').map((event) => [event.reason, event.claim]),
  }
}

function lines(path: string): string[] {
  return existsSync(path) ? readFileSync(path, 'utf8').trim().split('\n').filter(Boolean) : []
}

function ledgerLength(dir: string): number {
  return lines(join(dir, 'ledger.jsonl')).length
}

async function runChild(
  dir: string,
  argv: string[],
  killAt: number | null,
): Promise<{ killed: boolean; atSequence: number; stdout: string }> {
  return new Promise((resolveChild, reject) => {
    const child = spawn(
      process.execPath,
      [
        '--import',
        'tsx',
        resolve(import.meta.dirname, '../search-sim.ts'),
        'run',
        '--dir',
        dir,
        ...argv,
      ],
      { stdio: ['ignore', 'pipe', 'inherit'] },
    )
    let stdout = ''
    let killed = false
    let atSequence = -1
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
    })
    const poll =
      killAt === null
        ? null
        : setInterval(() => {
            const length = ledgerLength(dir)
            if (length >= killAt && !killed && child.pid !== undefined) {
              killed = true
              atSequence = length
              process.kill(child.pid, 'SIGKILL')
            }
          }, 2)
    child.on('error', reject)
    child.on('exit', () => {
      if (poll) clearInterval(poll)
      resolveChild({ killed, atSequence, stdout })
    })
  })
}

export async function killResume(dir: string, options: SimOptions, argv: string[], kills: number) {
  const reference = join(dir, 'reference')
  const killed = join(dir, 'killed')
  rmSync(dir, { recursive: true, force: true })
  const referenceRun = await runChild(reference, argv, null)
  const referenceSummary = JSON.parse(referenceRun.stdout) as Record<string, unknown>
  const total = ledgerLength(reference)
  const killPoints: number[] = []
  for (let index = 0; index < kills; index++) {
    const floor = killPoints.at(-1) ?? 1
    const at = floor + 1 + Math.floor(unit(options.seed, 'kill', index) * ((total - floor) / 2))
    if (at >= total - 1) break
    const outcome = await runChild(killed, argv, at)
    killPoints.push(outcome.killed ? outcome.atSequence : ledgerLength(killed))
    if (!outcome.killed) break
  }
  const finalRun = await runChild(killed, argv, null)
  const resumedSummary = JSON.parse(finalRun.stdout) as Record<string, unknown>
  const expected = finalFacts(reference)
  const actual = finalFacts(killed)
  const same = (key: string) => JSON.stringify(expected[key]) === JSON.stringify(actual[key])
  const started = lines(join(killed, 'executor', 'started.log'))
  const finished = lines(join(killed, 'executor', 'finished.log'))
  const adopted = lines(join(killed, 'executor', 'adopted.log'))
  const audit = resumedSummary.audit as {
    spend: { committedUsd: number; overspendUsd: number }
    operations: { started: number; recorded: number }
  }
  // A hill climb (incumbent, crowded-frontier) expands only once every
  // earlier child is screened, so under uniform its decisions do not depend
  // on the order cells finish in, and the resumed search must equal the
  // uninterrupted one. aide and beam expand while other screens run, and asha
  // ranks the nodes that finished a rung when a node finishes it, so a
  // restart that changes the finishing order may change a parent or a
  // promotion; there the resumed ledger must hold only decisions its own
  // evidence makes.
  const reproduces = {
    sameNodes: same('nodes'),
    sameEdges: same('edges'),
    sameCells: same('cells'),
    sameScores: same('scores'),
    sameDecisions: same('decisions'),
    sameClose: same('close'),
  }
  const invariants = {
    noDuplicateCellAllocations: actual.duplicateCellAllocations === 0,
    everyAttemptFinishedOnce: finished.length === new Set(finished).size,
    decisionsFromEvidence: (resumedSummary.ledgerChecks as { ok: boolean }).ok,
    spendWithinCap:
      options.maxUsd === null ||
      audit.spend.committedUsd <= options.maxUsd + audit.spend.overspendUsd + 1e-9,
  }
  const checks = { ...reproduces, ...invariants }
  const barrier = options.policy === undefined || options.policy === 'incumbent' || options.policy === 'crowded-frontier'
  const required = options.allocation === 'uniform' && barrier ? checks : invariants
  return {
    ok: Object.values(required).every(Boolean),
    checks,
    kills: killPoints,
    referenceEntries: total,
    resumedEntries: ledgerLength(killed),
    attempts: {
      started: started.length,
      startedTwice: started.length - new Set(started).size,
      finished: finished.length,
      adopted: adopted.length,
    },
    reference: referenceSummary,
    resumed: resumedSummary,
    counts: {
      nodes: (actual.nodes as unknown[]).length,
      cells: (actual.cells as unknown[]).length,
      decisions: actual.decisions,
    },
  }
}
