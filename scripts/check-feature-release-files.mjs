#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim()
const baseRef = 'origin/' + (process.env.GITHUB_BASE_REF || 'main')
const base = git('merge-base', baseRef, 'HEAD')
const show = (path) => git('show', base + ':' + path)
const read = (path) => readFileSync(path, 'utf8')
const versionFrom = (text) => /^version = "([^"\n]+)"/m.exec(text)?.[1]
const runtimeVersionFrom = (text) => /^    __version__ = "([^"\n]+)"/m.exec(text)?.[1]

const npmPath = 'package.json'
const pythonPath = 'clients/python/pyproject.toml'
const runtimePath = 'clients/python/src/agent_eval_rpc/__init__.py'
const changelogPath = 'CHANGELOG.md'
const baseNpm = JSON.parse(show(npmPath)).version
const headNpm = JSON.parse(read(npmPath)).version
const basePython = versionFrom(show(pythonPath))
const headPython = versionFrom(read(pythonPath))
const baseRuntime = runtimeVersionFrom(show(runtimePath))
const headRuntime = runtimeVersionFrom(read(runtimePath))
const changed = git('diff', '--name-only', base + '...HEAD').split('\n').filter(Boolean)
const branch = process.env.GITHUB_HEAD_REF || ''
const releaseVersion = /^release\/v((0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*))$/.exec(branch)?.[1]
// Maintainer syncs change the event actor while preserving the bot-created PR author.
const generatedReleasePr =
  process.env.GITHUB_EVENT_NAME === 'pull_request' &&
  process.env.PR_AUTHOR_LOGIN === 'github-actions[bot]' &&
  releaseVersion === headNpm

const semverPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
const isNextRelease = (baseVersion, headVersion) => {
  if (!semverPattern.test(baseVersion) || !semverPattern.test(headVersion)) return false
  const [baseMajor, baseMinor, basePatch] = baseVersion.split('.').map(Number)
  const [headMajor, headMinor, headPatch] = headVersion.split('.').map(Number)
  return (
    (headMajor === baseMajor + 1 && headMinor === 0 && headPatch === 0) ||
    (headMajor === baseMajor && headMinor === baseMinor + 1 && headPatch === 0) ||
    (headMajor === baseMajor && headMinor === baseMinor && headPatch === basePatch + 1)
  )
}

if (generatedReleasePr) {
  const releaseFiles = new Set([
    npmPath,
    pythonPath,
    runtimePath,
    'clients/python/uv.lock',
    changelogPath,
  ])
  const requiredFiles = [npmPath, pythonPath, runtimePath, changelogPath]
  const versionsMatch =
    baseNpm === basePython &&
    baseNpm === baseRuntime &&
    headNpm === headPython &&
    headNpm === headRuntime
  const filesMatch =
    changed.every((path) => releaseFiles.has(path)) &&
    requiredFiles.every((path) => changed.includes(path))
  const changelogHasVersion = read(changelogPath).includes('## [' + headNpm + ']')

  if (!versionsMatch || !filesMatch || !changelogHasVersion || !isNextRelease(baseNpm, headNpm)) {
    throw new Error('generated release PR must contain only matching, increasing version metadata')
  }

  console.log('prepared release files valid at ' + headNpm)
} else {
  const versionChanged =
    baseNpm !== headNpm ||
    basePython !== headPython ||
    baseRuntime !== headRuntime

  if (versionChanged || changed.includes(changelogPath)) {
    throw new Error('feature PRs must not change package versions or CHANGELOG.md; run Prepare Release after merge')
  }

  console.log('release files clean at ' + headNpm)
}
