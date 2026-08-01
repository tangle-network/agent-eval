#!/usr/bin/env node
// Restore each agent step's own reasoning text to CodeTraceBench normalized steps.
//
// CodeTracer's normalizer keeps only the shell command it extracts from an
// assistant message, so the message's reasoning ("THOUGHT: ...") never reaches
// the trace the analyst reads. Two steps whose commands are identical — the
// submit boilerplate mini-SWE-agent emits at the end of most trajectories —
// become indistinguishable spans even when the labels mark exactly one of them.
//
// This tool reads the raw trajectory beside the normalized steps, pairs
// assistant messages to steps in order, and writes `thinking` into a COPY of
// the normalized tree. `@tangle-network/traces import-codetracebench` already
// joins `thinking` and `action` into the span content, so no importer change is
// needed. The source tree is never modified: the unrestored input stays
// byte-identical for A/B comparison.
//
// Every pairing is checked and the tool fails on any violation: one trajectory
// file per case, one assistant message per normalized step, and the step's
// action must appear inside the message it is paired with.
//
// Usage:
//   restore-step-reasoning.mjs --labels LABELS.json --normalized DIR \
//     --extracted DIR --out DIR [--receipt PATH]

import { createHash } from 'node:crypto'
import { cpSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const BASH_FENCE = /```bash\n[\s\S]*?```/g

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
  const args = { labels: null, normalized: null, extracted: null, out: null, receipt: null }
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
    else if (arg === '--normalized') args.normalized = next()
    else if (arg === '--extracted') args.extracted = next()
    else if (arg === '--out') args.out = next()
    else if (arg === '--receipt') args.receipt = next()
    else usageError(`unknown argument '${arg}'`)
  }
  for (const key of ['labels', 'normalized', 'extracted', 'out']) {
    if (!args[key]) usageError(`--${key} is required`)
  }
  return args
}

function sha256(text) {
  return createHash('sha256').update(text).digest('hex')
}

function findTrajectoryFiles(directory) {
  const found = []
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.name.endsWith('.traj.json')) found.push(path)
    }
  }
  walk(directory)
  return found.sort()
}

function assistantMessages(path, trajectoryId) {
  const parsed = JSON.parse(readFileSync(path, 'utf8'))
  const messages = Array.isArray(parsed) ? parsed : parsed.messages
  if (!Array.isArray(messages)) {
    throw new Error(`${trajectoryId}: ${path} has no messages array`)
  }
  return messages
    .filter((message) => message?.role === 'assistant')
    .map((message) => {
      if (typeof message.content !== 'string') {
        throw new Error(`${trajectoryId}: assistant message content is not a string`)
      }
      return message.content
    })
}

function reasoningOf(message) {
  return message.replace(BASH_FENCE, '').trim()
}

const args = parseArgs(process.argv.slice(2))
const labels = JSON.parse(readFileSync(resolve(args.labels), 'utf8'))
const normalizedRoot = resolve(args.normalized)
const extractedRoot = resolve(args.extracted)
const outRoot = resolve(args.out)
mkdirSync(outRoot, { recursive: true })

const cases = []
let restoredSteps = 0
let emptyReasoning = 0
let addedBytes = 0

for (const row of labels) {
  const trajectoryId = row.traj_id
  if (typeof trajectoryId !== 'string' || !trajectoryId) {
    throw new Error('labels row has no traj_id')
  }
  const caseDirectory = join(normalizedRoot, trajectoryId)
  if (!statSync(caseDirectory).isDirectory()) {
    throw new Error(`${trajectoryId}: ${caseDirectory} is not a directory`)
  }
  const stepsPath = join(caseDirectory, 'steps.json')
  const stepsText = readFileSync(stepsPath, 'utf8')
  const steps = JSON.parse(stepsText)
  if (!Array.isArray(steps)) throw new Error(`${trajectoryId}: steps.json is not an array`)
  if (steps.length !== row.step_count) {
    throw new Error(
      `${trajectoryId}: steps.json has ${steps.length} steps, labels declare ${row.step_count}`,
    )
  }

  const trajectoryFiles = findTrajectoryFiles(join(extractedRoot, trajectoryId))
  if (trajectoryFiles.length !== 1) {
    throw new Error(
      `${trajectoryId}: expected one *.traj.json under the extracted archive, found ${trajectoryFiles.length}`,
    )
  }
  const messages = assistantMessages(trajectoryFiles[0], trajectoryId)
  if (messages.length !== steps.length) {
    throw new Error(
      `${trajectoryId}: ${messages.length} assistant messages for ${steps.length} normalized steps`,
    )
  }

  const restored = steps.map((step, index) => {
    const message = messages[index]
    const action = typeof step.action === 'string' ? step.action.trim() : ''
    if (action && !message.includes(action)) {
      throw new Error(
        `${trajectoryId}: step ${step.step_id ?? index + 1} action is absent from its paired assistant message`,
      )
    }
    const thinking = reasoningOf(message)
    if (!thinking) {
      emptyReasoning += 1
      return step
    }
    restoredSteps += 1
    addedBytes += Buffer.byteLength(thinking)
    return { ...step, thinking }
  })

  const outDirectory = join(outRoot, trajectoryId)
  cpSync(caseDirectory, outDirectory, { recursive: true })
  const restoredText = `${JSON.stringify(restored, null, 2)}\n`
  writeFileSync(join(outDirectory, 'steps.json'), restoredText)
  cases.push({
    traceId: trajectoryId,
    steps: steps.length,
    restoredSteps: restored.filter((step) => typeof step.thinking === 'string').length,
    sourceStepsSha256: sha256(stepsText),
    restoredStepsSha256: sha256(restoredText),
    trajectoryPath: trajectoryFiles[0].slice(extractedRoot.length + 1),
  })
}

const receipt = {
  kind: 'agent-eval/codetracebench-reasoning-restoration',
  labelsSha256: sha256(readFileSync(resolve(args.labels))),
  normalizedRoot,
  extractedRoot,
  outRoot,
  cases: cases.length,
  steps: cases.reduce((sum, item) => sum + item.steps, 0),
  restoredSteps,
  emptyReasoning,
  addedBytes,
  perCase: cases,
}
if (args.receipt) writeFileSync(resolve(args.receipt), `${JSON.stringify(receipt, null, 2)}\n`)
process.stdout.write(
  `restored reasoning on ${restoredSteps}/${receipt.steps} steps across ${cases.length} cases ` +
    `(+${addedBytes} bytes, ${emptyReasoning} steps had no reasoning text)\n`,
)
