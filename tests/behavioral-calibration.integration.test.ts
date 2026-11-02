import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type {
  AnalystFinding,
  BehavioralTraceGold,
  ChoiceGold,
  ChoicePrediction,
} from '../src/analyst/index'
import * as api from '../src/analyst/index'
import { DECISION_POINT_AUC_BAR, decisionPoint } from '../src/systemone'

// Fixture labels and probabilities test the arithmetic and wiring only; they are never calibration evidence.
const identity = {
  layer: 'event' as const,
  windowPolicy: { id: 'fixture-whole-window', version: '1' },
  model: 'fixture-model',
  servedModel: 'fixture-model',
  evaluatorIdentity: { id: 'fixture-evaluator', version: '1', config: {} },
}
const question = 'unverified-completion' as const
const digest = api.behavioralTraceQuestionDigest({ questionId: question, ...identity })
const evidenceRefs = [{ kind: 'artifact' as const, uri: 'artifact://fixture-labels' }]
// 60 windows over 6 agents: 20 gold yes (12 answered yes), 40 gold no (4 answered yes).
const yesScores = [
  0.95, 0.92, 0.9, 0.88, 0.85, 0.82, 0.8, 0.78, 0.75, 0.7, 0.65, 0.6, 0.45, 0.4, 0.35, 0.3, 0.25,
  0.2, 0.15, 0.1,
]
const noScores = [
  0.7,
  0.65,
  0.6,
  0.55,
  ...Array.from({ length: 36 }, (_, i) => Number((0.02 + (i * 0.38) / 35).toFixed(3))),
]
const windows = [
  ...yesScores.map((p, i) => ({ id: `yes-${i}`, label: 'yes' as const, p })),
  ...noScores.map((p, i) => ({ id: `no-${i}`, label: 'no' as const, p })),
]
function finding(window: (typeof windows)[number], index: number): AnalystFinding {
  return api.makeFinding({
    analyst_id: 'efficiency-behavioral',
    area: 'behavioral-trace-question',
    subject: `agent-${index % 6}`,
    claim: `fixture ${window.id}`,
    confidence: 0,
    severity: 'info',
    layer: 'event',
    scope: {
      population: [window.id],
      n: 1,
      window: { from: '2026-11-01T00:00:00Z', to: '2026-11-01T00:05:00Z' },
    },
    method: {
      kind: 'judged',
      name: 'behavioral-trace-questions',
      version: api.BEHAVIORAL_TRACE_QUESTIONS_VERSION,
    },
    evidence_refs: [{ kind: 'span', uri: `trace://t1/span/${window.id}` }],
    produced_at: '2026-11-01T00:05:00Z',
    metadata: {
      behavioral_trace_question: {
        questionId: question,
        windowId: window.id,
        traceId: 't1',
        answer: window.p > 0.5 ? 'yes' : 'no',
        probabilities: { yes: window.p, no: 1 - window.p, unsure: 0 },
        questionDigest: digest,
        requestedModel: identity.model,
        servedModel: identity.servedModel,
      },
    },
  })
}
const findings = windows.map(finding)
const gold: BehavioralTraceGold[] = windows.map((window) => ({
  questionId: question,
  windowId: window.id,
  label: window.label,
  source: 'human',
}))
const calibrate = (rows: BehavioralTraceGold[]) =>
  api
    .calibrateBehavioralTraceQuestions({ ...identity, gold: rows, findings, evidenceRefs })
    .find((row) => row.questionId === question)!

describe('behavioral calibration rows', () => {
  let directory: string
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'behavioral-calibration-'))
  })
  afterAll(async () => {
    await rm(directory, { recursive: true, force: true })
  })

  it('reproduces precision, recall and AUC with a seeded cluster interval around the point', () => {
    const row = calibrate(gold)
    expect(row).toMatchObject({ gold_n: 60, missingPredictions: 0, precision: 0.75, recall: 0.6 })
    expect(row.confusion).toEqual({
      yes: { yes: 12, no: 8, unsure: 0, missing: 0 },
      no: { yes: 4, no: 36, unsure: 0, missing: 0 },
    })
    expect(Math.abs(row.auc! - 0.83)).toBeLessThan(0.01)
    expect(row.ci).toMatchObject({ resamples: 2000, clusters: 6, cluster: 'subject' })
    expect(row.ci!.low).toBeLessThanOrEqual(row.auc!)
    expect(row.ci!.high).toBeGreaterThanOrEqual(row.auc!)
    expect(row.ci!.high - row.ci!.low).toBeGreaterThan(0)
    expect(row.kappa!).toBeCloseTo(0.526, 2)
    expect(row.kappaCi!.low).toBeLessThanOrEqual(row.kappa!)
    expect(row.kappaCi!.high).toBeGreaterThanOrEqual(row.kappa!)
    expect(row.eligible).toBe(false)
    expect(row.eligibleAuc).toBe(
      row.auc! >= DECISION_POINT_AUC_BAR.auc && row.ci!.low >= DECISION_POINT_AUC_BAR.ciLow,
    )
    expect(row.calibration).toMatchObject({ auc: row.auc, ci: row.ci, servedModel: identity.model })
    // The interval is seeded, so a second reading of the same evidence is the same interval.
    expect(calibrate(gold).ci).toEqual(row.ci)
  })

  it('returns a null AUC and no AUC eligibility for a one-class sample', () => {
    const row = calibrate(gold.filter((item) => item.label === 'yes'))
    expect(row).toMatchObject({
      gold_n: 20,
      precision: 1,
      recall: 0.6,
      auc: null,
      ci: null,
      eligibleAuc: false,
      eligible: false,
      calibration: null,
    })
    // Gold used one label while the judge used two, so p_e < 1 and κ is a measured zero, not undefined.
    expect(row.kappa).toBe(0)
  })

  it('binds auc and ci into the decision definition digest', () => {
    const certificate = { ...calibrate(gold).calibration!, servedModel: identity.model }
    const point = (calibration: typeof certificate) =>
      decisionPoint({
        id: 'fixture-point',
        version: '1',
        layers: ['event'],
        model: identity.model,
        questions: { [question]: api.BEHAVIORAL_TRACE_QUESTIONS[question] },
        policy: {
          [question]: {
            minimumProbability: 0.6,
            minimumMargin: 0.2,
            options: {
              yes: { action: 'act', route: 'coordinator-alarm' },
              no: { action: 'record' },
              unsure: { action: 'escalate' },
            },
            calibration,
          },
        },
        ledger: api.openFindingsLedger({ path: join(directory, 'ledger.jsonl') }),
        evaluator: {
          evaluate: async () => {
            throw new Error('fixture never evaluates')
          },
        },
      }).definitionDigest
    expect(point(certificate)).toBe(point(structuredClone(certificate)))
    expect(point({ ...certificate, auc: 0.9 })).not.toBe(point(certificate))
    expect(point({ ...certificate, ci: { ...certificate.ci!, low: 0.5 } })).not.toBe(
      point(certificate),
    )
  })

  it('calibrates an eight-label choice question with a row per option and a multi-class κ', () => {
    const labels = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']
    // 64 items, 8 per label over 8 clusters; 5 of each label are answered right, 3 slip to the next label.
    const items = labels.flatMap((label, l) =>
      Array.from({ length: 8 }, (_, i) => ({
        id: `${label}-${i}`,
        label,
        choice: i < 5 ? label : labels[(l + 1) % 8]!,
        cluster: `agent-${i}`,
      })),
    )
    const choiceGold: ChoiceGold[] = [
      ...items,
      { id: 'blank', label: null },
      { id: 'outside', label: 'insufficient_evidence' },
    ]
    const predictions: ChoicePrediction[] = items.map((item) => ({
      id: item.id,
      cluster: item.cluster,
      choice: item.choice,
      probabilities: Object.fromEntries(
        labels.map((label) => [label, label === item.choice ? 0.6 : 0.4 / 7]),
      ),
    }))
    const report = api.calibrateChoiceQuestion(choiceGold, predictions)
    expect(report).toMatchObject({
      options: labels,
      gold_n: 64,
      missingLabels: 2,
      missingPredictions: 0,
      abstentions: 0,
      agreement: 0.625,
    })
    expect(report.kappa!).toBeCloseTo(0.5714, 3)
    expect(report.kappaCi!.clusters).toBe(8)
    expect(report.rows).toHaveLength(8)
    for (const row of report.rows) {
      expect(row).toMatchObject({ gold_n: 8, predicted: 8, precision: 0.625, recall: 0.625 })
      expect(row.auc!).toBeCloseTo(0.7857, 3)
      expect(row.ci).toMatchObject({ clusters: 8, cluster: 'cluster', resamples: 2000 })
      expect(row.eligibleAuc).toBe(false)
    }
    const thin = api.calibrateChoiceQuestion(
      [
        { id: 'x1', label: 'x' },
        { id: 'y1', label: 'y' },
      ],
      [{ id: 'x1', choice: 'insufficient_evidence', probabilities: { x: 0.5, y: 0.5 } }],
    )
    expect(thin).toMatchObject({ gold_n: 2, missingPredictions: 1, abstentions: 1 })
    expect(thin.rows.map((row) => row.auc)).toEqual([null, null])
  })
})
