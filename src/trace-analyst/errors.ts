import { AgentEvalError, LimitExceededError, NotFoundError, ValidationError } from '../errors'

/** Invalid trace-tool arguments, including malformed filters and regexes. */
export class TraceAnalysisValidationError extends ValidationError {
  declare readonly code: 'validation'
}

/** A trace read cannot fit within a documented count or byte limit. */
export class TraceAnalysisLimitError extends LimitExceededError {
  declare readonly code: 'limit_exceeded'
  readonly operation: string
  readonly actual: number
  readonly limit: number

  constructor(operation: string, actual: number, limit: number, message?: string) {
    super(message ?? `${operation} produced ${actual}, over the limit of ${limit}`)
    this.operation = operation
    this.actual = actual
    this.limit = limit
  }
}

/** A supplied store returned a shape that violates the trace read contract. */
export class TraceAnalysisStoreContractError extends AgentEvalError {
  declare readonly code: 'backend_integrity'
  readonly operation: string

  constructor(operation: string, message: string, options?: { cause?: unknown }) {
    super('backend_integrity', `${operation}: ${message}`, options)
    this.operation = operation
  }
}

export class TraceFileMissingError extends NotFoundError {
  declare readonly code: 'not_found'
  readonly path: string

  constructor(path: string) {
    super(`trace file not found: ${path}`)
    this.path = path
  }
}

export class TraceFileTooLargeError extends TraceAnalysisLimitError {
  readonly path: string
  readonly size_bytes: number
  readonly max_bytes: number

  constructor(path: string, size_bytes: number, max_bytes: number) {
    super(
      'OtlpFileTraceStore.readBuffer',
      size_bytes,
      max_bytes,
      `trace file ${path} is ${size_bytes} bytes, over the ${max_bytes}-byte limit; ` +
        'raise OtlpFileTraceStoreOptions.maxFileBytes or pre-split the file',
    )
    this.path = path
    this.size_bytes = size_bytes
    this.max_bytes = max_bytes
  }
}

export class TraceNotFoundError extends NotFoundError {
  declare readonly code: 'not_found'
  readonly trace_id: string

  constructor(trace_id: string) {
    super(`trace not found: ${trace_id}`)
    this.trace_id = trace_id
  }
}

export class SpanNotFoundError extends NotFoundError {
  declare readonly code: 'not_found'
  readonly trace_id: string
  readonly span_id: string

  constructor(trace_id: string, span_id: string) {
    super(`span ${span_id} not found in trace ${trace_id}`)
    this.trace_id = trace_id
    this.span_id = span_id
  }
}
