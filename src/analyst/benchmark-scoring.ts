import { linearSumAssignment } from 'linear-sum-assignment'
import type {
  AnalystBenchmarkCase,
  AnalystEvidenceExpectation,
  AnalystFindingScore,
  AnalystIssueExpectation,
} from './benchmark'
import type { AnalystFinding, EvidenceRef } from './types'

export function scoreAnalystFindings(
  testCase: Pick<AnalystBenchmarkCase, 'id' | 'expectedIssues' | 'labeledEvidence'>,
  findings: readonly AnalystFinding[],
): AnalystFindingScore {
  assertValidAnalystScoringCase(testCase)
  const matchedFindingByIssue = matchFindingsToIssues(testCase.expectedIssues, findings)
  const matchedIssueIds = testCase.expectedIssues
    .filter((_, index) => matchedFindingByIssue.has(index))
    .map((issue) => issue.id)
  const missedIssueIds = testCase.expectedIssues
    .filter((_, index) => !matchedFindingByIssue.has(index))
    .map((issue) => issue.id)
  const supportedFindingIndexes = new Set(matchedFindingByIssue.values())

  const unsupportedFindingIndexes = findings
    .map((_, index) => index)
    .filter((index) => !supportedFindingIndexes.has(index))
  const expectedIssueCount = testCase.expectedIssues.length
  const issueRecall = expectedIssueCount === 0 ? 1 : matchedIssueIds.length / expectedIssueCount
  const findingPrecision =
    findings.length === 0
      ? expectedIssueCount === 0
        ? 1
        : 0
      : supportedFindingIndexes.size / findings.length
  const f1 = harmonicMeanScore(findingPrecision, issueRecall)
  const allEvidence = findings.flatMap((finding) => finding.evidence_refs)

  const criticalIssues = testCase.expectedIssues.filter(
    (issue) => (issue.criticalEvidence?.length ?? 0) > 0,
  )
  const criticalHits = testCase.expectedIssues.filter((issue) => {
    if ((issue.criticalEvidence?.length ?? 0) === 0) return false
    return matchesEvidence(allEvidence, issue.criticalEvidence ?? [], 'any')
  }).length

  const findingsWithEvidence = findings.filter((finding) => finding.evidence_refs.length > 0).length
  const unlabeledEvidence = testCase.labeledEvidence
    ? allEvidence.filter(
        (ref) => !testCase.labeledEvidence!.some((expected) => evidenceMatches(ref, expected)),
      )
    : []

  return {
    expectedIssueCount,
    matchedIssueIds,
    missedIssueIds,
    supportedFindingIndexes: [...supportedFindingIndexes].sort((a, b) => a - b),
    unsupportedFindingIndexes,
    unlabeledEvidence,
    issueRecall,
    findingPrecision,
    f1,
    criticalStepAccuracy: criticalIssues.length === 0 ? null : criticalHits / criticalIssues.length,
    citationCoverage: findings.length === 0 ? null : findingsWithEvidence / findings.length,
    citationExcerptCoverage:
      allEvidence.length === 0
        ? null
        : allEvidence.filter((evidence) => Boolean(evidence.excerpt?.trim())).length /
          allEvidence.length,
    citationLabelAgreement:
      testCase.labeledEvidence === undefined
        ? null
        : allEvidence.length === 0
          ? findings.length === 0
            ? null
            : 0
          : (allEvidence.length - unlabeledEvidence.length) / allEvidence.length,
    predictionOnLabelEmptyCase: expectedIssueCount === 0 && findings.length > 0,
  }
}

export function assertValidAnalystScoringCase(
  testCase: Pick<AnalystBenchmarkCase, 'id' | 'expectedIssues' | 'labeledEvidence'>,
): void {
  if (!testCase.id.trim()) throw new TypeError('analyst benchmark case id must not be empty')
  const ids = new Set<string>()
  for (const issue of testCase.expectedIssues) {
    if (!issue.id.trim()) throw new TypeError(`${testCase.id}: expected issue id must not be empty`)
    if (ids.has(issue.id)) {
      throw new TypeError(`${testCase.id}: duplicate expected issue id '${issue.id}'`)
    }
    ids.add(issue.id)
    if (
      !issue.findingIds?.length &&
      !issue.areas?.length &&
      !issue.subjects?.length &&
      !issue.evidence?.length
    ) {
      throw new TypeError(
        `${testCase.id}/${issue.id}: expected issue must identify a finding by id, area, subject, or evidence`,
      )
    }
  }
  for (const ref of testCase.labeledEvidence ?? []) {
    if (!ref.uri.trim()) {
      throw new TypeError(`${testCase.id}: labeled evidence URI must not be empty`)
    }
  }
}

export function harmonicMeanScore(a: number, b: number): number {
  return a + b === 0 ? 0 : (2 * a * b) / (a + b)
}

function matchFindingsToIssues(
  issues: readonly AnalystIssueExpectation[],
  findings: readonly AnalystFinding[],
): Map<number, number> {
  if (issues.length === 0) return new Map()
  const cardinalityWeight = issues.length + 1
  const scores = issues.map((issue) => [
    ...findings.map((finding) => {
      if (!findingMatchesIssue(finding, issue)) return -1
      const criticalHit =
        (issue.criticalEvidence?.length ?? 0) > 0 &&
        matchesEvidence(finding.evidence_refs, issue.criticalEvidence ?? [], 'any')
      return cardinalityWeight + Number(criticalHit)
    }),
    ...Array.from({ length: issues.length }, () => 0),
  ])
  const assignment = linearSumAssignment(scores, { maximaze: true }).rowAssignments
  const matches = new Map<number, number>()
  for (const [issueIndex, column] of assignment.entries()) {
    if (column < 0 || column >= findings.length) continue
    if (!findingMatchesIssue(findings[column]!, issues[issueIndex]!)) continue
    matches.set(issueIndex, column)
  }
  return matches
}

function findingMatchesIssue(finding: AnalystFinding, issue: AnalystIssueExpectation): boolean {
  if (issue.findingIds && !issue.findingIds.includes(finding.finding_id)) return false
  if (issue.areas && !issue.areas.includes(finding.area)) return false
  if (issue.subjects && (!finding.subject || !issue.subjects.includes(finding.subject))) {
    return false
  }
  if (
    issue.evidence &&
    !matchesEvidence(finding.evidence_refs, issue.evidence, issue.evidenceMode ?? 'any')
  ) {
    return false
  }
  return true
}

function matchesEvidence(
  actual: readonly EvidenceRef[],
  expected: readonly AnalystEvidenceExpectation[],
  mode: 'any' | 'all',
): boolean {
  if (expected.length === 0) return true
  const match = (target: AnalystEvidenceExpectation) =>
    actual.some((ref) => evidenceMatches(ref, target))
  return mode === 'all' ? expected.every(match) : expected.some(match)
}

function evidenceMatches(actual: EvidenceRef, expected: AnalystEvidenceExpectation): boolean {
  return (
    actual.uri === expected.uri && (expected.kind === undefined || actual.kind === expected.kind)
  )
}
