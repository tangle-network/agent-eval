import { describe, expect, it } from 'vitest'

import type { Span } from '../trace/schema'
import {
  compileStoryboard,
  reduceToSemanticEvents,
  renderStoryboardHtml,
  renderStoryboardMarkdown,
} from './index'

function llm(spanId: string, ts: number): Span {
  return {
    spanId,
    runId: 'r1',
    kind: 'llm',
    name: 'chat',
    model: 'gpt-4o-mini',
    messages: [],
    startedAt: ts,
    endedAt: ts + 50,
    status: 'ok',
  }
}
function tool(spanId: string, ts: number, toolName: string, over: Partial<Span> = {}): Span {
  return {
    spanId,
    runId: 'r1',
    kind: 'tool',
    name: toolName,
    toolName,
    startedAt: ts,
    endedAt: ts + 30,
    status: 'ok',
    ...over,
  } as Span
}

// A realistic little run: reason → read 3 files → edit → run tests (fail) → fix → done.
const SPANS: Span[] = [
  llm('s1', 1000),
  tool('s2', 1100, 'read_file', { args: { path: 'a.ts' } }),
  tool('s3', 1200, 'read_file', { args: { path: 'b.ts' } }),
  tool('s4', 1300, 'read_file', { args: { path: 'c.ts' } }),
  tool('s5', 1400, 'str_replace_editor', { args: { path: 'a.ts' } }),
  tool('s6', 1500, 'shell.exec', {
    args: 'npm test',
    status: 'error',
    error: 'redirect_uri_mismatch',
  }),
  tool('s7', 1600, 'str_replace_editor', { args: { path: '.env' } }),
  tool('s8', 1700, 'shell.exec', { args: 'npm test' }),
]

describe('reduceToSemanticEvents', () => {
  it('classifies spans by kind/toolName and a failed span always stands alone', () => {
    const evs = reduceToSemanticEvents(SPANS)
    const kinds = evs.map((e) => e.kind)
    // 3 reads collapse to one; the failure is never folded into neighbours.
    expect(kinds).toEqual([
      'reasoned',
      'read_file',
      'edited_code',
      'observed_failure',
      'edited_code',
      'ran_command',
    ])
    const reads = evs.find((e) => e.kind === 'read_file')!
    expect(reads.evidenceSpanIds).toEqual(['s2', 's3', 's4'])
    expect(reads.title).toContain('(3×)')
    const fail = evs.find((e) => e.kind === 'observed_failure')!
    expect(fail.importance).toBe(5)
    expect(fail.evidenceSpanIds).toEqual(['s6'])
  })

  it('collapseAdjacent:false keeps every span as its own moment', () => {
    expect(reduceToSemanticEvents(SPANS, { collapseAdjacent: false })).toHaveLength(SPANS.length)
  })
})

describe('compileStoryboard', () => {
  it('frames with a title + summary card and always keeps failures/edits', () => {
    const sb = compileStoryboard(reduceToSemanticEvents(SPANS), {
      title: 'Fix OAuth',
      maxScenes: 3,
    })
    expect(sb.scenes[0]!.sceneType).toBe('title_card')
    expect(sb.scenes[sb.scenes.length - 1]!.sceneType).toBe('summary')
    const types = sb.scenes.map((s) => s.sceneType)
    // even at maxScenes:3, both edits + the error survive (importance >= 4 / 5)
    expect(types.filter((t) => t === 'diff')).toHaveLength(2)
    expect(types).toContain('error')
    expect(sb.totalMs).toBe(sb.scenes.reduce((s, sc) => s + sc.durationMs, 0))
  })

  it('summary narration counts commands / edits / failures', () => {
    const sb = compileStoryboard(reduceToSemanticEvents(SPANS), {})
    expect(sb.scenes.at(-1)!.narration).toContain('2 edits')
    expect(sb.scenes.at(-1)!.narration).toContain('1 failure')
  })
})

describe('renderers', () => {
  const sb = compileStoryboard(reduceToSemanticEvents(SPANS), { title: 'Fix OAuth' })

  it('markdown is a timeline with the title and an error scene', () => {
    const md = renderStoryboardMarkdown(sb)
    expect(md.startsWith('# 🎬 Fix OAuth')).toBe(true)
    expect(md).toContain('❌')
    expect(md).toMatch(/\[\d+:\d{2}\]/) // timestamps
  })

  it('html is a self-contained doc embedding every scene, no external assets', () => {
    const html = renderStoryboardHtml(sb)
    expect(html.startsWith('<!doctype html>')).toBe(true)
    expect(html).toContain('<title>Fix OAuth</title>')
    // scenes serialized inline for the dependency-free player
    expect(html).toContain('const SCENES = [')
    for (const sc of sb.scenes) expect(html).toContain(sc.title.replace(/&/g, '&amp;'))
    // no external script/style/img references
    expect(html).not.toMatch(/<script[^>]+src=/)
    expect(html).not.toMatch(/<link[^>]+href=/)
  })

  it('renderers are pure — identical storyboard, identical bytes', () => {
    expect(renderStoryboardMarkdown(sb)).toBe(renderStoryboardMarkdown(sb))
    expect(renderStoryboardHtml(sb)).toBe(renderStoryboardHtml(sb))
  })
})
