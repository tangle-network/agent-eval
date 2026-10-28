import { createServer } from 'node:http'
import { describe, expect, it } from 'vitest'
import { AnalystRegistry, type ExactRegistryRunOpts, makeFinding } from '../src/index'
import { hashCanonical } from '../src/ledger-core/canonical'
import { systemOneAnalyst } from '../src/systemone'

const questions = { supported: { type: 'noul' } } as const

const policy: ExactRegistryRunOpts = {
  analystIds: ['review'],
  budget: null,
  totalTimeoutMs: 5_000,
  signal: null,
  costLedger: null,
  costLedgerIdentity: null,
  costPhase: null,
  tags: null,
  priorFindings: null,
  chainFindings: false,
  missingInputMode: 'abort',
  applyRegistryHooks: false,
  useRegistryChat: false,
}

describe('System One exact execution over the caller-owned HTTP transport', () => {
  it('binds detached effective controls and records the actual response and usage without a wrapper', async () => {
    const requests: { path: string; body: unknown }[] = []
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      requests.push({ path: request.url ?? '', body: JSON.parse(Buffer.concat(chunks).toString()) })
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(
        JSON.stringify({
          model: 'served-http-peer',
          answers: { supported: { type: 'noul', noul: 0.75 } },
          usage: { input_tokens: 12, output_tokens: 2 },
        }),
      )
    })
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(0, '127.0.0.1', resolve)
      })
      const address = server.address()
      if (address === null || typeof address === 'string') throw new Error('HTTP peer has no port')
      const baseUrl = `http://127.0.0.1:${address.port}`
      const digests: string[] = []
      for (const route of ['first', 'second']) {
        const controls = { endpoint: `${baseUrl}/${route}`, requestLimit: 1 }
        const expected = hashCanonical(controls)
        const observed: string[] = []
        const analyst = systemOneAnalyst<string, typeof questions>({
          id: 'review',
          description: 'Review supplied state over the selected transport',
          inputKind: 'custom',
          model: 'requested-alias',
          version: '1',
          executionConfig: controls,
          questions,
          renderState: (input) => input,
          pricing: { inputUsdPerMillion: 1, outputUsdPerMillion: 2 },
          evaluate: async (request, context) => {
            const response = await fetch(`${baseUrl}/${route}`, {
              method: 'POST',
              headers: {
                'content-type': 'application/json',
                'idempotency-key': context.idempotencyKey,
              },
              body: JSON.stringify(request),
              signal: context.signal,
            })
            if (!response.ok) throw new Error(`HTTP peer refused ${response.status}`)
            return response.json()
          },
          record: (result) => {
            observed.push(result.value.model)
          },
          findings: (result) => [
            makeFinding({
              analyst_id: 'review',
              severity: 'info',
              area: 'integration',
              claim: 'The HTTP response was retained.',
              confidence: result.answers.supported.noul,
              evidence_refs: [],
              metadata: { served_model: result.model },
            }),
          ],
        })
        controls.endpoint = `${baseUrl}/mutated`
        const registry = new AnalystRegistry()
        registry.register(analyst)
        const result = await registry.runExact(
          `http-${route}`,
          { custom: { review: 'Recorded trace state' } },
          policy,
        )
        const digest = result.execution_plan.analysts[0]?.execution_config_digest
        expect(digest).toBe(expected)
        digests.push(digest ?? '')
        expect(result.completion.status).toBe('complete')
        expect(result.per_analyst[0]).toMatchObject({
          status: 'ok',
          usage: { calls: 1, tokens: { input: 12, output: 2 }, cost: { kind: 'estimated' } },
        })
        expect(result.total_cost_usd).toBeGreaterThan(0)
        expect(result.findings[0]?.metadata?.served_model).toBe('served-http-peer')
        expect(observed).toEqual(['served-http-peer'])
      }
      expect(new Set(digests).size).toBe(2)
      expect(requests.map((request) => request.path)).toEqual(['/first', '/second'])
      expect(requests.map((request) => request.body)).toEqual([
        {
          model: 'requested-alias',
          state: 'Recorded trace state',
          questions: { supported: { type: 'noul' } },
        },
        {
          model: 'requested-alias',
          state: 'Recorded trace state',
          questions: { supported: { type: 'noul' } },
        },
      ])
    } finally {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
})
