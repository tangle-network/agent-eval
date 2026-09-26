#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
const version=process.argv[2]
if(!version||!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('usage: node scripts/prepare-release.mjs <x.y.z>')
const git=(...a)=>execFileSync('git',a,{encoding:'utf8'}).trim()
const rewrite=(path,pattern,replacement)=>{const raw=readFileSync(path,'utf8');const next=raw.replace(pattern,replacement);if(next===raw)throw new Error(`version field not found in ${path}`);writeFileSync(path,next)}
rewrite('package.json',/^(\s*"version":\s*)"[^"]+"/m,(_m,p)=>`${p}"${version}"`)
rewrite('clients/python/pyproject.toml',/^version = "[^"]+"/m,`version = "${version}"`)
rewrite('clients/python/src/agent_eval_rpc/__init__.py',/^    __version__ = "[^"]+"/m,`    __version__ = "${version}"`)
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
