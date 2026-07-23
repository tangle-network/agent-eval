import { readFileSync } from 'node:fs'

const path = new URL('../.claude/skills/agent-eval/SKILL.md', import.meta.url)
const content = readFileSync(path, 'utf8')
const maxDescriptionChars = 96
const maxSkillBytes = 20_000
const errors = []

const frontmatter = content.match(/^---\n([\s\S]*?)\n---(?:\n|$)/)?.[1]
const description = frontmatter
  ?.match(/^description:\s*(.+)$/m)?.[1]
  ?.replace(/^["']|["']$/g, '')

if (!description) {
  errors.push('skill description is missing')
} else if (description.length > maxDescriptionChars) {
  errors.push(`skill description has ${description.length} chars; max is ${maxDescriptionChars}`)
}

if (Buffer.byteLength(content) > maxSkillBytes) {
  errors.push(`SKILL.md has ${Buffer.byteLength(content)} bytes; max is ${maxSkillBytes}`)
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
    `agent-eval skill valid: ${description.length} description chars, ${Buffer.byteLength(content)} bytes`,
  )
}
