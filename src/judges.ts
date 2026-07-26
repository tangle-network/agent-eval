import { JudgeError } from './errors'
import type { LlmCallMetadata } from './llm-client'

type JudgeParseErrorOptions = { cause?: unknown; llmCall?: LlmCallMetadata }

/**
 * A judge's model response could not be parsed into scored dimensions.
 * Carries the raw response and paid-call metadata without fabricating a score.
 */
export class JudgeParseError extends JudgeError {
  readonly judgeName: string
  readonly raw: string
  readonly llmCall?: LlmCallMetadata

  constructor(judgeName: string, raw: string, options?: JudgeParseErrorOptions) {
    super(`judge '${judgeName}' returned an unparseable response: ${raw.slice(0, 200)}`, options)
    this.judgeName = judgeName
    this.raw = raw
    this.llmCall = options?.llmCall
  }
}
