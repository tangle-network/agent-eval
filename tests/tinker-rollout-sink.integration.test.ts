import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import {
  type RolloutLine,
  readRolloutLedger,
  type TinkerDatum,
  type TinkerExportOptions,
  toTinkerDatumRows,
  writeRolloutLedger,
} from '../src/rollout'

// Synthetic responses exist only at the external HTTP peer. No internal ledger/gate/pricer is
// replaced. This proves format/eligibility transport, not a real sampled policy or20 environments.
function peerLine(id: string, reward: number | null): RolloutLine {
  return {
    schema: 'tangle.rollout.v1',
    rollout_id: id,
    parent_rollout_id: null,
    run_id: `run-${id}`,
    experiment_id: null,
    candidate_id: null,
    generation: null,
    candidate_index: null,
    role: 'agent',
    task: { suite: 'loopback-boundary-control', instance_id: id, split: 'search', seed: 0, rep: 0 },
    policy: {
      harness: 'protocol-fixture',
      harness_version: null,
      model: 'fixture@1',
      provider: null,
      profile_commit: null,
      sampling: null,
    },
    messages: [
      { role: 'user', content: 'Question' },
      { role: 'assistant', content: 'Answer' },
    ],
    steps: [
      {
        kind: 'llm',
        name: 'sample',
        llm_call_count: 1,
        prompt_token_ids: [11, 12],
        completion_token_ids: [13, 14],
        logprobs: [-0.2, -0.4],
      },
    ],
    outcome: {
      reward,
      reward_source: reward === null ? null : 'protocol-control',
      verdict: null,
      metrics: {},
      is_completed: true,
      is_truncated: false,
      error: null,
      realness_gated: false,
      realness_screened: true,
    },
    cost: {
      usd: null,
      tokens_in: null,
      tokens_out: null,
      tokens_reasoning: null,
      cache_read: null,
      cache_write: null,
      wall_s: null,
    },
    artifacts: { patch_path: null, run_dir: null, transcript_ref: null },
    provenance: { captured_at: '2026-10-25T00:00:00.000Z', capture: 'settle-time' },
  }
}

const options: TinkerExportOptions = {
  model: 'fixture@1',
  decodeTokens: () => 'boundary control',
  advantageOf: (line) => (line.outcome.reward === 0 ? -0.5 : 0.5),
}

async function boundary(
  source: RolloutLine[],
  exercise: (
    lines: Awaited<ReturnType<typeof readRolloutLedger>>,
    url: string,
    dir: string,
  ) => Promise<void>,
) {
  const dir = await mkdtemp(join(tmpdir(), 'tinker-rollout-'))
  const errors: unknown[] = []
  let bodyFailed = false
  const server = createServer((req, res) => {
    void (async () => {
      if (req.method === 'GET' && req.url === '/rollouts') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify(source))
        return
      }
      if (req.method !== 'POST' || req.url !== '/datum-intake')
        throw new Error('unexpected peer route')
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(Buffer.from(chunk))
      const datums = JSON.parse(Buffer.concat(chunks).toString('utf8')) as TinkerDatum[]
      await writeRolloutReceipt(dir, datums)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ accepted: datums.length }))
    })().catch((error: unknown) => {
      errors.push(error)
      res.writeHead(400)
      res.end('invalid protocol control')
    })
  })
  try {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    const response = await fetch(`${url}/rollouts`)
    expect(response.ok).toBe(true)
    const ledger = join(dir, 'rollouts.jsonl')
    await writeRolloutLedger(ledger, (await response.json()) as RolloutLine[])
    const loaded = await readRolloutLedger(ledger)
    await exercise(loaded, url, dir)
    expect(errors).toEqual([])
  } catch (error) {
    bodyFailed = true
    errors.unshift(error)
  } finally {
    server.closeAllConnections()
    try {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      )
    } catch (error) {
      errors.push(error)
    }
    if (!bodyFailed && errors.length === 0) {
      try {
        await rm(dir, { recursive: true, force: true })
      } catch (error) {
        errors.push(error)
      }
    }
  }
  if (errors.length > 0) {
    console.error(`Tinker boundary retained at ${dir}`)
    if (errors.length === 1) throw errors[0]
    throw new AggregateError(errors, 'Tinker public boundary/cleanup failed')
  }
}

async function writeRolloutReceipt(dir: string, datums: TinkerDatum[]) {
  const { writeFile } = await import('node:fs/promises')
  await writeFile(
    join(dir, 'received.jsonl'),
    datums.map((datum) => JSON.stringify(datum)).join('\n'),
  )
}

it('reads canonical filesystem rows and sends aligned Datums with honest zero reward to the HTTP boundary', async () => {
  const source = [peerLine('success', 1), peerLine('honest-failure', 0), peerLine('unknown', null)]
  const dev = peerLine('dev', 1)
  dev.task.split = 'dev'
  const gated = peerLine('gated', 0)
  gated.outcome.realness_gated = true
  await boundary([...source, dev, gated], async (lines, url, dir) => {
    const before = JSON.stringify(lines)
    const rows = toTinkerDatumRows(lines, options)
    expect(rows.map((row) => row.rollout_id)).toEqual(['success', 'honest-failure'])
    expect(rows.map((row) => row.reward)).toEqual([1, 0])
    expect(rows[0]!.datum.model_input.chunks[0]!.tokens).toEqual([11, 12, 13])
    expect(rows[0]!.datum.loss_fn_inputs.target_tokens.data).toEqual([12, 13, 14])
    expect(rows[0]!.datum.loss_fn_inputs.logprobs.data).toEqual([0, -0.2, -0.4])
    expect(rows[0]!.datum.loss_fn_inputs.advantages.data).toEqual([0, 0.5, 0.5])
    expect(rows[1]!.datum.loss_fn_inputs.advantages.data).toEqual([0, -0.5, -0.5])
    expect(Object.keys(rows[0]!.datum.loss_fn_inputs).sort()).toEqual([
      'advantages',
      'logprobs',
      'target_tokens',
    ])
    const response = await fetch(`${url}/datum-intake`, {
      method: 'POST',
      body: JSON.stringify(rows.map((row) => row.datum)),
    })
    expect(response.ok).toBe(true)
    expect(await response.json()).toEqual({ accepted: 2 })
    const persisted = (await readFile(join(dir, 'received.jsonl'), 'utf8'))
      .split('\n')
      .map((line) => JSON.parse(line))
    expect(persisted).toEqual(rows.map((row) => row.datum))
    expect(JSON.stringify(lines)).toBe(before)
  })
}, 15_000)

it('refuses incomplete sampling capture, model mismatch and tokenized secrets; held-out input needs explicit consent', async () => {
  const missing = peerLine('missing', 1)
  delete missing.steps![0]!.logprobs
  const heldout = peerLine('heldout', 1)
  heldout.task.split = 'holdout'
  await boundary([missing, heldout], async (lines) => {
    expect(() => toTinkerDatumRows([lines[0]!], options)).toThrow('sampling logprobs')
    expect(toTinkerDatumRows([lines[1]!], options)).toEqual([])
    expect(
      toTinkerDatumRows([lines[1]!], { ...options, allowHeldOutTrainingData: true }),
    ).toHaveLength(1)
    // The callback is a JavaScript boundary: an unavailable baseline must not coerce to zero.
    for (const unavailable of [null, false, '0.5']) {
      const advantageOf = (() => unavailable) as unknown as TinkerExportOptions['advantageOf']
      expect(() =>
        toTinkerDatumRows([lines[1]!], {
          ...options,
          allowHeldOutTrainingData: true,
          advantageOf,
        }),
      ).toThrow('advantage must be a finite number')
    }
    expect(() =>
      toTinkerDatumRows([lines[1]!], {
        ...options,
        allowHeldOutTrainingData: true,
        model: 'other',
      }),
    ).toThrow('model identity')
    expect(() =>
      toTinkerDatumRows([lines[1]!], {
        ...options,
        allowHeldOutTrainingData: true,
        decodeTokens: () => 'API_KEY=fixture-secret-value',
      }),
    ).toThrow('scrubbing')
  })
}, 15_000)
