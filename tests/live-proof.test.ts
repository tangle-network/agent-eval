import { describe, expect, it } from 'vitest'
import { InMemoryFeedbackTrajectoryStore, runLiveProof } from '../src/index'

describe('runLiveProof', () => {
  it('records live artifacts, feedback, transcript, and release confidence evidence', async () => {
    const store = new InMemoryFeedbackTrajectoryStore()
    const result = await runLiveProof({
      projectId: 'tax-agent',
      scenarioId: 'tax-live-doc-review',
      task: 'prepare a filing brief from uploaded tax documents',
      requiredArtifacts: ['workspace', 'uploaded_document', 'generated_pdf'],
      minPassRate: 1,
      trajectoryStore: store,
      releaseConfidence: {
        target: 'tax-agent/live-proof',
        thresholds: {
          minPassRate: 1,
          minMeanScore: 1,
        },
      },
      drive: (ctx) => {
        ctx.addTurn({ role: 'user', content: 'I uploaded W-2s and bank statements.' })
        ctx.addTurn({
          role: 'assistant',
          content: 'I will inspect documents, compute forms, and generate PDFs.',
        })
        ctx.addArtifact({ kind: 'workspace', id: 'ws_1' })
        ctx.addArtifact({ kind: 'uploaded_document', path: '/documents/w2.pdf' })
        ctx.addArtifact({ kind: 'generated_pdf', path: '/output/1040.pdf' })
        ctx.addLabel({ source: 'environment', kind: 'approve', value: true })
        ctx.addCheck({
          name: 'pdf_field_readback',
          passed: true,
          expected: 'readable generated PDF',
          actual: 'readable',
        })
      },
    })

    expect(result.passed).toBe(true)
    expect(result.releaseConfidence?.status).toBe('pass')
    expect(result.trajectory.outcome?.success).toBe(true)
    expect(result.transcript).toHaveLength(2)
    await expect(store.get(result.trajectory.id)).resolves.not.toBeNull()
  })

  it('fails closed when required live artifacts are missing', async () => {
    const result = await runLiveProof({
      projectId: 'creative-agent',
      scenarioId: 'creative-live-generation',
      task: 'generate and fetch a creative artifact',
      requiredArtifacts: ['workspace', 'fetched_artifact'],
      drive: (ctx) => {
        ctx.addArtifact({ kind: 'workspace', id: 'ws_1' })
      },
    })

    expect(result.passed).toBe(false)
    expect(result.checks.find((check) => check.name === 'artifact:fetched_artifact')?.passed).toBe(
      false,
    )
  })

  it('preserves runtime failures as structured check results', async () => {
    const result = await runLiveProof({
      projectId: 'legal-agent',
      scenarioId: 'legal-live-redline',
      task: 'review a contract and produce versioned redlines',
      drive: () => {
        throw new Error('sandbox unavailable')
      },
    })

    expect(result.passed).toBe(false)
    expect(result.checks).toContainEqual(
      expect.objectContaining({
        name: 'live_proof_runtime',
        passed: false,
        actual: 'sandbox unavailable',
      }),
    )
  })
})
