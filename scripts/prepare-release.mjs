#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { OWN_VERSION_FIELDS, withOwnVersion } from './release-version-fields.mjs'

const version = process.argv[2]
if (!version || !/^\d+\.\d+\.\d+$/.test(version)) throw new Error('usage: node scripts/prepare-release.mjs <x.y.z>')
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim()
const { name, version: current } = JSON.parse(readFileSync('package.json', 'utf8'))
if (typeof name !== 'string' || !name || !/^\d+\.\d+\.\d+$/.test(current)) {
  throw new Error('package.json must name the current release version')
}

// uv.lock is rewritten in place, not re-resolved: `uv lock` also rewrites
// markers and the lock revision whenever uv itself has moved on, which is a
// dependency change no release should carry.
// Build every edit before writing: a missing field, bad boundary or changelog
// must not leave only part of the npm/Python version cohort bumped.
const edits = OWN_VERSION_FIELDS.map(({ path }) => {
  const text = readFileSync(path, 'utf8')
  if (withOwnVersion(path, text, current) !== text) {
    throw new Error(`${path}: own version does not match package.json ${current}`)
  }
  return { path, text: withOwnVersion(path, text, version) }
})
const old = readFileSync('CHANGELOG.md', 'utf8')
const unreleased = [...old.matchAll(/^## Unreleased$/gm)].length
if (unreleased > 1 || (unreleased === 0 && !/^---$/m.test(old))) {
  throw new Error('CHANGELOG.md needs one Unreleased heading or a release-section separator')
}
if (new RegExp(`^## \\[${version.replaceAll('.', '\\.')}\\]`, 'm').test(old)) {
  throw new Error(`CHANGELOG.md already contains ${version}`)
}

// Manual publication may be untagged and may ship commits after the nominal
// release commit. npm's exact-version gitHead identifies what actually shipped.
// Only a missing gitHead can use the native publisher's exact version tag;
// inconsistent publication evidence must never fall back to an older boundary.
const registry = (process.env.npm_config_registry || process.env.NPM_CONFIG_REGISTRY || 'https://registry.npmjs.org').replace(/\/$/, '')
const url = `${registry}/${encodeURIComponent(name)}/${encodeURIComponent(current)}`
const response = await fetch(url, { signal: AbortSignal.timeout(15_000) })
if (!response.ok) throw new Error(`cannot identify published ${name}@${current}: registry answered ${response.status}`)
const published = await response.json()
if (published.name !== name || published.version !== current) {
  throw new Error(`registry identity does not match ${name}@${current}`)
}
let source = published.gitHead
if (source === undefined) {
  source = git('rev-parse', '--verify', `refs/tags/v${current}^{commit}`)
} else if (typeof source !== 'string' || !/^[0-9a-f]{40}$/.test(source)) {
  throw new Error(`published ${name}@${current} has an invalid gitHead`)
}
git('merge-base', '--is-ancestor', source, 'HEAD')
const previous = JSON.parse(git('show', `${source}:package.json`))
if (previous.name !== name || previous.version !== current) {
  throw new Error(`published source ${source} does not contain ${name}@${current}`)
}
const subjects = git('log', '--no-merges', '--format=%s', `${source}..HEAD`).split('\n').filter(Boolean)
if (!subjects.length) throw new Error(`no commits since published ${current} (${source})`)
const date = new Date().toISOString().slice(0, 10)
const section = `## [${version}] — ${date}\n\n${subjects.map((subject) => `- ${subject}`).join('\n')}`
edits.push({
  path: 'CHANGELOG.md',
  text: unreleased ? old.replace(/^## Unreleased$/m, section) : old.replace(/^---$/m, `---\n\n${section}`),
})

for (const { path, text } of edits) writeFileSync(path, text)
console.log(`Prepared ${version} from ${subjects.length} commits since published ${current} (${source})`)
