import { describe, expect, it } from 'vitest'

import type { Span } from '../trace/schema'
import {
  type CodeEdit,
  codeEditFromSpan,
  codeEditsForStoryboard,
  compileStoryboard,
  editAnimationText,
  extractCodeEdits,
  reduceToSemanticEvents,
  renderCodeAnimationHtml,
} from './index'

function editSpan(
  spanId: string,
  ts: number,
  args: unknown,
  toolName = 'str_replace_editor',
): Span {
  return {
    spanId,
    runId: 'r1',
    kind: 'tool',
    name: toolName,
    toolName,
    args,
    startedAt: ts,
    endedAt: ts + 30,
    status: 'ok',
  } as Span
}

const llmSpan: Span = {
  spanId: 's1',
  runId: 'r1',
  kind: 'llm',
  name: 'chat',
  model: 'gpt-4o-mini',
  messages: [],
  startedAt: 1000,
  endedAt: 1050,
  status: 'ok',
} as Span
const readSpan: Span = {
  spanId: 's3',
  runId: 'r1',
  kind: 'tool',
  name: 'read_file',
  toolName: 'read_file',
  args: { path: 'x.ts' },
  startedAt: 1200,
  endedAt: 1210,
  status: 'ok',
} as Span
const todoEditSpan = editSpan('s2', 1100, {
  path: 'src/todo.ts',
  content: 'export interface Todo {\n  id: string\n  done: boolean\n}\n',
})
const appEditSpan = editSpan('s4', 1300, {
  file_path: 'src/app.tsx',
  diff: '--- a\n+++ b\n+const x = 1\n+const y = 2\n-old line\n',
})

const SPANS: Span[] = [llmSpan, todoEditSpan, readSpan, appEditSpan]

describe('code-edit extraction', () => {
  it('extracts edits from edit-tool spans, ignores reads/llm', () => {
    const edits = extractCodeEdits(SPANS)
    expect(edits.map((e) => e.path)).toEqual(['src/todo.ts', 'src/app.tsx'])
    expect(edits[0]?.language).toBe('ts')
    expect(edits[1]?.language).toBe('tsx')
  })

  it('counts additions/deletions from a unified diff', () => {
    const edit = codeEditFromSpan(appEditSpan)
    expect(edit?.additions).toBe(2)
    expect(edit?.deletions).toBe(1)
  })

  it('codeEditFromSpan returns undefined for non-edit spans', () => {
    expect(codeEditFromSpan(llmSpan)).toBeUndefined()
    expect(codeEditFromSpan(readSpan)).toBeUndefined()
  })

  it('editAnimationText prefers full body, falls back to diff additions then placeholder', () => {
    const edits = extractCodeEdits(SPANS)
    const todo = edits[0] as CodeEdit
    const app = edits[1] as CodeEdit
    expect(editAnimationText(todo)).toContain('interface Todo')
    expect(editAnimationText(app)).toBe('const x = 1\nconst y = 2')
    expect(
      editAnimationText({ ...app, after: undefined, diff: undefined, additions: 3 }),
    ).toContain('// src/app.tsx')
  })

  it('links diff scenes in a compiled storyboard to their concrete edits', () => {
    const sb = compileStoryboard(reduceToSemanticEvents(SPANS))
    const paired = codeEditsForStoryboard(sb, SPANS)
    expect(paired.length).toBeGreaterThanOrEqual(1)
    for (const p of paired) {
      expect(p.scene.sceneType).toBe('diff')
      expect(p.edit.path).toBeTruthy()
    }
  })

  it('renders a self-contained, dependency-free HTML animation with the real code', () => {
    const html = renderCodeAnimationHtml(SPANS, { title: 'Build Todo' })
    expect(html.startsWith('<!doctype html>')).toBe(true)
    expect(html).toContain('Build Todo')
    expect(html).toContain('src/todo.ts')
    expect(html).toContain('interface Todo')
    expect(html).not.toMatch(/<script src=|<link /)
  })

  it('accepts pre-extracted edits as well as raw spans', () => {
    const edits = extractCodeEdits(SPANS)
    const html = renderCodeAnimationHtml(edits)
    expect(html).toContain('src/app.tsx')
  })

  it('degrades gracefully on a run with no edits', () => {
    const html = renderCodeAnimationHtml([llmSpan, readSpan])
    expect(html).toContain('No code edits in this run')
  })
})
