// Rename declarations so one name means one concept; follow the renames through importers with tsc errors.
// Config: .prune/renames.json = [{ "file": "src/x.ts", "old": "A", "new": "B" }]
import fs from 'node:fs'
import { execSync } from 'node:child_process'
import { parseSync } from 'oxc-parser'
const sh = (c) => { try { return execSync(c, { encoding: 'utf8', maxBuffer: 1 << 29, stdio: ['ignore', 'pipe', 'pipe'] }) } catch (e) { return (e.stdout || '') + (e.stderr || '') } }
const rd = (f) => fs.readFileSync(f, 'utf8')
const cfg = JSON.parse(rd('.prune/renames.json'))
const word = (n) => new RegExp('(?<![\\w$.])' + n.replace(/\$/g, '\\$') + '(?![\\w$])', 'g')
const lineStarts = (t) => { const a = [0]; for (let i = 0; i < t.length; i++) if (t[i] === '\n') a.push(i + 1); return a }
const byOld = new Map()
for (const r of cfg) { byOld.set(r.old, [...(byOld.get(r.old) || []), r]); fs.writeFileSync(r.file, rd(r.file).replace(word(r.old), r.new)) }
// importers: tsc says the module has no export named old
const RX = /^([^()\n]+)\((\d+),(\d+)\): error TS(2305|2459|2724): .*?'(?:"[^"]+"|[^']+)'.*?'?([A-Za-z_$][\w$]*)'/gm
for (let round = 0; round < 40; round++) {
  const out = sh('npx tsc --noEmit --pretty false')
  const errs = [...out.matchAll(/^([^()\n]+)\((\d+),(\d+)\): error TS(2305|2459|2724): (.*)$/gm)].map((m) => {
    const names = [...m[5].matchAll(/'([^']+)'/g)].map((x) => x[1]); const nm = m[4] === '2305' ? names[1] : m[4] === '2459' ? names[1] : names[1]
    return { f: m[1], line: +m[2], col: +m[3], name: names.find((x) => byOld.has(x)) }
  }).filter((e) => e.name)
  if (!errs.length) { process.stderr.write('clean after round ' + round + '\n'); break }
  const byFile = new Map(); for (const e of errs) byFile.set(e.f, [...(byFile.get(e.f) || []), e])
  for (const [f, es] of byFile) {
    let t = rd(f); const ls = lineStarts(t); const { program } = parseSync(f, t, { lang: f.endsWith('.tsx') ? 'tsx' : 'ts' }); const ed = []; const renamedLocals = []
    for (const e of es) {
      const pos = ls[e.line - 1] + e.col - 1
      const st = program.body.find((s) => pos >= s.start && pos < s.end); if (!st) continue
      const sp = (st.specifiers || []).find((x) => pos >= x.start && pos < x.end); if (!sp) continue
      const target = byOld.get(e.name).find((r) => true).new
      const imported = sp.imported ?? sp.local ?? sp.exported
      const importedText = t.slice(imported.start, imported.end)
      if (sp.type === 'ImportSpecifier' && sp.local && sp.local.name === e.name && (!sp.imported || sp.imported.name === e.name)) { ed.push([sp.start, sp.end, (sp.importKind === 'type' ? 'type ' : '') + target]); renamedLocals.push(e.name) }
      else ed.push([imported.start, imported.end, target])
    }
    ed.sort((a, b) => b[0] - a[0]); for (const [a, b, r] of ed) t = t.slice(0, a) + r + t.slice(b)
    for (const o of new Set(renamedLocals)) {
      const target = byOld.get(o)[0].new
      // rewrite uses outside the import statements we just edited
      t = t.split('\n').map((line) => (/^\s*(import|export)\b|^\s+(type\s+)?[\w$]+,?$/.test(line) && line.includes(target) ? line : line.replace(word(o), target))).join('\n')
    }
    fs.writeFileSync(f, t)
  }
}
// tidy `X as X`
for (const f of sh("git ls-files 'src/**/*.ts' 'src/*.ts'").split('\n').filter(Boolean)) { const t = rd(f); const n = t.replace(/\b([\w$]+) as \1\b/g, '$1'); if (n !== t) fs.writeFileSync(f, n) }
console.log('@@PATCH-BEGIN'); console.log(sh('git diff -- . ":!.prune"')); console.log('@@PATCH-END'); console.log(sh('npx tsc --noEmit --pretty false | head -40'))
