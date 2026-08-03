#!/usr/bin/env node
// Decompose analyst micro-F1 loss on a CodeTraceBench run, case by case.
//
// Every number is recomputed from the run's own observations plus the split's
// labels and OTLP traces — no model calls, no scorer changes. Two micro views:
//   pooled    recall = sum(matched)/sum(expected), precision =
//             sum(supported)/sum(findings) over every observation. Equals
//             result.summaries[].f1 on splits whose rows are all labeled.
//   official  the same sums restricted to labelState 'positive' observations —
//             what result.summaries[].f1 reports on splits that carry
//             label-empty rows, where findings on negative rows never enter
//             the precision denominator.
//
// Loss classes per gold step (the analyst's view of a gold step is the OTLP
// span it would have to cite):
//   input-blind   the gold span's visible content repeats another span in the
//                 same trace, or carries nothing beyond the harness submit
//                 boilerplate. No analyst can single it out from the trace.
//                 Split by reason: 'duplicate' vs 'blank' (nothing beyond
//                 boilerplate — e.g. Terminus2 bare-Enter keystrokes).
//   hit           some finding cites the gold step exactly.
//   near          nearest citation is 1-2 steps away (block boundary error).
//   far           nearest citation is >2 steps away, split by direction
//                 (citations land later vs earlier than the gold step).
//   silent        the run produced no citation anywhere in the trace.
// Unsupported findings split into near (<=2 steps from a gold step) and pad
// (>2 steps), each also split by the trajectory's solved flag.
//
// Counterfactuals recompute official micro F1 with one class neutralised at a
// time. Block-shape sections compare labeled gold blocks (maximal contiguous
// gold runs) against the run's own predicted blocks
// (metadata.block_first_step/…_last_step). With --normalized, gold classes are
// additionally split by the normalized step's tool_type and thinking presence.
//
// The labels-level calibration section needs no run: it scores the constant
// positional rules from the split3 analysis (accuse step_count-shift, last-2
// window, and the best rule over a shift 0-15 x width 1-3 sweep) against the
// official scorer on labeled cases, one repetition.
//
// Usage:
//   decompose-analyst-loss.mjs --labels LABELS.json --traces TRACE_DIR \
//     [--normalized NORMALIZED_ROOT] \
//     --run LABEL=PATH [--run LABEL2=PATH2 ...] [--runner ID] [--markdown] [--json]
//
// PATH is a run directory, a result.json, or an observations.jsonl.

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const SUBMIT_BOILERPLATE = 'COMPLETE_TASK_AND_SUBMIT_FINAL_OUTPUT'
const NEAR_STEPS = 2

// A closed reader (`| head`) must end the tool quietly, not raise EPIPE.
process.stdout.on('error', (error) => {
  if (error.code === 'EPIPE') process.exit(0)
  throw error
})

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
  const args = {
    labels: null,
    traces: null,
    normalized: null,
    runs: [],
    runner: 'dspy-rlm',
    markdown: false,
    json: false,
  }
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
    else if (arg === '--normalized') args.normalized = next()
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

// Maximal contiguous runs over a sorted array of step ids.
function contiguousBlocks(steps) {
  const blocks = []
  for (const step of steps) {
    const last = blocks[blocks.length - 1]
    if (last && step === last.last + 1) last.last = step
    else blocks.push({ first: step, last: step })
  }
  return blocks.map((block) => ({ ...block, width: block.last - block.first + 1 }))
}

function quantile(sorted, q) {
  if (sorted.length === 0) return null
  const index = (sorted.length - 1) * q
  const low = Math.floor(index)
  const high = Math.ceil(index)
  return sorted[low] + (sorted[high] - sorted[low]) * (index - low)
}

function distribution(values) {
  const sorted = [...values].sort((a, b) => a - b)
  const round = (value) => (value === null ? null : Number(value.toFixed(3)))
  return {
    n: sorted.length,
    min: round(sorted[0] ?? null),
    p25: round(quantile(sorted, 0.25)),
    p50: round(quantile(sorted, 0.5)),
    p75: round(quantile(sorted, 0.75)),
    max: round(sorted[sorted.length - 1] ?? null),
    mean: round(sorted.length === 0 ? null : sorted.reduce((sum, v) => sum + v, 0) / sorted.length),
  }
}

// Per-trajectory normalized step facts: tool_type and thinking presence.
function readNormalizedSteps(root, trajectoryId) {
  const path = join(root, trajectoryId, 'steps.json')
  const steps = JSON.parse(readFileSync(path, 'utf8'))
  const byId = new Map()
  for (const step of steps) {
    byId.set(Number(step.step_id), {
      toolType: step.tool_type ?? inferToolType(step.action),
      hasThinking: Boolean(step.thinking),
      blankAction: String(step.action ?? '').trim() === '',
    })
  }
  return byId
}

// OpenHands actions are rendered tool calls (`read({...})`); Terminus2 actions
// are raw keystrokes. Anything without a call-shaped prefix counts as shell.
function inferToolType(action) {
  const match = /^([a-z_][a-z0-9_]*)\(\{/.exec(String(action ?? '').trim())
  return match ? match[1] : 'shell'
}

// Constant positional rules from the split3 analysis, scored with official
// semantics on labeled cases: one deterministic prediction set per case,
// matched against gold, precision = matched/predicted, recall = matched/gold.
function constantRuleCalibration(labels) {
  const labeled = [...labels.values()].filter((row) => goldSteps(row).length > 0)
  const score = (predict) => {
    let matched = 0
    let expected = 0
    let predicted = 0
    for (const row of labeled) {
      const gold = new Set(goldSteps(row))
      expected += gold.size
      for (const step of predict(row.step_count)) {
        if (step < 1 || step > row.step_count) continue
        predicted += 1
        if (gold.has(step)) matched += 1
      }
    }
    return micro(matched, expected, matched, predicted)
  }
  const named = {
    'n-0': score((n) => [n]),
    'n-1': score((n) => [n - 1]),
    'n-2': score((n) => [n - 2]),
    'last-2-window': score((n) => [n - 1, n]),
  }
  let best = { rule: null, f1: -1 }
  for (let shift = 0; shift <= 15; shift++) {
    for (let width = 1; width <= 3; width++) {
      const result = score((n) => Array.from({ length: width }, (_, i) => n - shift - i))
      if (result.f1 > best.f1) {
        best = { rule: `accuse steps n-${shift}..n-${shift + width - 1}`, f1: result.f1, ...result }
      }
    }
  }
  return { labeledCases: labeled.length, named, best }
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
  const blindReason = new Map()
  for (const step of gold) {
    const text = spans.get(step) ?? ''
    const beyondBoilerplate = text
      .split('\n')
      .filter((line) => !line.includes(SUBMIT_BOILERPLATE))
      .join('\n')
      .trim()
    if (beyondBoilerplate === '') {
      blind.add(step)
      blindReason.set(step, 'blank')
    } else if ((occurrences.get(text) ?? 0) > 1) {
      blind.add(step)
      blindReason.set(step, 'duplicate')
    }
  }
  traceFacts.set(trajectoryId, {
    gold,
    goldBlocks: contiguousBlocks(gold),
    blind,
    blindReason,
    normalizedSteps: args.normalized ? readNormalizedSteps(resolve(args.normalized), trajectoryId) : null,
    stepCount: row.step_count,
    solved: row.solved === true,
    annotation: String(row.annotation_relpath ?? '').split('/')[0],
    spanCount: spans.size,
  })
}

// Split-level structure that needs no run.
const goldBlockWidths = []
const goldBlockPositions = []
for (const facts of traceFacts.values()) {
  for (const block of facts.goldBlocks) {
    goldBlockWidths.push(block.width)
    goldBlockPositions.push(block.first / facts.stepCount)
  }
}
const splitStructure = {
  goldBlockWidth: distribution(goldBlockWidths),
  goldBlockStartPositionFraction: distribution(goldBlockPositions),
  constantRuleCalibration: constantRuleCalibration(labels),
}

const report = { splitStructure, runs: [] }
for (const run of args.runs) {
  const observations = readObservations(run.path, args.runner)
  const classes = { hit: 0, near: 0, far: 0, silent: 0, blindHit: 0, blind: 0 }
  const blindReasons = { blank: 0, duplicate: 0, blankHit: 0, duplicateHit: 0 }
  const farDirection = { later: 0, earlier: 0, straddling: 0 }
  const toolTypeClasses = new Map()
  const findingClasses = { supported: 0, near: 0, pad: 0, padSolved: 0, padUnsolved: 0 }
  const officialFindingClasses = { supported: 0, near: 0, pad: 0, padSolved: 0, padUnsolved: 0 }
  const predictedBlockWidths = []
  const predictedBlockPositions = []
  const perCase = new Map()
  const totals = { matched: 0, expected: 0, supported: 0, findings: 0 }
  const official = { matched: 0, expected: 0, supported: 0, findings: 0 }
  const counterfactual = {
    dropBlindGold: { matched: 0, expected: 0, supported: 0, findings: 0 },
    snapNear: { matched: 0, expected: 0, supported: 0, findings: 0 },
    snapFar: { matched: 0, expected: 0, supported: 0, findings: 0 },
    dropEscaped: { matched: 0, expected: 0, supported: 0, findings: 0 },
    abstainSolved: { matched: 0, expected: 0, supported: 0, findings: 0 },
  }

  for (const observation of observations) {
    const trajectoryId = observation.caseId.replace(/^codetrace:/, '')
    const facts = traceFacts.get(trajectoryId)
    if (!facts) throw new Error(`observation for unknown trajectory '${trajectoryId}'`)
    const positive = observation.labelState === 'positive'
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
    if (positive) {
      official.matched += matchedSteps.size
      official.expected += observation.score.expectedIssueCount
      official.supported += supported.size
      official.findings += findings.length
    }

    // Predicted block shape, from the runner's own block metadata.
    const seenBlocks = new Set()
    for (const finding of findings) {
      const first = finding.metadata?.block_first_step
      const last = finding.metadata?.block_last_step
      if (typeof first !== 'number' || typeof last !== 'number') continue
      const key = `${first}-${last}`
      if (seenBlocks.has(key)) continue
      seenBlocks.add(key)
      predictedBlockWidths.push(last - first + 1)
      predictedBlockPositions.push(first / facts.stepCount)
    }

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
      if (klass === 'blind' || klass === 'blindHit') {
        const reason = facts.blindReason.get(step)
        if (klass === 'blind') blindReasons[reason] += 1
        else blindReasons[`${reason}Hit`] += 1
      }
      if (klass === 'far') {
        const later = citedSteps.some((value) => value > step)
        const earlier = citedSteps.some((value) => value < step)
        if (later && earlier) farDirection.straddling += 1
        else if (later) farDirection.later += 1
        else farDirection.earlier += 1
      }
      if (facts.normalizedSteps) {
        const normalized = facts.normalizedSteps.get(step)
        const toolType = normalized?.toolType ?? 'unknown'
        const bucket = toolTypeClasses.get(toolType) ?? {
          gold: 0,
          hit: 0,
          near: 0,
          far: 0,
          silent: 0,
          blind: 0,
          withThinking: 0,
        }
        bucket.gold += 1
        bucket[klass === 'blindHit' ? 'hit' : klass] += 1
        if (normalized?.hasThinking) bucket.withThinking += 1
        toolTypeClasses.set(toolType, bucket)
      }
    }

    // Unsupported-finding classes.
    for (const [index, finding] of findings.entries()) {
      if (supported.has(index)) {
        findingClasses.supported += 1
        if (positive) officialFindingClasses.supported += 1
        continue
      }
      const step = cited[index]
      const distances = step === null ? [] : facts.gold.map((value) => Math.abs(value - step))
      const nearest = distances.length === 0 ? Number.POSITIVE_INFINITY : Math.min(...distances)
      if (nearest <= NEAR_STEPS) {
        findingClasses.near += 1
        if (positive) officialFindingClasses.near += 1
      } else {
        findingClasses.pad += 1
        if (facts.solved) findingClasses.padSolved += 1
        else findingClasses.padUnsolved += 1
        if (positive) {
          officialFindingClasses.pad += 1
          if (facts.solved) officialFindingClasses.padSolved += 1
          else officialFindingClasses.padUnsolved += 1
        }
      }
    }

    // Counterfactuals accumulate in the official currency: positive runs only,
    // matching the precision denominator result.summaries[].f1 reports.
    if (positive) {
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

      // Counterfactual 2b: any citation, at any distance, counts toward an
      // unmatched gold step (one finding per gold step). Upper-bounds what a
      // region-level fix could recover without changing finding volume.
      const farClaimed = new Set()
      let farSnapped = 0
      for (const step of unmatchedGold) {
        const candidate = findings.findIndex((_, index) => {
          if (supported.has(index) || farClaimed.has(index)) return false
          return cited[index] !== null
        })
        if (candidate >= 0) {
          farClaimed.add(candidate)
          farSnapped += 1
        }
      }
      counterfactual.snapFar.matched += matchedSteps.size + farSnapped
      counterfactual.snapFar.expected += observation.score.expectedIssueCount
      counterfactual.snapFar.supported += supported.size + farSnapped
      counterfactual.snapFar.findings += findings.length

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
    }

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
    official: micro(official.matched, official.expected, official.supported, official.findings),
    goldClasses: classes,
    blindReasons,
    farDirection,
    toolTypeClasses: Object.fromEntries(
      [...toolTypeClasses.entries()].sort((a, b) => b[1].gold - a[1].gold),
    ),
    predictedBlocks: {
      width: distribution(predictedBlockWidths),
      startPositionFraction: distribution(predictedBlockPositions),
    },
    findingClasses,
    officialFindingClasses,
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

const structure = report.splitStructure
process.stdout.write('\n## split structure (labels + traces, no run)\n')
process.stdout.write(`gold block width:          ${JSON.stringify(structure.goldBlockWidth)}\n`)
process.stdout.write(`gold block start fraction: ${JSON.stringify(structure.goldBlockStartPositionFraction)}\n`)
const calibration = structure.constantRuleCalibration
process.stdout.write(`constant rules (${calibration.labeledCases} labeled cases): `)
process.stdout.write(
  `${Object.entries(calibration.named)
    .map(([name, value]) => `${name} F1 ${fmt(value.f1, 3)}`)
    .join(', ')}; best sweep: ${calibration.best.rule} F1 ${fmt(calibration.best.f1, 3)}\n`,
)

for (const run of report.runs) {
  const b = run.baseline
  const o = run.official
  process.stdout.write(`\n## ${run.label} (${run.observations} observations, runner ${args.runner})\n`)
  process.stdout.write(
    `official micro recall ${fmt(o.recall)} precision ${fmt(o.precision)} F1 ${fmt(o.f1)} ` +
      `(matched ${o.matched}/${o.expected}, supported ${o.supported}/${o.findings}; positive runs only)\n`,
  )
  process.stdout.write(
    `pooled micro   recall ${fmt(b.recall)} precision ${fmt(b.precision)} F1 ${fmt(b.f1)} ` +
      `(matched ${b.matched}/${b.expected}, supported ${b.supported}/${b.findings}; all runs)\n`,
  )
  process.stdout.write(`gold-step classes: ${JSON.stringify(run.goldClasses)}\n`)
  process.stdout.write(`blind reasons:     ${JSON.stringify(run.blindReasons)}\n`)
  process.stdout.write(`far direction:     ${JSON.stringify(run.farDirection)}\n`)
  if (Object.keys(run.toolTypeClasses).length > 0) {
    process.stdout.write('gold classes by tool type:\n')
    for (const [toolType, bucket] of Object.entries(run.toolTypeClasses)) {
      process.stdout.write(`  ${toolType.padEnd(20)} ${JSON.stringify(bucket)}\n`)
    }
  }
  process.stdout.write(`predicted block width: ${JSON.stringify(run.predictedBlocks.width)}\n`)
  process.stdout.write(
    `predicted block start fraction: ${JSON.stringify(run.predictedBlocks.startPositionFraction)}\n`,
  )
  process.stdout.write(`finding classes (all runs):      ${JSON.stringify(run.findingClasses)}\n`)
  process.stdout.write(`finding classes (positive runs): ${JSON.stringify(run.officialFindingClasses)}\n`)
  process.stdout.write('counterfactual official micro F1:\n')
  for (const [name, value] of Object.entries(run.counterfactuals)) {
    process.stdout.write(
      `  ${name.padEnd(16)} recall ${fmt(value.recall)} precision ${fmt(value.precision)} ` +
        `F1 ${fmt(value.f1)} (delta ${fmt(value.f1 - o.f1, 4)})\n`,
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
