import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'

const execFileAsync = promisify(execFile)
const roots: string[] = []

async function createRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'agent-eval-skill-'))
  roots.push(root)
  return root
}

async function check(path: string) {
  return execFileAsync(process.execPath, ['scripts/check-skill.mjs'], {
    cwd: process.cwd(),
    env: { ...process.env, AGENT_EVAL_SKILL_PATH: path },
  })
}

function validSkill(lineEnding = '\n'): string {
  return [
    '---',
    'name: agent-eval',
    'description: A compact test skill.',
    '---',
    '',
    '# Agent Eval',
    '',
    '## Then consider',
    '',
    '- `verify` before release.',
    '',
  ].join(lineEnding)
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('agent-eval package skill check', () => {
  it('accepts valid CRLF frontmatter', async () => {
    const root = await createRoot()
    const path = join(root, 'SKILL.md')
    await writeFile(path, validSkill('\r\n'))
    await expect(check(path)).resolves.toMatchObject({ stderr: '' })
  })

  it('rejects a missing skill file', async () => {
    const root = await createRoot()
    await expect(check(join(root, 'missing.md'))).rejects.toMatchObject({
      stderr: expect.stringContaining('skill file is missing'),
    })
  })

  it.each([
    ['wrong name', 'name: different', 'frontmatter name'],
    ['long description', `description: ${'x'.repeat(97)}`, 'description has 97 chars'],
    ['folded long description', `description: >-\n  ${'x'.repeat(97)}`, 'description has 97 chars'],
    [
      'misplaced footer',
      '## Then consider\n\n- `verify` before release.\n\n## Later',
      'final level-two section',
    ],
  ])('rejects %s', async (_label, mutation, expected) => {
    const root = await createRoot()
    const path = join(root, 'SKILL.md')
    let content = validSkill()
    if (mutation.startsWith('name:')) content = content.replace('name: agent-eval', mutation)
    else if (mutation.startsWith('description:')) {
      content = content.replace('description: A compact test skill.', mutation)
    } else content = content.replace('## Then consider\n\n- `verify` before release.', mutation)
    await writeFile(path, content)

    await expect(check(path)).rejects.toMatchObject({ stderr: expect.stringContaining(expected) })
  })
})
