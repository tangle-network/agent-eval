#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
const base=`origin/${process.env.GITHUB_BASE_REF||'main'}`
const show=(path)=>execFileSync('git',['show',`${base}:${path}`],{encoding:'utf8'})
const baseNpm=JSON.parse(show('package.json')).version
const headNpm=JSON.parse(readFileSync('package.json','utf8')).version
const basePy=/^version = "([^"]+)"/m.exec(show('clients/python/pyproject.toml'))?.[1]
const headPy=/^version = "([^"]+)"/m.exec(readFileSync('clients/python/pyproject.toml','utf8'))?.[1]
const changed=execFileSync('git',['diff','--name-only',`${base}...HEAD`],{encoding:'utf8'}).trim().split('\n').filter(Boolean)
if(baseNpm!==headNpm||basePy!==headPy||changed.includes('CHANGELOG.md')) throw new Error('feature PRs must not change package versions or CHANGELOG.md; run Prepare Release after merge')
console.log(`release files clean at ${headNpm}`)
