import { describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  loadYamlPersonas,
  loadTsPersonas,
  runPersonaEval,
} from '../src/persona'
import type {
  PersonaRunner,
  PersonaScorer,
  PersonaSpec,
} from '../src/persona'
import { LlmRouteAssertionError } from '../src/llm-client'

async function makeTmp(prefix = 'persona-eval-'): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), prefix))
}

function makePersona(id: string, turns: string[]): PersonaSpec<string> {
  return {
    id,
    label: id,
    turns: turns.map((t, i) => ({ id: `t${i}`, input: t })),
  }
}

const echoRunner: PersonaRunner<string, string> = async function* (ctx) {
  yield { kind: 'model', model: 'echo@2026-05-08' }
  yield { kind: 'text', text: `echo:${ctx.turn.input}` }
  yield { kind: 'output', output: `echo:${ctx.turn.input}` }
  yield { kind: 'cost', usd: 0.001, tokenUsage: { input: 10, output: 5 } }
}

const passScorer: PersonaScorer<string> = ({ persona, finalText }) => ({
  pass: finalText.includes(persona.turns[0]!.input as string),
  score: 1,
})

describe('runPersonaEval — synthetic happy path', () => {
  it('produces raws/traces/records/manifest under the runId directory', async () => {
    const dir = await makeTmp()
    const artifact = await runPersonaEval({
      personas: [makePersona('p1', ['hello']), makePersona('p2', ['world'])],
      runner: echoRunner,
      scorer: passScorer,
      artifactDir: dir,
      runId: 'fixed-run',
      commitSha: 'deadbeef',
      captureIntegrity: { rawProviderSinkRequired: false, assertLlmRoute: false },
    })

    expect(artifact.runId).toBe('fixed-run')
    expect(artifact.personas).toHaveLength(2)
    expect(artifact.manifest.passCount).toBe(2)
    expect(artifact.manifest.failCount).toBe(0)
    expect(artifact.manifest.commitSha).toBe('deadbeef')
    expect(artifact.manifest.variantIds).toEqual(['baseline'])

    const runDir = path.join(dir, 'fixed-run')
    const expected = ['raws.jsonl', 'traces.jsonl', 'records.jsonl', 'manifest.json']
    for (const file of expected) {
      const stat = await fs.stat(path.join(runDir, file))
      expect(stat.isFile()).toBe(true)
    }
    const records = await fs.readFile(path.join(runDir, 'records.jsonl'), 'utf8')
    expect(records.trim().split('\n')).toHaveLength(2)
    const manifest = JSON.parse(await fs.readFile(path.join(runDir, 'manifest.json'), 'utf8'))
    expect(manifest.personaCount).toBe(2)
  })

  it('threads turn-by-turn state and feeds the scorer correct context', async () => {
    const dir = await makeTmp()
    const seen: string[] = []
    const runner: PersonaRunner<string, string> = async function* (ctx) {
      seen.push(`${ctx.persona.id}/${ctx.turn.id}/state.history.len=${ctx.state.history.length}`)
      yield { kind: 'text', text: `t${ctx.state.turnIndex}` }
    }
    const scorer: PersonaScorer<string> = ({ history, finalText }) => ({
      pass: history.length === 3,
      score: history.length === 3 ? 1 : 0,
      raw: { historyLen: history.length, finalLen: finalText.length },
    })
    const artifact = await runPersonaEval({
      personas: [makePersona('three-turn', ['a', 'b', 'c'])],
      runner,
      scorer,
      artifactDir: dir,
      captureIntegrity: { rawProviderSinkRequired: false, assertLlmRoute: false },
    })
    expect(seen).toEqual([
      'three-turn/t0/state.history.len=0',
      'three-turn/t1/state.history.len=1',
      'three-turn/t2/state.history.len=2',
    ])
    expect(artifact.personas[0]!.outcome.pass).toBe(true)
    expect(artifact.personas[0]!.outcome.raw?.historyLen).toBe(3)
  })

  it('honors the personaFilter option', async () => {
    const dir = await makeTmp()
    const artifact = await runPersonaEval({
      personas: [
        makePersona('keep', ['x']),
        makePersona('drop', ['y']),
      ],
      runner: echoRunner,
      scorer: passScorer,
      artifactDir: dir,
      personaFilter: (p) => p.id === 'keep',
      captureIntegrity: { rawProviderSinkRequired: false, assertLlmRoute: false },
    })
    expect(artifact.personas).toHaveLength(1)
    expect(artifact.personas[0]!.personaId).toBe('keep')
  })
})

describe('runPersonaEval — capture integrity', () => {
  it('asserts the LLM route at preflight when llmOpts present', async () => {
    const dir = await makeTmp()
    await expect(
      runPersonaEval({
        personas: [makePersona('p', ['x'])],
        runner: echoRunner,
        scorer: passScorer,
        artifactDir: dir,
        llmOpts: { /* no baseUrl */ },
      }),
    ).rejects.toBeInstanceOf(LlmRouteAssertionError)
  })

  it('flags integrity issues when the runner never emits raws and the sink is required', async () => {
    const dir = await makeTmp()
    const artifact = await runPersonaEval({
      personas: [makePersona('p', ['x'])],
      runner: echoRunner,
      scorer: passScorer,
      artifactDir: dir,
      captureIntegrity: {
        rawProviderSinkRequired: true,
        assertLlmRoute: false,
        expectations: { rawProviderEventsMin: 1, requireOutcome: true },
      },
    })
    // The default echoRunner emits no raw provider events, so the integrity
    // report should call this out by raising missing_raw_events.
    expect(artifact.personas[0]!.integrity.issues.map((i) => i.code))
      .toContain('missing_raw_events')
  })
})

describe('runPersonaEval — comparator + RL bridge', () => {
  it('produces an RL-bridge report when comparator + variants are provided', async () => {
    const dir = await makeTmp()
    const runner: PersonaRunner<string, string> = async function* (ctx) {
      const payload = ctx.state.variantPayload as string | undefined
      // Deterministic per-variant score signal.
      yield { kind: 'model', model: 'echo@2026-05-08' }
      yield { kind: 'output', output: payload ?? 'baseline' }
      yield { kind: 'cost', usd: 0.001, tokenUsage: { input: 1, output: 1 } }
    }
    let i = 0
    const scorer: PersonaScorer<string> = ({ history }) => {
      const variant = (history[0]?.output as string) ?? 'baseline'
      i++
      return { pass: variant === 'cand', score: variant === 'cand' ? 0.9 : 0.5 }
    }
    const artifact = await runPersonaEval({
      personas: [makePersona('p1', ['a']), makePersona('p2', ['b'])],
      runner,
      scorer,
      artifactDir: dir,
      variants: { baseline: 'baseline', cand: 'cand' },
      comparator: { baseline: 'baseline', variant: 'cand' },
      captureIntegrity: { rawProviderSinkRequired: false, assertLlmRoute: false },
    })
    expect(i).toBe(4)
    expect(artifact.rlBridge).toBeDefined()
    expect(artifact.rlBridge!.preferences.pairs.length).toBeGreaterThan(0)
    expect(artifact.manifest.artifactPaths.rlBridge).toBeDefined()
    const bridgePath = artifact.manifest.artifactPaths.rlBridge!
    const onDisk = JSON.parse(await fs.readFile(bridgePath, 'utf8'))
    expect(onDisk.comparator.variant).toBe('cand')
  })
})

describe('persona adapters', () => {
  it('loadYamlPersonas wraps tax-agent style YAML through a caller-supplied parser', async () => {
    const dir = await makeTmp('yaml-personas-')
    await fs.writeFile(
      path.join(dir, '01-foo.yaml'),
      'id: foo\nname: Foo Scenario\nprompt: do the foo\n',
      'utf8',
    )
    await fs.writeFile(
      path.join(dir, '02-bar.yaml'),
      'id: bar\nname: Bar Scenario\nturns:\n  - id: t0\n    input: hello bar\n',
      'utf8',
    )
    const personas = await loadYamlPersonas({
      paths: path.join(dir, '*.yaml'),
      parseYaml: tinyYamlParse,
    })
    expect(personas).toHaveLength(2)
    expect(personas[0]!.id).toBe('foo')
    expect(personas[0]!.turns[0]!.input).toBe('do the foo')
    expect(personas[1]!.id).toBe('bar')
    expect(personas[1]!.turns[0]!.input).toBe('hello bar')
  })

  it('loadTsPersonas extracts personas from a TS module via the default extractor', async () => {
    const dir = await makeTmp('ts-personas-')
    const mod = path.join(dir, 'mod.mjs')
    await fs.writeFile(
      mod,
      `export const personas = [
        { id: 'one', label: 'First', userMessage: 'go' },
        { id: 'two', label: 'Second', userMessage: 'stop' },
      ]`,
      'utf8',
    )
    const personas = await loadTsPersonas<{ id: string; label: string; userMessage: string }>({
      modulePath: mod,
      toPersonaSpec: (legacy) => ({
        id: legacy.id,
        label: legacy.label,
        turns: [{ id: 't0', input: legacy.userMessage }],
      }),
    })
    expect(personas).toHaveLength(2)
    expect(personas.map((p) => p.id)).toEqual(['one', 'two'])
  })
})

/**
 * A *tiny* YAML parser purpose-built for the small subset used in this
 * test. Production callers bring `yaml.parse`. We avoid taking a new
 * dependency for what amounts to a handful of test fixtures.
 */
function tinyYamlParse(text: string): unknown {
  const lines = text.split('\n')
  const root: Record<string, unknown> = {}
  let i = 0
  while (i < lines.length) {
    const line = lines[i]!
    if (!line.trim() || line.trim().startsWith('#')) { i++; continue }
    const m = line.match(/^([a-zA-Z0-9_]+):\s*(.*)$/)
    if (!m) { i++; continue }
    const [, key, rest] = m
    if (rest && rest.length > 0) {
      root[key!] = parseScalar(rest)
      i++
      continue
    }
    // Looks like an array of objects starting with `- `.
    const arr: Record<string, unknown>[] = []
    i++
    while (i < lines.length && lines[i]!.startsWith('  -')) {
      const item: Record<string, unknown> = {}
      const first = lines[i]!.replace(/^\s*-\s*/, '')
      const fm = first.match(/^([a-zA-Z0-9_]+):\s*(.*)$/)
      if (fm) item[fm[1]!] = parseScalar(fm[2]!)
      i++
      while (i < lines.length && /^    [a-zA-Z0-9_]+:/.test(lines[i]!)) {
        const sm = lines[i]!.match(/^\s+([a-zA-Z0-9_]+):\s*(.*)$/)!
        item[sm[1]!] = parseScalar(sm[2]!)
        i++
      }
      arr.push(item)
    }
    root[key!] = arr
  }
  return root
}

function parseScalar(s: string): unknown {
  const trimmed = s.trim()
  if (trimmed === 'true') return true
  if (trimmed === 'false') return false
  if (trimmed === '') return ''
  const num = Number(trimmed)
  if (!Number.isNaN(num) && /^-?[0-9.]+$/.test(trimmed)) return num
  return trimmed
}
