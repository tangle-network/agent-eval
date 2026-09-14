/**
 * The registered-rule AST: every rule an experiment registers is DATA.
 *
 * A closure cannot be canonicalized or hashed; a node tree can. `sealExperiment`
 * hashes the whole tree, and every interpreter in this file takes only a node
 * plus evidence records — no parameter for alpha, threshold, metric, or
 * stopping rule exists on any executable surface. The registered object and
 * the executed object are therefore the same object, and registered-vs-ran
 * drift is unrepresentable rather than checked.
 *
 * Node families:
 *   Predicate       closed-key comparisons — the only leaf
 *   AdmissionRule   monotone funnel stages with registered waivers
 *   SelectionRule   deterministic subsets over a closed field set
 *   Estimand        what the experiment measures
 *   IntervalSpec    how uncertainty is computed, seed included
 *   Condition       decision guards over named derived quantities
 *   DecisionRule    ordered verdict table, or a registered absence of one
 *   Obligation      a control that must exist before a verdict class is read
 *   ValidityGate    pre-spend design checks
 *   HaltRule        gates as prerequisites — failure refuses the spend
 *   BudgetRule      spend schedules with a named ledger
 *   MatchedBudgetRule  arm budget matching as a refusal
 *   ReissuePolicy   carrier faults are reissued; model outcomes stand
 */

import { ValidationError } from '../errors'
import { mulberry32 } from '../statistics'

/** JSON-serializable value — everything a sealed node may carry. */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [k: string]: JsonValue }

/** Evidence row shape. Fields are addressed by dot-separated paths. */
export type EvidenceRecord = Record<string, unknown>

/** A decision rule's branches did not cover the evidence. */
class DecisionTableNotTotalError extends ValidationError {}

// ── Predicate ────────────────────────────────────────────────────────

/**
 * Closed-key comparison over a declared record schema. The only leaf node.
 * `field` is a dot-separated path into an evidence record.
 */
export type Predicate =
  | {
      kind: 'compare'
      field: string
      op: 'eq' | 'ne' | 'lt' | 'lte' | 'gt' | 'gte'
      value: JsonValue
    }
  | { kind: 'in'; field: string; values: JsonValue[] }
  | { kind: 'all'; of: Predicate[] }
  | { kind: 'any'; of: Predicate[] }
  | { kind: 'not'; of: Predicate }

/** Read a dot-separated field path. Missing segments yield `undefined`. */
export function readField(record: EvidenceRecord, path: string): unknown {
  let current: unknown = record
  for (const key of path.split('.')) {
    if (current === null || typeof current !== 'object') return undefined
    current = (current as Record<string, unknown>)[key]
  }
  return current
}

/** Evaluate a predicate against one evidence record. */
export function evaluatePredicate(predicate: Predicate, record: EvidenceRecord): boolean {
  switch (predicate.kind) {
    case 'compare':
      return compareValues(readField(record, predicate.field), predicate.op, predicate.value)
    case 'in':
      return predicate.values.includes(readField(record, predicate.field) as JsonValue)
    case 'all':
      return predicate.of.every((p) => evaluatePredicate(p, record))
    case 'any':
      return predicate.of.some((p) => evaluatePredicate(p, record))
    case 'not':
      return !evaluatePredicate(predicate.of, record)
  }
}

/** Numbers compare numerically; everything else compares as strings. */
function compareValues(
  value: unknown,
  op: 'eq' | 'ne' | 'lt' | 'lte' | 'gt' | 'gte',
  target: JsonValue,
): boolean {
  if (op === 'eq') return value === target
  if (op === 'ne') return value !== target
  const numeric = typeof value === 'number' && typeof target === 'number'
  const left = numeric ? (value as number) : String(value)
  const right = numeric ? (target as number) : String(target)
  switch (op) {
    case 'lt':
      return left < right
    case 'lte':
      return left <= right
    case 'gt':
      return left > right
    case 'gte':
      return left >= right
  }
}

// ── Admission ────────────────────────────────────────────────────────

/**
 * One monotone funnel stage. `waives` names substrate admission conditions
 * deliberately NOT applied, so a waiver is registered, never implicit.
 */
export interface AdmissionStage {
  id: string
  keep: Predicate
  waives?: string[]
}

/** A partition is a set reported separately and never pooled. */
export interface AdmissionPartition {
  id: string
  /** Stage whose dropped rows this partition draws from. */
  from: string
  keep: Predicate
  pooling: 'never'
}

/** Declarative row-admission funnel. Stages only remove rows. */
export interface AdmissionRule {
  population: string
  stages: AdmissionStage[]
  partitions?: AdmissionPartition[]
}

// ── Selection ────────────────────────────────────────────────────────

/**
 * Deterministic subset selection. `reads` is the closed field set the rule
 * may touch — outcome-contaminated selection is unrepresentable because an
 * outcome field is simply not in the list.
 */
export type SelectionRule =
  | {
      kind: 'round-robin'
      groupBy: string
      groupOrder: 'lex-asc'
      withinOrder: { field: string; dir: 'asc' | 'desc' }
      take: number
      reads: string[]
    }
  | {
      kind: 'filter-of'
      /** Name of the sealed subset or selection this rule filters. */
      base: string
      keep: Predicate
      order: { field: string; dir: 'asc' | 'desc' }
    }

/**
 * Execute a selection rule.
 *
 * Round-robin walks groups in lexicographic order and takes ids in
 * within-group order until `take` ids are chosen. Filter-of keeps the ids of
 * `bases[rule.base]` whose record satisfies the predicate, in the registered
 * order. Ids absent from `records` are evaluated on their id alone (fields
 * derived from the id via `idFields`), so a sealed base outlives its source
 * records.
 */
export function runSelectionRule(
  rule: SelectionRule,
  records: readonly EvidenceRecord[],
  options: {
    /** Field carrying a row's identity. */
    idField: string
    /** Sealed or previously-computed subsets, by name. */
    bases?: Record<string, readonly string[]>
    /** Derive predicate-readable fields from a bare id when its record is absent. */
    idFields?: (id: string) => EvidenceRecord
  },
): string[] {
  if (rule.kind === 'round-robin') {
    const allowed = new Set(rule.reads)
    for (const field of [rule.groupBy, rule.withinOrder.field]) {
      if (!allowed.has(field)) {
        throw new ValidationError(
          `runSelectionRule: round-robin reads '${field}' but its closed read set is [${rule.reads.join(', ')}]`,
        )
      }
    }
    const byGroup = new Map<string, string[]>()
    for (const record of records) {
      const group = String(readField(record, rule.groupBy))
      const id = String(readField(record, rule.withinOrder.field))
      const bucket = byGroup.get(group)
      if (bucket) bucket.push(id)
      else byGroup.set(group, [id])
    }
    for (const ids of byGroup.values()) {
      ids.sort()
      if (rule.withinOrder.dir === 'desc') ids.reverse()
    }
    const groups = [...byGroup.keys()].sort()
    const chosen: string[] = []
    let cursor = 0
    while (chosen.length < rule.take && groups.some((g) => byGroup.get(g)!.length > 0)) {
      const group = groups[cursor % groups.length]!
      const ids = byGroup.get(group)!
      if (ids.length > 0) chosen.push(ids.shift()!)
      cursor += 1
    }
    return chosen
  }

  const base = options.bases?.[rule.base]
  if (!base) {
    throw new ValidationError(`runSelectionRule: filter-of base '${rule.base}' was not provided`)
  }
  const index = new Map(records.map((r) => [String(readField(r, options.idField)), r]))
  const kept = base.filter((id) => {
    const record = index.get(id) ?? options.idFields?.(id)
    if (!record) {
      throw new ValidationError(
        `runSelectionRule: base id '${id}' has no record and no idFields derivation`,
      )
    }
    return evaluatePredicate(rule.keep, record)
  })
  const sorted = [...kept].sort()
  if (rule.order.dir === 'desc') sorted.reverse()
  return sorted
}

// ── Estimands ────────────────────────────────────────────────────────

/** A named set of row identities, built from arm rows and an event predicate. */
export type SetExpr =
  | { kind: 'rows-where'; arm: string; event: Predicate }
  | { kind: 'intersect'; of: SetExpr[] }

/**
 * What the experiment measures. Every estimand names the fields it reads, so
 * the sealed tree records the full data dependency of the number.
 */
export type Estimand =
  | { kind: 'rate'; event: Predicate; over: 'rollouts' }
  | { kind: 'rate-at-least-once'; event: Predicate; groupBy: string }
  | {
      kind: 'paired-mean-diff'
      armField: string
      treatment: string
      control: string
      pairBy: string
      /**
       * Field path to the per-row outcome. A boolean reads as 1 or 0, so a
       * binary pass/fail outcome gives the risk difference directly.
       */
      value: string
      /** A pair one arm did not answer contributes a difference of exactly zero. */
      missing: 'zero-diff'
    }
  | {
      kind: 'set-ratio'
      armField: string
      idField: string
      numerator: SetExpr
      denominator: SetExpr
    }

export interface EstimandResult {
  value: number
  numerator: number
  denominator: number
}

function evaluateSetExpr(
  expr: SetExpr,
  rows: readonly EvidenceRecord[],
  armField: string,
  idField: string,
): Set<string> {
  if (expr.kind === 'rows-where') {
    const ids = new Set<string>()
    for (const row of rows) {
      if (String(readField(row, armField)) !== expr.arm) continue
      if (evaluatePredicate(expr.event, row)) ids.add(String(readField(row, idField)))
    }
    return ids
  }
  if (expr.of.length === 0) throw new ValidationError('computeEstimand: empty intersect')
  const sets = expr.of.map((e) => evaluateSetExpr(e, rows, armField, idField))
  const [first, ...rest] = sets
  const out = new Set<string>()
  for (const id of first!) {
    if (rest.every((s) => s.has(id))) out.add(id)
  }
  return out
}

/**
 * Read one registered outcome field as a number.
 *
 * A binary outcome reaches evidence as `true` or `false`. Its mean is the pass
 * rate and the mean of its paired differences is the risk difference, so
 * `true` reads as 1 and `false` as 0 — the same quantity a caller would
 * otherwise encode by hand, and the same reading in every interpreter here.
 * Every other type, and a non-finite number, is a measurement defect: it
 * rejects instead of poisoning the mean with `NaN` or a coerced zero.
 */
function readNumericOutcome(raw: unknown, context: string, field: string, where: string): number {
  if (typeof raw === 'boolean') return raw ? 1 : 0
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw
  throw new ValidationError(
    `${context}: value field '${field}' is not a finite number or a boolean on ${where}`,
  )
}

/** Compute an estimand over evidence rows. Pure; reads only registered fields. */
export function computeEstimand(
  estimand: Estimand,
  rows: readonly EvidenceRecord[],
): EstimandResult {
  switch (estimand.kind) {
    case 'rate': {
      const numerator = rows.filter((r) => evaluatePredicate(estimand.event, r)).length
      if (rows.length === 0) throw new ValidationError('computeEstimand: rate over zero rows')
      return { value: numerator / rows.length, numerator, denominator: rows.length }
    }
    case 'rate-at-least-once': {
      const byGroup = new Map<string, boolean>()
      for (const row of rows) {
        const group = String(readField(row, estimand.groupBy))
        const hit = evaluatePredicate(estimand.event, row)
        byGroup.set(group, (byGroup.get(group) ?? false) || hit)
      }
      if (byGroup.size === 0) {
        throw new ValidationError('computeEstimand: rate-at-least-once over zero groups')
      }
      const numerator = [...byGroup.values()].filter(Boolean).length
      return { value: numerator / byGroup.size, numerator, denominator: byGroup.size }
    }
    case 'paired-mean-diff': {
      const byPair = new Map<string, { treatment?: number; control?: number }>()
      for (const row of rows) {
        const arm = String(readField(row, estimand.armField))
        if (arm !== estimand.treatment && arm !== estimand.control) continue
        const pair = String(readField(row, estimand.pairBy))
        const value = readNumericOutcome(
          readField(row, estimand.value),
          'computeEstimand paired-mean-diff',
          estimand.value,
          `pair '${pair}'`,
        )
        const slot = byPair.get(pair) ?? {}
        if (arm === estimand.treatment) slot.treatment = value
        else slot.control = value
        byPair.set(pair, slot)
      }
      if (byPair.size === 0) {
        throw new ValidationError('computeEstimand: paired-mean-diff over zero pairs')
      }
      let sum = 0
      for (const slot of byPair.values()) {
        // missing: 'zero-diff' — an unanswered side contributes zero, never a drop
        sum += (slot.treatment ?? 0) - (slot.control ?? 0)
      }
      return { value: sum / byPair.size, numerator: sum, denominator: byPair.size }
    }
    case 'set-ratio': {
      const numeratorSet = evaluateSetExpr(
        estimand.numerator,
        rows,
        estimand.armField,
        estimand.idField,
      )
      const denominatorSet = evaluateSetExpr(
        estimand.denominator,
        rows,
        estimand.armField,
        estimand.idField,
      )
      if (denominatorSet.size === 0) {
        throw new ValidationError('computeEstimand: set-ratio denominator set is empty')
      }
      return {
        value: numeratorSet.size / denominatorSet.size,
        numerator: numeratorSet.size,
        denominator: denominatorSet.size,
      }
    }
  }
}

// ── Intervals ────────────────────────────────────────────────────────

/** How uncertainty is computed. The seed is part of the registration. */
export type IntervalSpec =
  | {
      kind: 'cluster-bootstrap'
      clusterBy: string
      /** Registered numeric or boolean outcome field, including a prepared paired difference. */
      value: string
      resamples: number
      seed: number
      level: number
      method: 'percentile'
    }
  | { kind: 'clopper-pearson'; level: number }

export interface ComputedInterval {
  lower: number
  upper: number
  level: number
}

/** Shared by registration and direct execution so malformed intervals cannot produce evidence. */
export function intervalSpecProblems(spec: IntervalSpec): string[] {
  if (spec === null || typeof spec !== 'object' || Array.isArray(spec)) {
    return ['interval must be an object']
  }
  if (spec.kind !== 'cluster-bootstrap' && spec.kind !== 'clopper-pearson') {
    return ['interval kind must be cluster-bootstrap or clopper-pearson']
  }
  const problems: string[] = []
  if (!Number.isFinite(spec.level) || spec.level <= 0 || spec.level >= 1) {
    problems.push('level must be a finite number between zero and one')
  }
  if (spec.kind === 'cluster-bootstrap') {
    for (const field of ['clusterBy', 'value'] as const) {
      const path = spec[field]
      if (
        typeof path !== 'string' ||
        path.split('.').some((segment) => segment.length === 0 || segment.trim() !== segment)
      ) {
        problems.push(`${field} must be a nonempty dot-separated field path`)
      }
    }
    if (
      !Number.isSafeInteger(spec.resamples) ||
      spec.resamples < 1 ||
      spec.resamples > 0xffff_ffff
    ) {
      problems.push('resamples must be a positive integer within the supported array length')
    }
    if (!Number.isSafeInteger(spec.seed)) problems.push('seed must be a safe integer')
    if (spec.method !== 'percentile') problems.push('method must be percentile')
  }
  return problems
}

/**
 * Execute an interval spec.
 *
 * Cluster-bootstrap resamples whole clusters of its registered `value` field and
 * takes percentile bounds of the pooled mean. Clopper-Pearson computes the
 * exact binomial interval and requires `successes`/`trials` evidence instead
 * of rows.
 */
export function computeInterval(
  spec: IntervalSpec,
  evidence:
    | { kind: 'rows'; rows: readonly EvidenceRecord[] }
    | { kind: 'binomial'; successes: number; trials: number },
): ComputedInterval {
  const problems = intervalSpecProblems(spec)
  if (problems.length > 0) throw new ValidationError(`computeInterval: ${problems.join('; ')}`)
  if (evidence === null || typeof evidence !== 'object' || Array.isArray(evidence)) {
    throw new ValidationError('computeInterval: evidence must be an object')
  }
  if (spec.kind === 'cluster-bootstrap') {
    if (evidence.kind !== 'rows') {
      throw new ValidationError('computeInterval: cluster-bootstrap requires row evidence')
    }
    if ('value' in evidence) {
      throw new ValidationError(
        'computeInterval: register value in the interval spec, not row evidence',
      )
    }
    if (!Array.isArray(evidence.rows))
      throw new ValidationError('computeInterval: rows must be an array')
    const clusters = new Map<string, number[]>()
    for (const [index, row] of evidence.rows.entries()) {
      if (row === null || typeof row !== 'object' || Array.isArray(row)) {
        throw new ValidationError(`computeInterval: row ${index} must be an object`)
      }
      const cluster = readField(row, spec.clusterBy)
      if (
        !(typeof cluster === 'string' && cluster.length > 0 && cluster.trim() === cluster) &&
        !(typeof cluster === 'number' && Number.isFinite(cluster))
      ) {
        throw new ValidationError(
          `computeInterval: cluster field '${spec.clusterBy}' must be a nonempty string or finite number on row ${index}`,
        )
      }
      const clusterKey = `${typeof cluster}:${cluster}`
      const value = readNumericOutcome(
        readField(row, spec.value),
        'computeInterval cluster-bootstrap',
        spec.value,
        `cluster '${cluster}'`,
      )
      const bucket = clusters.get(clusterKey)
      if (bucket) bucket.push(value)
      else clusters.set(clusterKey, [value])
    }
    const clusterValues = [...clusters.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([, values]) => values)
    if (clusterValues.length < 2) {
      throw new ValidationError(
        `computeInterval: cluster-bootstrap needs >= 2 clusters, got ${clusterValues.length}`,
      )
    }
    const rng = mulberry32(spec.seed)
    const means = new Array<number>(spec.resamples)
    for (let draw = 0; draw < spec.resamples; draw++) {
      let sum = 0
      let count = 0
      for (let pick = 0; pick < clusterValues.length; pick++) {
        const cluster = clusterValues[Math.floor(rng() * clusterValues.length)]!
        for (const value of cluster) sum += value
        count += cluster.length
      }
      means[draw] = sum / count
      if (!Number.isFinite(means[draw])) {
        throw new ValidationError(
          'computeInterval: cluster mean overflowed the finite numeric range',
        )
      }
    }
    means.sort((a, b) => a - b)
    const alpha = 1 - spec.level
    const lowerIndex = Math.floor((alpha / 2) * spec.resamples)
    const upperIndex = Math.min(spec.resamples - 1, Math.ceil((1 - alpha / 2) * spec.resamples) - 1)
    return {
      lower: means[lowerIndex]!,
      upper: means[Math.max(lowerIndex, upperIndex)]!,
      level: spec.level,
    }
  }

  if (evidence.kind !== 'binomial') {
    throw new ValidationError('computeInterval: clopper-pearson requires binomial evidence')
  }
  const { successes, trials } = evidence
  if (
    !Number.isSafeInteger(successes) ||
    !Number.isSafeInteger(trials) ||
    trials <= 0 ||
    successes < 0
  ) {
    throw new ValidationError(
      `computeInterval: clopper-pearson needs 0 <= successes <= trials, got ${successes}/${trials}`,
    )
  }
  if (successes > trials) {
    throw new ValidationError(
      `computeInterval: clopper-pearson successes ${successes} exceed trials ${trials}`,
    )
  }
  const alpha = 1 - spec.level
  const lower = successes === 0 ? 0 : binomialQuantile(successes, trials, alpha / 2, 'lower')
  const upper = successes === trials ? 1 : binomialQuantile(successes, trials, alpha / 2, 'upper')
  return { lower, upper, level: spec.level }
}

/**
 * Clopper-Pearson bound by bisection on the binomial tail. The lower bound is
 * the p with P(X >= successes | p) = alpha; the upper is the p with
 * P(X <= successes | p) = alpha. Deterministic, no special functions.
 */
function binomialQuantile(
  successes: number,
  trials: number,
  alpha: number,
  side: 'lower' | 'upper',
): number {
  const tail = (p: number): number => {
    // log-space binomial pmf accumulation for numeric stability
    let sum = 0
    for (let k = 0; k <= trials; k++) {
      const inTail = side === 'lower' ? k >= successes : k <= successes
      if (!inTail) continue
      sum += Math.exp(logBinomialPmf(k, trials, p))
    }
    return sum
  }
  let lo = 0
  let hi = 1
  for (let iter = 0; iter < 100; iter++) {
    const mid = (lo + hi) / 2
    if (tail(mid) < alpha) {
      if (side === 'lower') lo = mid
      else hi = mid
    } else {
      if (side === 'lower') hi = mid
      else lo = mid
    }
  }
  return (lo + hi) / 2
}

function logBinomialPmf(k: number, n: number, p: number): number {
  if (p <= 0) return k === 0 ? 0 : Number.NEGATIVE_INFINITY
  if (p >= 1) return k === n ? 0 : Number.NEGATIVE_INFINITY
  return logChoose(n, k) + k * Math.log(p) + (n - k) * Math.log(1 - p)
}

function logChoose(n: number, k: number): number {
  return logFactorial(n) - logFactorial(k) - logFactorial(n - k)
}

const LOG_FACTORIAL_CACHE: number[] = [0]
function logFactorial(n: number): number {
  for (let i = LOG_FACTORIAL_CACHE.length; i <= n; i++) {
    LOG_FACTORIAL_CACHE[i] = LOG_FACTORIAL_CACHE[i - 1]! + Math.log(i)
  }
  return LOG_FACTORIAL_CACHE[n]!
}

// ── Conditions and decisions ─────────────────────────────────────────

/** Decision guards read only named derived quantities — never raw rows. */
export type Condition =
  | { kind: 'interval-excludes-zero'; interval: string; sign: 'positive' | 'negative' }
  | { kind: 'interval-includes-zero'; interval: string }
  | { kind: 'quantity-threshold'; quantity: string; op: 'gte' | 'lte' | 'gt' | 'lt'; value: number }
  | { kind: 'obligation-met'; obligation: string }
  | { kind: 'all'; of: Condition[] }
  | { kind: 'any'; of: Condition[] }
  | { kind: 'not'; of: Condition }

/** The named quantities a decision rule may read. Nothing else reaches it. */
export interface DerivedQuantities {
  intervals: Record<string, { lower: number; upper: number }>
  quantities: Record<string, number>
  obligationsMet: Record<string, boolean>
}

export function evaluateCondition(condition: Condition, evidence: DerivedQuantities): boolean {
  switch (condition.kind) {
    case 'interval-excludes-zero': {
      const interval = evidence.intervals[condition.interval]
      if (!interval) {
        throw new ValidationError(
          `evaluateCondition: interval '${condition.interval}' is not in the evidence`,
        )
      }
      const excludes = interval.lower > 0 || interval.upper < 0
      return excludes && (condition.sign === 'positive' ? interval.lower > 0 : interval.upper < 0)
    }
    case 'interval-includes-zero': {
      const interval = evidence.intervals[condition.interval]
      if (!interval) {
        throw new ValidationError(
          `evaluateCondition: interval '${condition.interval}' is not in the evidence`,
        )
      }
      return interval.lower <= 0 && interval.upper >= 0
    }
    case 'quantity-threshold': {
      const value = evidence.quantities[condition.quantity]
      if (value === undefined) {
        throw new ValidationError(
          `evaluateCondition: quantity '${condition.quantity}' is not in the evidence`,
        )
      }
      return compareValues(value, condition.op, condition.value)
    }
    case 'obligation-met':
      return evidence.obligationsMet[condition.obligation] === true
    case 'all':
      return condition.of.every((c) => evaluateCondition(c, evidence))
    case 'any':
      return condition.of.some((c) => evaluateCondition(c, evidence))
    case 'not':
      return !evaluateCondition(condition.of, evidence)
  }
}

export interface DecisionBranch {
  when: Condition
  verdict: string
  report: string[]
}

/**
 * Ordered decision table: the first branch whose condition holds fires, and a
 * table no branch matches throws — a non-total registration is a defect, not
 * an implicit verdict. `report-only` registers the ABSENCE of a verdict
 * branch: the estimate and the per-row table are the finding, and the
 * registered meaning prose rides as non-executable interpretation data.
 */
export type DecisionRule =
  | { kind: 'table'; branches: DecisionBranch[] }
  | {
      kind: 'report-only'
      estimands: string[]
      intervals: string[]
      perRow: string[]
      interpretation?: { onQualitative: string; consequence: string }[]
    }

export interface DecisionOutcome {
  verdict: string
  report: string[]
}

export function executeDecisionRule(
  rule: DecisionRule,
  evidence: DerivedQuantities,
): DecisionOutcome {
  if (rule.kind === 'report-only') {
    return { verdict: 'report-only', report: [...rule.estimands, ...rule.intervals] }
  }
  for (const branch of rule.branches) {
    if (evaluateCondition(branch.when, evidence)) {
      return { verdict: branch.verdict, report: branch.report }
    }
  }
  throw new DecisionTableNotTotalError(
    'executeDecisionRule: decision table is not total — no branch matched the evidence',
  )
}

/** A registered control that must exist before a class of verdicts is read. */
export interface Obligation {
  id: string
  appliesToVerdicts: string[]
  control: string
}

// ── Validity gates and halt ──────────────────────────────────────────

/** Pre-spend design checks. Each returns pass/fail plus its evidence. */
export type ValidityGate =
  | {
      kind: 'oracle-determinism'
      unit: 'suite' | 'assertion'
      replicates: number
      maxFlipRate: number
    }
  | {
      kind: 'population-reproducibility'
      joinOn: string
      compare: string[]
      maxChangedRows: number
    }
  | { kind: 'provenance-assertion'; claim: Predicate }
  | {
      kind: 'power-floor'
      target: number
      /** Minimum worthwhile effect; must be represented exactly in effectGrid. */
      minimumEffect: number
      effectGrid: number[]
      sim: { trials: number; resamples: number; seed: number }
    }
  | { kind: 'identity'; field: 'served-model'; op: 'basename-eq'; onFail: 'abort' }

export interface GateResult {
  id: string
  passed: boolean
  evidence: JsonValue
}

/**
 * Replicate-flip counting over graded states. A state whose replicates split
 * between pass and fail is flipping; its flip rate is the minority share.
 */
export function evaluateOracleDeterminismGate(
  id: string,
  gate: Extract<ValidityGate, { kind: 'oracle-determinism' }>,
  repsByState: Record<string, readonly boolean[]>,
): GateResult {
  const evidence: Record<string, JsonValue> = {}
  let passed = true
  for (const [state, reps] of Object.entries(repsByState)) {
    const passes = reps.filter(Boolean).length
    const flipRate = reps.length === 0 ? 0 : Math.min(passes, reps.length - passes) / reps.length
    evidence[state] = { passes, replicates: reps.length, flipRate }
    if (flipRate > gate.maxFlipRate) passed = false
  }
  return { id, passed, evidence }
}

/**
 * Join two population snapshots on `joinOn` and compare the registered fields.
 * Only rows present in both snapshots are compared; a presence change is a
 * different failure and needs its own gate.
 */
export function evaluatePopulationReproducibilityGate(
  id: string,
  gate: Extract<ValidityGate, { kind: 'population-reproducibility' }>,
  populations: { left: readonly EvidenceRecord[]; right: readonly EvidenceRecord[] },
): GateResult {
  const rightByKey = new Map(populations.right.map((r) => [String(readField(r, gate.joinOn)), r]))
  const changed: string[] = []
  for (const left of populations.left) {
    const key = String(readField(left, gate.joinOn))
    const right = rightByKey.get(key)
    if (!right) continue
    const moved = gate.compare.filter((f) => readField(left, f) !== readField(right, f))
    if (moved.length > 0) {
      changed.push(
        `${key} ${moved.map((f) => `${f}:${String(readField(left, f))}->${String(readField(right, f))}`).join(' ')}`,
      )
    }
  }
  return { id, passed: changed.length <= gate.maxChangedRows, evidence: changed }
}

/** The registered claim about provenance must hold on the provenance record. */
export function evaluateProvenanceGate(
  id: string,
  gate: Extract<ValidityGate, { kind: 'provenance-assertion' }>,
  provenance: EvidenceRecord,
): GateResult {
  const passed = evaluatePredicate(gate.claim, provenance)
  return { id, passed, evidence: { claimHolds: passed } }
}

/** Final path segment equality between the pinned and the served identity. */
export function evaluateIdentityGate(
  id: string,
  _gate: Extract<ValidityGate, { kind: 'identity' }>,
  identities: { pinned: string; served: string },
): GateResult {
  const basename = (s: string): string => s.split('/').pop() ?? s
  const passed = basename(identities.pinned) === basename(identities.served)
  return {
    id,
    passed,
    evidence: { pinned: identities.pinned, served: identities.served, matched: passed },
  }
}

/**
 * The design's power at minimumEffect must reach the registered target.
 * The curve must cover the registered effect grid exactly — a curve
 * computed on a different grid is different evidence and is refused.
 */
export function evaluatePowerFloorGate(
  id: string,
  gate: Extract<ValidityGate, { kind: 'power-floor' }>,
  curve: readonly { effect: number; power: number }[],
): GateResult {
  const problems = powerFloorProblems(gate)
  if (problems.length > 0) {
    throw new ValidationError(`evaluatePowerFloorGate: ${problems.join('; ')}`)
  }
  if (curve.some((point) => !Number.isFinite(point.power) || point.power < 0 || point.power > 1)) {
    throw new ValidationError('evaluatePowerFloorGate: powers must be finite and in [0,1]')
  }
  const byEffect = new Map(curve.map((point) => [point.effect, point.power]))
  if (byEffect.size !== curve.length) {
    throw new ValidationError('evaluatePowerFloorGate: curve contains duplicate effects')
  }
  const missing = gate.effectGrid.filter((effect) => !byEffect.has(effect))
  if (missing.length > 0) {
    throw new ValidationError(
      `evaluatePowerFloorGate: curve does not cover registered effects [${missing.join(', ')}]`,
    )
  }
  const extra = curve.filter((point) => !gate.effectGrid.includes(point.effect))
  if (extra.length > 0) {
    throw new ValidationError(
      `evaluatePowerFloorGate: curve contains unregistered effects [${extra.map((point) => point.effect).join(', ')}]`,
    )
  }
  const powers = gate.effectGrid.map((effect) => byEffect.get(effect)!)
  const maxPower = Math.max(...powers)
  const powerAtMinimumEffect = byEffect.get(gate.minimumEffect)!
  return {
    id,
    passed: powerAtMinimumEffect >= gate.target,
    evidence: {
      target: gate.target,
      minimumEffect: gate.minimumEffect,
      powerAtMinimumEffect,
      maxPower,
      curve: gate.effectGrid.map((effect) => ({ effect, power: byEffect.get(effect)! })),
    },
  }
}

/** Shared by seal validation and direct execution; malformed designs never pass. */
export function powerFloorProblems(gate: Extract<ValidityGate, { kind: 'power-floor' }>): string[] {
  const problems: string[] = []
  if (!Number.isFinite(gate.target) || gate.target <= 0 || gate.target > 1) {
    problems.push('power target must be in (0,1]')
  }
  if (!Number.isFinite(gate.minimumEffect) || gate.minimumEffect <= 0) {
    problems.push('minimumEffect must be positive and finite')
  }
  if (gate.effectGrid.length === 0 || gate.effectGrid.some((effect) => !Number.isFinite(effect))) {
    problems.push('effectGrid must contain finite effects')
  }
  if (new Set(gate.effectGrid).size !== gate.effectGrid.length) {
    problems.push('effectGrid contains duplicate effects')
  }
  if (!gate.effectGrid.includes(gate.minimumEffect)) {
    problems.push('effectGrid must contain minimumEffect exactly; no interpolation is assumed')
  }
  for (const field of ['trials', 'resamples'] as const) {
    if (!Number.isInteger(gate.sim[field]) || gate.sim[field] <= 0) {
      problems.push(`power simulation ${field} must be a positive integer`)
    }
  }
  if (!Number.isInteger(gate.sim.seed)) problems.push('power simulation seed must be an integer')
  return problems
}

/** Checks as prerequisites: any named gate failing refuses the spend. */
export interface HaltRule {
  when: { kind: 'any-gate-failed'; gates: string[] }
  action: 'refuse-spend'
  report: 'settling-n'
}

export interface HaltOutcome {
  fired: boolean
  action: 'refuse-spend' | null
  failedGates: string[]
}

export function evaluateHaltRule(halt: HaltRule, gates: readonly GateResult[]): HaltOutcome {
  const seen = new Map(gates.map((g) => [g.id, g]))
  const missing = halt.when.gates.filter((id) => !seen.has(id))
  if (missing.length > 0) {
    throw new ValidationError(
      `evaluateHaltRule: halt references gates that were not evaluated: [${missing.join(', ')}]`,
    )
  }
  const failed = halt.when.gates.filter((id) => !seen.get(id)!.passed)
  return failed.length > 0
    ? { fired: true, action: halt.action, failedGates: failed }
    : { fired: false, action: null, failedGates: [] }
}

// ── Budget rules ─────────────────────────────────────────────────────

/**
 * Spend schedules as data. `ledger` names every entry the ceiling counts, so
 * what the gate reads is registered, not improvised at gate time.
 */
export type BudgetRule =
  | {
      kind: 'uniform-pass'
      ceilingUsd: number
      maxPasses: number
      projection: 'last-pass-cost'
      costSource: 'priced-per-call'
      ledger: { id: string; usd: number }[]
      partialPass: 'report-never-lift'
    }
  | {
      kind: 'n-ladder'
      steps: number[]
      ceilingUsd: number
      projection: 'unit-cost-times-rows-times-n'
      onExhaust: 'refuse-report-projection'
    }

export interface UniformPassDecision {
  pass: number
  cumulativeBefore: number
  projected: number
  go: boolean
}

export interface UniformPassSchedule {
  decisions: UniformPassDecision[]
  uniformN: number
}

/**
 * Execute the uniform-pass schedule against measured pass costs. Pass 1 always
 * runs; each later pass runs only when the cumulative spend plus the last
 * measured pass cost stays at or under the registered ceiling. The registered
 * ledger is the pre-spend the ceiling counts.
 */
export function runUniformPassBudget(
  rule: Extract<BudgetRule, { kind: 'uniform-pass' }>,
  measuredPassCosts: readonly number[],
): UniformPassSchedule {
  const preSpend = rule.ledger.reduce((sum, entry) => sum + entry.usd, 0)
  let cumulative = preSpend
  const decisions: UniformPassDecision[] = []
  let uniformN = 0
  for (let pass = 1; pass <= rule.maxPasses; pass++) {
    if (pass === 1) {
      if (measuredPassCosts[0] === undefined) break
      cumulative += measuredPassCosts[0]
      uniformN = 1
      continue
    }
    const projected = measuredPassCosts[pass - 2]
    if (projected === undefined) break
    const go = cumulative + projected <= rule.ceilingUsd
    decisions.push({ pass, cumulativeBefore: cumulative, projected, go })
    if (!go || measuredPassCosts[pass - 1] === undefined) break
    cumulative += measuredPassCosts[pass - 1]!
    uniformN = pass
  }
  return { decisions, uniformN }
}

export interface NLadderProjection {
  chosenN: number | null
  projections: { n: number; projectedUsd: number; affordable: boolean }[]
  refusal: null | { onExhaust: 'refuse-report-projection'; reason: string }
}

/**
 * Walk the registered n-ladder and pick the first affordable step. When no
 * step fits the ceiling, the rule refuses and reports the projection instead
 * of shrinking the row set — "never subset rows" is the registered invariant.
 */
export function projectNLadderBudget(
  rule: Extract<BudgetRule, { kind: 'n-ladder' }>,
  measured: { unitCostUsd: number; rows: number },
): NLadderProjection {
  const projections = rule.steps.map((n) => {
    const projectedUsd = measured.unitCostUsd * measured.rows * n
    return { n, projectedUsd, affordable: projectedUsd <= rule.ceilingUsd }
  })
  const first = projections.find((p) => p.affordable)
  if (first) return { chosenN: first.n, projections, refusal: null }
  return {
    chosenN: null,
    projections,
    refusal: {
      onExhaust: rule.onExhaust,
      reason: `no ladder step fits the ${rule.ceilingUsd} USD ceiling at ${measured.rows} rows x ${measured.unitCostUsd} USD per unit`,
    },
  }
}

// ── Matched budget and reissue ───────────────────────────────────────

/** Arm budget matching as a refusal, not prose. Verified by `verifyMatchedBudgets`. */
export interface MatchedBudgetRule {
  measure: 'realized-tokens'
  tolerance: number
  onFail: 'refuse-contrast'
}

/** Carrier faults are reissued; model outcomes stand. Closed enumeration. */
export interface ReissuePolicy {
  carrierEvents: ('http-status' | 'transport-error' | 'deadline' | 'empty-content')[]
  modelOutcomesStand: true
  maxIssues: number
}

export type ReissueVerdict = 'reissue' | 'stands' | 'exhausted'

/**
 * Classify one rollout event under the registered reissue policy. A carrier
 * event within the issue budget is reissued; a model outcome always stands;
 * a carrier event past `maxIssues` is exhausted and reported, never retried.
 */
export function classifyReissue(
  policy: ReissuePolicy,
  event: string,
  issuesSoFar: number,
): ReissueVerdict {
  if (!(policy.carrierEvents as string[]).includes(event)) return 'stands'
  return issuesSoFar < policy.maxIssues ? 'reissue' : 'exhausted'
}
