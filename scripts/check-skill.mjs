import { readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const path = process.env.AGENT_EVAL_SKILL_PATH
  ? resolve(process.env.AGENT_EVAL_SKILL_PATH)
  : fileURLToPath(new URL('../.claude/skills/agent-eval/SKILL.md', import.meta.url))
if (!statSync(path, { throwIfNoEntry: false })?.isFile()) {
  console.error(`agent-eval skill file is missing: ${path}`)
  process.exit(1)
}

const rawContent = readFileSync(path, 'utf8')
const content = rawContent.replace(/\r\n?/g, '\n')
const maxDescriptionChars = 96
const maxSkillBytes = 20_000
const errors = []

function frontmatterField(frontmatter, key) {
  if (!frontmatter) return undefined
  const lines = frontmatter.split('\n')
  const index = lines.findIndex((line) => line.startsWith(`${key}:`))
  if (index === -1) return undefined

  const value = lines[index].slice(key.length + 1).trim()
  if (!/^[>|][0-9+-]*$/.test(value)) return value.replace(/^["']|["']$/g, '')

  const continuation = []
  for (const line of lines.slice(index + 1)) {
    if (line && !/^\s/.test(line)) break
    continuation.push(line.trim())
  }
  return (value.startsWith('>') ? continuation.join(' ') : continuation.join('\n')).trim()
}

const frontmatter = content.match(/^---\n([\s\S]*?)\n---(?:\n|$)/)?.[1]
const name = frontmatterField(frontmatter, 'name')
const description = frontmatterField(frontmatter, 'description')

if (name !== 'agent-eval') {
  errors.push(`skill frontmatter name is ${JSON.stringify(name)}`)
}
if (!description) {
  errors.push('skill description is missing')
} else if (description.length > maxDescriptionChars) {
  errors.push(`skill description has ${description.length} chars; max is ${maxDescriptionChars}`)
}

if (Buffer.byteLength(rawContent) > maxSkillBytes) {
  errors.push(`SKILL.md has ${Buffer.byteLength(rawContent)} bytes; max is ${maxSkillBytes}`)
}

const footer = content.lastIndexOf('\n## Then consider\n')
if (footer === -1 || content.indexOf('\n## ', footer + 1) !== -1) {
  errors.push('## Then consider must be the final level-two section')
}

if (errors.length > 0) {
  for (const error of errors) console.error(error)
  process.exitCode = 1
} else {
  console.log(
    `agent-eval skill valid: ${description.length} description chars, ${Buffer.byteLength(rawContent)} bytes`,
  )
}
