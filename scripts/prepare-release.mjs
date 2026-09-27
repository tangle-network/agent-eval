#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { OWN_VERSION_FIELDS, withOwnVersion } from './release-version-fields.mjs'
const version=process.argv[2]
if(!version||!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('usage: node scripts/prepare-release.mjs <x.y.z>')
const git=(...a)=>execFileSync('git',a,{encoding:'utf8'}).trim()
// uv.lock is rewritten in place, not re-resolved: `uv lock` also rewrites
// markers and the lock revision whenever uv itself has moved on, which is a
// dependency change no release should carry.
for(const {path} of OWN_VERSION_FIELDS) writeFileSync(path,withOwnVersion(path,readFileSync(path,'utf8'),version))
const tag=git('describe','--tags','--abbrev=0','--match','v*')
const subjects=git('log','--no-merges','--format=%s',`${tag}..HEAD`).split('\n').filter(Boolean)
if(!subjects.length)throw new Error(`no commits since ${tag}`)
const old=readFileSync('CHANGELOG.md','utf8')
const date=new Date().toISOString().slice(0,10)
const section=`## [${version}] — ${date}\n\n${subjects.map(s=>`- ${s}`).join('\n')}`
const next=/^## Unreleased$/m.test(old)
  ? old.replace(/^## Unreleased$/m,section)
  : old.replace(/^---$/m,`---\n\n${section}`)
writeFileSync('CHANGELOG.md',next)
console.log(`Prepared ${version} from ${subjects.length} commits since ${tag}`)
