// Remove zero-consumer names from every published entry, then cascade: knip (production) + tsc delete what that orphaned,
// then prune tests that only covered the removed names. Prints a git patch between markers.
import fs from 'node:fs'
import path from 'node:path'
import { execSync } from 'node:child_process'
import { parseSync } from 'oxc-parser'

const ROOT = process.cwd()
const DROP = new Set(JSON.parse(fs.readFileSync('.prune/drop.json', 'utf8')))
const sh = (c) => { try { return execSync(c, { encoding: 'utf8', maxBuffer: 1 << 29, stdio: ['ignore', 'pipe', 'pipe'] }) } catch (e) { return (e.stdout || '') + (e.stderr || '') } }
const rd = (f) => fs.readFileSync(f, 'utf8')
const parse = (f, t) => parseSync(f, t, { lang: f.endsWith('.tsx') ? 'tsx' : 'ts' })
const apply = (f, list) => { let t = rd(f); for (const [a, b, r] of list.sort((x, y) => y[0] - x[0])) t = t.slice(0, a) + r + t.slice(b); fs.writeFileSync(f, t) }
const log = (...a) => process.stderr.write(a.join(' ') + '\n')

// ── entries ──
const pkg = JSON.parse(rd('package.json'))
const buildEntries = rd('scripts/build-entries.mjs'); const buildMap = new Map()
for (const m of buildEntries.matchAll(/'?([\w./-]+)'?\s*:\s*'([^']+)'/g)) buildMap.set(m[1], m[2])
const entryFiles = new Set()
for (const [sub, target] of Object.entries(pkg.exports)) {
  if (sub.endsWith('.json')) continue
  const published = typeof target === 'string' ? target : (target.import ?? target.default)
  const src = buildMap.get(published.replace(/^\.\/dist\//, '').replace(/\.js$/, ''))
  if (src) entryFiles.add(src)
}
const resolveMod = (from, spec) => { const b = path.resolve(path.dirname(from), spec); for (const c of [b + '.ts', b + '.tsx', path.join(b, 'index.ts')]) if (fs.existsSync(c) && fs.statSync(c).isFile()) return c; throw new Error('resolve ' + spec + ' from ' + from) }
const bindingNames = (p, out = []) => { switch (p.type) { case 'Identifier': out.push(p.name); break; case 'ObjectPattern': for (const q of p.properties) bindingNames(q.value ?? q.argument, out); break; case 'ArrayPattern': for (const e of p.elements) if (e) bindingNames(e, out); break; case 'AssignmentPattern': bindingNames(p.left, out); break; case 'RestElement': bindingNames(p.argument, out); break } return out }
const cache = new Map()
function modExports(file, seen = new Set()) {
  if (cache.has(file)) return cache.get(file)
  if (seen.has(file)) return new Map(); seen.add(file)
  const { program } = parse(file, rd(file)); const ex = new Map()
  const add = (n, k) => { const e = ex.get(n); if (e === undefined || (e === 'type' && k === 'value')) ex.set(n, k) }
  for (const n of program.body) {
    if (n.type === 'ExportNamedDeclaration') {
      const d = n.declaration
      if (d) { const k = d.type === 'TSTypeAliasDeclaration' || d.type === 'TSInterfaceDeclaration' ? 'type' : 'value'; if (d.type === 'VariableDeclaration') for (const x of d.declarations) for (const nm of bindingNames(x.id)) add(nm, 'value'); else if (d.id) add(d.id.name, k) }
      for (const s of n.specifiers ?? []) add(s.exported.name ?? s.exported.value, n.exportKind === 'type' || s.exportKind === 'type' ? 'type' : 'value')
    } else if (n.type === 'ExportAllDeclaration') {
      if (n.exported) add(n.exported.name, 'value')
      else for (const [nm, k] of modExports(resolveMod(file, n.source.value), seen)) add(nm, n.exportKind === 'type' ? 'type' : k)
    } else if (n.type === 'ExportDefaultDeclaration') add('default', 'value')
  }
  cache.set(file, ex); return ex
}

// ── step 1: strip dropped names from entry files ──
let removed = 0; const unresolvedLocal = []
const explicitSeen = (program) => { const s = new Set(); for (const n of program.body) if (n.type === 'ExportNamedDeclaration') for (const x of n.specifiers ?? []) s.add(x.exported.name ?? x.exported.value); return s }
for (const f of entryFiles) {
  const t = rd(f); const { program } = parse(f, t); const ed = []
  for (const n of program.body) {
    if (n.type === 'ExportNamedDeclaration' && n.source) {
      const keep = n.specifiers.filter((s) => n.exportKind === 'type' || s.exportKind === 'type' || !DROP.has(s.exported.name ?? s.exported.value))
      if (keep.length === n.specifiers.length) continue
      removed += n.specifiers.length - keep.length
      if (!keep.length) ed.push([n.start, n.end, ''])
      else { const kind = n.exportKind === 'type' ? 'export type ' : 'export '; ed.push([n.start, n.end, kind + '{ ' + keep.map((s) => t.slice(s.start, s.end)).join(', ') + ' } from ' + JSON.stringify(n.source.value).replace(/"/g, "'")]) }
    } else if (n.type === 'ExportNamedDeclaration' && n.declaration) {
      const d = n.declaration
      const names = d.type === 'VariableDeclaration' ? d.declarations.flatMap((x) => bindingNames(x.id)) : d.id ? [d.id.name] : []
      const isType = d.type === 'TSTypeAliasDeclaration' || d.type === 'TSInterfaceDeclaration'
      if (!isType && names.length && names.every((x) => DROP.has(x))) { ed.push([n.start, d.start, '']); removed += names.length; unresolvedLocal.push(f + ':' + names.join(',')) }
    } else if (n.type === 'ExportNamedDeclaration' && !n.source && n.specifiers?.length) {
      const keep = n.specifiers.filter((s) => n.exportKind === 'type' || s.exportKind === 'type' || !DROP.has(s.exported.name ?? s.exported.value))
      if (keep.length === n.specifiers.length) continue
      removed += n.specifiers.length - keep.length
      if (!keep.length) ed.push([n.start, n.end, '']); else ed.push([n.start, n.end, (n.exportKind === 'type' ? 'export type ' : 'export ') + '{ ' + keep.map((s) => t.slice(s.start, s.end)).join(', ') + ' }'])
    } else if (n.type === 'ExportAllDeclaration' && !n.exported) {
      const ex = modExports(resolveMod(f, n.source.value)); const src = JSON.stringify(n.source.value).replace(/"/g, "'")
      const vals = [...ex].filter(([, k]) => k === 'value').map(([nm]) => nm).filter((nm) => nm !== 'default')
      const dropped = vals.filter((nm) => DROP.has(nm))
      if (!dropped.length || n.exportKind === 'type') continue
      removed += dropped.length
      const keepV = vals.filter((nm) => !DROP.has(nm)); const types = [...ex].filter(([, k]) => k === 'type').map(([nm]) => nm)
      const seen = explicitSeen(program); const out = []
      for (const nm of keepV.slice()) if (seen.has(nm)) keepV.splice(keepV.indexOf(nm), 1)
      for (const nm of types.slice()) if (seen.has(nm)) types.splice(types.indexOf(nm), 1)
      if (keepV.length) out.push('export { ' + keepV.sort().join(', ') + ' } from ' + src)
      if (types.length) out.push('export type { ' + types.sort().join(', ') + ' } from ' + src)
      ed.push([n.start, n.end, out.join('\n')])
    }
  }
  if (ed.length) apply(f, ed)
}
log('step1 removed', removed, 'local-decl unexports', unresolvedLocal.length)
fs.writeFileSync('/tmp/unresolved-local.txt', unresolvedLocal.join('\n'))

// ── helpers for cascade ──
const SKIPTEST = (f) => /\.test\.|\.test-support|fixtures|test-fixtures|^tests\//.test(f)
const declNames = (d) => (!d ? [] : d.type === 'VariableDeclaration' ? d.declarations.map((x) => x.id.name) : d.id?.name ? [d.id.name] : [])
const startWithComments = (t, comments, start) => { let s = start; for (;;) { const c = comments.find((x) => x.end <= s && /^\s*$/.test(t.slice(x.end, s)) && t.slice(x.end, s).split('\n').length <= 2); if (!c) return s; s = c.start } }
const lineStarts = (t) => { const a = [0]; for (let i = 0; i < t.length; i++) if (t[i] === '\n') a.push(i + 1); return a }
const outside = sh("git grep -lE '.' -- examples scripts benchmarks docs README.md ':!docs/public-api.md' ':!docs/proofs' ':!docs/changes' ':!CHANGELOG.md' ':!*.test.*' | head -0")

// names a file outside src consumes (guard): word set from examples/scripts/benchmarks
const guardWords = new Set()
for (const m of sh("git grep -ohE '[A-Za-z_$][A-Za-z0-9_$]*' -- examples scripts benchmarks ':!*.test.*' ':!*.md' ':!*.json'").split('\n')) guardWords.add(m)
const PROTECTED = (f) => /^tests\//.test(f) || /invariant|guard|boundary|implementation|parity|golden|certif|integrity|contract|property|calibration/.test(f)
for (const f of sh("git ls-files 'src/**/*.test.ts' 'src/*.test.ts' 'tests/**' 'scripts/**/*.test.*'").split('\n')) {
  if (!f || !PROTECTED(f) || !fs.existsSync(f)) continue
  for (const w of rd(f).match(/[A-Za-z_$][A-Za-z0-9_$]*/g) ?? []) guardWords.add(w)
}
const docWords = new Set()
for (const m of sh("git grep -ohE '`[A-Za-z_$][A-Za-z0-9_$]*`' -- README.md AGENTS.md .claude docs ':!docs/public-api.md' ':!docs/proofs' ':!docs/changes'").split('\n')) docWords.add(m.replace(/`/g, ''))

// ── step 2: knip production → un-export + tsc fixpoint delete ──
const knipOut = sh('npx --yes knip@5 --production --no-progress --reporter json --no-exit-code')
const knip = JSON.parse(knipOut.slice(knipOut.indexOf('{"files"')))
let un = 0
for (const issue of knip.issues) {
  const f = issue.file; if (!f.startsWith('src/') || SKIPTEST(f)) continue
  const names = new Set([...(issue.exports || []), ...(issue.types || [])].map((e) => e.name).filter((n) => !guardWords.has(n) && !docWords.has(n)))
  if (!names.size) continue
  const t = rd(f); const { program } = parse(f, t); const ed = []
  for (const s of program.body) {
    if (s.type !== 'ExportNamedDeclaration' || !s.declaration) continue
    const ns = declNames(s.declaration)
    if (ns.length && ns.every((n) => names.has(n))) { ed.push([s.start, s.declaration.start, '']); un++ }
  }
  if (ed.length) apply(f, ed)
}
log('step2 unexported', un)

const tscDiags = (re) => { const out = sh('npx tsc --noEmit --pretty false'); return { out, list: [...out.matchAll(re)].map((m) => ({ f: m[1], line: +m[2], col: +m[3], code: m[4], msg: m[5] })) } }
const UNUSED = /^((?:src|tests|scripts|examples)\/[^()]+)\((\d+),(\d+)\): error TS(6133|6196|6192|6198): (.*)$/gm
function deleteUnused(onlyTests) {
  const { list } = tscDiags(UNUSED)
  const byFile = new Map(); for (const d of list) { if (onlyTests === false && !d.f.startsWith('src/')) continue; byFile.set(d.f, [...(byFile.get(d.f) || []), d]) }
  let acted = 0
  for (const [f, ds] of byFile) {
    const t = rd(f); const { program, comments } = parse(f, t); const ls = lineStarts(t); const ed = []; const done = new Set()
    for (const d of ds) {
      const pos = ls[d.line - 1] + d.col - 1
      const top = program.body.find((s) => pos >= s.start && pos < s.end)
      if (!top) continue
      if (top.type === 'ImportDeclaration') {
        if (d.code === '6192' || d.code === '6198' || top.specifiers.length === 1) { if (!done.has(top)) { done.add(top); ed.push([top.start, top.end, '']); acted++ } continue }
        const sp = top.specifiers.find((x) => pos >= x.start && pos < x.end); if (!sp || done.has(sp)) continue; done.add(sp)
        const i = top.specifiers.indexOf(sp); const a = i === 0 ? sp.start : top.specifiers[i - 1].end; const b = i === 0 ? top.specifiers[1].start : sp.end
        ed.push([a, b, '']); acted++; continue
      }
      if (top.type === 'ExportNamedDeclaration' || done.has(top)) continue
      const idNode = top.type === 'VariableDeclaration' ? (top.declarations.length === 1 ? top.declarations[0].id : null) : top.id
      if (!idNode || idNode.start !== pos) continue
      done.add(top); ed.push([startWithComments(t, comments, top.start), top.end, '']); acted++
    }
    if (ed.length) apply(f, ed)
  }
  return acted
}
const DANGLING = /^((?:src)\/[^()]+)\((\d+),(\d+)\): error TS(2305|2459|2724): (.*)$/gm
function danglingReexports() {
  const { list } = tscDiags(DANGLING)
  const byFile = new Map(); for (const d of list) { if (/\.test\./.test(d.f)) continue; byFile.set(d.f, [...(byFile.get(d.f) || []), d]) }
  let acted = 0
  for (const [f, ds] of byFile) {
    const t = rd(f); const { program } = parse(f, t); const ls = lineStarts(t); const ed = []; const rm = new Map()
    for (const d of ds) {
      const pos = ls[d.line - 1] + d.col - 1
      const top = program.body.find((s) => pos >= s.start && pos < s.end)
      if (!top || top.type !== 'ExportNamedDeclaration' || !top.specifiers?.length) continue
      const sp = top.specifiers.find((x) => pos >= x.start && pos < x.end); if (!sp) continue
      rm.set(top, [...(rm.get(top) || []), sp])
    }
    for (const [top, sps] of rm) {
      const keep = top.specifiers.filter((x) => !sps.includes(x))
      if (!keep.length) ed.push([top.start, top.end, ''])
      else ed.push([top.start, top.end, t.slice(top.start, top.specifiers[0].start) + keep.map((x) => t.slice(x.start, x.end)).join(', ') + t.slice(top.specifiers.at(-1).end, top.end)])
      acted += sps.length
    }
    if (ed.length) apply(f, ed)
  }
  return acted
}
for (let i = 0; i < 40; i++) { const a = danglingReexports(); const b = deleteUnused(false); log('round', i, 'dangling', a, 'deleted', b); if (!a && !b) break }

// ── step 3: tests that only covered removed names ──
const MISSING = /^((?:src|tests)\/[^()]+\.ts)\((\d+),(\d+)\): error TS(2305|2459|2724|2304|2614|2339|2724): (.*)$/gm
const TOP_TEST = new Set(['describe', 'it', 'test'])
for (let i = 0; i < 25; i++) {
  const { out, list } = tscDiags(MISSING)
  const fileNames = new Map()
  for (const d of list) {
    if (!/\.test\.ts$/.test(d.f) || PROTECTED(d.f)) continue
    const m = d.msg.match(/'([^']+)'/g)?.map((x) => x.slice(1, -1)) ?? []
    const nm = d.code === '2304' ? [m[0]] : d.code === '2305' || d.code === '2724' ? [m[1] ?? m[0]] : [m[1] ?? m[0]]
    const set = fileNames.get(d.f) ?? new Set(); for (const x of nm) if (x && /^[A-Za-z_$][\w$]*$/.test(x)) set.add(x); fileNames.set(d.f, set)
  }
  if (!fileNames.size) break
  let acted = 0
  for (const [f, miss] of fileNames) {
    const t = rd(f); const { program, comments } = parse(f, t); const ed = []
    const toks = (s) => new Set(t.slice(s.start, s.end).match(/[A-Za-z_$][\w$]*/g) ?? [])
    for (const s of program.body) {
      if (s.type === 'ImportDeclaration') {
        const gone = s.specifiers.filter((x) => miss.has(x.local?.name))
        if (!gone.length) continue
        if (gone.length === s.specifiers.length) ed.push([s.start, s.end, ''])
        else for (const sp of gone) { const i = s.specifiers.indexOf(sp); const a = i === 0 ? sp.start : s.specifiers[i - 1].end; const b = i === 0 ? s.specifiers[1].start : sp.end; ed.push([a, b, '']) }
        acted++; continue
      }
      const tk = toks(s); if (![...miss].some((x) => tk.has(x))) continue
      ed.push([startWithComments(t, comments, s.start), s.end, '']); acted++
    }
    if (ed.length) apply(f, ed)
    const after = rd(f)
    if (!/\b(it|test)\s*(\.\w+)?\s*\(/.test(after)) { fs.unlinkSync(f); log('deleted test file', f) }
  }
  if (!acted) break
  for (let j = 0; j < 8; j++) { if (!deleteUnused(true)) break }
}
for (let j = 0; j < 8; j++) { if (!deleteUnused(true)) break }
for (let i = 0; i < 40; i++) { const a = danglingReexports(); const b = deleteUnused(false); if (!a && !b) break }

console.log('@@PATCH-BEGIN'); console.log(sh('git add -A -N . ; git diff -- . ":!.prune"')); console.log('@@PATCH-END')
console.log(sh('git diff --shortstat -- . ":!.prune"'))
console.log('@@REMAINING'); console.log(sh('npx tsc --noEmit --pretty false | head -60'))
