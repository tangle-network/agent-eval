#!/usr/bin/env node
// Decompose analyst micro-F1 loss on a CodeTraceBench run, case by case.
//
// Every number is recomputed from the run's own observations plus the split's
// labels and OTLP traces — no model calls, no scorer changes. Micro recall =
// sum(matched)/sum(expected), micro precision = sum(supported)/sum(findings),
// micro F1 = harmonic mean, identical to result.summaries[].f1.
//
// Loss classes per gold step (the analyst's view of a gold step is the OTLP
// span it would have to cite):
//   input-blind   the gold span's visible content repeats another span in the
//                 same trace, or carries nothing beyond the harness submit
//                 boilerplate. No analyst can single it out from the trace.
//   hit           some finding cites the gold step exactly.
//   near          nearest citation is 1-2 steps away (block boundary error).
//   far           nearest citation is >2 steps away.
//   silent        the run produced no citation anywhere in the trace.
// Unsupported findings split into near (<=2 steps from a gold step) and pad
// (>2 steps), each also split by the trajectory's solved flag.
//
// Counterfactuals recompute micro F1 with one class neutralised at a time.
//
// Usage:
//   decompose-analyst-loss.mjs --labels LABELS.json --traces TRACE_DIR \
//     --run LABEL=PATH [--run LABEL2=PATH2 ...] [--runner ID] [--markdown] [--json]
//
// PATH is a run directory, a result.json, or an observations.jsonl.

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const SUBMIT_BOILERPLATE = 'COMPLETE_TASK_AND_SUBMIT_FINAL_OUTPUT'
const NEAR_STEPS = 2

function usageError(message) {
  process.stderr.write(`error: ${message}\n\nrun with --help for usage\n`)
  process.exit(2)
}

function printHelp() {
  const header = readFileSync(fileURLToPath(import.meta.url), 'utf8')
    .split('\n')
    .filter((line) => line.startsWith('//'))
    .map((line) => line.replace(/^\/\/ ?/, ''))
    .join('\n')
  process.stdout.write(`${header}\n`)
}

function parseArgs(argv) {
  const args = { labels: null, traces: null, runs: [], runner: 'dspy-rlm', markdown: false, json: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const next = () => {
      const value = argv[++i]
      if (value === undefined) usageError(`${arg} requires a value`)
      return value
    }
    if (arg === '--help' || arg === '-h') {
      printHelp()
      process.exit(0)
    } else if (arg === '--labels') args.labels = next()
    else if (arg === '--traces') args.traces = next()
    else if (arg === '--runner') args.runner = next()
    else if (arg === '--markdown') args.markdown = true
    else if (arg === '--json') args.json = true
    else if (arg === '--run') {
      const spec = next()
      const eq = spec.indexOf('=')
      if (eq <= 0) usageError(`--run expects LABEL=PATH, received '${spec}'`)
      args.runs.push({ label: spec.slice(0, eq), path: spec.slice(eq + 1) })
    } else usageError(`unknown argument '${arg}'`)
  }
  if (!args.labels) usageError('--labels is required')
  if (!args.traces) usageError('--traces is required')
  if (args.runs.length === 0) usageError('at least one --run is required')
  return args
}

function readObservations(path, runnerId) {
  const target = resolve(path)
  const file = statSync(target).isDirectory() ? join(target, 'observations.jsonl') : target
  const text = readFileSync(file, 'utf8')
  const rows = file.endsWith('.jsonl')
    ? text
        .split('\n')
        .filter((line) => line.trim())
        .map((line) => JSON.parse(line).observation)
    : JSON.parse(text).result.observations
  const selected = rows.filter((row) => row.runnerId === runnerId)
  if (selected.length === 0) throw new Error(`${file}: no observations for runner '${runnerId}'`)
  return selected
}

function goldSteps(row) {
  const steps = new Set()
  for (const stage of row.incorrect_stages ?? []) {
    for (const step of stage.incorrect_step_ids ?? []) steps.add(step)
  }
  return [...steps].sort((a, b) => a - b)
}

function assistantSpanContent(tracePath) {
  const content = new Map()
  for (const line of readFileSync(tracePath, 'utf8').split('\n')) {
    if (!line.trim()) continue
    const span = JSON.parse(line)
    const attributes = span.attributes ?? {}
    if (attributes['trajectory.role'] !== 'assistant') continue
    if (attributes.step === undefined) continue
    content.set(Number(attributes.step), String(attributes.content ?? ''))
  }
  return content
}

function citedStep(finding) {
  for (const ref of finding.evidence_refs ?? []) {
    const match = /\/span\/step-(\d+)$/.exec(ref.uri ?? '')
    if (match) return Number(match[1])
  }
  return null
}

function micro(matched, expected, supported, findings) {
  const recall = expected === 0 ? 0 : matched / expected
  const precision = findings === 0 ? 0 : supported / findings
  const f1 = recall + precision === 0 ? 0 : (2 * recall * precision) / (recall + precision)
  return { recall, precision, f1, matched, expected, supported, findings }
}

function fmt(value, digits = 4) {
  return Number.isFinite(value) ? value.toFixed(digits) : 'n/a'
}

const args = parseArgs(process.argv.slice(2))
const labelRows = JSON.parse(readFileSync(resolve(args.labels), 'utf8'))
const labels = new Map(labelRows.map((row) => [row.traj_id, row]))
const traceDirectory = resolve(args.traces)
const traceFiles = new Map(
  readdirSync(traceDirectory)
    .filter((name) => name.endsWith('.otlp.jsonl'))
    .map((name) => [name.replace(/\.otlp\.jsonl$/, ''), join(traceDirectory, name)]),
)

// Per-trajectory span facts: which gold steps the trace can single out at all.
const traceFacts = new Map()
for (const [trajectoryId, row] of labels) {
  const tracePath = traceFiles.get(trajectoryId)
  if (!tracePath) throw new Error(`no OTLP trace for '${trajectoryId}' in ${traceDirectory}`)
  const spans = assistantSpanContent(tracePath)
  const occurrences = new Map()
  for (const text of spans.values()) occurrences.set(text, (occurrences.get(text) ?? 0) + 1)
  const gold = goldSteps(row)
  const blind = new Set()
  for (const step of gold) {
    const text = spans.get(step) ?? ''
    const beyondBoilerplate = text
      .split('\n')
      .filter((line) => !line.includes(SUBMIT_BOILERPLATE))
      .join('\n')
      .trim()
    if ((occurrences.get(text) ?? 0) > 1 || beyondBoilerplate === '') blind.add(step)
  }
  traceFacts.set(trajectoryId, {
    gold,
    blind,
    stepCount: row.step_count,
    solved: row.solved === true,
    annotation: String(row.annotation_relpath ?? '').split('/')[0],
    spanCount: spans.size,
  })
}

const report = { runs: [] }
for (const run of args.runs) {
  const observations = readObservations(run.path, args.runner)
  const classes = { hit: 0, near: 0, far: 0, silent: 0, blindHit: 0, blind: 0 }
  const findingClasses = { supported: 0, near: 0, pad: 0, padSolved: 0, padUnsolved: 0 }
  const perCase = new Map()
  const totals = { matched: 0, expected: 0, supported: 0, findings: 0 }
  const counterfactual = {
    dropBlindGold: { matched: 0, expected: 0, supported: 0, findings: 0 },
    snapNear: { matched: 0, expected: 0, supported: 0, findings: 0 },
    dropEscaped: { matched: 0, expected: 0, supported: 0, findings: 0 },
    abstainSolved: { matched: 0, expected: 0, supported: 0, findings: 0 },
  }

  for (const observation of observations) {
    const trajectoryId = observation.caseId.replace(/^codetrace:/, '')
    const facts = traceFacts.get(trajectoryId)
    if (!facts) throw new Error(`observation for unknown trajectory '${trajectoryId}'`)
    const findings = observation.findings ?? []
    const supported = new Set(observation.score.supportedFindingIndexes ?? [])
    const matchedSteps = new Set(
      (observation.score.matchedIssueIds ?? []).map((id) => Number(id.split(':')[1])),
    )
    const cited = findings.map((finding) => citedStep(finding))
    const citedSteps = cited.filter((step) => step !== null)

    totals.matched += matchedSteps.size
    totals.expected += observation.score.expectedIssueCount
    totals.supported += supported.size
    totals.findings += findings.length

    // Gold-step classes.
    const rowClasses = []
    for (const step of facts.gold) {
      const distances = citedSteps.map((value) => Math.abs(value - step))
      const nearest = distances.length === 0 ? null : Math.min(...distances)
      let klass
      if (matchedSteps.has(step)) klass = facts.blind.has(step) ? 'blindHit' : 'hit'
      else if (facts.blind.has(step)) klass = 'blind'
      else if (nearest === null) klass = 'silent'
      else if (nearest <= NEAR_STEPS) klass = 'near'
      else klass = 'far'
      classes[klass] += 1
      rowClasses.push({ step, klass, nearest })
    }

    // Unsupported-finding classes.
    for (const [index, finding] of findings.entries()) {
      if (supported.has(index)) {
        findingClasses.supported += 1
        continue
      }
      const step = cited[index]
      const distances = step === null ? [] : facts.gold.map((value) => Math.abs(value - step))
      const nearest = distances.length === 0 ? Number.POSITIVE_INFINITY : Math.min(...distances)
      if (nearest <= NEAR_STEPS) findingClasses.near += 1
      else {
        findingClasses.pad += 1
        if (facts.solved) findingClasses.padSolved += 1
        else findingClasses.padUnsolved += 1
      }
    }

    // Counterfactual 1: gold the trace cannot single out leaves the denominator.
    const blindMatched = [...matchedSteps].filter((step) => facts.blind.has(step)).length
    const blindFindings = findings.filter((_, index) => {
      const step = cited[index]
      return step !== null && facts.blind.has(step)
    }).length
    const blindSupported = [...supported].filter((index) => {
      const step = cited[index]
      return step !== null && facts.blind.has(step)
    }).length
    counterfactual.dropBlindGold.matched += matchedSteps.size - blindMatched
    counterfactual.dropBlindGold.expected += observation.score.expectedIssueCount - facts.blind.size
    counterfactual.dropBlindGold.supported += supported.size - blindSupported
    counterfactual.dropBlindGold.findings += findings.length - blindFindings

    // Counterfactual 2: a citation within NEAR_STEPS of an unmatched gold step counts.
    const unmatchedGold = facts.gold.filter((step) => !matchedSteps.has(step))
    const claimed = new Set()
    let snapped = 0
    for (const step of unmatchedGold) {
      const candidate = findings.findIndex((_, index) => {
        if (supported.has(index) || claimed.has(index)) return false
        const value = cited[index]
        return value !== null && Math.abs(value - step) <= NEAR_STEPS
      })
      if (candidate >= 0) {
        claimed.add(candidate)
        snapped += 1
      }
    }
    counterfactual.snapNear.matched += matchedSteps.size + snapped
    counterfactual.snapNear.expected += observation.score.expectedIssueCount
    counterfactual.snapNear.supported += supported.size + snapped
    counterfactual.snapNear.findings += findings.length

    // Counterfactual 3: drop every block the analyst itself marked escaped.
    const kept = findings
      .map((finding, index) => ({ finding, index }))
      .filter(({ finding }) => finding.metadata?.escape_status !== 'escaped')
    counterfactual.dropEscaped.matched += kept.filter(({ index }) => supported.has(index)).length
    counterfactual.dropEscaped.expected += observation.score.expectedIssueCount
    counterfactual.dropEscaped.supported += kept.filter(({ index }) => supported.has(index)).length
    counterfactual.dropEscaped.findings += kept.length

    // Counterfactual 4: report nothing on trajectories whose task verified solved.
    counterfactual.abstainSolved.matched += facts.solved ? 0 : matchedSteps.size
    counterfactual.abstainSolved.expected += observation.score.expectedIssueCount
    counterfactual.abstainSolved.supported += facts.solved ? 0 : supported.size
    counterfactual.abstainSolved.findings += facts.solved ? 0 : findings.length

    const existing = perCase.get(trajectoryId) ?? {
      trajectoryId,
      solved: facts.solved,
      annotation: facts.annotation,
      stepCount: facts.stepCount,
      gold: facts.gold,
      blind: [...facts.blind],
      reps: [],
    }
    existing.reps.push({
      repetition: observation.repetition,
      findings: findings.length,
      cited: citedSteps,
      matched: [...matchedSteps].sort((a, b) => a - b),
      classes: rowClasses,
    })
    perCase.set(trajectoryId, existing)
  }

  report.runs.push({
    label: run.label,
    path: run.path,
    observations: observations.length,
    baseline: micro(totals.matched, totals.expected, totals.supported, totals.findings),
    goldClasses: classes,
    findingClasses,
    counterfactuals: Object.fromEntries(
      Object.entries(counterfactual).map(([name, value]) => [
        name,
        micro(value.matched, value.expected, value.supported, value.findings),
      ]),
    ),
    perCase: [...perCase.values()].sort((a, b) => a.trajectoryId.localeCompare(b.trajectoryId)),
  })
}

if (args.json) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  process.exit(0)
}

for (const run of report.runs) {
  const b = run.baseline
  process.stdout.write(`\n## ${run.label} (${run.observations} observations, runner ${args.runner})\n`)
  process.stdout.write(
    `micro recall ${fmt(b.recall)} precision ${fmt(b.precision)} F1 ${fmt(b.f1)} ` +
      `(matched ${b.matched}/${b.expected}, supported ${b.supported}/${b.findings})\n`,
  )
  process.stdout.write(`gold-step classes: ${JSON.stringify(run.goldClasses)}\n`)
  process.stdout.write(`finding classes:   ${JSON.stringify(run.findingClasses)}\n`)
  process.stdout.write('counterfactual micro F1:\n')
  for (const [name, value] of Object.entries(run.counterfactuals)) {
    process.stdout.write(
      `  ${name.padEnd(16)} recall ${fmt(value.recall)} precision ${fmt(value.precision)} ` +
        `F1 ${fmt(value.f1)} (delta ${fmt(value.f1 - b.f1, 4)})\n`,
    )
  }
  if (!args.markdown) continue
  process.stdout.write('\n| case | solved | annotation | steps | gold | input-blind gold | rep | findings | cited | matched | classes |\n')
  process.stdout.write('| --- | --- | --- | ---: | --- | --- | ---: | ---: | --- | --- | --- |\n')
  for (const row of run.perCase) {
    for (const rep of row.reps) {
      const classes = rep.classes.map((entry) => `${entry.step}:${entry.klass}`).join(' ')
      process.stdout.write(
        `| ${row.trajectoryId} | ${row.solved ? 'yes' : 'no'} | ${row.annotation} | ${row.stepCount} | ` +
          `${row.gold.join(',')} | ${row.blind.join(',') || '-'} | ${rep.repetition} | ${rep.findings} | ` +
          `${rep.cited.join(',') || '-'} | ${rep.matched.join(',') || '-'} | ${classes} |\n`,
      )
    }
  }
}
