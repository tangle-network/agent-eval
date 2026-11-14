import { hashCanonical } from '../ledger-core/canonical'
import { deepFreezeCanonicalJson } from '../ledger-core/deep-freeze'
import type { RunSplitTag } from '../run-record'
import type { StrategyChecker } from '../verification-strategy'
import { type BenchmarkDefinition, benchmarkDefinitionDigest, defineBenchmark } from './definition'
import {
  type BenchmarkResult,
  benchmarkResult,
  benchmarkResultEvidenceDigest,
  defineBenchmarkResult,
} from './result'
import type { BenchmarkAdapter, BenchmarkDatasetItem, BenchmarkEvaluation } from './types'

export interface NativeBenchmarkOptions<TPayload, TArtifact> {
  definition: BenchmarkDefinition
  /** Pins the adapter, normalization and artifact-digest implementation. */
  implementationRef: string
  load: () => Promise<BenchmarkDatasetItem<TPayload>[]>
  checker: StrategyChecker<
    { item: BenchmarkDatasetItem<TPayload>; artifact: TArtifact },
    BenchmarkEvaluation & { passed: boolean }
  >
  /** Preserve native splits. Rows without a split require this explicit policy. */
  assignSplit?: (itemId: string) => RunSplitTag
  /** Defaults to hashing the JSON value. Files/path artifacts must hash their actual bytes here. */
  artifactDigest?: (artifact: TArtifact) => string | Promise<string>
  family?: string
  taskKind?: string
}

export interface NativeBenchmarkAdapter<TPayload, TArtifact>
  extends BenchmarkAdapter<BenchmarkDatasetItem<TPayload>, TPayload, TArtifact> {
  definition: BenchmarkDefinition
  evaluationRef: string
  loadAll(): Promise<BenchmarkDatasetItem<TPayload>[]>
  evaluateResult(
    item: BenchmarkDatasetItem<TPayload>,
    artifact: TArtifact,
  ): Promise<BenchmarkResult>
}

/**
 * Bind an existing native grader without replacing its protocol. The checker explicitly projects
 * native scores into [0, 1], returns pass/fail separately, and retains native measurements in raw.
 * Execution, hidden-reference staging, model transport and spend remain the caller's responsibility.
 */
export function createNativeBenchmarkAdapter<TPayload, TArtifact>(
  options: NativeBenchmarkOptions<TPayload, TArtifact>,
): NativeBenchmarkAdapter<TPayload, TArtifact> {
  const definition = defineBenchmark(options.definition)
  const definitionDigest = benchmarkDefinitionDigest(definition)
  if (!options.implementationRef.trim())
    throw new Error('native benchmark requires an implementationRef')
  const evaluationRef = hashCanonical({
    definitionDigest,
    implementationRef: options.implementationRef,
  })
  const checker = options.checker
  const checkIdentity = () => {
    if (
      checker.strategy !== definition.verification.strategy ||
      hashCanonical(checker.identity) !== hashCanonical(definition.verification.checker)
    ) {
      throw new Error('native benchmark checker does not match its definition')
    }
  }
  checkIdentity()
  const load = options.load
  const splitPolicy = options.assignSplit
  const digestArtifact = options.artifactDigest ?? hashCanonical
  const roster = new Set(definition.taskIds)
  const admitted = new Map<string, { item: BenchmarkDatasetItem<TPayload>; digest: string }>()
  let snapshot: Promise<BenchmarkDatasetItem<TPayload>[]> | undefined
  const loadAll = async (): Promise<BenchmarkDatasetItem<TPayload>[]> => {
    snapshot ??= (async () => {
      const items = await load()
      const ids = new Set(items.map((item) => item.id))
      if (
        ids.size !== items.length ||
        ids.size !== roster.size ||
        [...ids].some((id) => !roster.has(id))
      ) {
        throw new Error(
          `native benchmark ${definition.id}: loaded task roster differs from its definition`,
        )
      }
      const result = items.map((item) => {
        if (
          item.source?.revision !== undefined &&
          item.source.revision !== definition.source.revision
        ) {
          throw new Error(
            `native benchmark ${definition.id}: source revision mismatch for ${item.id}`,
          )
        }
        const split = item.split ?? splitPolicy?.(item.id)
        if (!split || !['search', 'dev', 'holdout'].includes(split)) {
          throw new Error(
            `native benchmark ${definition.id}: no explicit valid split for ${item.id}`,
          )
        }
        const value = { ...item, source: item.source ?? definition.source, split }
        const digest = hashCanonical(value)
        const frozen = deepFreezeCanonicalJson(structuredClone(value))
        admitted.set(item.id, { item: frozen, digest })
        return frozen
      })
      return result
    })()
    return [...(await snapshot)]
  }
  const evaluateResult = async (item: BenchmarkDatasetItem<TPayload>, artifact: TArtifact) => {
    await loadAll()
    if (admitted.get(item.id)?.digest !== hashCanonical(item)) {
      throw new Error(
        `native benchmark ${definition.id}: item differs from the admitted task snapshot: ${item.id}`,
      )
    }
    checkIdentity()
    const artifactDigest = await digestArtifact(artifact)
    if (!/^sha256:[0-9a-f]{64}$/.test(artifactDigest))
      throw new Error('native benchmark artifact digest must be sha256')
    const outcome = await checker.check({ item: admitted.get(item.id)!.item, artifact })
    if (!outcome.succeeded)
      throw new Error(`${definition.id} ${item.id}: native checker failed: ${outcome.error}`)
    if ((await digestArtifact(artifact)) !== artifactDigest) {
      throw new Error(`${definition.id} ${item.id}: artifact changed during verification`)
    }
    const result = outcome.value
    if (
      !result.raw ||
      typeof result.raw !== 'object' ||
      Array.isArray(result.raw) ||
      Object.keys(result.raw).length === 0
    ) {
      throw new Error(
        `${definition.id} ${item.id}: native checker must retain raw measurement evidence`,
      )
    }
    const { certification, ...measurement } = result
    const receipt = benchmarkResult({
      definition,
      taskId: item.id,
      artifactDigest,
      evaluation: {
        ...measurement,
        raw: {
          measurement: result.raw,
          binding: { definitionDigest, taskId: item.id, artifactDigest, evaluationRef },
        },
      },
    })
    // A native attestation with another scope belongs in raw, not in this receipt's certificate.
    receipt.evaluation.certification = certification ?? {
      strategy: checker.strategy,
      checker: structuredClone(checker.identity),
      assumptions: [...definition.verification.assumptions],
      evidenceDigest: benchmarkResultEvidenceDigest(receipt),
    }
    return deepFreezeCanonicalJson(defineBenchmarkResult(receipt, definition))
  }
  return {
    id: definition.id,
    definition,
    evaluationRef,
    source: definition.source,
    family: options.family ?? 'custom',
    taskKind: options.taskKind ?? 'custom',
    defaultMetric: definition.metric.name,
    loadAll,
    assignSplit(id) {
      const split = admitted.get(id)?.item.split
      if (!split)
        throw new Error(`native benchmark: load the task snapshot before assigning split for ${id}`)
      return split
    },
    async loadDataset(split) {
      return (await loadAll()).filter((item) => item.split === split)
    },
    evaluateResult,
    async evaluate(item, artifact) {
      return (await evaluateResult(item, artifact)).evaluation
    },
  }
}
