/** Validate and freeze every input and identity before an exact analyst run starts. */
import { z } from 'zod'
import type { CostLedgerHandle } from '../cost-ledger'
import { snapshotAnalystFindings } from '../feedback-trajectory-review'
import { hashCanonical } from '../ledger-core/canonical'
import { deepFreezeCanonicalJson } from '../ledger-core/deep-freeze'
import type { ChatClient } from './chat-client'
import type {
  ExactAnalystExecutionPlanSnapshot,
  ExactCapableAnalyst,
  ExactExecutionComponentIdentity,
  ExactExecutionComponentSnapshot,
} from './exact-types'
import { snapshotExactExecutionComponentIdentity, snapshotExactExecutionPlan } from './exact-types'
import type {
  AnalystExecutionPlan,
  AnalystHooks,
  AnalystRegistryOptions,
  ExactAnalystBudgetPolicy,
  ExactRegistryRunOpts,
} from './registry-plan'
import { routeInput } from './registry-plan'
import { canonicalJsonSnapshot, isPlainRecord, readOwnFields } from './registry-snapshot'
import type { Analyst, AnalystFinding, AnalystRunInputs } from './types'
import { validateUsageSettlementTimeout } from './usage-receipt'

export function normalizeExactPlan(
  runId: string,
  inputs: AnalystRunInputs,
  runOpts: ExactRegistryRunOpts,
  analysts: ReadonlyMap<string, Analyst>,
  options: AnalystRegistryOptions,
): AnalystExecutionPlan {
  const exactRunId = snapshotExactRunId(runId)
  const exact = snapshotExactRegistryRunOpts(runOpts)
  const selected = normalizeExactAnalysts(selectExactAnalysts(analysts, exact.analystIds))
  const registryChat = options.chat
  const registryChatIdentity = options.chatIdentity
  const registryHooks = options.hooks
  const registryHooksIdentity = options.hooksIdentity
  if (exact.useRegistryChat && registryChat === undefined) {
    throw new TypeError(
      'ExactRegistryRunOpts.useRegistryChat is true but the registry has no chat client',
    )
  }
  if (exact.applyRegistryHooks && !hasRegistryHooks(registryHooks)) {
    throw new TypeError(
      'ExactRegistryRunOpts.applyRegistryHooks is true but the registry has no lifecycle hooks',
    )
  }
  const inputSnapshot = snapshotAnalystRunInputChannels(inputs)
  const prepared = selected.map((analyst) => ({
    analyst,
    input: routeInput(analyst, inputSnapshot),
  }))
  if (exact.missingInputMode === 'abort') {
    const missing = prepared.find((candidate) => candidate.input.kind === 'missing')?.analyst
    if (missing) {
      throw new TypeError(
        `ExactRegistryRunOpts.missingInputMode abort preflight found no "${missing.inputKind}" input for "${missing.id}"`,
      )
    }
  }
  const hooksIdentity =
    exact.applyRegistryHooks && registryHooks
      ? requireExactComponentIdentity(registryHooksIdentity, 'registry hooks')
      : null
  const chatIdentity = exact.useRegistryChat
    ? requireExactComponentIdentity(registryChatIdentity, 'registry chat')
    : null
  const costLedgerIdentity =
    exact.costLedger === null
      ? null
      : requireExactComponentIdentity(exact.costLedgerIdentity ?? undefined, 'cost ledger')
  const allocations = exactFixedBudgets(
    exact.budget,
    prepared
      .filter(
        (
          candidate,
        ): candidate is {
          analyst: ExactCapableAnalyst
          input: { kind: 'present'; value: unknown }
        } => candidate.input.kind === 'present',
      )
      .map((candidate) => candidate.analyst),
    selected,
  )
  const executionSnapshot = exactExecutionSnapshot(
    selected,
    exact,
    allocations,
    costLedgerIdentity,
    hooksIdentity,
    chatIdentity,
  )
  return {
    runId: exactRunId,
    prepared,
    budget: { kind: 'none' },
    totalTimeoutMs: exact.totalTimeoutMs,
    signal: exact.signal,
    costLedger: exact.costLedger,
    costPhase: exact.costPhase,
    tags: exact.tags,
    priorFindings: exact.priorFindings,
    chainFindings: exact.chainFindings,
    hooks: exact.applyRegistryHooks && registryHooks ? snapshotHooks(registryHooks) : {},
    chat: exact.useRegistryChat && registryChat ? snapshotChat(registryChat) : undefined,
    // Exact runs expose live events and versioned hooks. An inherited logger is intentionally
    // excluded because an anonymous callback can throw, block, or mutate shared state.
    log: () => {},
    executionSnapshot,
  }
}

function selectExactAnalysts(
  analysts: ReadonlyMap<string, Analyst>,
  ids: readonly string[],
): ReadonlyArray<{ readonly registeredId: string; readonly analyst: Analyst }> {
  return ids.map((id) => {
    const analyst = analysts.get(id)
    if (!analyst) throw new Error(`ExactRegistryRunOpts.analystIds names unknown analyst "${id}"`)
    return { registeredId: id, analyst }
  })
}

const exactRunFields = [
  'analystIds',
  'budget',
  'totalTimeoutMs',
  'signal',
  'costLedger',
  'costLedgerIdentity',
  'costPhase',
  'tags',
  'priorFindings',
  'chainFindings',
  'missingInputMode',
  'applyRegistryHooks',
  'useRegistryChat',
] as const

const exactNonEmptyString = z.string().min(1)
const exactFiniteNonnegative = z.number().finite().nonnegative()
const exactBudgetSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('equal'),
    totalUsd: exactFiniteNonnegative,
  }),
  z.strictObject({
    kind: z.literal('weighted'),
    totalUsd: exactFiniteNonnegative,
    weights: z.record(exactNonEmptyString, exactFiniteNonnegative),
  }),
])
const exactRunDataSchema = z
  .strictObject({
    analystIds: z.array(exactNonEmptyString).min(1),
    budget: exactBudgetSchema.nullable(),
    totalTimeoutMs: z.number().int().positive().max(2_147_483_647).nullable(),
    costLedgerIdentity: z.unknown().nullable(),
    costPhase: exactNonEmptyString.nullable(),
    tags: z.record(z.string(), z.string()).nullable(),
    chainFindings: z.boolean(),
    missingInputMode: z.enum(['skip', 'abort']),
    applyRegistryHooks: z.boolean(),
    useRegistryChat: z.boolean(),
  })
  .superRefine((policy, context) => {
    const issue = (path: PropertyKey[], message: string): void =>
      context.addIssue({ code: 'custom', path, message })
    if (new Set(policy.analystIds).size !== policy.analystIds.length) {
      issue(['analystIds'], 'must not contain duplicates')
    }
    if (
      policy.budget?.kind === 'weighted' &&
      Object.values(policy.budget.weights).every((weight) => weight === 0)
    ) {
      issue(['budget', 'weights'], 'must allocate positive weight to at least one analyst')
    }
    if (policy.budget?.kind === 'weighted') {
      const selected = [...policy.analystIds].sort()
      const weighted = Object.keys(policy.budget.weights).sort()
      if (
        selected.length !== weighted.length ||
        selected.some((id, index) => id !== weighted[index])
      ) {
        issue(['budget', 'weights'], 'must name every selected analyst and no others')
      }
    }
  })

function snapshotExactRunId(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError('AnalystRegistry.runExact: runId must be a non-empty string')
  }
  return canonicalJsonSnapshot(value, 'AnalystRegistry.runExact runId')
}

function snapshotAnalystRunInputChannels(inputs: AnalystRunInputs): AnalystRunInputs {
  if (!inputs || typeof inputs !== 'object' || Array.isArray(inputs)) {
    throw new TypeError('AnalystRegistry.runExact: inputs must be an object')
  }
  const traceStore = inputs.traceStore
  const artifactDir = inputs.artifactDir
  const runRecord = inputs.runRecord
  const judgeInput = inputs.judgeInput
  const custom = inputs.custom
  return Object.freeze({
    traceStore,
    artifactDir,
    runRecord,
    judgeInput,
    custom,
  })
}

/**
 * Read the untrusted caller object once, then validate and execute only this frozen snapshot.
 * Functions and resource handles retain identity; all data fields are copied canonically.
 */
function snapshotExactRegistryRunOpts(value: unknown): ExactRegistryRunOpts {
  const captured = readOwnFields(value, exactRunFields, 'ExactRegistryRunOpts')
  const missing = exactRunFields.find((field) => !Object.hasOwn(captured, field))
  if (missing) {
    throw new TypeError(`ExactRegistryRunOpts.${missing} must be supplied explicitly`)
  }
  const { signal, costLedger, priorFindings, ...rawData } = captured
  const data = canonicalJsonSnapshot(rawData, 'ExactRegistryRunOpts')
  const parsed = exactRunDataSchema.safeParse(data)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    if (issue?.code === 'unrecognized_keys' && issue.path.join('.') === 'budget') {
      const required =
        isPlainRecord(data.budget) && data.budget.kind === 'weighted'
          ? 'kind, totalUsd, weights'
          : 'kind, totalUsd'
      throw new TypeError(`ExactRegistryRunOpts.budget must contain exactly ${required}`)
    }
    const path = issue?.path.length ? `.${issue.path.join('.')}` : ''
    throw new TypeError(`ExactRegistryRunOpts${path}: ${issue?.message ?? 'is invalid'}`)
  }
  if (
    signal !== null &&
    (!signal ||
      typeof signal !== 'object' ||
      typeof (signal as AbortSignal).addEventListener !== 'function')
  ) {
    throw new TypeError('ExactRegistryRunOpts.signal must be an AbortSignal or null')
  }
  if (costLedger !== null && (!costLedger || typeof costLedger !== 'object')) {
    throw new TypeError('ExactRegistryRunOpts.costLedger must be a CostLedgerHandle or null')
  }
  if (costLedger === null && parsed.data.costLedgerIdentity !== null) {
    throw new TypeError('ExactRegistryRunOpts.costLedgerIdentity must be null without costLedger')
  }
  if (costLedger !== null && parsed.data.costLedgerIdentity === null) {
    throw new TypeError('ExactRegistryRunOpts.costLedgerIdentity is required with costLedger')
  }
  if (costLedger === null && parsed.data.costPhase !== null) {
    throw new TypeError('ExactRegistryRunOpts.costPhase requires a non-null costLedger')
  }
  return Object.freeze({
    ...deepFreezeCanonicalJson(parsed.data),
    signal: signal as AbortSignal | null,
    costLedger: costLedger as CostLedgerHandle | null,
    priorFindings: snapshotExactPriorFindings(priorFindings),
  }) as ExactRegistryRunOpts
}

function snapshotExactPriorFindings(value: unknown): ExactRegistryRunOpts['priorFindings'] {
  if (value === null) return null
  if (Array.isArray(value)) {
    return snapshotAnalystFindings(value, 'ExactRegistryRunOpts.priorFindings')
  }
  if (!isPlainRecord(value)) {
    throw new TypeError(
      'ExactRegistryRunOpts.priorFindings must be an array, a findings record, or null',
    )
  }
  const result: Record<string, ReadonlyArray<AnalystFinding>> = {}
  for (const [key, findings] of Object.entries(value)) {
    if (!Array.isArray(findings)) {
      throw new TypeError(`ExactRegistryRunOpts.priorFindings.${key} must be an array`)
    }
    result[key] = snapshotAnalystFindings(findings, `ExactRegistryRunOpts.priorFindings.${key}`)
  }
  return deepFreezeCanonicalJson(result)
}

function normalizeExactAnalysts(
  selections: ReadonlyArray<{ readonly registeredId: string; readonly analyst: Analyst }>,
): ExactCapableAnalyst[] {
  return selections.map(({ registeredId, analyst }) => {
    const exactAnalyst = analyst as Analyst & {
      readonly executionConfig?: Readonly<Record<string, unknown>>
    }
    const id = analyst.id
    const description = analyst.description
    const inputKind = analyst.inputKind
    const rawCostValue = analyst.cost
    const requiresValue = analyst.requires
    const version = analyst.version
    const executionConfigValue = exactAnalyst.executionConfig
    const analyzeValue = analyst.analyze
    if (id !== registeredId) {
      throw new TypeError(
        `AnalystRegistry.runExact: registered analyst "${registeredId}" changed id to "${id}"`,
      )
    }
    if (executionConfigValue === undefined) {
      throw new TypeError(`AnalystRegistry.runExact: analyst "${id}" must declare executionConfig`)
    }
    const executionConfig = canonicalJsonSnapshot(
      executionConfigValue,
      `AnalystRegistry.runExact analyst "${id}" executionConfig`,
    )
    if (!isPlainRecord(executionConfig)) {
      throw new TypeError(
        `AnalystRegistry.runExact analyst "${id}" executionConfig must be an object`,
      )
    }
    const rawCost = canonicalJsonSnapshot(
      rawCostValue,
      `AnalystRegistry.runExact analyst "${id}" cost`,
    )
    const cost =
      rawCost.kind === 'llm'
        ? Object.freeze({
            ...rawCost,
            settlement_timeout_ms: validateUsageSettlementTimeout(rawCost.settlement_timeout_ms),
          })
        : rawCost
    const requires =
      requiresValue === undefined
        ? undefined
        : canonicalJsonSnapshot(
            requiresValue,
            `AnalystRegistry.runExact analyst "${id}" requirements`,
          )
    const analyze = analyzeValue.bind(analyst)
    return Object.freeze({
      id,
      description,
      inputKind,
      cost,
      ...(requires === undefined ? {} : { requires }),
      version,
      executionConfig,
      analyze,
    }) satisfies ExactCapableAnalyst
  })
}

function hasRegistryHooks(hooks: AnalystHooks | undefined): hooks is AnalystHooks {
  return Boolean(
    hooks && (hooks.onBeforeAnalyze || hooks.onAfterAnalyze || hooks.onError || hooks.onComplete),
  )
}

function snapshotHooks(hooks: AnalystHooks): AnalystHooks {
  const onBeforeAnalyze = hooks.onBeforeAnalyze
  const onAfterAnalyze = hooks.onAfterAnalyze
  const onError = hooks.onError
  const onComplete = hooks.onComplete
  return Object.freeze({
    ...(onBeforeAnalyze === undefined ? {} : { onBeforeAnalyze: onBeforeAnalyze.bind(hooks) }),
    ...(onAfterAnalyze === undefined ? {} : { onAfterAnalyze: onAfterAnalyze.bind(hooks) }),
    ...(onError === undefined ? {} : { onError: onError.bind(hooks) }),
    ...(onComplete === undefined ? {} : { onComplete: onComplete.bind(hooks) }),
  })
}

function snapshotChat(chat: ChatClient): ChatClient {
  const transport = chat.transport
  const defaultModel = chat.defaultModel
  const maximumAttempts = chat.maximumAttempts
  const call = chat.chat
  return Object.freeze({
    transport,
    ...(defaultModel === undefined ? {} : { defaultModel }),
    ...(maximumAttempts === undefined ? {} : { maximumAttempts }),
    chat: call.bind(chat),
  })
}

function requireExactComponentIdentity(
  value: ExactExecutionComponentIdentity | undefined,
  label: string,
): ExactExecutionComponentSnapshot {
  if (value === undefined) {
    throw new TypeError(`AnalystRegistry.runExact: ${label} requires a versioned identity`)
  }
  return snapshotExactExecutionComponentIdentity(
    value,
    `AnalystRegistry.runExact ${label} identity`,
  )
}

function exactExecutionSnapshot(
  analysts: readonly ExactCapableAnalyst[],
  opts: ExactRegistryRunOpts,
  allocations: Readonly<Record<string, number | null>>,
  costLedger: ExactExecutionComponentSnapshot | null,
  hooks: ExactExecutionComponentSnapshot | null,
  chat: ExactExecutionComponentSnapshot | null,
): ExactAnalystExecutionPlanSnapshot {
  const priorFindings = exactPriorFindingsSnapshot(opts.priorFindings)
  const budget =
    opts.budget === null
      ? ({ kind: 'none' } as const)
      : opts.budget.kind === 'equal'
        ? ({
            kind: 'equal',
            total_usd: opts.budget.totalUsd,
            allocations_usd: { ...allocations },
          } as const)
        : ({
            kind: 'weighted',
            total_usd: opts.budget.totalUsd,
            weights: { ...opts.budget.weights },
            allocations_usd: { ...allocations },
          } as const)
  const material = {
    schema_version: '1.0.0' as const,
    analysts: analysts.map((analyst) => ({
      id: analyst.id,
      version: analyst.version,
      input_kind: analyst.inputKind,
      cost: analyst.cost,
      requirements: analyst.requires ?? null,
      execution_config_digest: hashCanonical(analyst.executionConfig),
    })),
    policy: {
      budget,
      total_timeout_ms: opts.totalTimeoutMs,
      signal_provided: opts.signal !== null,
      cost_ledger: costLedger,
      cost_phase: opts.costPhase,
      tags: opts.tags === null ? null : { ...opts.tags },
      prior_findings: priorFindings,
      chain_findings: opts.chainFindings,
      missing_input_mode: opts.missingInputMode,
      registry_hooks: hooks,
      registry_chat: chat,
    },
  }
  return snapshotExactExecutionPlan(
    { ...material, digest: hashCanonical(material) },
    'AnalystRegistry.runExact execution plan',
  )
}

function exactPriorFindingsSnapshot(
  findings: ExactRegistryRunOpts['priorFindings'],
): ExactAnalystExecutionPlanSnapshot['policy']['prior_findings'] {
  if (findings === null) return { kind: 'none' }
  if (Array.isArray(findings)) {
    return {
      kind: 'ordered',
      count: findings.length,
      digest: hashCanonical(findings),
    }
  }
  const record = findings as Readonly<Record<string, ReadonlyArray<AnalystFinding>>>
  const keys = Object.keys(record).sort()
  return {
    kind: 'by_analyst',
    keys,
    count: keys.reduce((sum, key) => sum + (record[key]?.length ?? 0), 0),
    digest: hashCanonical(record),
  }
}

function exactFixedBudgets(
  exact: ExactAnalystBudgetPolicy | null,
  runnable: readonly Analyst[],
  selected: readonly Analyst[],
): Readonly<Record<string, number | null>> {
  if (exact === null) return {}
  const allocations: Record<string, number | null> = Object.fromEntries(
    selected.map((analyst) => [analyst.id, null]),
  )
  if (runnable.length === 0) return deepFreezeCanonicalJson(allocations)
  if (exact.kind === 'equal') {
    const each = exact.totalUsd / runnable.length
    for (const analyst of runnable) allocations[analyst.id] = each
    return deepFreezeCanonicalJson(allocations)
  }
  const totalWeight = runnable.reduce((sum, analyst) => sum + exact.weights[analyst.id]!, 0)
  if (totalWeight === 0) {
    throw new Error(
      'ExactRegistryRunOpts weighted budget must allocate positive weight to a runnable analyst',
    )
  }
  for (const analyst of runnable) {
    allocations[analyst.id] = (exact.totalUsd * exact.weights[analyst.id]!) / totalWeight
  }
  return deepFreezeCanonicalJson(allocations)
}
