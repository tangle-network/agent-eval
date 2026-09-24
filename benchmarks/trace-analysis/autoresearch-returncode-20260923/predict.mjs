#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'

const [traceDir, outputPath, option, selectedMode] = process.argv.slice(2)
if (
  !traceDir || !outputPath ||
  (process.argv.length !== 4 &&
    !(process.argv.length === 6 && option === '--mode' && ['first', 'last', 'all'].includes(selectedMode)))
) {
  throw new Error('Usage: node predict.mjs TRACE_DIR OUTPUT_JSON [--mode first|last|all]')
}

const files = (await readdir(traceDir)).filter((name) => name.endsWith('.otlp.jsonl')).sort()
if (files.length === 0) throw new Error(`No OTLP JSONL files in ${traceDir}`)

const rows = []
const seen = new Set()
for (const name of files) {
  const bytes = await readFile(join(traceDir, name))
  const spans = bytes.toString('utf8').trim().split('\n').map((line) => JSON.parse(line))
  const roots = spans.filter((span) => span.span_id === 'root')
  if (roots.length !== 1) throw new Error(`${name}: expected exactly one root span`)
  const traceId = roots[0].trace_id
  if (!traceId || typeof traceId !== 'string' || seen.has(traceId)) {
    throw new Error(`${name}: missing or repeated trace id`)
  }
  if (basename(name, '.otlp.jsonl') !== traceId) {
    throw new Error(`${name}: filename does not match trace id ${traceId}`)
  }
  seen.add(traceId)

  const events = spans
    .filter((span) => span.span_id !== 'root')
    .map((span) => ({
      span,
      messageIndex: span.attributes?.['trajectory.message_index'],
    }))
    .filter(({ messageIndex }) => Number.isSafeInteger(messageIndex) && messageIndex > 0)
    .sort((a, b) => a.messageIndex - b.messageIndex)
  const messageIndexes = new Set()
  const actions = new Map()
  let activeStep = null
  let unmatchedReturncodes = 0
  for (const { span, messageIndex } of events) {
    if (messageIndexes.has(messageIndex)) throw new Error(`${name}: duplicate message index ${messageIndex}`)
    messageIndexes.add(messageIndex)
    const stepMatch = /^step-(\d+)$/.exec(span.span_id ?? '')
    if (stepMatch) {
      const step = Number(stepMatch[1])
      if (actions.has(step)) throw new Error(`${name}: duplicate step ${step}`)
      actions.set(step, { returncodes: [] })
      activeStep = step
      continue
    }
    if (span.attributes?.['trajectory.role'] !== 'observation') continue
    const content = span.attributes?.content
    if (typeof content !== 'string') continue
    const matches = [...content.matchAll(/<returncode>(-?\d+)<\/returncode>/g)]
    if (matches.length === 0) continue
    if (matches.length !== 1) throw new Error(`${name}: observation has multiple return codes`)
    if (activeStep === null) {
      unmatchedReturncodes += 1
      continue
    }
    const returncode = Number(matches[0][1])
    if (!Number.isSafeInteger(returncode)) throw new Error(`${name}: invalid return code`)
    actions.get(activeStep).returncodes.push(returncode)
  }
  const expectedActions = roots[0].attributes?.['trajectory.action_count']
  if (actions.size !== expectedActions) {
    throw new Error(`${name}: ${actions.size} step spans but root declares ${expectedActions} actions`)
  }
  const nonzero = [...actions.entries()]
    .filter(([, action]) => action.returncodes.some((code) => code !== 0))
    .map(([step]) => step)
    .sort((a, b) => a - b)
  const known = [...actions.values()].filter((action) => action.returncodes.length > 0).length
  rows.push({
    traceId,
    traceSha256: createHash('sha256').update(bytes).digest('hex'),
    actions: actions.size,
    stepsWithReturncode: known,
    stepsWithoutReturncode: actions.size - known,
    unmatchedReturncodes,
    nonzeroSteps: nonzero,
    predictions: selectPredictions({
      first: nonzero.length ? [nonzero[0]] : [],
      last: nonzero.length ? [nonzero.at(-1)] : [],
      all: nonzero,
    }),
  })
}

const result = {
  schema: 'agent-eval/autoresearch-returncode-predictions@1',
  predictor: 'predict.mjs',
  traceFiles: rows.length,
  rows,
}
await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`)
console.log(`${rows.length} traces, ${rows.reduce((n, row) => n + row.actions, 0)} actions`)

function selectPredictions(predictions) {
  return selectedMode ? { [selectedMode]: predictions[selectedMode] } : predictions
}
