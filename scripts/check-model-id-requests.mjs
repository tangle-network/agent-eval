/**
 * Model-id request gate.
 *
 * A model id that reaches a measurement path must arrive with proof of WHICH
 * model answered. A routing gateway can accept `model: "gpt-4.1-mini"` and
 * answer from another provider on HTTP 200, so a hardcoded id states an
 * intent and never evidence: every per-model number taken from that call
 * describes a model the code did not request.
 *
 * The gate reads every string literal in a REQUEST POSITION under `src/` — the
 * value of `model`, `judges`, `worker` and the other seat names — and demands
 * one of two things:
 *   - proof: the enclosing function, or the module for a top-level literal,
 *     calls a served-side assertion (`assertServedModel`, `assertModelsServed`,
 *     `assertCrossFamilyServed`, …); or
 *   - a waiver: an entry in `model-id-request-allowlist.json` that states why
 *     the literal never becomes a request.
 *
 * Position decides, spelling does not. A literal at `model:` is a model id
 * whatever it is spelled, so the gate keeps no register of known vendors and
 * cannot go stale as models ship. A shape filter drops sentinels that share
 * these positions but name no model, such as `""` and `"unattributed"`.
 *
 * `src/` is the measurement surface, because that is the code this package
 * ships and runs evals with. Tests, examples, docs and benchmarks demonstrate
 * rather than measure; NON_MEASUREMENT_PATHS below records that boundary.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseSync } from 'oxc-parser'

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DEFAULT_ALLOWLIST_PATH = resolve(REPOSITORY_ROOT, 'scripts/model-id-request-allowlist.json')

/** Directories that ship as the measured library. */
const MEASUREMENT_ROOTS = ['src']

/**
 * Files inside a measurement root that measure nothing. Tests and their
 * support files name models to drive stubs, so a served assertion there would
 * assert against a mock. Everything outside `src/` — `examples/`, `docs/`,
 * `tests/`, `benchmarks/` — demonstrates the library instead of shipping it,
 * and is out of scope by the roots above.
 */
const NON_MEASUREMENT_PATHS = [/\.test\.ts$/, /\.test-support\.ts$/, /\.d\.ts$/]

/**
 * Identifier positions that name a model to CALL. A literal here is a request,
 * whatever the string looks like.
 */
const REQUEST_KEYS = new Set([
  'model',
  'models',
  'judges',
  'judgeModel',
  'judgeModels',
  'worker',
  'workerModel',
  'analyst',
  'analystModel',
  'reflection',
  'reflectionModel',
  'verifier',
  'verifierModel',
  'defaultModel',
  'modelId',
  'fallbackModels',
])

/**
 * Calls that prove which model answered. The pattern covers local aliases such
 * as `assertServedModel as assertServedModelIdentity`, so an import rename
 * cannot quietly drop the proof.
 */
const PROOF_CALL = /^assert(ServedModels?|CrossFamilyServed|ModelsServed)/

/**
 * A model id is a bare routing token: vendor prefix, name, version, no spaces.
 * The second pattern requires a digit, a `/` or a `-`, which every real id
 * carries and which the sentinels sharing these positions (`""`,
 * `"unattributed"`, `"(default)"`, `"unknown@unknown"`) do not.
 */
const MODEL_ID_SHAPE = /^[a-z0-9][a-z0-9._@/-]*$/i
const MODEL_ID_DISCRIMINATOR = /[0-9/-]/

/** Nodes that pass a literal through without changing its position. */
const TRANSPARENT_NODES = new Set([
  'ArrayExpression',
  'TSAsExpression',
  'TSSatisfiesExpression',
  'TSNonNullExpression',
  'ParenthesizedExpression',
])

const FUNCTION_NODES = new Set([
  'FunctionDeclaration',
  'FunctionExpression',
  'ArrowFunctionExpression',
  'TSDeclareFunction',
])

/**
 * Scan `root` and report every model id that reaches a measurement path
 * unproven. Pure apart from reading the tree, so tests drive it over fixtures.
 * Throws on a malformed allowlist or an unparseable source file — a gate that
 * cannot read its own inputs must not report a pass.
 */
export function checkModelIdRequests({
  root = REPOSITORY_ROOT,
  allowlistPath = DEFAULT_ALLOWLIST_PATH,
} = {}) {
  const allowlist = loadAllowlist(allowlistPath)
  const usedWaivers = new Set()
  const offences = []

  for (const measurementRoot of MEASUREMENT_ROOTS) {
    const absoluteRoot = resolve(root, measurementRoot)
    if (!statSync(absoluteRoot, { throwIfNoEntry: false })?.isDirectory()) continue
    for (const file of sourceFiles(absoluteRoot)) {
      const relativePath = relative(root, file).replaceAll('\\', '/')
      if (NON_MEASUREMENT_PATHS.some((pattern) => pattern.test(relativePath))) continue
      collectOffences({ file, relativePath, allowlist, usedWaivers, offences })
    }
  }

  return {
    offences,
    unusedWaivers: allowlist.filter((entry) => !usedWaivers.has(waiverKey(entry))),
    waiverCount: allowlist.length,
  }
}

function loadAllowlist(allowlistPath) {
  const raw = JSON.parse(readFileSync(allowlistPath, 'utf8'))
  if (!Array.isArray(raw.allow)) {
    throw new Error(`${allowlistPath}: "allow" must be an array`)
  }
  for (const [index, entry] of raw.allow.entries()) {
    for (const field of ['file', 'literal', 'reason']) {
      if (typeof entry[field] !== 'string' || entry[field].trim() === '') {
        throw new Error(`${allowlistPath}: allow[${index}].${field} must be a non-empty string`)
      }
    }
    // A waiver states why the literal is not a request. Too short to be that
    // statement is too short to review.
    if (entry.reason.trim().length < 24) {
      throw new Error(
        `${allowlistPath}: allow[${index}].reason must explain why the id never becomes a request`,
      )
    }
  }
  return raw.allow
}

function waiverKey(entry) {
  return `${entry.file} ${entry.literal}`
}

function* sourceFiles(directory) {
  for (const name of readdirSync(directory).sort()) {
    const path = join(directory, name)
    if (statSync(path).isDirectory()) yield* sourceFiles(path)
    else if (path.endsWith('.ts')) yield path
  }
}

function collectOffences({ file, relativePath, allowlist, usedWaivers, offences }) {
  const source = readFileSync(file, 'utf8')
  const { program, errors } = parseSync(file, source)
  if (errors.length > 0) {
    throw new Error(`${relativePath}: parse failed — ${errors[0].message}`)
  }

  const ancestors = []
  const visit = (node) => {
    if (node === null || typeof node !== 'object') return
    if (Array.isArray(node)) {
      for (const child of node) visit(child)
      return
    }
    if (typeof node.type !== 'string') return

    if (node.type === 'Literal' && typeof node.value === 'string' && isModelId(node.value)) {
      const position = requestPosition(ancestors)
      if (position !== null) {
        const waiver = allowlist.find(
          (entry) => entry.file === relativePath && entry.literal === node.value,
        )
        if (waiver !== undefined) usedWaivers.add(waiverKey(waiver))
        else if (!hasServedAssertion(ancestors)) {
          offences.push({
            file: relativePath,
            line: lineOf(source, node.start),
            literal: node.value,
            position,
            scope: enclosingScopeName(ancestors),
          })
        }
      }
    }

    ancestors.push(node)
    for (const key of Object.keys(node)) {
      if (key === 'type' || key === 'start' || key === 'end') continue
      visit(node[key])
    }
    ancestors.pop()
  }
  visit(program)
}

function isModelId(value) {
  return MODEL_ID_SHAPE.test(value) && MODEL_ID_DISCRIMINATOR.test(value)
}

/**
 * Name the request position a literal sits in, or null when it sits somewhere
 * that names no model. Transparent containers are skipped so `judges: ['a']`
 * reads the same as `model: 'a'`; the first meaningful ancestor decides, so a
 * literal nested deeper in an unrelated structure does not inherit a position.
 */
function requestPosition(ancestors) {
  for (let index = ancestors.length - 1; index >= 0; index--) {
    const node = ancestors[index]
    if (TRANSPARENT_NODES.has(node.type)) continue
    if (node.type === 'Property' && node.computed !== true) {
      const key = node.key?.name ?? node.key?.value
      return REQUEST_KEYS.has(key) ? key : null
    }
    if (node.type === 'VariableDeclarator') {
      return REQUEST_KEYS.has(node.id?.name) ? node.id.name : null
    }
    if (node.type === 'AssignmentPattern') {
      return REQUEST_KEYS.has(node.left?.name) ? node.left.name : null
    }
    if (node.type === 'LogicalExpression') {
      const name = node.left?.property?.name ?? node.left?.name
      return REQUEST_KEYS.has(name) ? name : null
    }
    return null
  }
  return null
}

/**
 * True when the function holding the literal proves which model answered.
 * Proof anywhere in that function's subtree counts, because the assertion
 * commonly runs in a nested closure or a loop body rather than beside the id.
 * A literal outside any function is checked against the whole module.
 */
function hasServedAssertion(ancestors) {
  const scope = ancestors.findLast((node) => FUNCTION_NODES.has(node.type)) ?? ancestors[0]
  if (scope === undefined) return false
  let found = false
  const visit = (node) => {
    if (found || node === null || typeof node !== 'object') return
    if (Array.isArray(node)) {
      for (const child of node) visit(child)
      return
    }
    if (typeof node.type !== 'string') return
    if (node.type === 'Identifier' && PROOF_CALL.test(node.name)) {
      found = true
      return
    }
    for (const key of Object.keys(node)) {
      if (key === 'type' || key === 'start' || key === 'end') continue
      visit(node[key])
    }
  }
  visit(scope)
  return found
}

function enclosingScopeName(ancestors) {
  const scope = ancestors.findLast((node) => FUNCTION_NODES.has(node.type))
  if (scope === undefined) return 'module scope'
  return scope.id?.name === undefined ? 'an anonymous function' : `${scope.id.name}()`
}

function lineOf(source, offset) {
  let line = 1
  for (let index = 0; index < offset; index++) {
    if (source.charCodeAt(index) === 10) line++
  }
  return line
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { offences, unusedWaivers, waiverCount } = checkModelIdRequests()
    const allowlistLabel = relative(REPOSITORY_ROOT, DEFAULT_ALLOWLIST_PATH)

    for (const offence of offences) {
      console.error(
        `${offence.file}:${offence.line}: model id ${JSON.stringify(offence.literal)} is ` +
          `requested at \`${offence.position}\` in ${offence.scope} with no served-model assertion`,
      )
    }
    for (const entry of unusedWaivers) {
      console.error(
        `${allowlistLabel}: waiver for ${JSON.stringify(entry.literal)} in ${entry.file} ` +
          'matches nothing — delete it',
      )
    }
    if (offences.length > 0) {
      console.error(
        `\n${offences.length} model id(s) reach a measurement path unproven. A requested id is ` +
          'not evidence: a gateway can answer it from another model on HTTP 200. Either assert ' +
          'the served id in the same function — assertServedModel(model, response.servedModel) ' +
          'from src/integrity/served-model.ts, or assertModelsServed({ probe: true }) before the ' +
          `run — or, when the literal never becomes a request, waive it in ${allowlistLabel} ` +
          'with the reason.',
      )
    }
    if (offences.length > 0 || unusedWaivers.length > 0) process.exit(1)

    console.log(
      `model id request gate valid: every model id under ${MEASUREMENT_ROOTS.join(', ')} is ` +
        `either asserted against the served id or waived (${waiverCount} waivers, all matched)`,
    )
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}
