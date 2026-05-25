import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import * as gsm8k from '../examples/benchmarks/gsm8k/index'
import * as swebenchLite from '../examples/benchmarks/swebench-lite/index'
import * as routing from '../src/benchmarks/routing/index'
import { BENCHMARK_SPLIT_SEED, deterministicSplit } from '../src/benchmarks/types'

describe('deterministicSplit', () => {
  it('always returns one of search|dev|holdout', () => {
    for (let i = 0; i < 200; i++) {
      const tag = deterministicSplit(`item-${i}`)
      expect(['search', 'dev', 'holdout']).toContain(tag)
    }
  })

  it('is stable across calls', () => {
    const a = deterministicSplit('foo-1234')
    const b = deterministicSplit('foo-1234')
    expect(a).toBe(b)
  })

  it('hash distribution is roughly 60/20/20', () => {
    const counts: Record<string, number> = { search: 0, dev: 0, holdout: 0 }
    const N = 5000
    for (let i = 0; i < N; i++) counts[deterministicSplit(`x_${i}`)]! += 1
    expect(counts.search! / N).toBeGreaterThan(0.55)
    expect(counts.search! / N).toBeLessThan(0.65)
    expect(counts.dev! / N).toBeGreaterThan(0.15)
    expect(counts.dev! / N).toBeLessThan(0.25)
    expect(counts.holdout! / N).toBeGreaterThan(0.15)
    expect(counts.holdout! / N).toBeLessThan(0.25)
  })

  it('different seeds produce different assignments', () => {
    const a = deterministicSplit('item-x')
    const b = deterministicSplit('item-x', 'different-seed-v2')
    // Not guaranteed to differ on a single item, but at least the
    // seed param is read.
    const allSame = Array.from(
      { length: 100 },
      (_, i) =>
        deterministicSplit(`item-${i}`) === deterministicSplit(`item-${i}`, 'different-seed-v2'),
    ).every(Boolean)
    expect(allSame).toBe(false)
    expect(BENCHMARK_SPLIT_SEED).toBe('agent-eval-v1')
    void a
    void b
  })
})

// ── routing — synthetic dataset shipped in the package ──────────────

describe('routing benchmark', () => {
  it('loads non-empty splits', async () => {
    const search = await routing.loadDataset('search')
    const dev = await routing.loadDataset('dev')
    const hold = await routing.loadDataset('holdout')
    expect(search.length + dev.length + hold.length).toBe(routing.ROUTING_DATASET.length)
    expect(search.length).toBeGreaterThan(0)
  })

  it('scores correct route as 1', async () => {
    const all = await Promise.all([
      routing.loadDataset('search'),
      routing.loadDataset('dev'),
      routing.loadDataset('holdout'),
    ])
    const item = all.flat()[0]!
    const r = await routing.evaluate(item, `Picked route: ${item.payload.route}`)
    expect(r.score).toBe(1)
    expect(r.raw.matchedRoute).toBe(item.payload.route)
  })

  it('scores synonym as 1', async () => {
    const items = await routing.loadDataset(routing.assignSplit('file_001'))
    const item = items.find((i) => i.id === 'file_001')!
    expect(item).toBeDefined()
    const synonym = item.payload.synonyms[0]!
    const r = await routing.evaluate(item, `route=${synonym}`)
    expect(r.score).toBe(1)
  })

  it('scores wrong route as 0 and reports hard-negative hit', async () => {
    const items = await routing.loadDataset(routing.assignSplit('file_001'))
    const item = items.find((i) => i.id === 'file_001')!
    const wrong = item.payload.hardNegatives[0]!
    const r = await routing.evaluate(item, `route=${wrong}`)
    expect(r.score).toBe(0)
    expect(r.raw.hitHardNegative).toBe(true)
  })

  it('extracts route tokens from prose', () => {
    const tokens = routing.extractRouteTokens(
      'I think we should call fs.write here, not chat.reply.',
    )
    expect(tokens).toContain('fs.write')
    expect(tokens).toContain('chat.reply')
  })

  it('assignSplit is stable per id', () => {
    expect(routing.assignSplit('chat_001')).toBe(routing.assignSplit('chat_001'))
  })
})

// ── gsm8k — JSONL loader ────────────────────────────────────────────

describe('gsm8k benchmark', () => {
  let tmpDir: string
  let datasetPath: string
  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'agent-eval-gsm-'))
    datasetPath = join(tmpDir, 'gsm8k.jsonl')
    const rows = [
      { id: 'g1', question: '2+2?', answer: '#### 4' },
      { id: 'g2', question: '3*5?', answer: '#### 15' },
      { id: 'g3', question: '10-7?', answer: '#### 3' },
    ]
    writeFileSync(datasetPath, rows.map((r) => JSON.stringify(r)).join('\n'))
  })
  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('throws when AGENT_EVAL_GSM8K_PATH is unset', async () => {
    const prev = process.env.AGENT_EVAL_GSM8K_PATH
    delete process.env.AGENT_EVAL_GSM8K_PATH
    await expect(gsm8k.loadDataset('search')).rejects.toThrow(/AGENT_EVAL_GSM8K_PATH/)
    if (prev) process.env.AGENT_EVAL_GSM8K_PATH = prev
  })

  it('loads dataset rows from JSONL', async () => {
    process.env.AGENT_EVAL_GSM8K_PATH = datasetPath
    const all = [
      ...(await gsm8k.loadDataset('search')),
      ...(await gsm8k.loadDataset('dev')),
      ...(await gsm8k.loadDataset('holdout')),
    ]
    expect(all).toHaveLength(3)
    delete process.env.AGENT_EVAL_GSM8K_PATH
  })

  it('parseGsm8kAnswer respects the #### marker', () => {
    expect(gsm8k.parseGsm8kAnswer('First, blah blah.\n#### 42')).toBe(42)
    expect(gsm8k.parseGsm8kAnswer('plain text 17')).toBe(17)
    expect(gsm8k.parseGsm8kAnswer('1,234')).toBe(1234)
    expect(gsm8k.parseGsm8kAnswer('no number here')).toBeNull()
  })

  it('evaluate returns 1 on exact match, 0 otherwise', async () => {
    const item = {
      id: 'g1',
      payload: { question: '2+2?', answer: '#### 4' },
    }
    const ok = await gsm8k.evaluate(item, 'The answer is #### 4')
    expect(ok.score).toBe(1)
    expect(ok.raw.exactMatch).toBe(true)
    const bad = await gsm8k.evaluate(item, 'The answer is 5')
    expect(bad.score).toBe(0)
  })
})

// ── swebench-lite — external grader ─────────────────────────────────

describe('swebench-lite benchmark (external grader)', () => {
  it('throws when AGENT_EVAL_SWEBENCH_PATH is unset', async () => {
    const prev = process.env.AGENT_EVAL_SWEBENCH_PATH
    delete process.env.AGENT_EVAL_SWEBENCH_PATH
    await expect(swebenchLite.loadDataset('search')).rejects.toThrow(/AGENT_EVAL_SWEBENCH_PATH/)
    if (prev) process.env.AGENT_EVAL_SWEBENCH_PATH = prev
  })

  it('throws on evaluate without a configured grader', async () => {
    const prevGrader = process.env.AGENT_EVAL_SWEBENCH_GRADER_CMD
    delete process.env.AGENT_EVAL_SWEBENCH_GRADER_CMD
    await expect(
      swebenchLite.evaluate(
        {
          id: 'inst1',
          payload: {
            instanceId: 'inst1',
            problemStatement: '',
            baseCommit: '',
            repo: '',
            failToPass: [],
            passToPass: [],
          },
        },
        'patch',
      ),
    ).rejects.toThrow(/AGENT_EVAL_SWEBENCH_GRADER_CMD/)
    if (prevGrader) process.env.AGENT_EVAL_SWEBENCH_GRADER_CMD = prevGrader
  })

  it('assignSplit is deterministic', () => {
    expect(swebenchLite.assignSplit('django__django-1234')).toBe(
      swebenchLite.assignSplit('django__django-1234'),
    )
  })

  it('parses quoted grader commands', () => {
    expect(
      swebenchLite.parseSweBenchGraderCommand('"node binary" ./grader.js --flag "two words"'),
    ).toEqual(['node binary', './grader.js', '--flag', 'two words'])
    expect(() => swebenchLite.parseSweBenchGraderCommand('"unterminated')).toThrow(/unterminated/)
  })

  it('runs a configured grader command', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'agent-eval-swebench-'))
    const graderPath = join(tmpDir, 'grader with space.mjs')
    writeFileSync(
      graderPath,
      [
        "let input = '';",
        "process.stdin.on('data', (chunk) => input += chunk);",
        "process.stdin.on('end', () => {",
        '  const payload = JSON.parse(input);',
        '  process.stdout.write(JSON.stringify({',
        "    passed: payload.instance_id === 'inst1' && payload.patch.includes('fix'),",
        '    fail_to_pass_passed: true,',
        '    pass_to_pass_passed: true,',
        "    log: 'ok'",
        '  }));',
        '});',
      ].join('\n'),
    )
    chmodSync(graderPath, 0o755)
    const prevGrader = process.env.AGENT_EVAL_SWEBENCH_GRADER_CMD
    const prevTimeout = process.env.AGENT_EVAL_SWEBENCH_GRADER_TIMEOUT_MS
    process.env.AGENT_EVAL_SWEBENCH_GRADER_CMD = `node "${graderPath}"`
    process.env.AGENT_EVAL_SWEBENCH_GRADER_TIMEOUT_MS = '5000'
    try {
      const result = await swebenchLite.evaluate(
        {
          id: 'inst1',
          payload: {
            instanceId: 'inst1',
            problemStatement: '',
            baseCommit: '',
            repo: '',
            failToPass: [],
            passToPass: [],
          },
        },
        'fix patch',
      )
      expect(result.score).toBe(1)
      expect(result.raw).toMatchObject({
        passed: true,
        failToPassPassed: true,
        passToPassPassed: true,
      })
    } finally {
      if (prevGrader) process.env.AGENT_EVAL_SWEBENCH_GRADER_CMD = prevGrader
      else delete process.env.AGENT_EVAL_SWEBENCH_GRADER_CMD
      if (prevTimeout) process.env.AGENT_EVAL_SWEBENCH_GRADER_TIMEOUT_MS = prevTimeout
      else delete process.env.AGENT_EVAL_SWEBENCH_GRADER_TIMEOUT_MS
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })
})
