import { contentHash } from '../verdict-cache'
import type { CampaignStorage } from './storage'

interface EvaluationBudgetState {
  maxEvaluations: number
  accepted: number
}

export interface ExternalOptimizerRunBudget {
  runKey: string
  attemptId: string
  runTags: Readonly<Record<string, string>>
  attemptTags: Readonly<Record<string, string>>
  acceptedEvaluations(): number
  acceptEvaluation(): number | undefined
}

export function externalOptimizerRunKey(input: {
  material: unknown
  attemptId: string
  resumeEnabled: boolean
}): string {
  if (!input.attemptId.trim() || input.attemptId.trim() !== input.attemptId) {
    throw new Error('external optimizer attemptId must be trimmed and non-empty')
  }
  if (typeof input.resumeEnabled !== 'boolean') {
    throw new Error('external optimizer resumeEnabled must be a boolean')
  }
  const compatible = externalOptimizerCompatibleRunKey(input.material)
  return input.resumeEnabled ? compatible : `${compatible}-${input.attemptId}`
}

export function externalOptimizerCompatibleRunKey(material: unknown): string {
  return contentHash(material)
}

export function openExternalOptimizerRunBudget(input: {
  storage: CampaignStorage
  runDir: string
  runKey: string
  attemptId: string
  maxEvaluations: number
}): ExternalOptimizerRunBudget {
  if (!input.runKey.trim() || input.runKey.trim() !== input.runKey) {
    throw new Error('external optimizer runKey must be trimmed and non-empty')
  }
  if (!input.attemptId.trim() || input.attemptId.trim() !== input.attemptId) {
    throw new Error('external optimizer attemptId must be trimmed and non-empty')
  }
  if (!Number.isSafeInteger(input.maxEvaluations) || input.maxEvaluations <= 0) {
    throw new Error('external optimizer maxEvaluations must be a positive safe integer')
  }
  const budgetDir = `${input.runDir}/budgets`
  const statePath = `${budgetDir}/${input.runKey}.jsonl`
  input.storage.ensureDir(budgetDir)
  const runTags = Object.freeze({ optimizerRun: input.runKey })
  const attemptTags = Object.freeze({
    optimizerRun: input.runKey,
    optimizerAttempt: input.attemptId,
  })

  return {
    runKey: input.runKey,
    attemptId: input.attemptId,
    runTags,
    attemptTags,
    acceptedEvaluations: () =>
      readState(input.storage.read(statePath), input.maxEvaluations, statePath).accepted,
    acceptEvaluation() {
      for (let attempt = 0; attempt < 16; attempt += 1) {
        const current = input.storage.read(statePath) ?? ''
        const state = readState(current, input.maxEvaluations, statePath)
        if (state.accepted >= input.maxEvaluations) return undefined
        if (!input.storage.append) {
          throw new Error('external optimizer evaluation budgets require appendable storage')
        }
        const next = state.accepted + 1
        const event = `${JSON.stringify({
          maxEvaluations: input.maxEvaluations,
          accepted: next,
        } satisfies EvaluationBudgetState)}\n`
        const expectedBytes = new TextEncoder().encode(current).byteLength
        const appended = input.storage.append(statePath, event, expectedBytes)
        if (appended !== undefined) return next
      }
      throw new Error(
        `external optimizer evaluation counter for '${input.runKey}' was updated concurrently`,
      )
    },
  }
}

function readState(
  text: string | undefined,
  maxEvaluations: number,
  statePath: string,
): EvaluationBudgetState {
  if (text === undefined || text === '') return { maxEvaluations, accepted: 0 }
  let accepted = 0
  for (const line of text.split('\n')) {
    if (!line) continue
    let value: unknown
    try {
      value = JSON.parse(line)
    } catch (cause) {
      throw new Error(`external optimizer evaluation state is invalid at '${statePath}'`, {
        cause,
      })
    }
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      Object.keys(value).sort().join(',') !== 'accepted,maxEvaluations' ||
      (value as Partial<EvaluationBudgetState>).maxEvaluations !== maxEvaluations ||
      (value as Partial<EvaluationBudgetState>).accepted !== accepted + 1
    ) {
      throw new Error(`external optimizer evaluation state does not match at '${statePath}'`)
    }
    accepted += 1
  }
  if (accepted > maxEvaluations) {
    throw new Error(`external optimizer evaluation state exceeds its limit at '${statePath}'`)
  }
  return { maxEvaluations, accepted }
}
