/** Public MKA showcase data import. This module contains no official or substitute grader. */
import { createHash } from 'node:crypto'
import { readFile, readdir, realpath } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { BenchmarkDatasetItem } from '../../../src/benchmarks/types'
import type { RunSplitTag } from '../../../src/run-record'

export const MKA_SHOWCASE_REVISION = '46bce7ab8768f661750bd1016ec8cbdc517740b5'
export interface MkaCriterion {
  description: string
  justification: string
  weight: string
  criterion_tags: unknown[]
  criterion_weight: number
  grading_target: string
  dependencies: unknown[]
  [key: string]: unknown
}
export interface MkaPayload {
  prompt: string
  /** Agent-visible inputs only. Rubrics are a separate evaluator input. */
  inputs: Array<{name: string; path: string; sha256: string | null; available: boolean}>
  inputsComplete: boolean
  officialGraderIncluded: false
  scope: 'public-showcase'
}
export interface MkaGradingReferences {
  nativeMetadata: Record<string, unknown>
  rubrics: Record<string, MkaCriterion>
}

const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label}: expected object`)
  return value as Record<string, unknown>
}

export async function loadMkaShowcase(options: {
  root: string
  taskIds?: readonly string[]
  /** Always explicit: the public showcase has no official search/dev/holdout partition. */
  split: RunSplitTag
  /** metadata-only tolerates missing input assets and marks the item incomplete. */
  inputPolicy: 'require' | 'metadata-only'
}): Promise<{
  items: BenchmarkDatasetItem<MkaPayload>[]
  /** Bind this map in the checker's closure; it is deliberately absent from every item. */
  gradingReferences: Map<string, MkaGradingReferences>
}> {
  const root = await realpath(options.root)
  const manifest = JSON.parse(await readFile(join(root, 'REFERENCE_MANIFEST.json'), 'utf8'))
  if (manifest.revision !== MKA_SHOWCASE_REVISION ||
      manifest.source !== 'https://huggingface.co/datasets/google/multimodal-knowledge-agent') {
    throw new Error('MKA input package does not declare the pinned public showcase revision.')
  }
  const files = new Map<string, string>(manifest.files.map((file: {path: string; sha256: string}) =>
    [file.path, file.sha256]))
  const readPinned = async (path: string): Promise<Buffer> => {
    const full = await realpath(join(root, path))
    const rel = relative(root, full)
    if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) throw new Error('MKA path leaves input package')
    const value = await readFile(full)
    if (!files.has(path) || digest(value) !== files.get(path)) throw new Error(`MKA manifest digest mismatch: ${path}`)
    return value
  }
  const ids = options.taskIds ?? (await readdir(join(root, 'tasks'), {withFileTypes: true}))
    .filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort()
  if (!ids.length || new Set(ids).size !== ids.length) throw new Error('MKA requires a nonempty unique task selection')
  const gradingReferences = new Map<string, MkaGradingReferences>()
  const items = await Promise.all(ids.map(async (id) => {
    if (!/^task_[a-f0-9]+$/.test(id)) throw new Error(`Invalid MKA task ID: ${id}`)
    const prefix = `tasks/${id}`
    const metadataBytes = await readPinned(`${prefix}/metadata.json`)
    const rubricBytes = await readPinned(`${prefix}/rubrics.json`)
    const metadata = object(JSON.parse(metadataBytes.toString('utf8')), `${id} metadata`)
    const rubrics = object(JSON.parse(rubricBytes.toString('utf8')), `${id} rubrics`)
    if (metadata.TaskID !== id || typeof metadata.Prompt !== 'string' || !metadata.Prompt.trim() ||
        typeof metadata.Input_files !== 'string') throw new Error(`Malformed MKA task ${id}`)
    if (!Object.keys(rubrics).length) throw new Error(`MKA ${id} has no criteria`)
    for (const [key, raw] of Object.entries(rubrics)) {
      const criterion = object(raw, `${id} ${key}`)
      if (typeof criterion.description !== 'string' || typeof criterion.weight !== 'string' ||
          typeof criterion.criterion_weight !== 'number' || !Number.isFinite(criterion.criterion_weight) ||
          !Array.isArray(criterion.dependencies) || !Array.isArray(criterion.criterion_tags)) {
        throw new Error(`Malformed MKA criterion ${id}/${key}`)
      }
    }
    const names = metadata.Input_files.split(',').map((name) => name.trim()).filter(Boolean)
    const inputs = await Promise.all(names.map(async (name) => {
      if (isAbsolute(name) || name.split(/[\\/]/u).includes('..')) throw new Error(`Unsafe MKA input ${name}`)
      const path = `${prefix}/input/${name}`
      if (!files.has(path) && options.inputPolicy === 'metadata-only') {
        return {name, path: resolve(root, path), sha256: null, available: false}
      }
      const value = await readPinned(path)
      return {name, path: resolve(root, path), sha256: digest(value), available: true}
    }))
    gradingReferences.set(id, {nativeMetadata: metadata, rubrics: rubrics as Record<string, MkaCriterion>})
    return {
      id, split: options.split, family: 'mka-public-showcase', taskKind: 'multimodal-artifact',
      tags: [metadata.Vertical, metadata.Domain, metadata.Role].filter((tag): tag is string => typeof tag === 'string'),
      source: {name: 'MKA public showcase',
        url: 'https://huggingface.co/datasets/google/multimodal-knowledge-agent',
        revision: MKA_SHOWCASE_REVISION, license: 'Apache-2.0', contamination: 'unknown' as const},
      metadata: {metadataSha256: digest(metadataBytes), rubricsSha256: digest(rubricBytes)},
      payload: {prompt: metadata.Prompt, inputs,
        inputsComplete: inputs.every((input) => input.available), officialGraderIncluded: false as const,
        scope: 'public-showcase' as const},
    }
  }))
  return {items, gradingReferences}
}
