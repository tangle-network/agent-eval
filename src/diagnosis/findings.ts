/**
 * The diagnosis findings document: what the engine returns and what the
 * diagnosis report renders. It mirrors the kit's JSON Schema
 * (`https://tangle.tools/schemas/diagnosis-findings-v1.json`, owned by the
 * traces repository's diagnosis kit) field for field, including its closed
 * objects, so a document that passes {@link validateDiagnosisFindings} passes
 * that schema.
 */

export const DIAGNOSIS_FINDINGS_SCHEMA_ID =
  'https://tangle.tools/schemas/diagnosis-findings-v1.json'

export type DiagnosisSeverity = 'critical' | 'high' | 'medium' | 'low'

/** `observed` is read directly off the trace; `inferred` is a model's reading of it. */
export type DiagnosisConfidence = 'observed' | 'inferred'

export interface DiagnosisMeasure {
  name: string
  value: number
  unit: string
  /** What the value is out of. The engine always sets it; a rate without one is not reportable. */
  denominator: string
}

export interface DiagnosisFinding {
  id: string
  severity: DiagnosisSeverity
  claim: string
  consequence: string
  measure?: DiagnosisMeasure
  /** Verbatim span ids from the input. Never empty. */
  evidence: string[]
  reproduce?: string
  confidence: DiagnosisConfidence
  recommendation?: string
}

export interface DiagnosisCapability {
  available: boolean
  reason?: string
}

export interface DiagnosisSkippedAnalysis {
  analysis: string
  reason: string
}

export interface DiagnosisRedaction {
  redactionCount: number
  byRule: Record<string, number>
  droppedAttributes: string[]
}

export interface DiagnosisFindingsDocument {
  schemaVersion: 1
  subject: {
    label: string
    runCount: number
    window: string
    contentIncluded?: boolean
  }
  coverage: {
    capabilities: Record<string, DiagnosisCapability>
    skipped: DiagnosisSkippedAnalysis[]
    redaction?: DiagnosisRedaction
  }
  findings: DiagnosisFinding[]
}

const SEVERITIES = new Set(['critical', 'high', 'medium', 'low'])
export const SEVERITY_RANK: Record<DiagnosisSeverity, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
}

/**
 * Structural check against the v1 schema plus the two rules the schema states
 * in prose: an unavailable capability carries a reason, and a measure carries a
 * denominator. When `spanIds` is given, every evidence id must resolve to it.
 * Returns the list of defects; empty means valid.
 */
export function validateDiagnosisFindings(
  document: unknown,
  options: { spanIds?: ReadonlySet<string> } = {},
): string[] {
  const errors: string[] = []
  if (!isObject(document)) return ['document is not an object']
  closed(document, ['schemaVersion', 'subject', 'coverage', 'findings'], '', errors)
  if (document.schemaVersion !== 1) errors.push('schemaVersion must be 1')

  const subject = document.subject
  if (!isObject(subject)) errors.push('subject must be an object')
  else {
    closed(subject, ['label', 'runCount', 'window', 'contentIncluded'], 'subject', errors)
    if (typeof subject.label !== 'string') errors.push('subject.label must be a string')
    if (!Number.isInteger(subject.runCount) || (subject.runCount as number) < 0)
      errors.push('subject.runCount must be a non-negative integer')
    if (typeof subject.window !== 'string') errors.push('subject.window must be a string')
    if (subject.contentIncluded !== undefined && typeof subject.contentIncluded !== 'boolean')
      errors.push('subject.contentIncluded must be a boolean')
  }

  const coverage = document.coverage
  if (!isObject(coverage)) errors.push('coverage must be an object')
  else {
    closed(coverage, ['capabilities', 'skipped', 'redaction'], 'coverage', errors)
    if (!isObject(coverage.capabilities)) errors.push('coverage.capabilities must be an object')
    else {
      for (const [name, capability] of Object.entries(coverage.capabilities)) {
        if (!isObject(capability) || typeof capability.available !== 'boolean') {
          errors.push(`coverage.capabilities.${name}.available must be a boolean`)
        } else if (
          !capability.available &&
          !(typeof capability.reason === 'string' && capability.reason)
        ) {
          errors.push(`coverage.capabilities.${name} is unavailable without a reason`)
        }
      }
    }
    if (!Array.isArray(coverage.skipped)) errors.push('coverage.skipped must be an array')
    else
      coverage.skipped.forEach((entry, index) => {
        if (
          !isObject(entry) ||
          typeof entry.analysis !== 'string' ||
          typeof entry.reason !== 'string'
        )
          errors.push(`coverage.skipped[${index}] needs analysis and reason strings`)
      })
    if (coverage.redaction !== undefined) {
      const redaction = coverage.redaction
      if (!isObject(redaction)) errors.push('coverage.redaction must be an object')
      else {
        if (!Number.isInteger(redaction.redactionCount) || (redaction.redactionCount as number) < 0)
          errors.push('coverage.redaction.redactionCount must be a non-negative integer')
        if (redaction.byRule !== undefined && !isObject(redaction.byRule))
          errors.push('coverage.redaction.byRule must be an object')
        if (
          redaction.droppedAttributes !== undefined &&
          !Array.isArray(redaction.droppedAttributes)
        )
          errors.push('coverage.redaction.droppedAttributes must be an array')
      }
    }
  }

  if (!Array.isArray(document.findings)) errors.push('findings must be an array')
  else
    document.findings.forEach((finding, index) => {
      const at = `findings[${index}]`
      if (!isObject(finding)) {
        errors.push(`${at} must be an object`)
        return
      }
      closed(
        finding,
        [
          'id',
          'severity',
          'claim',
          'consequence',
          'measure',
          'evidence',
          'reproduce',
          'confidence',
          'recommendation',
        ],
        at,
        errors,
      )
      for (const key of ['id', 'claim', 'consequence'] as const) {
        if (typeof finding[key] !== 'string' || !(finding[key] as string))
          errors.push(`${at}.${key} must be a non-empty string`)
      }
      if (!SEVERITIES.has(finding.severity as string)) errors.push(`${at}.severity is invalid`)
      if (finding.confidence !== 'observed' && finding.confidence !== 'inferred')
        errors.push(`${at}.confidence must be observed or inferred`)
      if (!Array.isArray(finding.evidence) || finding.evidence.length === 0)
        errors.push(`${at}.evidence must be a non-empty array`)
      else
        for (const id of finding.evidence) {
          if (typeof id !== 'string') errors.push(`${at}.evidence holds a non-string`)
          else if (options.spanIds && !options.spanIds.has(id))
            errors.push(`${at}.evidence ${id} does not resolve`)
        }
      if (finding.measure !== undefined) {
        const measure = finding.measure
        if (
          !isObject(measure) ||
          typeof measure.name !== 'string' ||
          typeof measure.value !== 'number' ||
          !Number.isFinite(measure.value) ||
          typeof measure.unit !== 'string'
        ) {
          errors.push(`${at}.measure needs name, finite value and unit`)
        } else if (!(typeof measure.denominator === 'string' && measure.denominator)) {
          errors.push(`${at}.measure has no denominator`)
        }
      }
      for (const key of ['reproduce', 'recommendation'] as const) {
        if (finding[key] !== undefined && typeof finding[key] !== 'string')
          errors.push(`${at}.${key} must be a string`)
      }
    })
  return errors
}

function closed(
  value: Record<string, unknown>,
  allowed: readonly string[],
  at: string,
  errors: string[],
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) errors.push(`${at ? `${at}.` : ''}${key} is not allowed`)
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
