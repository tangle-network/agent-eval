/**
 * The declarative contract form: a JSON document that names tools, model
 * calls, and run limits, compiled onto the temporal operators.
 *
 * ```json
 * {
 *   "name": "refund-agent",
 *   "run": { "requireCompleted": true, "maxDurationMs": 120000 },
 *   "tools": {
 *     "required": ["lookup_order", "issue_refund"],
 *     "forbidden": ["delete_account"],
 *     "allowed": ["lookup_order", "issue_refund", "send_email"],
 *     "maxCalls": 20,
 *     "requiredOrder": ["lookup_order", "issue_refund"],
 *     "arguments": [{ "tool": "issue_refund", "pointer": "/amount", "type": "number" }],
 *     "enforced": true
 *   },
 *   "retries": {
 *     "reads": ["lookup_order"],
 *     "writes": [{ "tool": "issue_refund", "idempotencyKey": "/idempotency_key" }]
 *   },
 *   "llm": { "maxCalls": 10, "maxTotalTokens": 50000, "allowedModels": ["claude-sonnet-4-5"] },
 *   "alternatives": { "anyOf": [{ "id": "cache-hit", "tools": { "required": ["read_cache"] } }] }
 * }
 * ```
 *
 * Parsing is strict: an unknown key anywhere is an error that names the
 * closest known key, so a typo never silently drops a check. Tool rules match
 * TOOL spans only and model rules match LLM spans only, so an LLM span that
 * shares a tool's name never satisfies a tool rule. `rules` accepts the
 * low-level operators for checks the declarative keys cannot state.
 */

import { SPAN_KINDS } from '@tangle-network/agent-trace-contract'
import { ValidationError } from '../errors'
import { describeCheck } from './explain'
import { normalizePredicate } from './predicates'
import {
  ARGUMENT_OCCURRENCES,
  ARGUMENT_TYPES,
  type ArgumentCheck,
  type ArgumentOccurrence,
  type ArgumentType,
  type ContractAlternative,
  type ContractRule,
  ORDER_MODES,
  type OrderMode,
  type RetryWrite,
  RUN_STATUSES,
  type RunChecks,
  type SpanPredicate,
  type TraceContract,
} from './types'
import { assertContract, assertRule } from './validate'

export interface ToolArgumentSpec {
  tool: string
  /** RFC 6901 JSON Pointer into the call's arguments; `''` is the whole value. */
  pointer: string
  /** Which calls must satisfy the check. Default `all`. */
  occurrence?: ArgumentOccurrence
  /** Exactly one of `exists`, `equals`, `oneOf`, `type`. */
  exists?: true
  equals?: unknown
  oneOf?: unknown[]
  type?: ArgumentType
}

export interface ToolsSpec {
  /** Each must be called at least once. */
  required?: string[]
  /** None may be called. */
  forbidden?: string[]
  /** Every tool call must name one of these; a call without a name fails. */
  allowed?: string[]
  /** Ceiling on tool calls of any name. */
  maxCalls?: number
  /** Ceiling per tool name. */
  maxCallsPerTool?: Record<string, number>
  /** Each tool is called, and each comes before the next under `orderMode`. */
  requiredOrder?: string[]
  /** Default `start-order`. */
  orderMode?: OrderMode
  arguments?: ToolArgumentSpec[]
  /** The trace records the tools the harness offered the model
   *  (`gen_ai.tool.definitions`), every call is one of them, and, with
   *  `allowed`, every offered tool is allowed. */
  enforced?: true
}

export interface RetriesSpec {
  /** Tools that change nothing outside the run: repeating a call is safe. */
  reads?: string[]
  /** Tools that change state outside the run: a repeated call must carry one
   *  idempotency key. Any other tool called twice with the same arguments fails. */
  writes?: RetryWrite[]
}

export interface LlmSpec {
  maxCalls?: number
  /** Input plus output tokens across LLM calls; an unrecorded count fails. */
  maxTotalTokens?: number
  /** Every LLM call must name one of these models; a call without one fails. */
  allowedModels?: string[]
}

/** The checks one path carries: the base contract or one alternative. */
export interface PathSpec {
  run?: RunChecks
  tools?: ToolsSpec
  llm?: LlmSpec
  retries?: RetriesSpec
  /** Low-level rules in their serialized form. */
  rules?: ContractRule[]
}

export interface AlternativeSpec extends PathSpec {
  id: string
}

export interface TraceContractSpec extends PathSpec {
  name: string
  description?: string
  /** Check only the one span matching `root` and its descendants: one
   *  sub-agent (`{ "kind": "AGENT", "name": "researcher" }`) or one search
   *  node (`{ "attr": { "agent.branch.id": "n7" } }`). */
  scope?: { root: SpanPredicate }
  /** At least one alternative must pass completely, as well as the base checks. */
  alternatives?: { anyOf: AlternativeSpec[] }
}

const PATH_KEYS = ['run', 'tools', 'llm', 'retries', 'rules'] as const
const SPEC_KEYS = ['name', 'description', 'scope', 'alternatives', ...PATH_KEYS] as const
const ALTERNATIVE_KEYS = ['id', ...PATH_KEYS] as const
const RUN_KEYS = ['requireCompleted', 'allowedStatuses', 'maxDurationMs'] as const
const TOOLS_KEYS = [
  'required',
  'forbidden',
  'allowed',
  'maxCalls',
  'maxCallsPerTool',
  'requiredOrder',
  'orderMode',
  'arguments',
  'enforced',
] as const
const RETRIES_KEYS = ['reads', 'writes'] as const
const WRITE_KEYS = ['tool', 'idempotencyKey'] as const
const LLM_KEYS = ['maxCalls', 'maxTotalTokens', 'allowedModels'] as const
const ARGUMENT_KEYS = [
  'tool',
  'pointer',
  'occurrence',
  'exists',
  'equals',
  'oneOf',
  'type',
] as const
const ARGUMENT_CHECK_KEYS = ['exists', 'equals', 'oneOf', 'type'] as const
const PREDICATE_KEYS = ['name', 'tool', 'model', 'kind', 'attr', 'not'] as const
const MATCHER_KEYS = ['$regex', 'flags', 'oneOf'] as const
const RULE_KEYS: Record<ContractRule['kind'], readonly string[]> = {
  always: ['kind', 'label', 'p'],
  never: ['kind', 'label', 'p'],
  eventually: ['kind', 'label', 'p'],
  precedes: ['kind', 'label', 'a', 'b', 'order'],
  neverUnless: ['kind', 'label', 'p', 'prior', 'order'],
  atMost: ['kind', 'label', 'p', 'max'],
  tokensAtMost: ['kind', 'label', 'p', 'max'],
  run: ['kind', 'label', ...RUN_KEYS],
  argument: ['kind', 'label', 'p', 'pointer', 'check', 'occurrence'],
  toolsOffered: ['kind', 'label', 'declared'],
  retrySafe: ['kind', 'label', 'reads', 'writes'],
}

/**
 * Parse and compile a declarative contract. Throws `ValidationError` naming
 * the path of the first problem: an unknown key, a wrong type, an unknown
 * status, or a contract that checks nothing.
 */
export function compileTraceContractSpec(input: unknown): TraceContract {
  const spec = parseSpec(input)
  const scope = spec.scope ? { root: normalizePredicate(spec.scope.root, 'scope.root') } : undefined
  // Reports name an alternative's rules `<id>/<label>`, so its labels carry no path prefix.
  const alternatives: ContractAlternative[] | undefined = spec.alternatives?.anyOf.map((alt) => ({
    id: alt.id,
    rules: compilePath(alt, ''),
  }))
  const contract: TraceContract = {
    name: spec.name,
    ...(spec.description === undefined ? {} : { description: spec.description }),
    ...(scope === undefined ? {} : { scope }),
    rules: compilePath(spec, ''),
    ...(alternatives === undefined ? {} : { alternatives }),
  }
  assertContract(contract, `contract spec "${spec.name}"`)
  return contract
}

// ── Compilation ───────────────────────────────────────────────────────

const toolCall = (tool: string): SpanPredicate => ({ kind: 'TOOL', tool })
const ANY_TOOL: SpanPredicate = { kind: 'TOOL' }
const ANY_LLM: SpanPredicate = { kind: 'LLM' }

function compilePath(path: PathSpec, prefix: string): ContractRule[] {
  const at = (key: string) => (prefix ? `${prefix}.${key}` : key)
  const rules: ContractRule[] = []
  if (path.run) rules.push({ kind: 'run', label: at('run'), ...path.run })
  const tools = path.tools
  if (tools) {
    for (const tool of tools.required ?? []) {
      rules.push({ kind: 'eventually', label: at(`tools.required[${tool}]`), p: toolCall(tool) })
    }
    for (const tool of tools.forbidden ?? []) {
      rules.push({ kind: 'never', label: at(`tools.forbidden[${tool}]`), p: toolCall(tool) })
    }
    if (tools.allowed) {
      rules.push({
        kind: 'never',
        label: at('tools.allowed'),
        p: { kind: 'TOOL', not: { tool: { oneOf: [...tools.allowed] } } },
      })
    }
    if (tools.maxCalls !== undefined) {
      rules.push({ kind: 'atMost', label: at('tools.maxCalls'), p: ANY_TOOL, max: tools.maxCalls })
    }
    for (const [tool, max] of Object.entries(tools.maxCallsPerTool ?? {})) {
      rules.push({
        kind: 'atMost',
        label: at(`tools.maxCallsPerTool[${tool}]`),
        p: toolCall(tool),
        max,
      })
    }
    const order = tools.requiredOrder ?? []
    for (let i = 1; i < order.length; i++) {
      rules.push({
        kind: 'precedes',
        label: at(`tools.requiredOrder[${order[i - 1]}->${order[i]}]`),
        a: toolCall(order[i - 1]!),
        b: toolCall(order[i]!),
        ...(tools.orderMode === undefined ? {} : { order: tools.orderMode }),
      })
    }
    // A one-tool order states presence only.
    if (order.length === 1) {
      rules.push({
        kind: 'eventually',
        label: at(`tools.requiredOrder[${order[0]}]`),
        p: toolCall(order[0]!),
      })
    }
    tools.arguments?.forEach((arg, i) => {
      const check = argumentCheck(arg)
      rules.push({
        kind: 'argument',
        label: at(
          `tools.arguments[${i}] ${arg.tool} ${arg.pointer || '(whole value)'} ${describeCheck(check)}`,
        ),
        p: toolCall(arg.tool),
        pointer: arg.pointer,
        check,
        ...(arg.occurrence === undefined ? {} : { occurrence: arg.occurrence }),
      })
    })
    if (tools.enforced) {
      rules.push({
        kind: 'toolsOffered',
        label: at('tools.enforced'),
        ...(tools.allowed === undefined ? {} : { declared: [...tools.allowed] }),
      })
    }
  }
  if (path.retries) {
    rules.push({
      kind: 'retrySafe',
      label: at('retries'),
      ...(path.retries.reads === undefined ? {} : { reads: [...path.retries.reads] }),
      ...(path.retries.writes === undefined
        ? {}
        : { writes: path.retries.writes.map((w) => ({ ...w })) }),
    })
  }
  const llm = path.llm
  if (llm) {
    if (llm.maxCalls !== undefined) {
      rules.push({ kind: 'atMost', label: at('llm.maxCalls'), p: ANY_LLM, max: llm.maxCalls })
    }
    if (llm.maxTotalTokens !== undefined) {
      rules.push({
        kind: 'tokensAtMost',
        label: at('llm.maxTotalTokens'),
        p: ANY_LLM,
        max: llm.maxTotalTokens,
      })
    }
    if (llm.allowedModels) {
      rules.push({
        kind: 'never',
        label: at('llm.allowedModels'),
        p: { kind: 'LLM', not: { model: { oneOf: [...llm.allowedModels] } } },
      })
    }
  }
  for (const rule of path.rules ?? []) rules.push({ ...rule })
  return rules
}

function argumentCheck(arg: ToolArgumentSpec): ArgumentCheck {
  if (arg.exists) return { op: 'exists' }
  if ('equals' in arg) return { op: 'equals', value: arg.equals }
  if (arg.oneOf) return { op: 'oneOf', values: arg.oneOf }
  return { op: 'type', type: arg.type! }
}

// ── Strict parsing ────────────────────────────────────────────────────

type Obj = Record<string, unknown>

function parseSpec(input: unknown): TraceContractSpec {
  const spec = object(input, 'contract')
  strictKeys(spec, SPEC_KEYS, 'contract')
  const name = nonEmptyString(spec.name, 'name')
  if (spec.description !== undefined) nonEmptyString(spec.description, 'description')
  if (spec.scope !== undefined) {
    const scope = object(spec.scope, 'scope')
    strictKeys(scope, ['root'], 'scope')
    predicate(scope.root, 'scope.root')
  }
  parsePath(spec, '')
  if (spec.alternatives !== undefined) {
    const alternatives = object(spec.alternatives, 'alternatives')
    strictKeys(alternatives, ['anyOf'], 'alternatives')
    const anyOf = nonEmptyArray(alternatives.anyOf, 'alternatives.anyOf')
    anyOf.forEach((alt, i) => {
      const where = `alternatives.anyOf[${i}]`
      const a = object(alt, where)
      strictKeys(a, ALTERNATIVE_KEYS, where)
      nonEmptyString(a.id, `${where}.id`)
      parsePath(a, where)
    })
  }
  return { ...(spec as unknown as TraceContractSpec), name }
}

function parsePath(path: Obj, prefix: string): void {
  const at = (key: string) => (prefix ? `${prefix}.${key}` : key)
  if (path.run !== undefined) {
    const run = object(path.run, at('run'))
    strictKeys(run, RUN_KEYS, at('run'))
    if (Array.isArray(run.allowedStatuses)) {
      run.allowedStatuses.forEach((status, i) => {
        oneOfValues(status, RUN_STATUSES, at(`run.allowedStatuses[${i}]`))
      })
    }
    assertRule({ kind: 'run', label: 'run', ...(run as RunChecks) }, at('run'))
  }
  if (path.tools !== undefined) {
    const tools = object(path.tools, at('tools'))
    strictKeys(tools, TOOLS_KEYS, at('tools'))
    for (const key of ['required', 'forbidden', 'allowed', 'requiredOrder'] as const) {
      if (tools[key] !== undefined) toolNames(tools[key], at(`tools.${key}`))
    }
    if (tools.maxCalls !== undefined) count(tools.maxCalls, at('tools.maxCalls'))
    if (tools.maxCallsPerTool !== undefined) {
      const perTool = object(tools.maxCallsPerTool, at('tools.maxCallsPerTool'))
      for (const [tool, max] of Object.entries(perTool)) {
        nonEmptyString(tool, at('tools.maxCallsPerTool key'))
        count(max, at(`tools.maxCallsPerTool.${tool}`))
      }
    }
    if (tools.enforced !== undefined && tools.enforced !== true) {
      throw new ValidationError(`${at('tools.enforced')}: must be true`)
    }
    if (tools.orderMode !== undefined)
      oneOfValues(tools.orderMode, ORDER_MODES, at('tools.orderMode'))
    if (tools.orderMode !== undefined && tools.requiredOrder === undefined) {
      throw new ValidationError(`${at('tools.orderMode')}: set only with requiredOrder`)
    }
    if (tools.arguments !== undefined) {
      nonEmptyArray(tools.arguments, at('tools.arguments')).forEach((arg, i) => {
        const where = at(`tools.arguments[${i}]`)
        const a = object(arg, where)
        strictKeys(a, ARGUMENT_KEYS, where)
        nonEmptyString(a.tool, `${where}.tool`)
        const checks = ARGUMENT_CHECK_KEYS.filter((k) => k in a)
        if (checks.length !== 1) {
          throw new ValidationError(
            `${where}: set exactly one of ${ARGUMENT_CHECK_KEYS.join(', ')} (found ${checks.length})`,
          )
        }
        if (a.exists !== undefined && a.exists !== true) {
          throw new ValidationError(`${where}.exists: must be true`)
        }
        if (a.oneOf !== undefined) nonEmptyArray(a.oneOf, `${where}.oneOf`)
        if (a.type !== undefined) oneOfValues(a.type, ARGUMENT_TYPES, `${where}.type`)
        if (a.occurrence !== undefined)
          oneOfValues(a.occurrence, ARGUMENT_OCCURRENCES, `${where}.occurrence`)
        assertRule(
          {
            kind: 'argument',
            label: 'argument',
            p: toolCall(a.tool as string),
            pointer: a.pointer as string,
            check: argumentCheck(a as unknown as ToolArgumentSpec),
          },
          where,
        )
      })
    }
  }
  if (path.retries !== undefined) {
    const retries = object(path.retries, at('retries'))
    strictKeys(retries, RETRIES_KEYS, at('retries'))
    if (retries.reads !== undefined) toolNames(retries.reads, at('retries.reads'))
    if (retries.writes !== undefined) {
      nonEmptyArray(retries.writes, at('retries.writes')).forEach((w, i) => {
        const where = at(`retries.writes[${i}]`)
        strictKeys(object(w, where), WRITE_KEYS, where)
        nonEmptyString((w as Obj).tool, `${where}.tool`)
      })
    }
    assertRule({ kind: 'retrySafe', label: 'retries', ...(retries as RetriesSpec) }, at('retries'))
  }
  if (path.llm !== undefined) {
    const llm = object(path.llm, at('llm'))
    strictKeys(llm, LLM_KEYS, at('llm'))
    if (llm.maxCalls !== undefined) count(llm.maxCalls, at('llm.maxCalls'))
    if (llm.maxTotalTokens !== undefined) count(llm.maxTotalTokens, at('llm.maxTotalTokens'))
    if (llm.allowedModels !== undefined) toolNames(llm.allowedModels, at('llm.allowedModels'))
  }
  if (path.rules !== undefined) {
    nonEmptyArray(path.rules, at('rules')).forEach((raw, i) => {
      const where = at(`rules[${i}]`)
      const rule = object(raw, where)
      const kind = oneOfValues(
        rule.kind,
        Object.keys(RULE_KEYS),
        `${where}.kind`,
      ) as ContractRule['kind']
      strictKeys(rule, RULE_KEYS[kind], where)
      for (const key of ['p', 'a', 'b', 'prior'] as const) {
        if (rule[key] !== undefined) predicate(rule[key], `${where}.${key}`)
      }
      if (kind === 'argument' && rule.check !== undefined) {
        strictKeys(
          object(rule.check, `${where}.check`),
          ['op', 'value', 'values', 'type'],
          `${where}.check`,
        )
      }
      assertRule(rule as unknown as ContractRule, where)
    })
  }
}

function predicate(value: unknown, where: string): void {
  const p = object(value, where)
  strictKeys(p, PREDICATE_KEYS, where)
  for (const key of ['name', 'tool', 'model'] as const) {
    const m = p[key]
    if (m !== null && typeof m === 'object' && !Array.isArray(m)) {
      strictKeys(m as Obj, MATCHER_KEYS, `${where}.${key}`)
    }
  }
  if (p.kind !== undefined) oneOfValues(p.kind, SPAN_KINDS, `${where}.kind`)
  if (p.not !== undefined) predicate(p.not, `${where}.not`)
}

function strictKeys(value: Obj, allowed: readonly string[], where: string): void {
  for (const key of Object.keys(value)) {
    if (allowed.includes(key)) continue
    const hint = closest(key, allowed)
    throw new ValidationError(
      `${where}: unknown key "${key}"${hint ? ` — did you mean "${hint}"?` : ''} (allowed: ${allowed.join(', ')})`,
    )
  }
}

function object(value: unknown, where: string): Obj {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ValidationError(`${where}: must be an object`)
  }
  return value as Obj
}

function nonEmptyString(value: unknown, where: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ValidationError(`${where}: must be a non-empty string`)
  }
  return value
}

function nonEmptyArray(value: unknown, where: string): unknown[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new ValidationError(`${where}: must be a non-empty array`)
  }
  return value
}

function toolNames(value: unknown, where: string): string[] {
  const names = nonEmptyArray(value, where).map((v, i) => nonEmptyString(v, `${where}[${i}]`))
  const dup = names.find((n, i) => names.indexOf(n) !== i)
  if (dup !== undefined) throw new ValidationError(`${where}: "${dup}" is listed twice`)
  return names
}

function count(value: unknown, where: string): void {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new ValidationError(`${where}: must be a non-negative integer`)
  }
}

function oneOfValues(value: unknown, allowed: readonly string[], where: string): string {
  if (typeof value === 'string' && allowed.includes(value)) return value
  const hint = typeof value === 'string' ? closest(value, allowed) : undefined
  throw new ValidationError(
    `${where}: ${JSON.stringify(value)} is not one of ${allowed.join(', ')}${hint ? ` — did you mean "${hint}"?` : ''}`,
  )
}

/** The allowed word within edit distance 2 (or a case-insensitive match). */
function closest(word: string, allowed: readonly string[]): string | undefined {
  let best: { word: string; d: number } | undefined
  for (const candidate of allowed) {
    const d =
      candidate.toLowerCase() === word.toLowerCase()
        ? 0
        : editDistance(word.toLowerCase(), candidate.toLowerCase())
    if (d <= 2 && (!best || d < best.d)) best = { word: candidate, d }
  }
  return best?.word
}

function editDistance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    const cur = [i]
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(
        prev[j]! + 1,
        cur[j - 1]! + 1,
        prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      )
    }
    prev = cur
  }
  return prev[b.length]!
}

// ── Lint ──────────────────────────────────────────────────────────────

export interface ContractLintFinding {
  /** `error`: the contract can never pass, or contradicts itself.
   *  `warning`: the contract works but likely does not say what was meant. */
  level: 'error' | 'warning'
  code: string
  path: string
  message: string
}

/**
 * Find contradictions and likely mistakes in a declarative contract. Parses
 * strictly first, so a malformed spec throws instead of linting.
 */
export function lintTraceContractSpec(input: unknown): ContractLintFinding[] {
  const spec = parseSpec(input)
  const findings: ContractLintFinding[] = []
  lintPath(spec, '', findings)
  for (const [i, alt] of (spec.alternatives?.anyOf ?? []).entries()) {
    lintPath(alt, `alternatives.anyOf[${i}]`, findings)
  }
  if (spec.alternatives?.anyOf.length === 1) {
    findings.push({
      level: 'warning',
      code: 'alternatives.single',
      path: 'alternatives.anyOf',
      message:
        'one alternative is the same as base checks; move its checks to the base or add another path',
    })
  }
  const ids = spec.alternatives?.anyOf.map((a) => a.id) ?? []
  const dupId = ids.find((id, i) => ids.indexOf(id) !== i)
  if (dupId !== undefined) {
    findings.push({
      level: 'error',
      code: 'alternatives.duplicate-id',
      path: 'alternatives.anyOf',
      message: `alternative id "${dupId}" is used twice`,
    })
  }
  return findings
}

function lintPath(path: PathSpec, prefix: string, out: ContractLintFinding[]): void {
  const at = (key: string) => (prefix ? `${prefix}.${key}` : key)
  const error = (code: string, key: string, message: string) =>
    out.push({ level: 'error', code, path: at(key), message })
  const warn = (code: string, key: string, message: string) =>
    out.push({ level: 'warning', code, path: at(key), message })
  const t = path.tools ?? {}
  const forbidden = new Set(t.forbidden ?? [])
  const allowed = t.allowed ? new Set(t.allowed) : undefined
  const needed = [...(t.required ?? []), ...(t.requiredOrder ?? [])]
  for (const tool of needed) {
    if (forbidden.has(tool)) {
      error('tools.required-and-forbidden', 'tools', `"${tool}" is both required and forbidden`)
    }
    if (allowed && !allowed.has(tool)) {
      error(
        'tools.required-not-allowed',
        'tools.allowed',
        `"${tool}" is required but not in allowed`,
      )
    }
    if (t.maxCallsPerTool?.[tool] === 0) {
      error(
        'tools.required-capped-at-zero',
        'tools.maxCallsPerTool',
        `"${tool}" is required but capped at 0 calls`,
      )
    }
  }
  if (t.maxCalls === 0 && needed.length > 0) {
    error('tools.required-but-no-calls', 'tools.maxCalls', 'tools are required but maxCalls is 0')
  }
  const distinctNeeded = new Set(needed).size
  if (t.maxCalls !== undefined && t.maxCalls > 0 && distinctNeeded > t.maxCalls) {
    error(
      'tools.max-below-required',
      'tools.maxCalls',
      `${distinctNeeded} distinct tools are required but maxCalls is ${t.maxCalls}`,
    )
  }
  for (const tool of forbidden) {
    if (allowed?.has(tool))
      error('tools.allowed-and-forbidden', 'tools', `"${tool}" is both allowed and forbidden`)
    if (t.maxCallsPerTool?.[tool] !== undefined) {
      warn(
        'tools.cap-on-forbidden',
        'tools.maxCallsPerTool',
        `"${tool}" is forbidden, so its call cap never applies`,
      )
    }
  }
  for (const tool of Object.keys(t.maxCallsPerTool ?? {})) {
    if (allowed && !allowed.has(tool)) {
      warn(
        'tools.cap-on-disallowed',
        'tools.maxCallsPerTool',
        `"${tool}" has a cap but is not in allowed`,
      )
    }
  }
  for (const [i, arg] of (t.arguments ?? []).entries()) {
    if (forbidden.has(arg.tool)) {
      error(
        'tools.argument-on-forbidden',
        `tools.arguments[${i}]`,
        `"${arg.tool}" is forbidden, so its arguments can never be checked`,
      )
    }
    if (!needed.includes(arg.tool)) {
      warn(
        'tools.argument-without-required',
        `tools.arguments[${i}]`,
        `"${arg.tool}" is not required; a run that never calls it fails this check for missing evidence`,
      )
    }
  }
  if (t.enforced && !allowed) {
    warn(
      'tools.enforced-without-allowed',
      'tools.enforced',
      'without allowed, only calls are checked against the offered tools; add allowed to also check what the harness offered',
    )
  }
  for (const [i, w] of (path.retries?.writes ?? []).entries()) {
    if (forbidden.has(w.tool)) {
      warn(
        'retries.write-forbidden',
        `retries.writes[${i}]`,
        `"${w.tool}" is forbidden, so its retry rule never applies`,
      )
    }
  }
  const order = t.requiredOrder ?? []
  const repeated = order.find((tool, i) => order.indexOf(tool) !== i)
  if (repeated !== undefined) {
    error(
      'tools.order-repeats',
      'tools.requiredOrder',
      `"${repeated}" appears twice, so the order contradicts itself`,
    )
  }
  if (order.length > 1 && t.orderMode === undefined) {
    warn(
      'tools.order-default-mode',
      'tools.orderMode',
      'start-order passes when calls overlap; set finish-before-start if each step must finish first',
    )
  }
  const run = path.run
  if (run?.requireCompleted && run.allowedStatuses && !run.allowedStatuses.includes('completed')) {
    error(
      'run.completed-not-allowed',
      'run',
      'requireCompleted needs status completed, which allowedStatuses excludes',
    )
  } else if (run?.requireCompleted && run.allowedStatuses?.some((s) => s !== 'completed')) {
    warn(
      'run.statuses-beside-completed',
      'run.allowedStatuses',
      'requireCompleted accepts only completed, so the other allowed statuses never apply',
    )
  }
  if (
    path.llm?.maxCalls === 0 &&
    (path.llm.maxTotalTokens !== undefined || path.llm.allowedModels)
  ) {
    warn('llm.no-calls', 'llm', 'maxCalls is 0, so the token and model limits never apply')
  }
}
