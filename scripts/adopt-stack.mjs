#!/usr/bin/env node
// Adopt the newest @tangle-network releases in a caller repository: pin them,
// widen the caller's own peer ranges to include them, gate the result with the
// caller's acceptance command, and open (and optionally merge) one pull request.
// .github/workflows/adopt-stack.yml runs it for every caller repository.
//
// Rules carried over from gtm-agent scripts/agent-app-bump.mjs and
// discovery-lab .github/workflows/runtime-bump.yml:
// - One open adoption branch (`chore/adopt-stack`). The pull request body
//   records a hash of the plan's edits and the last result. A run skips only
//   when the open pull request records the same hash and a passed gate (and
//   `--merge` is off); any other plan, a failed gate or a refused merge is
//   re-gated and replaces the head. A missing or edited marker counts as a
//   different plan, so the failure mode is one extra gate run.
// - Commits use the Actions bot identity, because self-hosted runners have no
//   git identity and the first discovery-lab bumps died at their first commit.
// - The new releases' peer ranges decide the sibling pins: a sibling the caller
//   pins outside an adopted release's peer range moves to the newest version
//   inside every such range, even when that holds it below npm latest.
// - The adopted versions are exact pins, so the install refetches metadata for
//   a version its cache has not seen; no cache override is needed.
// - It merges only a head whose base is still the default branch head, so the
//   merged tree is the one the gate passed. No admin merge is attempted.
//
// Widening keeps the lower bound of the range's last alternative and moves its
// upper bound to <0.(m+1).0 for the 0.m.x version pinned, which is npm latest
// unless a sibling rule holds it lower; a peer never claims a version the gate
// did not run. A range that already covers the version is left as written.
// Packages past 1.0 (agent-knowledge, agent-interface) are pinned like any
// other, but a range that excludes a new major is refused with a non-zero exit:
// a major is a breaking release a person widens on purpose. A prerelease npm
// latest is refused the same way. An unparseable range in an adopted release's
// own peers is skipped with a warning instead of aborting every package.
//
// The semver subset below is hand-written because the script runs from a
// sparse checkout in each caller with no installed dependencies.
//
// usage: node scripts/adopt-stack.mjs [--dir PATH] [--packages a,b] [--gate CMD]
//          [--default-branch main] [--merge] [--dry-run] [--json]
// Without --dry-run it needs git, gh (GH_TOKEN with contents and pull-requests:
// write) and the caller's package manager.
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const SCOPE = '@tangle-network/'
const BRANCH = 'chore/adopt-stack'
const BOT = ['-c', 'user.name=github-actions[bot]', '-c', 'user.email=41898282+github-actions[bot]@users.noreply.github.com']
const REGISTRY = (process.env.npm_config_registry || process.env.NPM_CONFIG_REGISTRY || 'https://registry.npmjs.org').replace(/\/$/, '')
const EXACT = /^\d+\.\d+\.\d+$/
const MARKER = /<!-- adopt-stack:plan=([0-9a-f]+) result=(pass|gate-fail|merge-refused) -->/

// ---- semver: release versions and the range grammar package.json uses ----

/** Parse an exact release version; prereleases and build tags return null. */
function release(text) {
  const m = EXACT.exec(String(text).trim().replace(/^[=v]+/, ''))
  return m ? text.trim().replace(/^[=v]+/, '').split('.').map(Number) : null
}

const compare = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]
const format = (v) => v.join('.')

/** A partial version such as `1`, `1.2`, `1.2.x` as [major, minor|null, patch|null]. */
function partial(text) {
  const m = /^v?(\d+|[xX*])(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?$/.exec(text)
  if (!m) throw new Error(`unsupported version "${text}" in a range`)
  const part = (s) => (s === undefined || /^[xX*]$/.test(s) ? null : Number(s))
  const [major, minor, patch] = [part(m[1]), part(m[2]), part(m[3])]
  if (major === null) return [null, null, null]
  return [major, minor === null ? null : minor, minor === null ? null : patch]
}

/** One range alternative as [op, version] comparators with only >=, >, <, <=. */
function comparators(alternative) {
  const text = alternative.trim().replace(/(<=|>=|<|>|=|\^|~)\s+/g, '$1')
  if (text === '' || text === '*' || /^[xX]$/.test(text)) return []
  const hyphen = /^(\S+)\s+-\s+(\S+)$/.exec(text)
  if (hyphen) return [...comparators(`>=${hyphen[1]}`), ...comparators(`<=${hyphen[2]}`)]
  const out = []
  for (const token of text.split(/\s+/)) {
    const m = /^(\^|~|>=|<=|>|<|=)?(.+)$/.exec(token)
    if (!m || /-/.test(m[2])) throw new Error(`unsupported comparator "${token}"`)
    const op = m[1] ?? '='
    const [major, minor, patch] = partial(m[2])
    if (major === null) continue
    const low = [major, minor ?? 0, patch ?? 0]
    // The first version above a partial: 1.2 -> 1.3.0, 1 -> 2.0.0.
    const above = minor === null ? [major + 1, 0, 0] : patch === null ? [major, minor + 1, 0] : [major, minor, patch + 1]
    if (op === '^') {
      const upper = major > 0 || minor === null ? [major + 1, 0, 0]
        : minor > 0 || patch === null ? [0, minor + 1, 0] : [0, 0, patch + 1]
      out.push(['>=', low], ['<', upper])
    } else if (op === '~') out.push(['>=', low], ['<', minor === null ? [major + 1, 0, 0] : [major, minor + 1, 0]])
    else if (op === '=') out.push(['>=', low], ['<', above])
    else if (op === '>') out.push(['>=', above])
    else if (op === '<=') out.push(['<', above])
    else out.push([op, low])
  }
  return out
}

/** Whether every alternative of `range` is in the grammar above. */
function parses(range) {
  try {
    for (const alternative of range.split('||')) comparators(alternative)
    return true
  } catch {
    return false
  }
}

/** Whether release version `version` satisfies `range` (`||`, caret, tilde, x and hyphen ranges). */
export function satisfies(version, range) {
  const v = release(version)
  if (!v) return false
  return range.split('||').some((alternative) =>
    comparators(alternative).every(([op, bound]) => (op === '>=' ? compare(v, bound) >= 0 : compare(v, bound) < 0)))
}

/**
 * Widen `range` so it includes `latest`, keeping the lower bound of its last
 * alternative. Returns the range unchanged when it already covers `latest`.
 */
export function widenRange(range, latest) {
  const v = release(latest)
  if (!v) throw new Error(`${latest} is not a release version`)
  if (satisfies(latest, range)) return range
  if (v[0] > 0) throw new Error(`"${range}" excludes ${latest}, a new major release; widen it by hand`)
  const alternatives = range.split('||').map((part) => part.trim())
  const lower = comparators(alternatives.at(-1)).filter(([op]) => op === '>=').map(([, bound]) => bound)
    .sort(compare).at(-1)
  if (!lower) throw new Error(`cannot widen "${range}": its last alternative has no lower bound`)
  if (compare(lower, v) > 0) throw new Error(`cannot widen "${range}": its lower bound is above ${latest}`)
  alternatives[alternatives.length - 1] = `>=${format(lower)} <0.${v[1] + 1}.0`
  return alternatives.join(' || ')
}

// ---- registry ----

async function packument(name) {
  const url = `${REGISTRY}/${name.replace('/', '%2f')}`
  const response = await fetch(url, { headers: { accept: 'application/vnd.npm.install-v1+json' } })
  if (!response.ok) throw new Error(`GET ${url} answered ${response.status}`)
  const doc = await response.json()
  const latest = doc['dist-tags']?.latest
  if (!release(latest ?? '')) throw new Error(`${name}: npm latest ${latest} is not a release version`)
  return { latest, versions: doc.versions }
}

const newestIn = (doc, ranges) => Object.keys(doc.versions)
  .filter((v) => release(v) && ranges.every((range) => satisfies(v, range)))
  .sort((a, b) => compare(release(a), release(b))).at(-1)

// ---- plan ----

const SECTIONS = ['dependencies', 'devDependencies']

/** The new spec for a dependency, or null when it stays as written. */
function respec(spec, target) {
  if (EXACT.test(spec)) return spec === target ? null : target
  // Protocols, git shorthands and dist-tags are the caller's choice, not a version.
  if (/^(workspace|catalog|npm|file|link|git|github|https?):/.test(spec) || spec.includes('/') || /^[a-wyzA-WYZ]/.test(spec)) return null
  const widened = widenRange(spec, target)
  return widened === spec ? null : widened
}

/** Edit the catalog entries in a pnpm-workspace.yaml text, line by line within catalog blocks. */
function catalogEdits(text, targets) {
  const edits = []
  let block = null
  const lines = text.split('\n').map((line, index) => {
    const top = /^([A-Za-z][\w-]*):/.exec(line)
    if (top) block = top[1]
    if (block !== 'catalog' && block !== 'catalogs') return line
    const m = /^(\s+)(['"]?)(@tangle-network\/[\w.-]+)\2(\s*:\s*)(['"]?)([^'"#]+?)\5(\s*(?:#.*)?)$/.exec(line)
    if (!m || !targets.has(m[3])) return line
    const to = respec(m[6], targets.get(m[3]).target)
    if (!to) return line
    const { target: version, why } = targets.get(m[3])
    edits.push({ file: 'pnpm-workspace.yaml', section: `${block} line ${index + 1}`, name: m[3], from: m[6], to, version, why })
    return `${m[1]}${m[2]}${m[3]}${m[2]}${m[4]}${m[5]}${to}${m[5]}${m[7]}`
  })
  return { text: lines.join('\n'), edits }
}

export async function plan(dir, requested = []) {
  const manifestText = readFileSync(join(dir, 'package.json'), 'utf8')
  const pkg = JSON.parse(manifestText)
  const found = new Set([...SECTIONS, 'peerDependencies'].flatMap((section) => Object.keys(pkg[section] ?? {}))
    .filter((name) => name.startsWith(SCOPE) && name !== pkg.name))
  const names = requested.length ? requested : [...found].sort()
  for (const name of names) if (!name.startsWith(SCOPE)) throw new Error(`${name} is not a ${SCOPE}* package`)

  const docs = new Map()
  const doc = async (name) => {
    if (!docs.has(name)) docs.set(name, packument(name))
    return docs.get(name)
  }
  await Promise.all(names.map(doc))
  const targets = new Map()
  for (const name of names) targets.set(name, { latest: (await doc(name)).latest, target: (await doc(name)).latest, why: 'npm latest' })

  // Sibling pins: every adopted release's peer ranges constrain the caller's
  // @tangle-network pins, adopted or not.
  const pinned = new Map()
  for (const section of SECTIONS) for (const [name, spec] of Object.entries(pkg[section] ?? {})) {
    if (name.startsWith(SCOPE) && name !== pkg.name) pinned.set(name, spec)
  }
  const constraints = new Map()
  const warnings = []
  for (const name of names) {
    const { latest } = targets.get(name)
    for (const [peer, range] of Object.entries((await doc(name)).versions[latest]?.peerDependencies ?? {})) {
      if (!pinned.has(peer) || peer === name) continue
      if (!parses(range)) {
        warnings.push(`${name}@${latest} peers ${peer} "${range}", a range this script cannot read; that constraint is skipped`)
        continue
      }
      constraints.set(peer, [...(constraints.get(peer) ?? []), { by: `${name}@${latest}`, range }])
    }
  }
  for (const [sibling, rules] of constraints) {
    const current = targets.get(sibling)?.target ?? (EXACT.test(pinned.get(sibling)) ? pinned.get(sibling) : null)
    if (!current || rules.every(({ range }) => satisfies(current, range))) continue
    const allowed = newestIn(await doc(sibling), rules.map(({ range }) => range))
    const reason = rules.map(({ by, range }) => `${by} peers ${range}`).join('; ')
    if (!allowed) throw new Error(`no published ${sibling} satisfies every adopted peer range (${reason})`)
    targets.set(sibling, { latest: (await doc(sibling)).latest, target: allowed, why: `held by peer ranges: ${reason}` })
  }

  const edits = []
  for (const section of SECTIONS) for (const [name, spec] of Object.entries(pkg[section] ?? {})) {
    const entry = targets.get(name)
    const to = entry && respec(spec, entry.target)
    if (to) edits.push({ file: 'package.json', section, name, from: spec, to, version: entry.target, why: entry.why })
  }
  for (const [name, range] of Object.entries(pkg.peerDependencies ?? {})) {
    const entry = targets.get(name)
    if (!entry || !names.includes(name)) continue
    const to = widenRange(range, entry.target)
    const pinnedAt = entry.target === entry.latest ? `npm latest ${entry.target}` : `${entry.target}, the version pinned`
    if (to !== range) edits.push({ file: 'package.json', section: 'peerDependencies', name, from: range, to, version: entry.target, why: `upper bound widened to include ${pinnedAt}` })
  }
  const workspacePath = join(dir, 'pnpm-workspace.yaml')
  const workspace = existsSync(workspacePath) ? catalogEdits(readFileSync(workspacePath, 'utf8'), targets) : { edits: [] }
  edits.push(...workspace.edits)

  return {
    packages: names.map((name) => ({ name, ...targets.get(name) })),
    held: [...targets].filter(([name, entry]) => !names.includes(name) || entry.target !== entry.latest)
      .map(([name, entry]) => ({ name, ...entry })),
    edits,
    warnings,
    files: { manifestText, pkg, workspaceText: workspace.text },
  }
}

/**
 * The pull request title, a label only: `chore(deps): adopt <package> <version>`
 * for one package; several share one pull request. planHash is its identity.
 */
export function titleOf(edits) {
  const names = [...new Set(edits.map((edit) => edit.name))]
  if (names.length > 1) return `chore(deps): adopt ${names.length} ${SCOPE}* packages`
  const pin = edits.find((edit) => edit.section !== 'peerDependencies') ?? edits[0]
  return `chore(deps): adopt ${pin.name} ${pin.version}`
}

/** A digest of the edits alone, so the same plan always hashes the same. */
export function planHash(edits) {
  const rows = edits.map(({ file, section, name, from, to }) => [file, section, name, from, to]).map((row) => JSON.stringify(row)).sort()
  return createHash('sha256').update(rows.join('\n')).digest('hex').slice(0, 16)
}

// ---- effects ----

const out = (cmd, argv, cwd) => execFileSync(cmd, argv, { cwd, encoding: 'utf8' }).trim()
const run = (cmd, argv, cwd, env = {}) => spawnSync(cmd, argv, { cwd, stdio: 'inherit', env: { ...process.env, ...env } }).status === 0
const log = (line) => console.log(`adopt-stack: ${line}`)

function write(dir, result) {
  const { manifestText, pkg, workspaceText } = result.files
  for (const edit of result.edits) if (edit.file === 'package.json') pkg[edit.section][edit.name] = edit.to
  const indent = /^([ \t]+)"/m.exec(manifestText)?.[1] ?? '  '
  writeFileSync(join(dir, 'package.json'), `${JSON.stringify(pkg, null, indent)}\n`)
  if (result.edits.some((edit) => edit.file === 'pnpm-workspace.yaml')) writeFileSync(join(dir, 'pnpm-workspace.yaml'), workspaceText)
}

function install(dir) {
  if (existsSync(join(dir, 'pnpm-lock.yaml'))) {
    if (!run('pnpm', ['install', '--no-frozen-lockfile'], dir)) throw new Error('pnpm install failed for the new pins')
  } else if (existsSync(join(dir, 'package-lock.json'))) {
    if (!run('npm', ['install', '--prefer-online'], dir)) throw new Error('npm install failed for the new pins')
  } else throw new Error('no pnpm-lock.yaml or package-lock.json to update')
}

function body(result, gate, hash, outcome, head) {
  const rows = result.edits.map((e) => `| \`${e.name}\` | ${e.file} ${e.section} | \`${e.from}\` | \`${e.to}\` | ${e.why} |`)
  return [
    `Adopts the newest ${SCOPE}* releases (agent-eval scripts/adopt-stack.mjs, run by .github/workflows/adopt-stack.yml).`,
    '',
    '| package | where | from | to | why |', '|---|---|---|---|---|', ...rows, '',
    `Gate: \`${gate}\` on ${head.slice(0, 12)}: ${outcome === 'gate-fail' ? 'failed' : 'passed'}.`,
    '',
    `<!-- adopt-stack:plan=${hash} result=${outcome} -->`,
  ].join('\n')
}

async function deliver(dir, result, { gate, defaultBranch, merge }) {
  const title = titleOf(result.edits)
  const hash = planHash(result.edits)
  const gh = (argv) => out('gh', argv, dir)
  const open = JSON.parse(gh(['pr', 'list', '--head', BRANCH, '--base', defaultBranch, '--state', 'open', '--json', 'number,body']))[0]
  const recorded = MARKER.exec(open?.body ?? '')
  if (recorded?.[1] === hash && recorded[2] === 'pass' && !merge) return log(`#${open.number} already proposes plan ${hash} and passed its gate`)

  write(dir, result)
  install(dir)
  const base = out('git', ['rev-parse', 'HEAD'], dir)
  log(`gate: ${gate}`)
  const green = run('bash', ['-c', gate], dir)

  const files = ['package.json', 'pnpm-workspace.yaml', 'pnpm-lock.yaml', 'package-lock.json'].filter((file) => existsSync(join(dir, file)))
  if (!run('git', ['switch', '-q', '-C', BRANCH], dir) || !run('git', ['add', '--', ...files], dir)) throw new Error('could not stage the adoption')
  if (!run('git', [...BOT, 'commit', '-q', '-m', title], dir)) throw new Error('commit failed')
  // The adoption branch belongs to this workflow; a newer plan replaces its head.
  if (!run('git', ['push', '-q', '--force', 'origin', `HEAD:refs/heads/${BRANCH}`], dir)) throw new Error('push failed')
  const head = out('git', ['rev-parse', 'HEAD'], dir)
  const bodyFile = join(mkdtempSync(join(tmpdir(), 'adopt-stack-body-')), 'body.md')
  writeFileSync(bodyFile, body(result, gate, hash, green ? 'pass' : 'gate-fail', head))
  let number = open?.number
  if (number) gh(['pr', 'edit', String(number), '--title', title, '--body-file', bodyFile])
  else {
    gh(['pr', 'create', '--head', BRANCH, '--base', defaultBranch, '--title', title, '--body-file', bodyFile])
    number = JSON.parse(gh(['pr', 'list', '--head', BRANCH, '--base', defaultBranch, '--state', 'open', '--json', 'number']))[0].number
  }
  log(`${open ? 'updated' : 'opened'} #${number}: ${title}`)

  const comment = (text) => gh(['pr', 'comment', String(number), '--body', text])
  if (!green) {
    comment(`Gate \`${gate}\` failed on ${head.slice(0, 12)}. Left open; the next run re-gates it.`)
    throw new Error(`#${number} failed its gate`)
  }
  if (!merge) return log('merge is off; left open')
  const remote = out('git', ['ls-remote', 'origin', `refs/heads/${defaultBranch}`], dir).split(/\s/)[0]
  if (remote !== base) {
    // Closed, so the next run does not mistake it for an in-flight proposal.
    gh(['pr', 'close', String(number), '--comment', `Gate passed, but ${defaultBranch} moved from ${base.slice(0, 12)} to ${remote.slice(0, 12)}; the next run re-gates on the new head.`])
    return log(`${defaultBranch} moved during the gate; closed #${number} for a re-gate`)
  }
  const merged = spawnSync('gh', ['pr', 'merge', String(number), '--squash', '--match-head-commit', head], { cwd: dir, encoding: 'utf8' })
  if (merged.status !== 0) {
    writeFileSync(bodyFile, body(result, gate, hash, 'merge-refused', head))
    gh(['pr', 'edit', String(number), '--body-file', bodyFile])
    comment(`Gate passed on ${head.slice(0, 12)}, but the merge was refused:\n\n\`\`\`\n${(merged.stderr || merged.stdout).trim()}\n\`\`\`\n\nNo admin merge or protection bypass was attempted.`)
    throw new Error(`merging #${number} was refused`)
  }
  log(`merged #${number} at ${head.slice(0, 12)}`)
}

function options(argv) {
  const value = (flag, fallback) => (argv.includes(flag) ? argv[argv.indexOf(flag) + 1] ?? '' : fallback)
  return {
    dir: resolve(value('--dir', '.')),
    packages: value('--packages', '').split(/[\s,]+/).filter(Boolean),
    gate: value('--gate', '').trim(),
    defaultBranch: value('--default-branch', 'main'),
    merge: argv.includes('--merge'),
    dryRun: argv.includes('--dry-run'),
    json: argv.includes('--json'),
  }
}

async function main() {
  const opts = options(process.argv.slice(2))
  const result = await plan(opts.dir, opts.packages)
  const { files: _files, ...printable } = result
  if (opts.json) {
    console.log(JSON.stringify(printable, null, 2))
    if (opts.dryRun) return
  } else {
    for (const p of result.packages) log(`${p.name}: npm latest ${p.latest}${p.target !== p.latest ? `, held at ${p.target} (${p.why})` : ''}`)
    for (const h of result.held) if (!result.packages.some((p) => p.name === h.name)) log(`${h.name}: sibling moves to ${h.target} (${h.why})`)
    for (const e of result.edits) log(`${e.file} ${e.section} ${e.name}: ${e.from} -> ${e.to} (${e.why})`)
  }
  for (const warning of result.warnings) console.error(`adopt-stack: warning: ${warning}`)
  if (!result.edits.length) return log('nothing to adopt')
  if (opts.dryRun) return log(`dry run: would open "${titleOf(result.edits)}" (plan ${planHash(result.edits)})${opts.gate ? `, gate it with \`${opts.gate}\`` : ''}${opts.merge ? ' and merge it when green' : ''}; nothing was changed`)
  if (!opts.gate) throw new Error('--gate is required without --dry-run')
  await deliver(opts.dir, result, opts)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(`adopt-stack: ${error.message}`)
    process.exit(1)
  })
}
