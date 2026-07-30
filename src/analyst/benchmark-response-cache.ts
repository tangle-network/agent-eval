import { existsSync, lstatSync, readFileSync } from 'node:fs'
import * as nodePath from 'node:path'
import { z } from 'zod'
import type { CostReceiptInput } from '../cost-ledger'
import { ValidationError } from '../errors'
import {
  canonicalString,
  hashCanonical,
  withLedgerFileLock,
  writeLedgerFileAtomically,
} from '../ledger-core'
import type { AnalystBenchmarkError } from './benchmark'

const SHA256 = /^[a-f0-9]{64}$/

const CostReceiptInputSchema = z
  .object({
    model: z.string().min(1),
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    reasoningTokens: z.number().int().nonnegative().optional(),
    cachedTokens: z.number().int().nonnegative().optional(),
    cacheWriteTokens: z.number().int().nonnegative().optional(),
    customTokenPricing: z
      .object({
        inputUsdPerMillion: z.number().nonnegative(),
        cachedInputUsdPerMillion: z.number().nonnegative().optional(),
        cacheWriteUsdPerMillion: z.number().nonnegative().optional(),
        outputUsdPerMillion: z.number().nonnegative(),
      })
      .strict()
      .optional(),
    actualCostUsd: z.number().nonnegative().optional(),
    estimatedCostUsd: z.number().nonnegative().optional(),
    costUnknown: z.boolean().optional(),
    usageUnknown: z.boolean().optional(),
  })
  .strict()

const BenchmarkErrorSchema = z
  .object({
    class: z.string().min(1),
    message: z.string(),
    code: z.string().min(1).optional(),
    status: z.number().int().min(100).max(599).optional(),
  })
  .strict()

const ResponseMetadataSchema = z
  .object({
    providerModel: z.string().min(1),
    providerDurationMs: z.number().nonnegative(),
    finishReason: z.string().nullable(),
    producedAt: z.string().datetime(),
  })
  .strict()

const CacheIdentityShape = {
  kind: z.literal('agent-eval/public-benchmark-model-response'),
  callId: z.string().min(1),
  runIdentitySha256: z.string().regex(SHA256),
  caseId: z.string().min(1),
  repetition: z.number().int().nonnegative(),
}

const SuccessCacheEntryWithoutDigestSchema = z
  .object({
    ...CacheIdentityShape,
    status: z.literal('succeeded'),
    response: z.json(),
    metadata: ResponseMetadataSchema,
    receipt: CostReceiptInputSchema,
  })
  .strict()

const FailureCacheEntryWithoutDigestSchema = z
  .object({
    ...CacheIdentityShape,
    status: z.literal('failed'),
    error: BenchmarkErrorSchema,
    receipt: CostReceiptInputSchema,
  })
  .strict()

const CacheEntryWithoutDigestSchema = z.discriminatedUnion('status', [
  SuccessCacheEntryWithoutDigestSchema,
  FailureCacheEntryWithoutDigestSchema,
])

const CacheEntrySchema = z.discriminatedUnion('status', [
  SuccessCacheEntryWithoutDigestSchema.extend({
    entrySha256: z.string().regex(SHA256),
  }),
  FailureCacheEntryWithoutDigestSchema.extend({
    entrySha256: z.string().regex(SHA256),
  }),
])

interface CacheIdentity {
  runIdentitySha256: string
  caseId: string
  repetition: number
}

export interface PublicBenchmarkResponseMetadata {
  providerModel: string
  providerDurationMs: number
  finishReason: string | null
  producedAt: string
}

export type PublicBenchmarkResponseCacheEntry =
  | (CacheIdentity & {
      kind: 'agent-eval/public-benchmark-model-response'
      callId: string
      status: 'succeeded'
      response: unknown
      metadata: PublicBenchmarkResponseMetadata
      receipt: CostReceiptInput
      entrySha256: string
    })
  | (CacheIdentity & {
      kind: 'agent-eval/public-benchmark-model-response'
      callId: string
      status: 'failed'
      error: AnalystBenchmarkError
      receipt: CostReceiptInput
      entrySha256: string
    })

export type PublicBenchmarkResponseCacheInput =
  | Omit<Extract<PublicBenchmarkResponseCacheEntry, { status: 'succeeded' }>, 'entrySha256'>
  | Omit<Extract<PublicBenchmarkResponseCacheEntry, { status: 'failed' }>, 'entrySha256'>

export function publicBenchmarkCallId(identity: CacheIdentity): string {
  assertCacheIdentity(identity)
  const boundIdentity: CacheIdentity = {
    runIdentitySha256: identity.runIdentitySha256,
    caseId: identity.caseId,
    repetition: identity.repetition,
  }
  return `analyst-benchmark-${hashCanonical(boundIdentity).slice('sha256:'.length)}`
}

export function readPublicBenchmarkResponseCache(
  cacheDirectory: string,
  identity: CacheIdentity,
): PublicBenchmarkResponseCacheEntry | undefined {
  const callId = publicBenchmarkCallId(identity)
  const path = responseCachePath(cacheDirectory, callId)
  if (!existsSync(path)) return undefined
  const metadata = lstatSync(path)
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new ValidationError(`benchmark response cache must be a real file: ${path}`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    throw new ValidationError(`benchmark response cache contains invalid JSON: ${path}`, {
      cause: error,
    })
  }
  const entry = parseCacheEntry(parsed, path)
  if (
    entry.callId !== callId ||
    entry.runIdentitySha256 !== identity.runIdentitySha256 ||
    entry.caseId !== identity.caseId ||
    entry.repetition !== identity.repetition
  ) {
    throw new ValidationError(`benchmark response cache identity does not match: ${path}`)
  }
  return entry
}

export function writePublicBenchmarkResponseCache(
  cacheDirectory: string,
  entry: PublicBenchmarkResponseCacheInput,
): PublicBenchmarkResponseCacheEntry {
  const expectedCallId = publicBenchmarkCallId(entry)
  if (entry.callId !== expectedCallId) {
    throw new ValidationError('benchmark response cache callId does not match its identity')
  }
  const validated = JSON.parse(
    JSON.stringify(CacheEntryWithoutDigestSchema.parse(entry)),
  ) as z.infer<typeof CacheEntryWithoutDigestSchema>
  const complete = {
    ...validated,
    entrySha256: hashCanonical(validated).slice('sha256:'.length),
  } as PublicBenchmarkResponseCacheEntry
  const path = responseCachePath(cacheDirectory, complete.callId)
  const content = `${canonicalString(complete)}\n`
  withLedgerFileLock(path, fileContext(), () => {
    if (existsSync(path)) {
      const existing = readPublicBenchmarkResponseCache(cacheDirectory, complete)
      if (!existing || canonicalString(existing) !== canonicalString(complete)) {
        throw new ValidationError(`benchmark response cache conflicts with existing file: ${path}`)
      }
      return
    }
    writeLedgerFileAtomically(path, content, fileContext())
  })
  return complete
}

function parseCacheEntry(value: unknown, path: string): PublicBenchmarkResponseCacheEntry {
  let parsed: z.infer<typeof CacheEntrySchema>
  try {
    parsed = CacheEntrySchema.parse(value)
  } catch (error) {
    throw new ValidationError(`benchmark response cache has an invalid shape: ${path}`, {
      cause: error,
    })
  }
  const { entrySha256, ...withoutDigest } = parsed
  const expected = hashCanonical(withoutDigest).slice('sha256:'.length)
  if (entrySha256 !== expected) {
    throw new ValidationError(`benchmark response cache digest does not match: ${path}`)
  }
  return parsed as PublicBenchmarkResponseCacheEntry
}

function responseCachePath(cacheDirectory: string, callId: string): string {
  const directory = nodePath.resolve(cacheDirectory)
  const path = nodePath.resolve(directory, `${hashCanonical(callId).slice('sha256:'.length)}.json`)
  if (!isPathInsideDirectory(directory, path, nodePath)) {
    throw new ValidationError('benchmark response cache path escapes its directory')
  }
  return path
}

interface PathOperations {
  relative(from: string, to: string): string
  isAbsolute(path: string): boolean
  sep: string
}

export function isPathInsideDirectory(
  directory: string,
  candidate: string,
  pathOperations: PathOperations = nodePath,
): boolean {
  const relative = pathOperations.relative(directory, candidate)
  return (
    relative !== '' &&
    relative !== '..' &&
    !relative.startsWith(`..${pathOperations.sep}`) &&
    !pathOperations.isAbsolute(relative)
  )
}

function assertCacheIdentity(identity: CacheIdentity): void {
  if (!SHA256.test(identity.runIdentitySha256)) {
    throw new ValidationError('benchmark response cache requires a SHA-256 run identity')
  }
  if (!identity.caseId.trim()) {
    throw new ValidationError('benchmark response cache requires a case id')
  }
  if (!Number.isSafeInteger(identity.repetition) || identity.repetition < 0) {
    throw new ValidationError('benchmark response cache repetition must be non-negative')
  }
}

function fileContext() {
  return {
    subject: 'benchmark response cache',
    integrityError: (message: string, options?: { cause?: unknown }) =>
      new ValidationError(message, options),
  }
}
