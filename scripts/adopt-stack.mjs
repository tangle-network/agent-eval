#!/usr/bin/env node
// Adopt the newest @tangle-network releases in a caller repository: pin them,
// widen the caller's own peer ranges to include them, gate the result with the
// caller's acceptance command, and open (and optionally merge) one pull request.
// .github/workflows/adopt-stack.yml runs it for every caller repository.
//
// Rules carried over from gtm-agent scripts/agent-app-bump.mjs and
// discovery-lab .github/workflows/runtime-bump.yml:
// - One open adoption branch (`chore/adopt-stack`), deleted when its squash merge lands, so the
//   next delivery starts from the default instead of a branch the squash left behind. Each delivery normally
//   merges the captured default into the fetched owned proposal, plans against
//   that tree, verifies real installed/locked resolutions and gates before an
//   ordinary fast-forward push. Conflicts retain their state and fail safely.
//   Existing proposals are re-gated even when the new plan has no pin edits.
// - Commits use the Actions bot identity, because self-hosted runners have no
//   git identity and the first discovery-lab bumps died at their first commit.
// - The planned releases' peer ranges decide the sibling pins: a sibling the
//   caller pins outside a planned release's peer range moves to the newest
//   version inside every such range, even when that holds it below npm latest.
//   A planned release's dependency range also caps an adopted target the
//   current version is inside (agent-eval 0.217.1 depends on agent-core
//   ^0.12.0, so agent-core stays on 0.12.x rather than becoming a second copy).
// - Peer checks read the version the lockfile will hold (an exact pin, the
//   locked version, or the target when the edit moves the lock), never npm
//   latest. A sibling whose locked release peers a range excluding a planned
//   version rises to the newest release of its major whose peers admit it;
//   without one, the planned version is held inside the sibling's peer range.
//   agent-runtime#1946 kept agent-knowledge 22.0.3 (peer agent-eval <0.216.0)
//   under `^22.0.3` while adopting agent-eval 0.217.1, and pnpm refused it.
//   Each pass rebuilds targets from npm latest with the current raises and all
//   holds so far, so a raise a later hold made unnecessary drops out.
// - An install keeps a locked version its range still admits. A range whose
//   lock is older than a target inside the range as written gets its floor
//   raised (`^22.0.3` -> `^22.0.7`), as does one a peer raise requires. A pnpm
//   catalog entry follows the root pin when that moves to the target, so every
//   workspace importer resolves the same version. Any other locked dependency
//   or catalog range stays as written: only peer ranges widen.
// - A lockfile this script cannot read (or yarn/bun) stops the plan, since
//   every hold, raise and cohort edit depends on what it holds.
// - A caller's release/cohort.json entries move to the version the lockfile
//   will hold for each planned package and its source commit (npm gitHead,
//   else the release tag); an entry whose lock does not move stays.
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
// did not run. A peer range that already covers the version is left as written.
// Packages past 1.0 (agent-knowledge, agent-interface) are pinned like any
// other, but a range that excludes a new major is refused with a non-zero exit:
// a major is a breaking release a person widens on purpose, and a 0.x range meets
// that refusal at its package's first 1.0 release. A prerelease npm
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
//          [--post-pin CMD] [--deploy-workflow NAME] [--default-branch main]
//          [--merge] [--dry-run] [--json]
// Without --dry-run it needs git, gh (GH_TOKEN with contents and pull-requests:
// write) and the caller's package manager.
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, lstatSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { constraints, dependencies, lockedVersion, manifests, readLocks, resolvedVersions, preparePlaywrightBrowsers } from './adopt-stack-workspace.mjs'

const SCOPE = '@tangle-network/'
export const ADOPTION_BRANCH = 'chore/adopt-stack'
const BRANCH = ADOPTION_BRANCH
const COHORT = 'release/cohort.json'
const BOT_EMAIL = '41898282+github-actions[bot]@users.noreply.github.com'
const BOT = ['-c', 'user.name=github-actions[bot]', '-c', `user.email=${BOT_EMAIL}`]
const REGISTRY = (process.env.npm_config_registry || process.env.NPM_CONFIG_REGISTRY || 'https://registry.npmjs.org').replace(/\/$/, '')
const EXACT = /^\d+\.\d+\.\d+$/
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
 * raising the floor. It keeps only the alternative that admits `version` with
 * the highest lower bound: a lone caret or tilde keeps its operator, anything
 * else becomes `>=version` up to that alternative's upper bound. Throws when
 * no alternative admits `version` (widen the range first).
 */
export function raiseFloor(range, version) {
  const floor = (alternative) => comparators(alternative).filter(([op]) => op === '>=').map(([, bound]) => bound).sort(compare).at(-1) ?? [0, 0, 0]
  const alternative = range.split('||').map((part) => part.trim()).filter((part) => satisfies(version, part))
    .sort((a, b) => compare(floor(a), floor(b))).at(-1)
  if (alternative === undefined) throw new Error(`cannot raise "${range}" to ${version}: no alternative admits it`)
  const lone = /^([\^~])\d+\.\d+\.\d+$/.exec(alternative)
  if (lone) return `${lone[1]}${version}`
  const upper = comparators(alternative).filter(([op]) => op === '<').map(([, bound]) => bound).sort(compare)[0]
  return upper ? `>=${version} <${format(upper)}` : `>=${version}`
}

// ---- lockfile ----

/**
 * The versions the caller's lockfile holds for its root manifest's dependencies
 * (`importer`) and its pnpm catalog entries (`catalog`, the lowest across named
 * catalogs). Read line by line, since the script has no YAML parser.
 */
export function lockedVersions(dir) {
  return readLocks(dir)
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

const PROTOCOL = /^(workspace|catalog|npm|file|link|git|github|https?):/

/**
 * What a dependency spec becomes for `target` (`to`, null when it stays as
 * written) and the version the lockfile then holds (`holds`, null when
 * unknown). An install keeps a locked version its range still admits, so a
 * range whose lock is older than `target` gets its floor raised, but only when
 * `target` is inside the range as written (a compatible update) or `force` is
 * set (a peer range requires it, or the caller's root pin moves to it). A
 * locked range otherwise stays as written, so a published dependency range
 * never admits a version no gate installed; only peer ranges widen.
 */
function respec(spec, target, locked, force = false) {
  if (EXACT.test(spec)) return { to: spec === target ? null : target, holds: target }
  // Protocols, git shorthands and dist-tags are the caller's choice, not a version.
  if (PROTOCOL.test(spec) || spec.includes('/') || /^[a-wyzA-WYZ]/.test(spec)) return { to: null, holds: locked ?? null }
  if (!locked) {
    // Nothing locked: the install resolves the newest version the range admits.
    const widened = widenRange(spec, target)
    return { to: widened === spec ? null : widened, holds: target }
  }
  if (compare(release(locked), release(target)) < 0 && (force || satisfies(target, spec))) {
    const to = raiseFloor(widenRange(spec, target), target)
    if (!satisfies(target, to) || satisfies(locked, to)) throw new Error(`raising "${spec}" to ${target} gave "${to}", which does not move the locked ${locked} to it`)
    return { to, holds: target }
  }
  return { to: null, holds: locked }
}

const CATALOG_LINE = /^(\s+)(['"]?)(@tangle-network\/[\w.-]+)\2(\s*:\s*)(['"]?)([^'"#]+?)\5(\s*(?:#.*)?)$/

/** Visit the @tangle-network catalog entries of a pnpm-workspace.yaml text; `edit` returns a new spec or null. */
function catalogLines(text, edit) {
  let block = null
  return text.split('\n').map((line, index) => {
    const top = /^([A-Za-z][\w-]*):/.exec(line)
    if (top) block = top[1]
    if (block !== 'catalog' && block !== 'catalogs') return line
    const m = CATALOG_LINE.exec(line)
    const to = m && edit(m[3], m[6], `${block} line ${index + 1}`)
    return to ? `${m[1]}${m[2]}${m[3]}${m[2]}${m[4]}${m[5]}${to}${m[5]}${m[7]}` : line
  }).join('\n')
}

export async function plan(dir, requested = []) {
  const members = manifests(dir)
  const root = members.find((member) => member.file === 'package.json')
  const { text: manifestText, pkg } = root
  const pins = dependencies(members)
  const found = new Set([...pins.map(({ name }) => name), ...members.flatMap(({ pkg }) => Object.keys(pkg.peerDependencies ?? {}).filter((name) => name.startsWith(SCOPE) && name !== pkg.name))])
  const callerOwned = new Set(pins.filter(({ spec }) => PROTOCOL.test(spec) && !spec.startsWith('catalog:')).map(({ name }) => name).filter((name) => !pins.some((pin) => pin.name === name && (!PROTOCOL.test(pin.spec) || pin.spec.startsWith('catalog:')))))
  const names = (requested.length ? requested : [...found].sort()).filter((name) => !callerOwned.has(name))
  for (const name of names) if (!name.startsWith(SCOPE)) throw new Error(`${name} is not a ${SCOPE}* package`)

  const docs = new Map()
  const doc = async (name) => {
    if (!docs.has(name)) docs.set(name, packument(name))
    return docs.get(name)
  }
  await Promise.all(names.map(doc))
  const targets = new Map()
  for (const name of names) targets.set(name, { latest: (await doc(name)).latest, target: (await doc(name)).latest, why: 'npm latest' })

  const pinned = new Map()
  for (const { name, spec } of [...pins].sort((a, b) => (a.file === 'package.json' ? -1 : b.file === 'package.json' ? 1 : a.file.localeCompare(b.file)))) {
    if (!pinned.has(name)) pinned.set(name, spec)
  }
  const workspacePath = join(dir, 'pnpm-workspace.yaml')
  const workspaceText = existsSync(workspacePath) ? readFileSync(workspacePath, 'utf8') : null
  const catalogSpecs = new Map()
  if (workspaceText !== null) catalogLines(workspaceText, (name, spec) => void (catalogSpecs.has(name) || catalogSpecs.set(name, spec)))
  const locks = lockedVersions(dir)
  for (const versions of locks.importers.values()) for (const [name, version] of versions) if (!locks.importer.has(name)) locks.importer.set(name, version)
  // Every hold, raise and cohort edit reads the lock; guessing it would publish edits no install backs.
  if (locks.unread && pinned.size) throw new Error(`${locks.unread}, so the versions it holds are unknown and no plan is made`)
  const warnings = []
  const warn = (text) => warnings.includes(text) || warnings.push(text)
  for (const name of callerOwned) warn(`${name}: caller-owned protocol is retained without a registry target; its effective version is unverified`)
  for (const { file, name, spec } of pins) if (targets.has(name) && PROTOCOL.test(spec) && !spec.startsWith('catalog:')) warn(`${file} ${name}: caller-owned ${spec} is retained; npm latest is not a verified effective version for this pin`)

  // The version the root lockfile holds before the plan (an exact pin, else the
  // locked version) and after it (what respec says the edit leaves locked).
  // Peer checks read these, never npm latest.
  const specOf = (name) => (/^catalog:/.test(pinned.get(name) ?? '') ? catalogSpecs.get(name) : pinned.get(name))
  const before = (name) => locks.importer.get(name) ?? (EXACT.test(specOf(name) ?? '') ? specOf(name) : null)
  const planned = (name) => {
    const entry = targets.get(name)
    if (!entry) return before(name)
    if (!specOf(name)) return entry.target
    return respec(specOf(name), entry.target, locks.importer.get(name), entry.force).holds
  }
  const parsed = (owner, kind, other, range) => {
    if (parses(range)) return true
    warn(`${owner} ${kind} ${other} "${range}", a range this script cannot read; that constraint is skipped`)
    return false
  }

  // Each pass rebuilds the targets from npm latest, then applies the current
  // raises and every hold so far, so a raise a later hold made unnecessary
  // drops out. Holds only accumulate, so the passes settle.
  const baseline = new Map(targets)
  const peerHolds = new Map()
  let raises = new Map()
  for (let pass = 0; ; pass++) {
    if (pass === 6) {
      warn('the peer and dependency holds did not settle after 6 passes; the plan uses the last pass')
      break
    }
    targets.clear()
    for (const [name, entry] of [...baseline, ...raises]) targets.set(name, entry)

    // Holds: each planned release's peer ranges constrain the caller's
    // @tangle-network pins, adopted or not, and its dependency ranges cap an
    // adopted target that would otherwise leave a second copy behind (a range
    // the current version already escapes is ignored). A sibling's peer range
    // that no newer sibling meets holds the adopted package too (peerHolds).
    for (let round = 0; round < 6; round++) {
      const snapshot = JSON.stringify([...targets])
      const rules = new Map([...peerHolds].map(([name, list]) => [name, [...list]]))
      for (const name of [...targets.keys()]) {
        const at = planned(name) ?? targets.get(name).target
        const manifest = (await doc(name)).versions[at]
        for (const [kind, ranges] of [['peers', manifest?.peerDependencies], ['depends on', manifest?.dependencies]]) {
          for (const [other, range] of Object.entries(ranges ?? {})) {
            if (other === name || !pinned.has(other) || !other.startsWith(SCOPE)) continue
            if (kind === 'depends on' && (!targets.has(other) || !before(other) || !parsed(`${name}@${at}`, kind, other, range) || !satisfies(before(other), range))) continue
            if (kind === 'peers' && !parsed(`${name}@${at}`, kind, other, range)) continue
            rules.set(other, [...(rules.get(other) ?? []), { by: `${name}@${at}`, kind, range }])
          }
        }
      }
      for (const [sibling, list] of rules) {
        const current = targets.get(sibling)?.target ?? before(sibling)
        if (!current || list.every(({ range }) => satisfies(current, range))) continue
        const peers = list.filter(({ kind }) => kind === 'peers')
        const siblingDoc = await doc(sibling)
        // Dependency caps that no release meets together with the peers are dropped: a second copy beats no install.
        const all = newestIn(siblingDoc, list.map(({ range }) => range))
        const used = all ? list : peers
        const allowed = all ?? newestIn(siblingDoc, peers.map(({ range }) => range))
        const reason = used.map(({ by, kind, range }) => `${by} ${kind} ${range}`).join('; ')
        if (!allowed) throw new Error(`no published ${sibling} satisfies every planned peer range (${reason})`)
        if (!all) warn(`no ${sibling} meets both its peer ranges and ${list.filter(({ kind }) => kind !== 'peers').map(({ by, range }) => `${by} depends on ${range}`).join('; ')}; held by the peer ranges only`)
        if (allowed !== current) targets.set(sibling, { latest: siblingDoc.latest, target: allowed, why: `held by ${used.every(({ kind }) => kind === 'peers') ? 'peer ranges' : 'peer and dependency ranges'}: ${reason}` })
      }
      if (JSON.stringify([...targets]) === snapshot) break
    }

    // Raises, recomputed against this pass's targets: a sibling whose version
    // without a raise peers a range that excludes a planned target rises to the
    // newest release of the same major whose peers admit every planned target,
    // even when its range already admits npm latest. Without one, the excluded
    // targets are held inside the sibling's peer ranges from the next pass on.
    const next = new Map()
    let held = false
    for (const sibling of [...pinned.keys()].sort()) {
      const raisedEntry = targets.get(sibling)
      if (raises.has(sibling)) baseline.has(sibling) ? targets.set(sibling, baseline.get(sibling)) : targets.delete(sibling)
      const current = planned(sibling)
      if (raisedEntry) targets.set(sibling, raisedEntry)
      if (!current) continue
      const siblingDoc = await doc(sibling)
      const excluded = (version) => Object.entries(siblingDoc.versions[version]?.peerDependencies ?? {})
        .filter(([peer, range]) => peer !== sibling && targets.has(peer) && parses(range) && !satisfies(planned(peer) ?? targets.get(peer).target, range))
      if (!siblingDoc.versions[current] || !excluded(current).length) continue
      const reason = excluded(current).map(([peer, range]) => `${sibling}@${current} peers ${peer} ${range}, excluding ${planned(peer) ?? targets.get(peer).target}`).join('; ')
      const raised = Object.keys(siblingDoc.versions)
        .filter((v) => release(v) && release(v)[0] === release(current)[0] && compare(release(v), release(current)) > 0 && !excluded(v).length)
        .sort((a, b) => compare(release(a), release(b))).at(-1)
      if (raised) {
        next.set(sibling, { latest: siblingDoc.latest, target: raised, force: true, why: `raised by peer range: ${reason}` })
        continue
      }
      for (const [peer, range] of excluded(current)) {
        const list = peerHolds.get(peer) ?? []
        if (list.some((rule) => rule.range === range && rule.by === `${sibling}@${current}`)) continue
        peerHolds.set(peer, [...list, { by: `${sibling}@${current}`, kind: 'peers', range }])
        held = true
      }
    }
    if (!held && JSON.stringify([...next]) === JSON.stringify([...raises])) break
    raises = next
  }

  const edits = []
  for (const { file, section, name, spec } of pins) {
    const entry = targets.get(name)
    if (!entry) continue
    const importer = file === 'package.json' ? '.' : file.slice(0, -'/package.json'.length)
    const locked = locks.importers.get(importer)?.get(name) ?? locks.importer.get(name)
    const next = respec(spec, entry.target, locked, entry.force || planned(name) === entry.target)
    if (next.to) edits.push({ file, section, name, from: spec, to: next.to, version: entry.target, why: entry.why })
    if (!PROTOCOL.test(spec) && next.holds !== planned(name)) throw new Error(`${file} ${name}: conflicting effective versions ${next.holds} and ${planned(name)}; reconcile the caller's ranges before adoption`)
  }
  for (const { file, pkg: member } of members) for (const [name, range] of Object.entries(member.peerDependencies ?? {})) {
    const entry = targets.get(name)
    if (!entry || !names.includes(name)) continue
    const to = widenRange(range, entry.target)
    const pinnedAt = entry.target === entry.latest ? `npm latest ${entry.target}` : `${entry.target}, the version pinned`
    if (to !== range) edits.push({ file, section: 'peerDependencies', name, from: range, to, version: entry.target, why: `upper bound widened to include ${pinnedAt}` })
  }
  const workspace = { edits: [] }
  if (workspaceText !== null) {
    workspace.text = catalogLines(workspaceText, (name, spec, section) => {
      const entry = targets.get(name)
      // An unused catalog entry resolves nothing; a used one follows the root pin when that moves to the target.
      if (!entry || !locks.catalog.has(name)) return null
      const to = respec(spec, entry.target, locks.catalog.get(name), entry.force || planned(name) === entry.target).to
      if (to) workspace.edits.push({ file: 'pnpm-workspace.yaml', section, name, from: spec, to, version: entry.target, why: entry.why })
      return to
    })
  }
  edits.push(...workspace.edits)
  const expected = new Map([...targets.keys()].map((name) => [name, planned(name)]).filter(([, version]) => version))
  const policy = constraints(members, workspace.text ?? workspaceText, expected, (name, spec) => respec(spec, expected.get(name), locks.importer.get(name), true).to)
  edits.push(...policy.edits)
  const installRequired = pins.some(({ file, section, name, spec }) => {
    if (!expected.has(name) || PROTOCOL.test(spec) && !spec.startsWith('catalog:')) return false
    return lockedVersion(locks, file, section, name) !== expected.get(name)
  })
  const cohort = await cohortEdits(dir, (name) => (targets.has(name) ? planned(name) : null))
  edits.push(...cohort.edits)

  return {
    packages: names.map((name) => ({ name, ...targets.get(name), effective: expected.get(name) ?? null })),
    expected: [...expected],
    unmanaged: [...callerOwned].map((name) => ({ name, verified: false, reason: 'caller-owned protocol retained; no registry target' })),
    installRequired,
    held: [...targets].filter(([name, entry]) => !names.includes(name) || entry.target !== entry.latest)
      .map(([name, entry]) => ({ name, ...entry })),
    edits,
    warnings,
    files: { manifestText, pkg, members, workspaceText: policy.text, cohortText: cohort.text },
  }
}

/**
 * Move each release/cohort.json entry (agent-runtime's record of the exact
 * first-party versions and source commits it releases with) to the version the
 * lockfile will hold for a planned package, with that version's source commit.
 * An entry whose lock does not move stays as written.
 */
async function cohortEdits(dir, plannedVersion) {
  const path = join(dir, COHORT)
  if (!existsSync(path)) return { edits: [] }
  const text = readFileSync(path, 'utf8')
  const cohort = JSON.parse(text)
  const edits = []
  for (const [key, entry] of Object.entries(cohort.packages ?? {})) {
    const planned = entry?.name && plannedVersion(entry.name)
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
  if (!edits.length) return 'chore(deps): verify the existing adoption'
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

export function writePlan(dir, result) {
  const { members, workspaceText, cohortText } = result.files
  for (const member of members) {
    const edits = result.edits.filter((edit) => edit.file === member.file)
    if (!edits.length) continue
    for (const edit of edits) {
      const path = edit.path ?? [edit.section, edit.name]
      const parent = path.slice(0, -1).reduce((obj, key) => obj[key], member.pkg)
      parent[path.at(-1)] = edit.to
    }
    const indent = /^([ \t]+)"/m.exec(member.text)?.[1] ?? '  '
    writeFileSync(join(dir, member.file), `${JSON.stringify(member.pkg, null, indent)}\n`)
  }
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

/** Fingerprint tracked working bytes around normal commit hooks, without logging content. */
function trackedDigest(dir) {
  const files = out('git', ['ls-files', '-z'], dir).split('\0').filter(Boolean).sort()
  return createHash('sha256').update(JSON.stringify(files.map((file) => [file, digest(join(dir, file))]))).digest('hex')
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
    writePlan(copy, result)
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
    ...(result.resolved?.length ? ['| package | importer | expected | lock | installed |', '|---|---|---|---|---|', ...result.resolved.map((row) => `| ${row.name} | ${row.file} | ${row.expected ?? row.source} | ${row.locked ?? 'unverified'} | ${row.installed ?? row.reason} |`), ''] : []),
    ...(synced.command ? [`Post-pin: \`${synced.command}\` ${synced.files.length ? `changed ${synced.files.map((file) => `\`${file}\``).join(', ')}` : 'changed no files'}.`, ''] : []),
    `Gate: \`${gate}\` on ${head.slice(0, 12)}: ${outcome === 'gate-fail' ? 'failed' : 'passed'}.`,
    '',
    `<!-- adopt-stack:plan=${hash} result=${outcome} -->`,
  ].join('\n')
}

export const UPDATER_DRAFT_MARKER = '<!-- adopt-stack:draft=gate-fail -->'
const SETTLE_MS = 30_000
const MAX_READS = 6
const SETTLE_POLL_MS = 1_000

/** A failed legacy draft without explicit updater ownership remains held. */
export function isManuallyHeldDraft(open, previous) {
  return Boolean(previous?.isDraft && !(open?.isDraft && open.body.includes(UPDATER_DRAFT_MARKER) && previous.body.includes(UPDATER_DRAFT_MARKER)))
}

/**
 * Git's owned branch is authoritative after push; the PR view may settle later.
 * No metadata changes are allowed until both agree. Every attempt brackets the
 * PR read with fresh remote refs; unknown or competing refs fail immediately.
 * The final merge still requires its native expected-head and captured-base guards.
 * `readProposal` is the external HTTP read seam; production uses authenticated gh.
 */
export async function readPushedProposal(dir, number, expectedHead, defaultBranch, readProposal) {
  const deadline = Date.now() + SETTLE_MS
  const command = (cmd, argv) => {
    const remaining = deadline - Date.now()
    if (remaining <= 0) throw new Error(`#${number} PR head settlement exceeded ${SETTLE_MS} ms; no metadata or merge attempted`)
    return execFileSync(cmd, argv, { cwd: dir, encoding: 'utf8', timeout: Math.min(10_000, remaining), stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  }
  const remoteHead = () => {
    const actual = command('git', ['ls-remote', 'origin', `refs/heads/${ADOPTION_BRANCH}`]).split(/\s/)[0]
    if (!/^[0-9a-f]{40}$/.test(actual)) throw new Error(`#${number} authoritative proposal ref is unknown (expected ${expectedHead}, observed ${actual || 'empty'}); no metadata or merge attempted`)
    if (actual !== expectedHead) throw new Error(`#${number} moved after the gate: authoritative branch expected ${expectedHead}, observed ${actual}; no metadata or merge attempted`)
  }
  const read = readProposal ?? (() => JSON.parse(command('gh', ['api', `repos/{owner}/{repo}/pulls/${number}`])))
  let observed = 'unknown'
  for (let attempt = 1; attempt <= MAX_READS; attempt += 1) {
    remoteHead()
    const controller = new AbortController()
    const remaining = deadline - Date.now()
    let timer
    let raw
    try {
      raw = await Promise.race([
        read({ signal: controller.signal }),
        new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error(`#${number} PR read deadline exceeded; no metadata or merge attempted`)) }, Math.max(1, remaining)) }),
      ])
    } finally {
      clearTimeout(timer)
      controller.abort()
    }
    remoteHead()
    const proposal = raw && { headRefOid: raw.head?.sha, headRefName: raw.head?.ref, baseRefName: raw.base?.ref, state: raw.state, isDraft: raw.draft, body: raw.body ?? '' }
    if (!proposal || !/^[0-9a-f]{40}$/.test(proposal.headRefOid ?? '') || typeof proposal.isDraft !== 'boolean' || typeof proposal.body !== 'string') throw new Error(`#${number} PR head/state response is unknown; no metadata or merge attempted`)
    if (proposal.state !== 'open' || proposal.headRefName !== ADOPTION_BRANCH || proposal.baseRefName !== defaultBranch) throw new Error(`#${number} proposal scope changed (state ${proposal.state}, head ${proposal.headRefName}, base ${proposal.baseRefName}); no metadata or merge attempted`)
    if (proposal.headRefOid === expectedHead) return proposal
    observed = proposal.headRefOid
    console.log(`adopt-stack: #${number} PR head ${observed} differs from stable pushed branch ${expectedHead}; settlement read ${attempt}/${MAX_READS}`)
    if (attempt < MAX_READS && Date.now() + SETTLE_POLL_MS < deadline) await new Promise((done) => setTimeout(done, SETTLE_POLL_MS))
    else break
  }
  throw new Error(`#${number} PR head did not settle (expected ${expectedHead}, last PR ${observed}, branch remained expected); no metadata or merge attempted`)
}

/** Preserve an open proposal's history. Restart from the default (`replaces` leases the push) when no PR is open, since the branch outlived another's squash merge, or when an open proposal only this updater wrote no longer merges. */
export function prepareBranch(dir, defaultBranch, proposalOpen = true) {
  if (out('git', ['status', '--porcelain'], dir)) throw new Error('caller checkout is dirty; nothing was reset or discarded')
  if (out('git', ['rev-parse', '--is-shallow-repository'], dir) === 'true' && !run('git', ['fetch', '--unshallow', 'origin'], dir)) throw new Error('could not obtain complete proposal/default history; no merge was attempted')
  const base = out('git', ['rev-parse', 'HEAD'], dir)
  const current = out('git', ['ls-remote', 'origin', `refs/heads/${defaultBranch}`], dir).split(/\s/)[0]
  if (current !== base) throw new Error(`${defaultBranch} moved before planning; start from its fresh head`)
  const existing = out('git', ['ls-remote', 'origin', `refs/heads/${BRANCH}`], dir).split(/\s/)[0]
  const merged = existing && proposalOpen && run('git', ['fetch', '-q', 'origin', `refs/heads/${BRANCH}`], dir)
    && run('git', ['switch', '--detach', 'FETCH_HEAD'], dir) && run('git', [...BOT, 'merge', '--no-edit', base], dir)
  if (existing && proposalOpen && !merged) {
    run('git', ['merge', '--abort'], dir)
    if (out('git', ['log', '--format=%ae', `${base}..${existing}`], dir).split('\n').some((email) => email !== BOT_EMAIL)) {
      throw new Error(`could not normally merge ${defaultBranch} into ${BRANCH}; resolve its retained conflicts before retrying, no history was rewritten`)
    }
  }
  if (!merged && !run('git', ['switch', '-C', BRANCH, base], dir)) throw new Error(`could not create ${BRANCH} from ${defaultBranch}`)
  return { base, proposal: Boolean(out('git', ['diff', '--name-only', base], dir)), replaces: merged ? '' : existing }
}

async function deliver(dir, result, { gate, postPin: command, defaultBranch, merge, base, deployWorkflow, replaces }) {
  const title = titleOf(result.edits)
  const hash = planHash(result.edits, command)
  const gh = (argv) => out('gh', argv, dir)
  const open = JSON.parse(gh(['pr', 'list', '--head', BRANCH, '--base', defaultBranch, '--state', 'open', '--json', 'number,body,isDraft']))[0]

  writePlan(dir, result)
  install(dir)
  const synced = { command, files: command ? postPin(dir, command) : [] }
  result.resolved = resolvedVersions(dir, new Map(result.expected))
  for (const row of result.resolved) log(`resolved ${row.file} ${row.name}: ${row.verified ? `lock=${row.locked} installed=${row.installed}` : row.reason}`)
  preparePlaywrightBrowsers(dir)
  log(`gate: ${gate}`)
  const green = run('bash', ['-c', gate], dir)
  if (green) result.resolved = resolvedVersions(dir, new Map(result.expected))

  const files = [...result.files.members.map(({ file }) => file), 'pnpm-workspace.yaml', COHORT, 'pnpm-lock.yaml', 'package-lock.json'].filter((file) => existsSync(join(dir, file)))
  // -A stages a file the post-pin command deleted.
  if (!run('git', ['add', '-A', '--', ...new Set([...files, ...synced.files])], dir)) throw new Error('could not stage the adoption')
  const gatedTree = trackedDigest(dir)
  if (out('git', ['diff', '--cached', '--name-only'], dir) && !run('git', [...BOT, 'commit', '-q', '-m', title], dir)) throw new Error('commit failed')
  // An untracked file the gate wrote (wrangler check startup's worker-startup.cpuprofile) is not in the commit.
  if (out('git', ['status', '--porcelain', '--untracked-files=no'], dir) || trackedDigest(dir) !== gatedTree) throw new Error('commit hooks changed the gated tree; retained locally, no push or merge was attempted')
  if (!run('git', ['push', '-q', ...(replaces ? [`--force-with-lease=refs/heads/${BRANCH}:${replaces}`] : []), 'origin', `HEAD:refs/heads/${BRANCH}`], dir)) throw new Error('push failed')
  const head = out('git', ['rev-parse', 'HEAD'], dir)
  const bodyFile = join(mkdtempSync(join(tmpdir(), 'adopt-stack-body-')), 'body.md')
  const draftMarker = UPDATER_DRAFT_MARKER
  const previous = open ? await readPushedProposal(dir, open.number, head, defaultBranch) : null
  // Only drafts created by this updater are promoted. Preserve manual holds, including ones added while the gate ran.
  let manualDraft = isManuallyHeldDraft(open, previous)
  writeFileSync(bodyFile, body(result, gate, hash, green ? 'pass' : 'gate-fail', head, synced)
    + (!green && !manualDraft ? `\n\n${draftMarker}\n` : ''))
  const promoteDraft = green && previous?.isDraft && !manualDraft
  let number = open?.number
  if (number && !promoteDraft) gh(['pr', 'edit', String(number), '--title', title, '--body-file', bodyFile])
  else if (!number) {
    gh(['pr', 'create', '--head', BRANCH, '--base', defaultBranch, '--title', title, '--body-file', bodyFile, ...(!green ? ['--draft'] : [])])
    number = JSON.parse(gh(['pr', 'list', '--head', BRANCH, '--base', defaultBranch, '--state', 'open', '--json', 'number']))[0].number
  }
  const proposal = await readPushedProposal(dir, number, head, defaultBranch)
  const newlyHeldDraft = proposal.isDraft && (previous ? !previous.isDraft : green)
  if (newlyHeldDraft) {
    manualDraft = true
    // A hold observed after recording a failed gate belongs to its maintainer.
    // Do not leave our marker behind for the next green run to claim it.
    if (!green) {
      writeFileSync(bodyFile, body(result, gate, hash, 'gate-fail', head, synced))
      gh(['pr', 'edit', String(number), '--title', title, '--body-file', bodyFile])
    }
  }
  if (!manualDraft && proposal.isDraft !== !green) gh(['pr', 'ready', String(number), ...(!green ? ['--undo'] : [])])
  const current = await readPushedProposal(dir, number, head, defaultBranch)
  if (green && current.isDraft) manualDraft = true
  // Retain the failed-draft marker if readiness fails, so a later run can recover.
  if (promoteDraft && !manualDraft) gh(['pr', 'edit', String(number), '--title', title, '--body-file', bodyFile])
  log(`${open ? 'updated' : 'opened'} #${number}: ${title}`)

  const comment = (text) => gh(['pr', 'comment', String(number), '--body', text])
  if (!green) {
    comment(`Gate \`${gate}\` failed on ${head.slice(0, 12)}. Left open; the next run re-gates it.`)
    throw new Error(`#${number} failed its gate`)
  }
  if (manualDraft) return log(`#${number} remains a manually held draft; no merge attempted`)
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
  const state = JSON.parse(gh(['pr', 'view', String(number), '--json', 'mergedAt,mergeCommit']))
  if (!state.mergedAt || !/^[0-9a-f]{40}$/.test(state.mergeCommit?.oid ?? '')) throw new Error(`merge command returned success but #${number} has no confirmed merge commit`)
  log(`merged #${number} as ${state.mergeCommit.oid}`)
  if (deployWorkflow) {
    if (!run('gh', ['workflow', 'run', deployWorkflow, '--ref', defaultBranch], dir)) throw new Error(`#${number} merged as ${state.mergeCommit.oid}, but deploy dispatch ${deployWorkflow} failed; source merge succeeded, deployment is unconfirmed`)
    log(`dispatched existing deploy workflow ${deployWorkflow} on ${defaultBranch} after merge ${state.mergeCommit.oid}; served revision remains the deploy workflow's proof`)
  }
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
export async function mergeWhenApproved(dir, number, head, base, defaultBranch) {
  const deadline = Date.now() + WAIT_MS
  for (;;) {
    const remote = out('git', ['ls-remote', 'origin', `refs/heads/${defaultBranch}`], dir).split(/\s/)[0]
    if (remote !== base) return { moved: remote }
    const merged = spawnSync('gh', ['pr', 'merge', String(number), '--squash', '--delete-branch', '--match-head-commit', head], { cwd: dir, encoding: 'utf8' })
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
    deployWorkflow: value('--deploy-workflow', '').trim(),
    defaultBranch: value('--default-branch', 'main'),
    merge: argv.includes('--merge'),
    dryRun: argv.includes('--dry-run'),
    json: argv.includes('--json'),
  }
}

async function main() {
  const opts = options(process.argv.slice(2))
  if (!opts.dryRun && !opts.gate) throw new Error('--gate is required without --dry-run')
  if (!opts.dryRun) Object.assign(opts, prepareBranch(opts.dir, opts.defaultBranch, JSON.parse(out('gh', ['pr', 'list', '--head', BRANCH, '--base', opts.defaultBranch, '--state', 'open', '--json', 'number'], opts.dir)).length > 0))
  const result = await plan(opts.dir, opts.packages)
  if (opts.dryRun && opts.postPin && (result.edits.length || result.installRequired)) {
    result.postPin = { command: opts.postPin, changed: previewPostPin(opts.dir, result, opts.postPin) }
  }
  const { files: _files, ...printable } = result
  if (opts.json) {
    console.log(JSON.stringify(printable, null, 2))
    if (opts.dryRun) return
  } else {
    for (const p of result.packages) log(`${p.name}: npm latest ${p.latest}${p.target !== p.latest ? `, held at ${p.target} (${p.why})` : ''}${p.effective !== p.target ? `, effective ${p.effective ?? 'unknown'} (caller-owned range/protocol retained)` : ''}`)
    for (const h of result.held) if (!result.packages.some((p) => p.name === h.name)) log(`${h.name}: sibling moves to ${h.target} (${h.why})`)
    for (const e of result.edits) log(`${e.file} ${e.section} ${e.name}: ${e.from} -> ${e.to} (${e.why})`)
    if (result.postPin) log(`post-pin would change ${result.postPin.changed.join(', ') || 'no files'} (given the pinned manifest, without an install)`)
  }
  for (const warning of result.warnings) console.error(`adopt-stack: warning: ${warning}`)
  if (!result.edits.length && !result.installRequired && !opts.proposal) return log('nothing to adopt; effective lock versions match the plan')
  if (opts.dryRun) return log(`dry run: would open "${titleOf(result.edits)}" (plan ${planHash(result.edits, opts.postPin)})${opts.gate ? `, gate it with \`${opts.gate}\`` : ''}${opts.merge ? ' and merge it when green' : ''}; nothing was changed`)
  await deliver(opts.dir, result, opts)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(`adopt-stack: ${error.message}`)
    process.exit(1)
  })
}
