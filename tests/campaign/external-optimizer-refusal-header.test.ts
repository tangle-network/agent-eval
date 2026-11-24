import { execFile } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { testModelExecutionOwner } from '../../src/analyst/model-execution.test-support'
import { EXTERNAL_OPTIMIZER_REFUSAL_HEADER } from '../../src/campaign/external-optimizer-contracts'
import { handleModelProxyRequest } from '../../src/campaign/external-optimizer-model-handler'
import { CostLedger } from '../../src/cost-ledger'

const runBridge = promisify(execFile)

const officialPython = process.env.AGENT_EVAL_TEST_PYTHON?.trim()
const officialIt = officialPython ? it : it.skip

// A refusal reason no header value could carry: Cyrillic and an em dash are
// outside Latin-1 and the newline is a control character.
const NON_LATIN_1_REFUSAL_REASON =
  'optimizer model cost limit — лимит reached\nno further spend'

const MODEL_BUDGET = {
  maxCostUsd: 0.1,
  maxRequests: 2,
  maxRequestBytes: 100_000,
  maxResponseBytes: 100_000,
  maxOutputTokensPerRequest: 100,
  pricing: {
    inputUsdPerMillion: 1,
    outputUsdPerMillion: 2,
  },
}

const openServers: Server[] = []

afterEach(async () => {
  await Promise.all(
    openServers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.closeAllConnections?.()
          server.close((error) => (error ? reject(error) : resolve()))
        }),
    ),
  )
})

describe('refusal reason never crosses into the refusal header value', () => {
  it(
    'answers a non-Latin-1 refusal reason with 429, a fixed kind code, and the reason in the body',
    async () => {
      const { origin, token, refusedRequests } = await startRefusingModelProxy()
      const response = await fetch(`${origin}/v1/chat/completions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(chatRequest()),
      })
      expect(response.status).toBe(429)
      expect(response.headers.get(EXTERNAL_OPTIMIZER_REFUSAL_HEADER)).toBe('cost-limit')
      expect(await response.json()).toEqual({ error: NON_LATIN_1_REFUSAL_REASON })
      expect(refusedRequests()).toBe(1)
    },
  )

  officialIt(
    'counts one refused attempt in the Python bridge for the same response',
    async () => {
      const { origin, token } = await startRefusingModelProxy()
      const { stdout } = await runBridge(officialPython!, [
        '-c',
        BRIDGE_COUNTING_SCRIPT,
        `${origin}/v1/chat/completions`,
        token,
      ])
      const observed = JSON.parse(stdout) as {
        status: number
        refusalHeader: string | null
        error: unknown
        usage: Record<string, number>
      }
      expect(observed.status).toBe(429)
      expect(observed.refusalHeader).toBe('cost-limit')
      expect(observed.error).toBe(NON_LATIN_1_REFUSAL_REASON)
      expect(observed.usage).toMatchObject({
        calls: 0,
        requestAttempts: 1,
        refusedAttempts: 1,
      })
    },
    60_000,
  )
})

function chatRequest(): Record<string, unknown> {
  return {
    model: 'model',
    max_tokens: 20,
    messages: [{ role: 'user', content: 'improve' }],
  }
}

/**
 * Serve the real model-proxy request handler with a reservation owner that
 * refuses every request, so the refusal wire format is observed end to end.
 */
async function startRefusingModelProxy(): Promise<{
  origin: string
  token: string
  refusedRequests: () => number
}> {
  const token = 'refusal-header-test-token'
  let refused = 0
  const ledger = new CostLedger()
  const owner = testModelExecutionOwner({ fetchImpl: fetch })
  const server = createServer((request, response) => {
    void handleModelProxyRequest({
      request,
      response,
      controller: new AbortController(),
      token,
      args: {
        call: owner.call,
        callRef: owner.callRef,
        recordExecution: owner.recordExecution,
        model: 'model',
        budget: MODEL_BUDGET,
        costLedger: ledger,
        phase: 'test.optimizer-model',
        actor: 'refusal-header-test',
      },
      nextReservation: () => {
        refused += 1
        return {
          accepted: false as const,
          kind: 'cost-limit' as const,
          reason: NON_LATIN_1_REFUSAL_REASON,
        }
      },
      settleReservation: () => {},
      recordSuccessfulCompletion: () => {},
      recordExecutionReceipt: () => {},
      recordModelCallInvocation: () => {},
      recordFailure: () => {},
    })
  })
  openServers.push(server)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('refusing proxy failed to bind')
  return {
    origin: `http://127.0.0.1:${address.port}`,
    token,
    refusedRequests: () => refused,
  }
}

// One request through the same httpx event hooks the GEPA bridge installs, so
// the bridge's own refusal counting observes the proxy's actual response.
const BRIDGE_COUNTING_SCRIPT = [
  'import json',
  'import sys',
  '',
  'import httpx',
  '',
  'from agent_eval_rpc.gepa_model_proxy import _ProxyUsage',
  '',
  'url, token = sys.argv[1], sys.argv[2]',
  'usage = _ProxyUsage()',
  'client = httpx.Client(',
  '    event_hooks={',
  '        "request": [usage.observe_request],',
  '        "response": [usage.observe_response],',
  '    },',
  '    timeout=5,',
  ')',
  'try:',
  '    response = client.post(',
  '        url,',
  '        headers={"Authorization": f"Bearer {token}"},',
  '        json={',
  '            "model": "model",',
  '            "messages": [{"role": "user", "content": "improve"}],',
  '            "max_tokens": 20,',
  '        },',
  '    )',
  '    print(',
  '        json.dumps(',
  '            {',
  '                "status": response.status_code,',
  '                "refusalHeader": response.headers.get("x-agent-eval-refusal"),',
  '                "error": response.json().get("error"),',
  '                "usage": usage.snapshot(),',
  '            },',
  '            ensure_ascii=False,',
  '        )',
  '    )',
  'finally:',
  '    usage.close()',
].join('\n')
