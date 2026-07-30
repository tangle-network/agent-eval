import { z } from 'zod'

export type VerificationOutcomeStatus = 'passed' | 'failed' | 'unavailable'

export interface VerificationOutcomeSource {
  path: string
  format: 'terminal-bench' | 'swe-bench' | 'swe-multi'
  status: VerificationOutcomeStatus
}

export interface VerificationOutcome {
  status: VerificationOutcomeStatus
  reason?:
    | 'missing-result'
    | 'result-output-unavailable'
    | 'result-parse-error'
    | 'result-label-disagreement'
  parseError?: { class: string; message: string }
  sources: VerificationOutcomeSource[]
  passedCheckCount: number
  failedCheckCount: number
  passedChecks: string[]
  failedChecks: string[]
}

export interface VerificationResultFile {
  relativePath: string
  content: string
}

const MAX_REPORTED_CHECKS = 20
const SWE_MULTI_NO_TEST_RESULTS =
  'After applying the fix patch, no test results were captured when executing the test command.'

const checkNameSchema = z.string().min(1)
const checkListSchema = z.array(checkNameSchema).superRefine((checks, context) => {
  const seen = new Set<string>()
  for (const [index, check] of checks.entries()) {
    if (seen.has(check)) {
      context.addIssue({
        code: 'custom',
        path: [index],
        message: `duplicate check '${check}'`,
      })
    }
    seen.add(check)
  }
})
const nonNegativeCountSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)

const terminalBenchSchema = z
  .object({
    is_resolved: z.boolean().nullable(),
    failure_mode: z.string().min(1),
    parser_results: z.record(z.string().min(1), z.enum(['passed', 'failed'])).nullable(),
  })
  .passthrough()

const directSweBenchSchema = z
  .object({
    resolved: z.boolean(),
    passed_tests: checkListSchema,
    failed_tests: checkListSchema,
  })
  .passthrough()

const nestedSweBenchCategorySchema = z
  .object({
    success: checkListSchema,
    failure: checkListSchema,
  })
  .passthrough()

const nestedSweBenchInstanceSchema = z
  .object({
    resolved: z.boolean(),
    tests_status: z
      .record(z.string().min(1), nestedSweBenchCategorySchema)
      .refine((value) => Object.keys(value).length > 0, 'must contain at least one test category'),
  })
  .passthrough()

const nestedSweBenchSchema = z
  .record(z.string().min(1), nestedSweBenchInstanceSchema)
  .refine((value) => Object.keys(value).length > 0, 'must contain at least one instance')

const sweMultiCheckResultSchema = z
  .object({
    passed_count: nonNegativeCountSchema,
    failed_count: nonNegativeCountSchema,
    skipped_count: nonNegativeCountSchema,
    passed_tests: checkListSchema,
    failed_tests: checkListSchema,
    skipped_tests: checkListSchema,
  })
  .passthrough()

const sweMultiSchema = z
  .object({
    valid: z.boolean(),
    error_msg: z.string(),
    fix_patch_result: sweMultiCheckResultSchema,
  })
  .passthrough()

export function parseVerificationOutcome(
  files: readonly VerificationResultFile[],
): VerificationOutcome {
  if (files.length === 0) {
    throw new Error('final verification outcome requires at least one result file')
  }

  const sources: VerificationOutcomeSource[] = []
  const passedChecks = new Set<string>()
  const failedChecks = new Set<string>()
  const unavailableReasons = new Set<NonNullable<VerificationOutcome['reason']>>()

  for (const file of files) {
    let value: unknown
    try {
      value = JSON.parse(file.content)
    } catch (error) {
      throw new TypeError(
        `final verification result is not valid JSON: ${file.relativePath}: ${errorMessage(error)}`,
      )
    }
    const parsed = parseResult(value, file.relativePath)
    sources.push({
      path: file.relativePath,
      format: parsed.format,
      status: parsed.status,
    })
    if (parsed.reason) unavailableReasons.add(parsed.reason)
    for (const check of parsed.passedChecks) passedChecks.add(check)
    for (const check of parsed.failedChecks) failedChecks.add(check)
  }

  const statuses = new Set(sources.map((source) => source.status))
  if (statuses.size !== 1) {
    throw new Error(
      `final verification result files disagree: ${sources
        .map((source) => `${source.path}=${source.status}`)
        .join(', ')}`,
    )
  }
  if (unavailableReasons.size > 1) {
    throw new Error(
      `final verification result files disagree on why the outcome is unavailable: ${[
        ...unavailableReasons,
      ].join(', ')}`,
    )
  }
  const [unavailableReason] = unavailableReasons

  const passed = [...passedChecks].sort()
  const failed = [...failedChecks].sort()
  assertDisjointChecks(passed, failed, 'final verification result')
  return {
    status: sources[0]!.status,
    ...(unavailableReason ? { reason: unavailableReason } : {}),
    sources,
    passedCheckCount: passed.length,
    failedCheckCount: failed.length,
    passedChecks: passed.slice(0, MAX_REPORTED_CHECKS),
    failedChecks: failed.slice(0, MAX_REPORTED_CHECKS),
  }
}

interface ParsedResult {
  format: VerificationOutcomeSource['format']
  status: VerificationOutcomeStatus
  reason?: NonNullable<VerificationOutcome['reason']>
  passedChecks: string[]
  failedChecks: string[]
}

function parseResult(value: unknown, path: string): ParsedResult {
  const record = asRecord(value)
  if (!record) {
    throw unsupported(path)
  }

  const discriminators = ['is_resolved', 'resolved', 'valid'].filter((field) =>
    Object.hasOwn(record, field),
  )
  if (discriminators.length > 1) {
    throw new TypeError(
      `final verification result is ambiguous: ${path}: found ${discriminators.join(', ')}`,
    )
  }
  if (discriminators[0] === 'is_resolved') return parseTerminalBench(record, path)
  if (discriminators[0] === 'resolved') return parseDirectSweBench(record, path)
  if (discriminators[0] === 'valid') return parseSweMulti(record, path)

  const entries = Object.entries(record)
  const looksNested = entries.some(([, candidate]) => {
    const nested = asRecord(candidate)
    return nested !== null && Object.hasOwn(nested, 'resolved')
  })
  if (looksNested) return parseNestedSweBench(record, path)

  throw unsupported(path)
}

function parseTerminalBench(value: unknown, path: string): ParsedResult {
  const record = parseSchema(terminalBenchSchema, value, path, 'Terminal-Bench')
  if (record.is_resolved === null) {
    if (record.parser_results !== null) {
      throw malformed(
        path,
        'Terminal-Bench',
        'parser_results must be null when is_resolved is null',
      )
    }
    if (record.failure_mode === 'unset') {
      throw malformed(path, 'Terminal-Bench', "failure_mode cannot be 'unset' when unresolved")
    }
    return {
      format: 'terminal-bench',
      status: 'unavailable',
      reason:
        record.failure_mode === 'parse_error' ? 'result-parse-error' : 'result-output-unavailable',
      passedChecks: [],
      failedChecks: [],
    }
  }
  if (record.parser_results === null) {
    throw malformed(
      path,
      'Terminal-Bench',
      'parser_results must be an object when is_resolved is boolean',
    )
  }
  const checks = stringStatusChecks(record.parser_results)
  if (checks.passedChecks.length + checks.failedChecks.length === 0) {
    throw malformed(path, 'Terminal-Bench', 'parser_results must contain at least one check')
  }
  assertOutcomeConsistency(record.is_resolved, checks, path, 'Terminal-Bench is_resolved', true)
  return {
    format: 'terminal-bench',
    status: status(record.is_resolved),
    ...checks,
  }
}

function parseDirectSweBench(value: unknown, path: string): ParsedResult {
  const record = parseSchema(directSweBenchSchema, value, path, 'SWE-bench')
  const checks = {
    passedChecks: record.passed_tests,
    failedChecks: record.failed_tests,
  }
  assertOutcomeConsistency(record.resolved, checks, path, 'SWE-bench resolved')
  return {
    format: 'swe-bench',
    status: status(record.resolved),
    ...checks,
  }
}

function parseNestedSweBench(value: unknown, path: string): ParsedResult {
  const record = parseSchema(nestedSweBenchSchema, value, path, 'SWE-bench instance report')
  const instances = Object.entries(record)
  const statuses = new Set(instances.map(([, instance]) => status(instance.resolved)))
  if (statuses.size !== 1) {
    throw new Error(
      `final verification report contains conflicting instance outcomes: ${path}: ${instances
        .map(([id, instance]) => `${id}=${status(instance.resolved)}`)
        .join(', ')}`,
    )
  }

  const passedChecks: string[] = []
  const failedChecks: string[] = []
  for (const [instanceId, instance] of instances) {
    const checks = nestedSweBenchChecks(instanceId, instance.tests_status)
    assertOutcomeConsistency(
      instance.resolved,
      checks,
      path,
      `SWE-bench instance '${instanceId}' resolved`,
    )
    passedChecks.push(...checks.passedChecks)
    failedChecks.push(...checks.failedChecks)
  }
  return {
    format: 'swe-bench',
    status: [...statuses][0]!,
    passedChecks,
    failedChecks,
  }
}

function parseSweMulti(value: unknown, path: string): ParsedResult {
  const record = parseSchema(sweMultiSchema, value, path, 'SWE-Multi')
  const fix = record.fix_patch_result
  assertCount(fix.passed_count, fix.passed_tests, 'passed', path)
  assertCount(fix.failed_count, fix.failed_tests, 'failed', path)
  assertCount(fix.skipped_count, fix.skipped_tests, 'skipped', path)
  assertDisjointChecks(fix.passed_tests, fix.failed_tests, `SWE-Multi result ${path}`)
  assertDisjointChecks(fix.passed_tests, fix.skipped_tests, `SWE-Multi result ${path}`)
  assertDisjointChecks(fix.failed_tests, fix.skipped_tests, `SWE-Multi result ${path}`)

  const checks = {
    passedChecks: fix.passed_tests,
    failedChecks: fix.failed_tests,
  }
  if (record.valid === false && isSweMultiOutputUnavailable(record)) {
    return {
      format: 'swe-multi',
      status: 'unavailable',
      reason: 'result-output-unavailable',
      ...checks,
    }
  }
  assertOutcomeConsistency(record.valid, checks, path, 'SWE-Multi valid')
  return {
    format: 'swe-multi',
    status: status(record.valid),
    ...checks,
  }
}

function isSweMultiOutputUnavailable(record: z.infer<typeof sweMultiSchema>): boolean {
  const fix = record.fix_patch_result
  return (
    (record.error_msg === SWE_MULTI_NO_TEST_RESULTS ||
      record.error_msg.startsWith(`${SWE_MULTI_NO_TEST_RESULTS} `)) &&
    fix.passed_count === 0 &&
    fix.failed_count === 0 &&
    fix.skipped_count === 0
  )
}

function stringStatusChecks(record: Record<string, 'passed' | 'failed'>): {
  passedChecks: string[]
  failedChecks: string[]
} {
  const passedChecks: string[] = []
  const failedChecks: string[] = []
  for (const [name, result] of Object.entries(record)) {
    if (result === 'passed') passedChecks.push(name)
    else failedChecks.push(name)
  }
  return { passedChecks, failedChecks }
}

function nestedSweBenchChecks(
  instanceId: string,
  testsStatus: z.infer<typeof nestedSweBenchInstanceSchema>['tests_status'],
): { passedChecks: string[]; failedChecks: string[] } {
  const passedChecks: string[] = []
  const failedChecks: string[] = []
  for (const [category, result] of Object.entries(testsStatus)) {
    passedChecks.push(...result.success.map((name) => `${instanceId}:${category}:${name}`))
    failedChecks.push(...result.failure.map((name) => `${instanceId}:${category}:${name}`))
  }
  return { passedChecks, failedChecks }
}

function assertOutcomeConsistency(
  passed: boolean,
  checks: { passedChecks: readonly string[]; failedChecks: readonly string[] },
  path: string,
  field: string,
  requireFailedCheck = false,
): void {
  assertDisjointChecks(checks.passedChecks, checks.failedChecks, `${field} in ${path}`)
  if (passed && checks.failedChecks.length > 0) {
    throw malformed(
      path,
      field,
      `cannot be true while failed checks are reported: ${checks.failedChecks.join(', ')}`,
    )
  }
  if (passed && checks.passedChecks.length === 0) {
    throw malformed(path, field, 'cannot be true without at least one passed check')
  }
  if (!passed && requireFailedCheck && checks.failedChecks.length === 0) {
    throw malformed(path, field, 'cannot be false without at least one failed check')
  }
}

function assertCount(count: number, checks: readonly string[], kind: string, path: string): void {
  if (count !== checks.length) {
    throw malformed(
      path,
      'SWE-Multi',
      `${kind}_count=${count} does not match ${kind}_tests length ${checks.length}`,
    )
  }
}

function assertDisjointChecks(
  left: readonly string[],
  right: readonly string[],
  source: string,
): void {
  const rightSet = new Set(right)
  const contradictions = [...new Set(left.filter((check) => rightSet.has(check)))].sort()
  if (contradictions.length > 0) {
    throw new Error(
      `${source} marks checks as both passed and failed: ${contradictions.join(', ')}`,
    )
  }
}

function parseSchema<T>(schema: z.ZodType<T>, value: unknown, path: string, format: string): T {
  const parsed = schema.safeParse(value)
  if (parsed.success) return parsed.data
  const details = parsed.error.issues
    .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
    .join('; ')
  throw malformed(path, format, details)
}

function malformed(path: string, format: string, details: string): TypeError {
  return new TypeError(`malformed ${format} verification result: ${path}: ${details}`)
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function status(value: boolean): VerificationOutcomeStatus {
  return value ? 'passed' : 'failed'
}

function unsupported(path: string): TypeError {
  return new TypeError(
    `final verification result has no supported outcome field: ${path}; expected is_resolved, resolved, valid, or a SWE-bench instance report`,
  )
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
