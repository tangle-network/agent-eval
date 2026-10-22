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
// - Peer checks read the version the lockfile will hold (the planned target,
//   an exact pin, or the locked version), never npm latest. A sibling whose
//   locked release peers a range excluding an adopted version rises to the
//   newest release whose peers admit it. agent-runtime#1946 kept
//   agent-knowledge 22.0.3 (peer agent-eval <0.216.0) under `^22.0.3` while
//   adopting agent-eval 0.217.1, and pnpm refused the peer.
// - A range dependency or catalog entry whose locked version is older than its
//   target gets its floor raised to the target (`^22.0.3` -> `^22.0.7`), since
//   an install keeps a locked version its range still admits.
// - A caller's release/cohort.json entries for planned packages move to the
//   planned version and its source commit (npm gitHead, else the release tag),
//   so the cohort the caller releases with matches its pins.
// - The adopted versions are exact pins, so the install refetches metadata for
//   a version its cache has not seen; no cache override is needed.
// - It merges only a head whose base is still the default branch head, so the
//   merged tree is the one the gate passed. No admin or auto merge is attempted.
// - A merge refused by the base branch policy while the pull request's review
//   decision is REVIEW_REQUIRED waits for the approval bot: the same merge is
//   retried every 20 s for up to 15 min. Any other refusal, or the wait running
//   out, records merge-refused and the comment says which.
//   ADOPT_STACK_POLL_MS and ADOPT_STACK_WAIT_MS override the two bounds.
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
// `--post-pin CMD` runs the caller's own sync step (template pins, peer floors
// and other rules only the caller knows) in its checkout after the pins and the
// lockfile are written and before the gate. Every file it changes is committed
// in the adoption commit and listed in the pull request body; the command is
// part of the plan hash, so changing it re-gates. A failing command fails the
// run with its output before anything is committed. A dry run runs it in a
// throwaway copy of the pinned manifest without an install and lists the files
// it would change.
//
// The semver subset below is hand-written because the script runs from a
// sparse checkout in each caller with no installed dependencies.
//
// usage: node scripts/adopt-stack.mjs [--dir PATH] [--packages a,b] [--gate CMD]
//          [--post-pin CMD] [--default-branch main] [--merge] [--dry-run] [--json]
// Without --dry-run it needs git, gh (GH_TOKEN with contents and pull-requests:
// write) and the caller's package manager.
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, lstatSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const SCOPE = '@tangle-network/'
const BRANCH = 'chore/adopt-stack'
const COHORT = 'release/cohort.json'
const BOT = ['-c', 'user.name=github-actions[bot]', '-c', 'user.email=41898282+github-actions[bot]@users.noreply.github.com']
const REGISTRY = (process.env.npm_config_registry || process.env.NPM_CONFIG_REGISTRY || 'https://registry.npmjs.org').replace(/\/$/, '')
const EXACT = /^\d+\.\d+\.\d+$/
const MARKER = /<!-- adopt-stack:plan=([0-9a-f]+) result=(pass|gate-fail|merge-refused) -->/
// gh's refusal when a required review (or check) is missing; reviewDecision tells which.
const POLICY = /base branch policy prohibits the merge/
const POLL_MS = Number(process.env.ADOPT_STACK_POLL_MS || 20_000)
const WAIT_MS = Number(process.env.ADOPT_STACK_WAIT_MS || 15 * 60_000)

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

/**
 * `range` narrowed so `version` is its lowest admitted release: an install
 * keeps a locked version its range still admits, so adopting a newer one means
 * raising the floor. A lone caret or tilde keeps its operator; anything else
 * becomes `>=version` up to the last alternative's upper bound. `range` must
 * already admit `version` (widen it first).
 */
export function raiseFloor(range, version) {
  const last = range.split('||').at(-1).trim()
  const lone = /^([\^~])\d+\.\d+\.\d+$/.exec(last)
  if (lone) return `${lone[1]}${version}`
  const upper = comparators(last).filter(([op]) => op === '<').map(([, bound]) => bound).sort(compare)[0]
  return upper ? `>=${version} <${format(upper)}` : `>=${version}`
}

// ---- lockfile ----

/**
 * The versions the caller's lockfile holds for its root manifest's dependencies
 * (`importer`) and its pnpm catalog entries (`catalog`, the lowest across named
 * catalogs). Read line by line, since the script has no YAML parser.
 */
export function lockedVersions(dir) {
  const importer = new Map()
  const catalog = new Map()
  const record = (map, name, value) => {
    const version = String(value).replace(/^['"]|['"]$/g, '').replace(/\(.*$/, '')
    if (!release(version)) return
    if (!map.has(name) || compare(release(version), release(map.get(name))) < 0) map.set(name, version)
  }
  const pnpmLock = join(dir, 'pnpm-lock.yaml')
  const npmLock = join(dir, 'package-lock.json')
  if (existsSync(pnpmLock)) {
    const path = []
    for (const line of readFileSync(pnpmLock, 'utf8').split('\n')) {
      const m = /^( *)(['"]?)([^'":\s][^'":]*)\2:(?:\s+(\S.*))?$/.exec(line)
      if (!m) continue
      const depth = m[1].length / 2
      path.length = depth
      path[depth] = m[3]
      if (m[3] !== 'version' || !m[4]) continue
      // catalogs.<catalog>.<name>.version and importers['.'].<section>.<name>.version
      if (path[0] === 'catalogs' && depth === 3) record(catalog, path[2], m[4])
      else if (path[0] === 'importers' && path[1] === '.' && depth === 4 && SECTIONS.includes(path[2])) record(importer, path[3], m[4])
    }
  } else if (existsSync(npmLock)) {
    for (const [key, entry] of Object.entries(JSON.parse(readFileSync(npmLock, 'utf8')).packages ?? {})) {
      const name = /^node_modules\/((?:@[^/]+\/)?[^/]+)$/.exec(key)?.[1]
      if (name && entry?.version) record(importer, name, entry.version)
    }
  }
  return { importer, catalog }
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

/**
 * The new spec for a dependency, or null when it stays as written. A range
 * whose `locked` version is older than `target` gets its floor raised, because
 * an install keeps a locked version its range still admits.
 */
function respec(spec, target, locked) {
  if (EXACT.test(spec)) return spec === target ? null : target
  // Protocols, git shorthands and dist-tags are the caller's choice, not a version.
  if (/^(workspace|catalog|npm|file|link|git|github|https?):/.test(spec) || spec.includes('/') || /^[a-wyzA-WYZ]/.test(spec)) return null
  const widened = widenRange(spec, target)
  const stale = locked && compare(release(locked), release(target)) < 0 && satisfies(locked, widened)
  const to = stale ? raiseFloor(widened, target) : widened
  return to === spec ? null : to
}

/** Edit the catalog entries in a pnpm-workspace.yaml text, line by line within catalog blocks. */
function catalogEdits(text, targets, locked) {
  const edits = []
  let block = null
  const lines = text.split('\n').map((line, index) => {
    const top = /^([A-Za-z][\w-]*):/.exec(line)
    if (top) block = top[1]
    if (block !== 'catalog' && block !== 'catalogs') return line
    const m = /^(\s+)(['"]?)(@tangle-network\/[\w.-]+)\2(\s*:\s*)(['"]?)([^'"#]+?)\5(\s*(?:#.*)?)$/.exec(line)
    if (!m || !targets.has(m[3])) return line
    const to = respec(m[6], targets.get(m[3]).target, locked.get(m[3]))
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
  // The version the lockfile will hold after the plan: an adopted target (the
  // edits below raise any range whose lock is older), else an exact pin, else
  // the version the lockfile already holds, never npm latest.
  const locks = lockedVersions(dir)
  const resolved = (name) => targets.get(name)?.target
    ?? (EXACT.test(pinned.get(name)) ? pinned.get(name) : locks.importer.get(name) ?? null)
  for (const [sibling, rules] of constraints) {
    const current = resolved(sibling)
    if (!current || rules.every(({ range }) => satisfies(current, range))) continue
    const allowed = newestIn(await doc(sibling), rules.map(({ range }) => range))
    const reason = rules.map(({ by, range }) => `${by} peers ${range}`).join('; ')
    if (!allowed) throw new Error(`no published ${sibling} satisfies every adopted peer range (${reason})`)
    targets.set(sibling, { latest: (await doc(sibling)).latest, target: allowed, why: `held by peer ranges: ${reason}` })
  }

  // The other direction: a sibling whose resolved version's own peer range
  // excludes an adopted target rises to the newest release whose peers admit
  // every adopted target, even when its range already admits npm latest. When
  // no release admits them yet, the sibling rises to its newest release and
  // the excluded targets are held inside that release's peer ranges.
  for (const sibling of [...pinned.keys()].sort()) {
    const current = resolved(sibling)
    if (!current) continue
    const siblingDoc = await doc(sibling)
    const excluded = (version) => Object.entries(siblingDoc.versions[version]?.peerDependencies ?? {})
      .filter(([peer, range]) => peer !== sibling && targets.has(peer) && parses(range) && !satisfies(targets.get(peer).target, range))
    if (!siblingDoc.versions[current] || !excluded(current).length) continue
    const reason = excluded(current).map(([peer, range]) => `${sibling}@${current} peers ${peer} ${range}, excluding ${targets.get(peer).target}`).join('; ')
    const newer = Object.keys(siblingDoc.versions).filter((v) => release(v) && compare(release(v), release(current)) > 0)
      .sort((a, b) => compare(release(a), release(b)))
    const raised = newer.filter((v) => !excluded(v).length).at(-1) ?? newer.at(-1) ?? current
    if (raised !== current) targets.set(sibling, { latest: siblingDoc.latest, target: raised, why: `raised by peer range: ${reason}` })
    for (const [peer, range] of excluded(raised)) {
      const held = newestIn(await doc(peer), [range])
      if (!held) throw new Error(`no published ${peer} satisfies ${sibling}@${raised}'s peer range ${range}`)
      targets.set(peer, { ...targets.get(peer), target: held, why: `held by peer ranges: ${sibling}@${raised} peers ${range}` })
    }
  }

  const edits = []
  for (const section of SECTIONS) for (const [name, spec] of Object.entries(pkg[section] ?? {})) {
    const entry = targets.get(name)
    const to = entry && respec(spec, entry.target, locks.importer.get(name))
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
  const workspace = existsSync(workspacePath) ? catalogEdits(readFileSync(workspacePath, 'utf8'), targets, locks.catalog) : { edits: [] }
  edits.push(...workspace.edits)
  const cohort = await cohortEdits(dir, targets)
  edits.push(...cohort.edits)

  return {
    packages: names.map((name) => ({ name, ...targets.get(name) })),
    held: [...targets].filter(([name, entry]) => !names.includes(name) || entry.target !== entry.latest)
      .map(([name, entry]) => ({ name, ...entry })),
    edits,
    warnings,
    files: { manifestText, pkg, workspaceText: workspace.text, cohortText: cohort.text },
  }
}

/**
 * Move each release/cohort.json entry (agent-runtime's record of the exact
 * first-party versions and source commits it releases with) to the planned
 * version and that version's source commit.
 */
async function cohortEdits(dir, targets) {
  const path = join(dir, COHORT)
  if (!existsSync(path)) return { edits: [] }
  const text = readFileSync(path, 'utf8')
  const cohort = JSON.parse(text)
  const edits = []
  for (const [key, entry] of Object.entries(cohort.packages ?? {})) {
    const planned = targets.get(entry?.name)?.target
    if (!planned || entry.version === planned) continue
    const ref = await sourceRef(entry.name, planned, entry.repository)
    edits.push({ file: COHORT, section: `packages.${key}`, name: entry.name, from: `${entry.version} ${entry.ref}`, to: `${planned} ${ref}`, version: planned, why: `${entry.name}@${planned} and its source commit` })
    cohort.packages[key] = { ...entry, version: planned, ref }
  }
  const indent = /^([ \t]+)"/m.exec(text)?.[1] ?? '  '
  return { edits, text: `${JSON.stringify(cohort, null, indent)}\n` }
}

/**
 * The commit a release was published from: npm's gitHead, else the release tag
 * (`<name>@<version>` or `v<version>`) in `repository` (owner/name on GitHub).
 */
async function sourceRef(name, version, repository) {
  const url = `${REGISTRY}/${name.replace('/', '%2f')}/${version}`
  const response = await fetch(url)
  if (!response.ok) throw new Error(`GET ${url} answered ${response.status}`)
  const gitHead = (await response.json()).gitHead
  if (/^[0-9a-f]{40}$/.test(gitHead ?? '')) return gitHead
  const tags = [`refs/tags/${name}@${version}`, `refs/tags/v${version}`]
  const remote = repository ? out('git', ['ls-remote', '--tags', `https://github.com/${repository}.git`, ...tags], process.cwd()) : ''
  const refs = new Map(remote.split('\n').filter(Boolean).map((line) => line.split('\t').reverse()))
  // An annotated tag's peeled (^{}) entry names the commit; a lightweight tag names it directly.
  const ref = tags.flatMap((tag) => [refs.get(`${tag}^{}`), refs.get(tag)]).find(Boolean)
  if (!ref) throw new Error(`${name}@${version}: npm records no gitHead and ${repository || 'its repository'} has no ${tags.map((tag) => tag.slice(10)).join(' or ')} tag, so ${COHORT} cannot name its source commit`)
  return ref
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

/**
 * A digest of the edits and the post-pin command, so the same plan always
 * hashes the same. Without a post-pin command the hash is the edits' alone.
 */
export function planHash(edits, postPin = '') {
  const rows = edits.map(({ file, section, name, from, to }) => [file, section, name, from, to]).map((row) => JSON.stringify(row)).sort()
  if (postPin) rows.push(JSON.stringify(['post-pin', postPin]))
  return createHash('sha256').update(rows.join('\n')).digest('hex').slice(0, 16)
}

// ---- effects ----

const out = (cmd, argv, cwd) => execFileSync(cmd, argv, { cwd, encoding: 'utf8' }).trim()
const run = (cmd, argv, cwd, env = {}) => spawnSync(cmd, argv, { cwd, stdio: 'inherit', env: { ...process.env, ...env } }).status === 0
const log = (line) => console.log(`adopt-stack: ${line}`)

function write(dir, result) {
  const { manifestText, pkg, workspaceText, cohortText } = result.files
  for (const edit of result.edits) if (edit.file === 'package.json') pkg[edit.section][edit.name] = edit.to
  const indent = /^([ \t]+)"/m.exec(manifestText)?.[1] ?? '  '
  writeFileSync(join(dir, 'package.json'), `${JSON.stringify(pkg, null, indent)}\n`)
  if (result.edits.some((edit) => edit.file === 'pnpm-workspace.yaml')) writeFileSync(join(dir, 'pnpm-workspace.yaml'), workspaceText)
  if (result.edits.some((edit) => edit.file === COHORT)) writeFileSync(join(dir, COHORT), cohortText)
}

function install(dir) {
  if (existsSync(join(dir, 'pnpm-lock.yaml'))) {
    if (!run('pnpm', ['install', '--no-frozen-lockfile'], dir)) throw new Error('pnpm install failed for the new pins')
  } else if (existsSync(join(dir, 'package-lock.json'))) {
    if (!run('npm', ['install', '--prefer-online'], dir)) throw new Error('npm install failed for the new pins')
  } else throw new Error('no pnpm-lock.yaml or package-lock.json to update')
}

/** Files under `dir` that differ from the index or are untracked, with a digest of each (null when deleted). */
function dirty(dir) {
  const list = (argv) => out('git', argv, dir).split('\0').filter(Boolean)
  const paths = new Set([...list(['diff', '--name-only', '-z', '--relative']), ...list(['ls-files', '--others', '--exclude-standard', '-z'])])
  return new Map([...paths].map((path) => [path, digest(join(dir, path))]))
}

/** A file's content digest; a symlink (pnpm links directories) by its target, a nested repository as itself. */
function digest(path) {
  const stat = lstatSync(path, { throwIfNoEntry: false })
  if (!stat) return null
  if (stat.isSymbolicLink()) return `link:${readlinkSync(path)}`
  if (!stat.isFile()) return 'directory'
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

/**
 * Run the caller's post-pin command in `dir` and return the files it changed,
 * so files already dirty before it (the pins, the lockfile) count only when it
 * changed them again. A non-zero exit throws with the command's output.
 */
function postPin(dir, command) {
  const before = dirty(dir)
  // Everything goes to stderr, so a --json plan on stdout stays parseable.
  console.error(`adopt-stack: post-pin: ${command}`)
  const ran = spawnSync('bash', ['-c', command], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  process.stderr.write(ran.stdout + ran.stderr)
  if (ran.status !== 0) {
    throw new Error(`post-pin \`${command}\` ${ran.status === null ? `died (${ran.signal ?? ran.error?.message})` : `exited ${ran.status}`}; nothing was committed:\n${`${ran.stdout}${ran.stderr}`.trim()}`)
  }
  return [...dirty(dir)].filter(([path, digest]) => before.get(path) !== digest).map(([path]) => path).sort()
}

/** The files `postPin` would change, run in a throwaway copy of `dir` holding the pinned manifest; no install runs. */
function previewPostPin(dir, result, command) {
  const copy = mkdtempSync(join(tmpdir(), 'adopt-stack-post-pin-'))
  try {
    cpSync(dir, copy, { recursive: true, filter: (source) => !/(^|[\\/])(\.git|node_modules)$/.test(source) })
    // The copy's index records the tree before the pins, like the caller's checkout.
    if (!run('git', ['init', '-q'], copy) || !run('git', ['add', '-A'], copy)) throw new Error('could not prepare the post-pin preview copy')
    write(copy, result)
    return postPin(copy, command)
  } finally {
    rmSync(copy, { recursive: true, force: true })
  }
}

function body(result, gate, hash, outcome, head, synced) {
  const rows = result.edits.map((e) => `| \`${e.name}\` | ${e.file} ${e.section} | \`${e.from}\` | \`${e.to}\` | ${e.why} |`)
  return [
    `Adopts the newest ${SCOPE}* releases (agent-eval scripts/adopt-stack.mjs, run by .github/workflows/adopt-stack.yml).`,
    '',
    '| package | where | from | to | why |', '|---|---|---|---|---|', ...rows, '',
    ...(synced.command ? [`Post-pin: \`${synced.command}\` ${synced.files.length ? `changed ${synced.files.map((file) => `\`${file}\``).join(', ')}` : 'changed no files'}.`, ''] : []),
    `Gate: \`${gate}\` on ${head.slice(0, 12)}: ${outcome === 'gate-fail' ? 'failed' : 'passed'}.`,
    '',
    `<!-- adopt-stack:plan=${hash} result=${outcome} -->`,
  ].join('\n')
}

async function deliver(dir, result, { gate, postPin: command, defaultBranch, merge }) {
  const title = titleOf(result.edits)
  const hash = planHash(result.edits, command)
  const gh = (argv) => out('gh', argv, dir)
  const open = JSON.parse(gh(['pr', 'list', '--head', BRANCH, '--base', defaultBranch, '--state', 'open', '--json', 'number,body']))[0]
  const recorded = MARKER.exec(open?.body ?? '')
  if (recorded?.[1] === hash && recorded[2] === 'pass' && !merge) return log(`#${open.number} already proposes plan ${hash} and passed its gate`)

  write(dir, result)
  install(dir)
  const synced = { command, files: command ? postPin(dir, command) : [] }
  const base = out('git', ['rev-parse', 'HEAD'], dir)
  log(`gate: ${gate}`)
  const green = run('bash', ['-c', gate], dir)

  const files = ['package.json', 'pnpm-workspace.yaml', COHORT, 'pnpm-lock.yaml', 'package-lock.json'].filter((file) => existsSync(join(dir, file)))
  // -A stages a file the post-pin command deleted.
  if (!run('git', ['switch', '-q', '-C', BRANCH], dir) || !run('git', ['add', '-A', '--', ...new Set([...files, ...synced.files])], dir)) throw new Error('could not stage the adoption')
  if (!run('git', [...BOT, 'commit', '-q', '-m', title], dir)) throw new Error('commit failed')
  // The adoption branch belongs to this workflow; a newer plan replaces its head.
  if (!run('git', ['push', '-q', '--force', 'origin', `HEAD:refs/heads/${BRANCH}`], dir)) throw new Error('push failed')
  const head = out('git', ['rev-parse', 'HEAD'], dir)
  const bodyFile = join(mkdtempSync(join(tmpdir(), 'adopt-stack-body-')), 'body.md')
  writeFileSync(bodyFile, body(result, gate, hash, green ? 'pass' : 'gate-fail', head, synced))
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
  const merged = await mergeWhenApproved(dir, number, head, base, defaultBranch)
  if (merged.moved) {
    // Closed, so the next run does not mistake it for an in-flight proposal.
    gh(['pr', 'close', String(number), '--comment', `Gate passed, but ${defaultBranch} moved from ${base.slice(0, 12)} to ${merged.moved.slice(0, 12)}; the next run re-gates on the new head.`])
    return log(`${defaultBranch} moved after the gate; closed #${number} for a re-gate`)
  }
  if (merged.refusal) {
    writeFileSync(bodyFile, body(result, gate, hash, 'merge-refused', head, synced))
    gh(['pr', 'edit', String(number), '--body-file', bodyFile])
    comment(`Gate passed on ${head.slice(0, 12)}, but ${merged.why}:\n\n\`\`\`\n${merged.refusal}\n\`\`\`\n\nNo admin merge or protection bypass was attempted.`)
    throw new Error(`merging #${number} failed: ${merged.why}`)
  }
  log(`merged #${number} at ${head.slice(0, 12)}`)
}

/**
 * Merge `head` while the default branch still sits at `base`, the tree the gate
 * passed. A base branch policy refusal while the review decision is
 * REVIEW_REQUIRED means an approval (usually the approval bot's) has not landed
 * yet, so the identical merge is retried every POLL_MS until WAIT_MS has
 * passed. Any other refusal returns at once, including a moved head, which
 * `--match-head-commit` refuses on every retry. A decision gh cannot read
 * (null) refuses at once. Each retry re-reads the default branch, so a base
 * that moves during the wait closes the pull request for a re-gate.
 * Returns {} when merged, { moved } when the base moved, or { refusal, why }.
 */
async function mergeWhenApproved(dir, number, head, base, defaultBranch) {
  const deadline = Date.now() + WAIT_MS
  for (;;) {
    const remote = out('git', ['ls-remote', 'origin', `refs/heads/${defaultBranch}`], dir).split(/\s/)[0]
    if (remote !== base) return { moved: remote }
    const merged = spawnSync('gh', ['pr', 'merge', String(number), '--squash', '--match-head-commit', head], { cwd: dir, encoding: 'utf8' })
    if (merged.status === 0) return {}
    const refusal = (merged.stderr || merged.stdout).trim()
    if (!POLICY.test(refusal) || reviewDecision(dir, number) !== 'REVIEW_REQUIRED') return { refusal, why: 'the merge was refused' }
    if (Date.now() + POLL_MS >= deadline) return { refusal, why: `the required approval had not landed after ${WAIT_MS / 60_000} min` }
    log(`#${number} awaits a required approval; retrying the merge in ${POLL_MS / 1000} s`)
    await new Promise((done) => setTimeout(done, POLL_MS))
  }
}

/** The pull request's review decision, or null when gh cannot read it. */
function reviewDecision(dir, number) {
  const viewed = spawnSync('gh', ['pr', 'view', String(number), '--json', 'reviewDecision'], { cwd: dir, encoding: 'utf8' })
  try {
    return viewed.status === 0 ? JSON.parse(viewed.stdout).reviewDecision : null
  } catch {
    return null
  }
}

function options(argv) {
  const value = (flag, fallback) => (argv.includes(flag) ? argv[argv.indexOf(flag) + 1] ?? '' : fallback)
  return {
    dir: resolve(value('--dir', '.')),
    packages: value('--packages', '').split(/[\s,]+/).filter(Boolean),
    gate: value('--gate', '').trim(),
    postPin: value('--post-pin', '').trim(),
    defaultBranch: value('--default-branch', 'main'),
    merge: argv.includes('--merge'),
    dryRun: argv.includes('--dry-run'),
    json: argv.includes('--json'),
  }
}

async function main() {
  const opts = options(process.argv.slice(2))
  const result = await plan(opts.dir, opts.packages)
  if (opts.dryRun && opts.postPin && result.edits.length) {
    result.postPin = { command: opts.postPin, changed: previewPostPin(opts.dir, result, opts.postPin) }
  }
  const { files: _files, ...printable } = result
  if (opts.json) {
    console.log(JSON.stringify(printable, null, 2))
    if (opts.dryRun) return
  } else {
    for (const p of result.packages) log(`${p.name}: npm latest ${p.latest}${p.target !== p.latest ? `, held at ${p.target} (${p.why})` : ''}`)
    for (const h of result.held) if (!result.packages.some((p) => p.name === h.name)) log(`${h.name}: sibling moves to ${h.target} (${h.why})`)
    for (const e of result.edits) log(`${e.file} ${e.section} ${e.name}: ${e.from} -> ${e.to} (${e.why})`)
    if (result.postPin) log(`post-pin would change ${result.postPin.changed.join(', ') || 'no files'} (given the pinned manifest, without an install)`)
  }
  for (const warning of result.warnings) console.error(`adopt-stack: warning: ${warning}`)
  if (!result.edits.length) return log('nothing to adopt')
  if (opts.dryRun) return log(`dry run: would open "${titleOf(result.edits)}" (plan ${planHash(result.edits, opts.postPin)})${opts.gate ? `, gate it with \`${opts.gate}\`` : ''}${opts.merge ? ' and merge it when green' : ''}; nothing was changed`)
  if (!opts.gate) throw new Error('--gate is required without --dry-run')
  await deliver(opts.dir, result, opts)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(`adopt-stack: ${error.message}`)
    process.exit(1)
  })
}
