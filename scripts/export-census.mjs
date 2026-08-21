/**
 * Public-API census.
 *
 * Every subpath in `package.json#exports` publishes a set of named value
 * exports. A published symbol with no consumer is surface a caller can bind
 * to and this package must then keep working, so each one must name who uses
 * it. This script enumerates the surface mechanically (oxc-parser, `export *`
 * resolved through the barrels) and joins it with two evidence sources:
 *
 *   - in-repo evidence, recomputed on every run: production modules, the CLI
 *     and wire server, examples, tests, and the Markdown front doors;
 *   - consumer evidence, read from `scripts/public-api-consumers.json`, which
 *     `--sweep` writes from the default branch of every repository that
 *     depends on this package.
 *
 * The sweep needs checkouts and the network, so this runs on demand
 * (`pnpm api:census`), never in CI. The document states the date and the
 * commit of every repository it read, so a reader can see how old it is
 * instead of trusting a green check.
 *
 * Classification:
 *   production — imported by a consumer repository's production code, by this
 *                package's own CLI, wire server, or other production module,
 *                or bound in a consumer's type position.
 *   planned    — no production caller, but a consumer's tests, an example, or
 *                a Markdown front door names it, or a consumer repository
 *                mentions the name where the import graph cannot see the bind
 *                (a dynamic `import()` destructure or a namespace import).
 *   none       — no evidence in any channel.
 *
 * `none` is the delete list. The blind spots that decide how far that list can
 * be trusted are stated in the generated document, not hidden here.
 */

import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync, statSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseSync } from 'oxc-parser'

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CONSUMERS_PATH = join(REPOSITORY_ROOT, 'scripts/public-api-consumers.json')
const DOCUMENT_PATH = join(REPOSITORY_ROOT, 'docs/public-api.md')
const PACKAGE_NAME = '@tangle-network/agent-eval'

/** Markdown front doors: a symbol named here is documented surface. */
const DOC_ROOTS = ['docs', 'examples']
const DOC_FILES = ['README.md', 'CLAUDE.md', '.claude/skills/agent-eval/SKILL.md', 'clients/python/README.md']

/** Production modules inside this package that are not part of the library
 *  barrel: the CLI, the wire server, and the maintenance scripts bind the
 *  surface as a caller does. `scripts/` is not incidental — `evidence:check`,
 *  `contract:finding:check`, and `check:analyst-benchmark` run inside
 *  `verify:package`, so a symbol only they import is release-gating. */
const IN_PACKAGE_CALLER_ROOTS = ['src/cli.ts', 'src/cli-config.ts', 'src/wire', 'scripts/', 'benchmarks/']

const SOURCE_FILE = /\.(ts|tsx|mts|cts|mjs|cjs|js)$/
const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/
const CONSUMER_SOURCE_FILE = /\.(ts|tsx|mts|cts|js|mjs|cjs|jsx)$/
const SKIP_DIRECTORIES = new Set(['node_modules', 'dist', 'build', '.git', 'coverage', '.next', 'out'])
const IDENTIFIER = /[A-Za-z_$][\w$]*/g

// ── Surface enumeration ───────────────────────────────────────────────

/** Subpath -> entry module, from `package.json#exports` and the build map. */
function subpathEntries() {
  const packageJson = JSON.parse(readFileSync(join(REPOSITORY_ROOT, 'package.json'), 'utf8'))
  const buildEntries = readFileSync(join(REPOSITORY_ROOT, 'scripts/build-entries.mjs'), 'utf8')
  const buildMap = new Map()
  for (const match of buildEntries.matchAll(/'?([\w./-]+)'?\s*:\s*'([^']+)'/g)) {
    buildMap.set(match[1], match[2])
  }
  const entries = new Map()
  for (const subpath of Object.keys(packageJson.exports)) {
    if (subpath.endsWith('.json')) continue
    const key = subpath === '.' ? 'index' : subpath.slice(2)
    const source = buildMap.get(key) ?? buildMap.get(`${key}/index`)
    if (source === undefined) {
      throw new Error(`export-census: no build entry for subpath '${subpath}'`)
    }
    entries.set(subpath, source)
  }
  return entries
}

function resolveModule(fromFile, specifier) {
  const base = resolve(dirname(fromFile), specifier)
  for (const candidate of [`${base}.ts`, `${base}.tsx`, join(base, 'index.ts')]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate
  }
  throw new Error(`export-census: cannot resolve '${specifier}' from ${fromFile}`)
}

function bindingNames(pattern, out = []) {
  switch (pattern.type) {
    case 'Identifier':
      out.push(pattern.name)
      break
    case 'ObjectPattern':
      for (const property of pattern.properties) bindingNames(property.value ?? property.argument, out)
      break
    case 'ArrayPattern':
      for (const element of pattern.elements) if (element) bindingNames(element, out)
      break
    case 'AssignmentPattern':
      bindingNames(pattern.left, out)
      break
    case 'RestElement':
      bindingNames(pattern.argument, out)
      break
    default:
      throw new Error(`export-census: unhandled binding pattern ${pattern.type}`)
  }
  return out
}

const moduleExportCache = new Map()

/** Named exports of one module, `export *` resolved. name -> 'value' | 'type'. */
function moduleExports(file, visiting = new Set()) {
  const cached = moduleExportCache.get(file)
  if (cached) return cached
  if (visiting.has(file)) return new Map()
  visiting.add(file)
  const parsed = parseSync(file, readFileSync(file, 'utf8'))
  if (parsed.errors.length > 0) {
    throw new Error(`export-census: parse error in ${file}: ${parsed.errors[0].message}`)
  }
  const exports = new Map()
  const add = (name, kind) => {
    const existing = exports.get(name)
    if (existing === undefined || (existing === 'type' && kind === 'value')) exports.set(name, kind)
  }
  for (const node of parsed.program.body) {
    if (node.type === 'ExportNamedDeclaration') {
      const declaration = node.declaration
      if (declaration) {
        const kind =
          declaration.type === 'TSTypeAliasDeclaration' || declaration.type === 'TSInterfaceDeclaration'
            ? 'type'
            : 'value'
        if (declaration.type === 'VariableDeclaration') {
          for (const declarator of declaration.declarations) {
            for (const name of bindingNames(declarator.id)) add(name, 'value')
          }
        } else if (declaration.id) {
          add(declaration.id.name, kind)
        }
      }
      for (const specifier of node.specifiers ?? []) {
        const kind = node.exportKind === 'type' || specifier.exportKind === 'type' ? 'type' : 'value'
        add(specifier.exported.name ?? specifier.exported.value, kind)
      }
    } else if (node.type === 'ExportAllDeclaration') {
      if (node.exported) {
        add(node.exported.name, node.exportKind === 'type' ? 'type' : 'value')
      } else {
        const target = resolveModule(file, node.source.value)
        for (const [name, kind] of moduleExports(target, visiting)) {
          add(name, node.exportKind === 'type' ? 'type' : kind)
        }
      }
    } else if (node.type === 'ExportDefaultDeclaration') {
      add('default', 'value')
    }
  }
  moduleExportCache.set(file, exports)
  return exports
}

/** Every published value export as { subpath, name }. */
function publishedValueExports() {
  const rows = []
  for (const [subpath, entry] of subpathEntries()) {
    for (const [name, kind] of moduleExports(join(REPOSITORY_ROOT, entry))) {
      if (kind === 'value') rows.push({ subpath, name })
    }
  }
  rows.sort((a, b) => a.subpath.localeCompare(b.subpath) || a.name.localeCompare(b.name))
  return rows
}

// ── Evidence: this repository ─────────────────────────────────────────

function* walk(directory, matches) {
  for (const entry of readdirSync(directory)) {
    if (SKIP_DIRECTORIES.has(entry)) continue
    const path = join(directory, entry)
    let stats
    try {
      stats = statSync(path)
    } catch {
      // A broken symlink in a consumer checkout is not a scan failure.
      continue
    }
    if (stats.isDirectory()) yield* walk(path, matches)
    else if (matches.test(entry)) yield path
  }
}

function isBarrel(relativePath) {
  return relativePath.endsWith('/index.ts') || relativePath === 'src/index.ts'
}

/** Named imports from relative modules, per file, across this package. */
function inRepositoryEvidence(names) {
  const evidence = new Map()
  const record = (name, channel, where) => {
    if (!names.has(name)) return
    const entry = evidence.get(name) ?? { production: [], examples: [], tests: [], docs: [] }
    entry[channel].push(where)
    evidence.set(name, entry)
  }
  for (const root of ['src', 'tests', 'examples', 'scripts', 'benchmarks']) {
    const directory = join(REPOSITORY_ROOT, root)
    if (!existsSync(directory)) continue
    for (const file of walk(directory, SOURCE_FILE)) {
      const relativePath = relative(REPOSITORY_ROOT, file)
      const parsed = parseSync(file, readFileSync(file, 'utf8'))
      const channel = TEST_FILE.test(relativePath)
        ? 'tests'
        : relativePath.startsWith('examples/')
          ? 'examples'
          : isBarrel(relativePath)
            ? undefined
            : 'production'
      if (channel === undefined) continue
      for (const node of parsed.program.body) {
        if (node.type !== 'ImportDeclaration') continue
        if (!node.source.value.startsWith('.') && !node.source.value.startsWith(PACKAGE_NAME)) continue
        for (const specifier of node.specifiers ?? []) {
          if (specifier.type !== 'ImportSpecifier') continue
          record(specifier.imported.name ?? specifier.imported.value, channel, `${relativePath}:${lineOf(file, node.start)}`)
        }
      }
    }
  }
  for (const path of markdownFiles()) {
    const text = readFileSync(join(REPOSITORY_ROOT, path), 'utf8')
    const seen = new Set()
    for (const token of text.match(IDENTIFIER) ?? []) {
      if (names.has(token) && !seen.has(token)) {
        seen.add(token)
        record(token, 'docs', path)
      }
    }
  }
  return evidence
}

function markdownFiles() {
  const files = []
  for (const root of DOC_ROOTS) {
    const directory = join(REPOSITORY_ROOT, root)
    if (!existsSync(directory)) continue
    for (const file of walk(directory, /\.md$/)) files.push(relative(REPOSITORY_ROOT, file))
  }
  for (const file of DOC_FILES) if (existsSync(join(REPOSITORY_ROOT, file))) files.push(file)
  return files.filter((f) => f !== relative(REPOSITORY_ROOT, DOCUMENT_PATH)).sort()
}

const lineCache = new Map()
function lineOf(file, index) {
  let offsets = lineCache.get(file)
  if (!offsets) {
    const text = readFileSync(file, 'utf8')
    offsets = []
    for (let i = 0; i < text.length; i++) if (text[i] === '\n') offsets.push(i)
    lineCache.set(file, offsets)
  }
  let line = 1
  for (const offset of offsets) {
    if (offset >= index) break
    line++
  }
  return line
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// ── Evidence: consumer repositories ───────────────────────────────────

/**
 * Scan one consumer checkout for binds of this package. Records every named
 * import, every namespace member access, and every name mentioned anywhere in
 * the repository — the last one covers the binds the import graph cannot see.
 */
function sweepRepository(name, root, names) {
  const hits = { production: [], typeOnly: [], tests: [], mentions: false }
  const mentioned = new Set()
  for (const file of walk(root, CONSUMER_SOURCE_FILE)) {
    const text = readFileSync(file, 'utf8')
    const relativePath = relative(root, file)
    // Identifier tokens, intersected with the census: one pass per file
    // instead of one regex per census name.
    for (const token of text.match(IDENTIFIER) ?? []) {
      if (names.has(token)) mentioned.add(token)
    }
    if (!text.includes(PACKAGE_NAME)) continue
    let parsed
    try {
      parsed = parseSync(file, text)
    } catch {
      continue
    }
    const isTest = TEST_FILE.test(relativePath) || /(^|\/)tests?\//.test(relativePath)
    const visit = (node) => {
      if (!node || typeof node !== 'object') return
      if (Array.isArray(node)) {
        for (const child of node) visit(child)
        return
      }
      const source = node.source?.value
      const importsPackage =
        typeof source === 'string' && (source === PACKAGE_NAME || source.startsWith(`${PACKAGE_NAME}/`))
      if (importsPackage && (node.type === 'ImportDeclaration' || node.type === 'ExportNamedDeclaration')) {
        const subpath = source === PACKAGE_NAME ? '.' : `./${source.slice(PACKAGE_NAME.length + 1)}`
        for (const specifier of node.specifiers ?? []) {
          if (specifier.type !== 'ImportSpecifier' && specifier.type !== 'ExportSpecifier') continue
          const symbol = specifier.imported?.name ?? specifier.imported?.value ?? specifier.local?.name
          if (!names.has(symbol)) continue
          const typeOnly =
            node.importKind === 'type' || node.exportKind === 'type' || specifier.importKind === 'type'
          const where = { symbol, subpath, where: `${name}:${relativePath}` }
          if (isTest) hits.tests.push(where)
          else if (typeOnly) hits.typeOnly.push(where)
          else hits.production.push(where)
        }
      }
      for (const key of Object.keys(node)) {
        if (key === 'type' || key === 'start' || key === 'end') continue
        visit(node[key])
      }
    }
    visit(parsed.program.body)
  }
  return { hits, mentioned: [...mentioned] }
}

function gitDescribe(root) {
  try {
    const ref = execFileSync('git', ['-C', root, 'rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' }).trim()
    const commit = execFileSync('git', ['-C', root, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim()
    return { ref, commit }
  } catch {
    return { ref: 'unknown', commit: 'unknown' }
  }
}

function runSweep(specifications) {
  const names = new Set(publishedValueExports().map((row) => row.name))
  const repositories = []
  const symbols = {}
  const touch = (symbol) => (symbols[symbol] ??= { production: [], typeOnly: [], tests: [], mentions: [] })
  for (const specification of specifications) {
    const separator = specification.indexOf('=')
    if (separator < 0) throw new Error(`export-census: --sweep needs name=path, got '${specification}'`)
    const name = specification.slice(0, separator)
    const root = resolve(specification.slice(separator + 1))
    const { hits, mentioned } = sweepRepository(name, root, names)
    const { ref, commit } = gitDescribe(root)
    repositories.push({ name, ref, commit, files: undefined })
    for (const channel of ['production', 'typeOnly', 'tests']) {
      for (const hit of hits[channel]) touch(hit.symbol)[channel].push(hit.where)
    }
    for (const symbol of mentioned) touch(symbol).mentions.push(name)
    process.stderr.write(`swept ${name} @ ${ref} ${commit}\n`)
  }
  for (const record of Object.values(symbols)) {
    for (const key of Object.keys(record)) record[key] = [...new Set(record[key])].sort()
  }
  const payload = {
    sweptAt: new Date().toISOString().slice(0, 10),
    repositories: repositories.sort((a, b) => a.name.localeCompare(b.name)),
    symbols: Object.fromEntries(Object.entries(symbols).sort(([a], [b]) => a.localeCompare(b))),
  }
  writeFileSync(CONSUMERS_PATH, `${JSON.stringify(payload, null, 2)}\n`)
  process.stderr.write(`wrote ${relative(REPOSITORY_ROOT, CONSUMERS_PATH)}\n`)
}

// ── Classification and rendering ──────────────────────────────────────

function classify(rows) {
  const names = new Set(rows.map((row) => row.name))
  const local = inRepositoryEvidence(names)
  const consumers = JSON.parse(readFileSync(CONSUMERS_PATH, 'utf8'))
  return {
    consumers,
    rows: rows.map((row) => {
      const inRepo = local.get(row.name) ?? { production: [], examples: [], tests: [], docs: [] }
      const external = consumers.symbols[row.name] ?? { production: [], typeOnly: [], tests: [], mentions: [] }
      const inPackageCaller = inRepo.production.filter((where) =>
        IN_PACKAGE_CALLER_ROOTS.some((root) => where.startsWith(root)),
      )
      if (external.production.length > 0) {
        return { ...row, consumer: 'production', evidence: external.production[0] }
      }
      if (inPackageCaller.length > 0) {
        return { ...row, consumer: 'production', evidence: `this package: ${inPackageCaller[0]}` }
      }
      if (external.typeOnly.length > 0) {
        return { ...row, consumer: 'production', evidence: `type position: ${external.typeOnly[0]}` }
      }
      if (inRepo.production.length > 0) {
        return { ...row, consumer: 'production', evidence: `this package: ${inRepo.production[0]}` }
      }
      if (external.tests.length > 0) {
        return { ...row, consumer: 'planned', evidence: `consumer tests: ${external.tests[0]}` }
      }
      if (inRepo.examples.length > 0) {
        return { ...row, consumer: 'planned', evidence: `example: ${inRepo.examples[0]}` }
      }
      if (inRepo.docs.length > 0) {
        return { ...row, consumer: 'planned', evidence: `doc: ${inRepo.docs[0]}` }
      }
      if (external.mentions.length > 0) {
        return { ...row, consumer: 'planned', evidence: `named in ${external.mentions[0]} (bind not in the import graph)` }
      }
      if (inRepo.tests.length > 0) {
        return { ...row, consumer: 'none', evidence: `only this package's tests: ${inRepo.tests[0]}` }
      }
      return { ...row, consumer: 'none', evidence: '' }
    }),
  }
}

function render({ rows, consumers }) {
  const tally = { production: 0, planned: 0, none: 0 }
  for (const row of rows) tally[row.consumer]++
  const subpaths = [...new Set(rows.map((row) => row.subpath))]
  const lines = []
  lines.push('# Public API census')
  lines.push('')
  lines.push(
    `Generated by \`pnpm api:census\` on demand — this is a dated reading, not a gate. Every named value export of every \`package.json#exports\` subpath, with the consumer that justifies publishing it. Regenerate it when the surface changes; do not edit it by hand.`,
  )
  lines.push('')
  lines.push('## Totals')
  lines.push('')
  lines.push('| measure | count |')
  lines.push('| --- | --- |')
  lines.push(`| export subpaths | ${subpaths.length} |`)
  lines.push(`| published value exports (subpath x symbol) | ${rows.length} |`)
  lines.push(`| distinct symbols | ${new Set(rows.map((r) => r.name)).size} |`)
  lines.push(`| production | ${tally.production} |`)
  lines.push(`| planned | ${tally.planned} |`)
  lines.push(`| none | ${tally.none} |`)
  lines.push('')
  lines.push('Type-only exports are not listed: a type binds no runtime surface, and removing one cannot break a caller at run time.')
  lines.push('')
  lines.push('## Classification')
  lines.push('')
  lines.push('- **production** — a consumer repository imports it in production code, this package\'s own CLI or wire server imports it, a consumer binds it in a type position, or another production module of this package imports it.')
  lines.push('- **planned** — no production caller, but a consumer\'s tests, a runnable example, a Markdown front door, or a consumer repository that names the symbol where the import graph cannot see the bind.')
  lines.push('- **none** — no evidence in any channel above. This is the delete list.')
  lines.push('')
  lines.push('## Consumer sweep')
  lines.push('')
  lines.push(`Swept ${consumers.sweptAt} across ${consumers.repositories.length} repositories, each on its default branch:`)
  lines.push('')
  lines.push('| repository | ref | commit |')
  lines.push('| --- | --- | --- |')
  for (const repository of consumers.repositories) {
    lines.push(`| ${repository.name} | ${repository.ref} | \`${repository.commit}\` |`)
  }
  lines.push('')
  lines.push('## What this census cannot see')
  lines.push('')
  lines.push('Every gap below makes a `none` less certain, so each one is answered by keeping the symbol, never by deleting it.')
  lines.push('')
  lines.push('1. **Dynamic imports and namespace binds.** `const { x } = await import(\'@tangle-network/agent-eval\')` and `import * as evaluation from ...` name no symbol the import graph can resolve. The sweep therefore also records every census name mentioned anywhere in a consumer repository; a symbol with only that evidence is `planned`, never `none`.')
  lines.push('2. **Repositories outside the sweep.** The list above is every repository in the `tangle-network` organisation whose `package.json` names this package, plus the local checkouts. A private fork, a consumer outside the organisation, or an npm consumer nobody told us about returns no hits and reads exactly like an unused symbol.')
  lines.push('3. **Pinned versions.** Each consumer is read at its default branch HEAD, which may resolve an older published version whose surface differs from this one.')
  lines.push('4. **The wire and RPC surfaces.** A JSON-RPC method name or an OpenAPI schema reached over the wire binds no TypeScript symbol. `docs/wire-protocol.md` and `clients/python/` own that contract.')
  lines.push('5. **String-keyed dispatch.** A symbol reached through a registry keyed by string is invisible to both channels.')
  lines.push('')
  lines.push('## Why a `none` can still be published')
  lines.push('')
  lines.push('A `none` row is a deletion candidate, not a deletion order. A symbol stays when removing it would lose something the census cannot weigh: a documented historical constant, a value another module of this package still needs, or a name whose only reference is a contract test over an on-disk artifact. Those are kept deliberately and stay listed here as `none`, so the next reader sees the same evidence and can decide again.')
  lines.push('')
  lines.push('The `none` set was reviewed symbol by symbol on 2026-08-21. Four rules decided most of it; each is recorded so the next reader inherits the judgment instead of redoing it.')
  lines.push('')
  lines.push('1. **A typed error constructor stays.** A caller discriminates a failure with `instanceof`, and a consumer that catches broadly binds no name for the import graph to see. Un-exporting one removes the only way to tell a named refusal from a bug, which contradicts this package\'s typed-outcome rule.')
  lines.push('2. **A wire schema or a contract-version constant stays.** `docs/wire-protocol.md`, `clients/python/`, and the OpenAPI document bind the same contract without binding a TypeScript symbol. That is blind spot 4 above, and it applies to every `*Schema`, `*_VERSION`, and `*_SCHEMA` row.')
  lines.push('3. **A published entry point with no doc is a documentation defect, not a dead export.** The per-harness coding-agent intake functions read `none` only because no Markdown front door named them; `docs/code-agent-intake.md` now does.')
  lines.push('4. **A symbol is deleted only when every channel is silent.** The 31-repository default-branch sweep, a GitHub code search across the organisation, the published `dist/` of every downstream package on npm, this repository\'s own source, tests, scripts, examples, and Markdown must all return nothing. Two symbols survived exactly this sweep: `runProposeReviewAsControlLoop`, whose caller is an uncommitted tool in `discovery-lab` but whose generated `.PROPOSAL.md` artifacts are committed there, and `shuffleOrder`, one of three stock contamination perturbations the changelog documents as a set.')
  lines.push('')
  lines.push('## Exports')
  lines.push('')
  for (const subpath of subpaths) {
    const subpathRows = rows.filter((row) => row.subpath === subpath)
    const counts = { production: 0, planned: 0, none: 0 }
    for (const row of subpathRows) counts[row.consumer]++
    lines.push(`### \`${subpath}\``)
    lines.push('')
    lines.push(`${subpathRows.length} value exports — ${counts.production} production, ${counts.planned} planned, ${counts.none} none.`)
    lines.push('')
    lines.push('| symbol | consumer | evidence |')
    lines.push('| --- | --- | --- |')
    for (const row of subpathRows) {
      lines.push(`| \`${row.name}\` | ${row.consumer} | ${row.evidence === '' ? '—' : row.evidence} |`)
    }
    lines.push('')
  }
  return `${lines.join('\n')}`
}

// ── Entry ─────────────────────────────────────────────────────────────

const argv = process.argv.slice(2)
if (argv[0] === '--sweep') {
  runSweep(argv.slice(1))
} else {
  writeFileSync(DOCUMENT_PATH, render(classify(publishedValueExports())))
  process.stdout.write(`wrote ${relative(REPOSITORY_ROOT, DOCUMENT_PATH)}\n`)
}
