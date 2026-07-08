import type { RunSplitTag } from '../run-record'
import type {
  BenchmarkAdapter,
  BenchmarkDatasetItem,
  BenchmarkFamily,
  BenchmarkSource,
  BenchmarkTaskKind,
} from './types'
import { deterministicSplit } from './types'

export interface StandardRetrievalDocument {
  id: string
  title?: string
  text: string
  metadata?: Record<string, unknown>
}

export interface StandardRetrievalQuery {
  id: string
  text: string
  metadata?: Record<string, unknown>
}

export interface StandardRetrievalQrel {
  queryId: string
  documentId: string
  score: number
}

export interface StandardRetrievalPayload {
  queryId: string
  query: string
  expectedDocumentIds: string[]
  expectedScores: Record<string, number>
  corpus?: Record<string, StandardRetrievalDocument>
  metadata?: Record<string, unknown>
}

export interface BuildStandardRetrievalItemsOptions {
  benchmarkId: string
  family: BenchmarkFamily | string
  queries: readonly StandardRetrievalQuery[]
  qrels: readonly StandardRetrievalQrel[]
  corpus?: readonly StandardRetrievalDocument[]
  includeCorpusInPayload?: boolean
  source?: BenchmarkSource
  tags?: readonly string[]
  splitOf?: (queryId: string) => RunSplitTag
}

export interface RetrievalIdAdapterOptions extends BuildStandardRetrievalItemsOptions {
  responseIdPattern?: RegExp
  cutoffs?: readonly number[]
  primaryMetric?: string
  passMetric?: string
  passThreshold?: number
}

export interface StandardRetrievalResult {
  id?: string
  documentId?: string
  docId?: string
  score?: number
}

export type StandardRetrievalArtifact =
  | string
  | readonly string[]
  | readonly StandardRetrievalResult[]
  | {
      ids?: readonly string[]
      documentIds?: readonly string[]
      results?: readonly StandardRetrievalResult[]
    }

export interface StandardRetrievalEvaluationOptions {
  responseIdPattern?: RegExp
  cutoffs?: readonly number[]
  primaryMetric?: string
  passMetric?: string
  passThreshold?: number
}

export function parseJsonlRows<T = unknown>(text: string): T[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line) as T
      } catch (error) {
        throw new Error(`invalid JSONL row ${index + 1}: ${(error as Error).message}`)
      }
    })
}

export function parseTsvRows(text: string): string[][] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !line.startsWith('#'))
    .map((line) => line.split(/\t|\s+/))
}

export function parseQrels(text: string): StandardRetrievalQrel[] {
  return parseTsvRows(text).flatMap((parts, index) => {
    if (parts.length < 3) return []
    const [queryId, maybeZeroOrDocId, maybeDocIdOrScore, maybeScore] = parts
    if (!queryId || !maybeZeroOrDocId || !maybeDocIdOrScore) return []
    if (queryId.toLowerCase() === 'query-id' || queryId.toLowerCase() === 'qid') return []
    const documentId = maybeScore === undefined ? maybeZeroOrDocId : maybeDocIdOrScore
    const scoreText = maybeScore === undefined ? maybeDocIdOrScore : maybeScore
    const score = Number(scoreText)
    if (!documentId || !Number.isFinite(score)) {
      throw new Error(`invalid qrels row ${index + 1}: expected query id, doc id, score`)
    }
    return [{ queryId, documentId, score }]
  })
}

export function parseBeirCorpusJsonl(text: string): StandardRetrievalDocument[] {
  return parseJsonlRows<Record<string, unknown>>(text).map((row, index) => {
    const id = stringField(row, '_id') ?? stringField(row, 'id')
    const body = stringField(row, 'text') ?? stringField(row, 'contents')
    if (!id || body === undefined) {
      throw new Error(`invalid BEIR corpus row ${index + 1}: expected _id/id and text/contents`)
    }
    return {
      id,
      title: stringField(row, 'title'),
      text: body,
      metadata: stripKnown(row, ['_id', 'id', 'title', 'text', 'contents']),
    }
  })
}

export function parseBeirQueriesJsonl(text: string): StandardRetrievalQuery[] {
  return parseJsonlRows<Record<string, unknown>>(text).map((row, index) => {
    const id = stringField(row, '_id') ?? stringField(row, 'id') ?? stringField(row, 'query_id')
    const query = stringField(row, 'text') ?? stringField(row, 'query')
    if (!id || !query) {
      throw new Error(`invalid BEIR query row ${index + 1}: expected _id/id and text/query`)
    }
    return {
      id,
      text: query,
      metadata: stripKnown(row, ['_id', 'id', 'query_id', 'text', 'query']),
    }
  })
}

export function buildStandardRetrievalItems(
  options: BuildStandardRetrievalItemsOptions,
): Array<BenchmarkDatasetItem<StandardRetrievalPayload>> {
  const qrelsByQuery = new Map<string, StandardRetrievalQrel[]>()
  for (const qrel of options.qrels) {
    if (qrel.score <= 0) continue
    const list = qrelsByQuery.get(qrel.queryId) ?? []
    list.push(qrel)
    qrelsByQuery.set(qrel.queryId, list)
  }
  const corpus =
    options.includeCorpusInPayload && options.corpus
      ? Object.fromEntries(options.corpus.map((document) => [document.id, document]))
      : undefined
  return options.queries.flatMap((query) => {
    const qrels = qrelsByQuery.get(query.id) ?? []
    if (qrels.length === 0) return []
    const split =
      options.splitOf?.(query.id) ?? deterministicSplit(`${options.benchmarkId}:${query.id}`)
    return [
      {
        id: query.id,
        split,
        family: options.family,
        taskKind: 'retrieval',
        tags: [...new Set([...(options.tags ?? []), split])],
        ...(options.source ? { source: options.source } : {}),
        ...(query.metadata ? { metadata: query.metadata } : {}),
        payload: {
          queryId: query.id,
          query: query.text,
          expectedDocumentIds: qrels.map((qrel) => qrel.documentId),
          expectedScores: Object.fromEntries(qrels.map((qrel) => [qrel.documentId, qrel.score])),
          ...(corpus ? { corpus } : {}),
          ...(query.metadata ? { metadata: query.metadata } : {}),
        },
      },
    ]
  })
}

export function createRetrievalIdBenchmarkAdapter(
  options: RetrievalIdAdapterOptions,
): BenchmarkAdapter<
  BenchmarkDatasetItem<StandardRetrievalPayload>,
  StandardRetrievalPayload,
  StandardRetrievalArtifact
> {
  const items = buildStandardRetrievalItems(options)
  return {
    id: options.benchmarkId,
    family: options.family,
    taskKind: 'retrieval' satisfies BenchmarkTaskKind,
    source: options.source,
    defaultMetric: options.primaryMetric ?? 'ndcg@10',
    async loadDataset(split) {
      return items.filter((item) => item.split === split)
    },
    async evaluate(item, artifact) {
      return evaluateStandardRetrieval(item.payload, artifact, options)
    },
    assignSplit(itemId) {
      return options.splitOf?.(itemId) ?? deterministicSplit(`${options.benchmarkId}:${itemId}`)
    },
  }
}

export function evaluateStandardRetrieval(
  payload: StandardRetrievalPayload,
  artifact: StandardRetrievalArtifact,
  options: StandardRetrievalEvaluationOptions = {},
) {
  const rankedDocumentIds = normalizeRetrievedDocumentIds(
    artifact,
    options.responseIdPattern ?? /[A-Za-z0-9_.:/-]+/g,
  )
  const cutoffs = normalizeCutoffs(options.cutoffs ?? [1, 3, 5, 10])
  const dimensions: Record<string, number> = {
    expected_count: payload.expectedDocumentIds.length,
    returned_count: rankedDocumentIds.length,
  }
  for (const cutoff of cutoffs) {
    Object.assign(
      dimensions,
      retrievalMetricsAtCutoff({
        rankedDocumentIds,
        expectedScores: payload.expectedScores,
        cutoff,
      }),
    )
  }
  const primaryMetric = options.primaryMetric ?? 'ndcg@10'
  const passMetric = options.passMetric ?? 'hit@10'
  const score = dimensions[primaryMetric] ?? dimensions[`ndcg@${cutoffs[cutoffs.length - 1]}`] ?? 0
  const passScore =
    dimensions[passMetric] ?? dimensions[`hit@${cutoffs[cutoffs.length - 1]}`] ?? score
  return {
    score,
    passed: passScore >= (options.passThreshold ?? 1),
    dimensions,
    raw: {
      rankedDocumentIds,
      expectedDocumentIds: payload.expectedDocumentIds,
      expectedScores: payload.expectedScores,
    },
  }
}

export function normalizeRetrievedDocumentIds(
  artifact: StandardRetrievalArtifact,
  responseIdPattern: RegExp = /[A-Za-z0-9_.:/-]+/g,
): string[] {
  if (typeof artifact === 'string') {
    return uniqueOrdered((artifact.match(responseIdPattern) ?? []).map((value) => value.trim()))
  }
  if (Array.isArray(artifact)) {
    const entries = artifact as readonly (string | StandardRetrievalResult)[]
    return uniqueOrdered(
      entries.flatMap((entry) => {
        if (typeof entry === 'string') return [entry]
        return [entry.documentId ?? entry.docId ?? entry.id ?? '']
      }),
    )
  }
  const objectArtifact = artifact as Exclude<StandardRetrievalArtifact, string | readonly unknown[]>
  return uniqueOrdered(
    [
      ...(objectArtifact.documentIds ?? []),
      ...(objectArtifact.ids ?? []),
      ...(objectArtifact.results ?? []).map(
        (entry) => entry.documentId ?? entry.docId ?? entry.id ?? '',
      ),
    ].map((value) => value.trim()),
  )
}

export function retrievalMetricsAtCutoff(input: {
  rankedDocumentIds: readonly string[]
  expectedScores: Record<string, number>
  cutoff: number
}): Record<string, number> {
  const top = input.rankedDocumentIds.slice(0, input.cutoff)
  const relevantIds = Object.keys(input.expectedScores).filter(
    (id) => input.expectedScores[id]! > 0,
  )
  const relevant = new Set(relevantIds)
  const hits = top.filter((id) => relevant.has(id)).length
  const firstRelevantRank = top.findIndex((id) => relevant.has(id))
  const prefix = `@${input.cutoff}`
  return {
    [`hit${prefix}`]: hits > 0 ? 1 : 0,
    [`recall${prefix}`]: relevant.size === 0 ? 1 : hits / relevant.size,
    [`precision${prefix}`]: hits / input.cutoff,
    [`mrr${prefix}`]: firstRelevantRank === -1 ? 0 : 1 / (firstRelevantRank + 1),
    [`ndcg${prefix}`]: ndcgAt(input.rankedDocumentIds, input.expectedScores, input.cutoff),
  }
}

function stringField(row: Record<string, unknown>, key: string): string | undefined {
  const value = row[key]
  return typeof value === 'string' ? value : undefined
}

function stripKnown(
  row: Record<string, unknown>,
  keys: readonly string[],
): Record<string, unknown> {
  const known = new Set(keys)
  return Object.fromEntries(Object.entries(row).filter(([key]) => !known.has(key)))
}

function normalizeCutoffs(cutoffs: readonly number[]): number[] {
  return [
    ...new Set(cutoffs.map((cutoff) => Math.trunc(cutoff)).filter((cutoff) => cutoff > 0)),
  ].sort((a, b) => a - b)
}

function uniqueOrdered(values: readonly string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const value of values) {
    const trimmed = value.trim()
    if (!trimmed || seen.has(trimmed)) continue
    seen.add(trimmed)
    out.push(trimmed)
  }
  return out
}

function ndcgAt(
  rankedDocumentIds: readonly string[],
  expectedScores: Record<string, number>,
  cutoff: number,
): number {
  const dcg = rankedDocumentIds
    .slice(0, cutoff)
    .reduce(
      (sum, documentId, index) => sum + discountedGain(expectedScores[documentId] ?? 0, index),
      0,
    )
  const ideal = Object.values(expectedScores)
    .filter((score) => score > 0)
    .sort((a, b) => b - a)
    .slice(0, cutoff)
    .reduce((sum, score, index) => sum + discountedGain(score, index), 0)
  return ideal === 0 ? 1 : dcg / ideal
}

function discountedGain(relevance: number, zeroBasedRank: number): number {
  if (relevance <= 0) return 0
  return (2 ** relevance - 1) / Math.log2(zeroBasedRank + 2)
}
