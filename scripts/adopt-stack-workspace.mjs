// The caller's existing workspace manifests, install constraints and resolutions.
// No dependency is installed to plan: pnpm itself enumerates its workspaces.
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'

const SCOPE = '@tangle-network/'
const SECTIONS = ['dependencies', 'devDependencies', 'optionalDependencies']
const exact = /^\d+\.\d+\.\d+$/
const protocol = /^(workspace|catalog|npm|file|link|git|github|https?):/

export function manifests(dir) {
  const paths = new Set(['package.json'])
  if (existsSync(join(dir, 'pnpm-workspace.yaml'))) {
    const listed = execFileSync('pnpm', ['--recursive', 'list', '--depth', '-1', '--json'], { cwd: dir, encoding: 'utf8' })
    for (const member of JSON.parse(listed)) {
      const path = relative(resolve(dir), resolve(member.path))
      if (path.startsWith('..') || path.startsWith('/')) throw new Error(`workspace outside caller: ${member.path}`)
      paths.add(join(path, 'package.json'))
    }
  } else if (existsSync(join(dir, 'package-lock.json'))) {
    const lock = JSON.parse(readFileSync(join(dir, 'package-lock.json'), 'utf8'))
    for (const path of Object.keys(lock.packages ?? {})) {
      if (path && !path.split('/').includes('node_modules') && existsSync(join(dir, path, 'package.json'))) paths.add(join(path, 'package.json'))
    }
  }
  return [...paths].sort().map((file) => {
    const text = readFileSync(join(dir, file), 'utf8')
    return { file, text, pkg: JSON.parse(text) }
  })
}

export function dependencies(members) {
  return members.flatMap(({ file, pkg }) => SECTIONS.flatMap((section) =>
    Object.entries(pkg[section] ?? {}).filter(([name]) => name.startsWith(SCOPE) && name !== pkg.name)
      .map(([name, spec]) => ({ file, section, name, spec }))))
}

/** Every pnpm importer, including leaves; keep root/catalog maps for callers. */
export function readLocks(dir) {
  const importers = new Map()
  const catalog = new Map()
  const importer = new Map()
  const rows = []
  let format = null
  const record = (map, name, raw) => {
    const version = String(raw).replace(/^['"]|['"]$/g, '').replace(/\(.*$/, '')
    if (exact.test(version)) map.set(name, version)
    return version
  }
  if (existsSync(join(dir, 'pnpm-lock.yaml'))) {
    format = 'pnpm'
    const path = []
    for (const line of readFileSync(join(dir, 'pnpm-lock.yaml'), 'utf8').replace(/\r/g, '').split('\n')) {
      const m = /^( *)(['"]?)([^'":\s][^'":]*)\2:(?:\s+(\S.*))?$/.exec(line)
      if (!m) continue
      const depth = m[1].length / 2
      path.length = depth
      path[depth] = m[3]
      if (m[3] !== 'version' || !m[4]) continue
      if (path[0] === 'catalogs' && depth === 3) {
        const version = m[4].replace(/^['"]|['"]$/g, '').replace(/\(.*$/, '')
        const old = catalog.get(path[2])
        if (exact.test(version) && (!old || version.localeCompare(old, undefined, { numeric: true }) < 0)) catalog.set(path[2], version)
      } else if (path[0] === 'importers' && depth === 4 && SECTIONS.includes(path[2])) {
        const versions = importers.get(path[1]) ?? new Map()
        const version = record(versions, path[3], m[4])
        importers.set(path[1], versions)
        rows.push({ importer: path[1], section: path[2], name: path[3], version })
      }
    }
    for (const [name, version] of importers.get('.') ?? []) importer.set(name, version)
  } else if (existsSync(join(dir, 'package-lock.json'))) {
    format = 'npm'
    const lock = JSON.parse(readFileSync(join(dir, 'package-lock.json'), 'utf8'))
    for (const [key, entry] of Object.entries(lock.packages ?? {})) {
      const match = /^(?:(.*?)\/)?node_modules\/((?:@[^/]+\/)?[^/]+)$/.exec(key)
      if (!match || !entry?.version) continue
      const versions = importers.get(match[1] || '.') ?? new Map()
      record(versions, match[2], entry.version)
      importers.set(match[1] || '.', versions)
    }
    for (const [name, version] of importers.get('.') ?? []) importer.set(name, version)
  }
  const other = ['yarn.lock', 'bun.lock', 'bun.lockb'].find((file) => existsSync(join(dir, file)))
  const present = existsSync(join(dir, 'pnpm-lock.yaml')) || existsSync(join(dir, 'package-lock.json'))
  const unread = present ? (!importer.size && !catalog.size && !rows.length ? 'the lockfile records no dependency version this script can read' : null)
    : other ? `${other} is a lockfile this script cannot read` : null
  return { importer, importers, catalog, rows, unread, format }
}

export function lockedVersion(locks, file, section, name) {
  const importer = dirname(file) === '.' ? '.' : dirname(file)
  return locks.format === 'pnpm' ? locks.rows.find((row) => row.importer === importer && row.section === section && row.name === name)?.version
    : locks.importers.get(importer)?.get(name) ?? locks.importer.get(name)
}

const packageOf = (key) => /^(@tangle-network\/[\w.-]+)$/.exec(key)?.[1]

/** Rewrite existing pins only. Qualified/nested override selectors refuse safely. */
export function constraints(members, workspaceText, targets, edit) {
  const edits = []
  const change = (file, section, name, spec, path) => {
    const target = targets.get(name)
    const to = target && edit(name, spec)
    if (to && to !== spec) edits.push({ file, section, name, from: spec, to, version: target, why: 'follows the effective workspace pin', path })
    return to
  }
  const override = (key, value, file, section, path) => {
    // pnpm's $ references follow an existing direct spec, including parent>child selectors.
    if (typeof value === 'string' && value.startsWith('$')) {
      const reference = value.slice(1)
      if (!SECTIONS.some((section) => Object.hasOwn(members.find(({ file }) => file === 'package.json').pkg[section] ?? {}, reference))) throw new Error(`${file} ${section}: override ${key} references missing root direct dependency ${reference}`)
      return null
    }
    const name = packageOf(key)
    if (!name) {
      if ([...targets.keys()].some((n) => key.includes(n))) throw new Error(`${file} ${section} override selector ${key} needs explicit reconciliation; no green plan is possible`)
      return null
    }
    if (typeof value !== 'string') throw new Error(`${file} ${section} ${key}: nested overrides are unsupported`)
    return change(file, section, name, value, path)
  }
  const age = (value, file, section, path) => {
    if (typeof value !== 'string') throw new Error(`${file} ${section}: expected release-age string`)
    for (const [name, target] of targets) {
      if (!value.startsWith(`${name}@`)) continue
      const qualifier = value.slice(name.length + 1)
      if (!exact.test(qualifier)) throw new Error(`${file} ${section}: release-age qualifier ${value} needs explicit reconciliation`)
      const to = `${name}@${target}`
      if (to !== value) edits.push({ file, section, name, from: value, to, version: target, why: 'moves the existing version-qualified release-age exemption', path })
      return to
    }
    return null
  }
  for (const { file, pkg } of members) {
    for (const [key, value] of Object.entries(pkg.pnpm?.overrides ?? {})) override(key, value, file, 'pnpm.overrides', ['pnpm', 'overrides', key])
    for (const field of ['minimumReleaseAgeExclude', 'minimumReleaseAgeExcludes']) {
      for (const [i, value] of (pkg.pnpm?.[field] ?? []).entries()) age(value, file, `pnpm.${field}`, ['pnpm', field, i])
    }
  }
  let block = null
  const yaml = (workspaceText ?? '').split('\n').map((line, index) => {
    const top = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line)
    if (top) {
      block = top[1]
      if (['overrides', 'minimumReleaseAgeExclude', 'minimumReleaseAgeExcludes'].includes(block) && top[2] && !top[2].startsWith('#')) throw new Error(`pnpm-workspace.yaml ${block}: use block syntax so existing pins can be reconciled`)
      return line
    }
    if (block === 'overrides') {
      const m = /^(  )(['"]?)([^'"#]+?)\2(\s*:\s*)(['"]?)([^'"#]+?)\5(\s*(?:#.*)?)$/.exec(line)
      if (!m) {
        if (line.includes(SCOPE)) throw new Error(`pnpm-workspace.yaml overrides line ${index + 1}: unsupported selector syntax`)
        return line
      }
      const to = override(m[3], m[6], 'pnpm-workspace.yaml', `overrides line ${index + 1}`)
      return to ? `${m[1]}${m[2]}${m[3]}${m[2]}${m[4]}${m[5]}${to}${m[5]}${m[7]}` : line
    }
    if (block === 'minimumReleaseAgeExclude' || block === 'minimumReleaseAgeExcludes') {
      const m = /^(\s+-\s*)(['"]?)([^'"#]+?)\2(\s*(?:#.*)?)$/.exec(line)
      const to = m && age(m[3], 'pnpm-workspace.yaml', `${block} line ${index + 1}`)
      return to ? `${m[1]}${m[2]}${to}${m[2]}${m[4]}` : line
    }
    return line
  }).join('\n')
  return { edits, text: workspaceText === null ? null : yaml }
}

export function installedVersion(dir, file, name) {
  let path = dirname(resolve(dir, file))
  for (;;) {
    const manifest = join(path, 'node_modules', ...name.split('/'), 'package.json')
    if (existsSync(manifest)) {
      const pkg = JSON.parse(readFileSync(manifest, 'utf8'))
      if (pkg.name !== name) throw new Error(`${file}: ${name} resolves to ${pkg.name}`)
      return pkg.version
    }
    if (path === resolve(dir)) return null
    const parent = dirname(path)
    if (parent === path) return null
    path = parent
  }
}

/** Compare the actual post-install/post-sync boundary to the plan, not its labels. */
export function resolvedVersions(dir, expected) {
  const locks = readLocks(dir)
  const rows = []
  for (const { file, section, name, spec } of dependencies(manifests(dir))) {
    if (!expected.has(name)) continue
    if (protocol.test(spec) && !spec.startsWith('catalog:')) {
      rows.push({ file, name, source: spec, verified: false, reason: 'caller-owned protocol retained' })
      continue
    }
    const target = expected.get(name)
    const locked = lockedVersion(locks, file, section, name)
    const installed = installedVersion(dir, file, name)
    if (section === 'optionalDependencies' && !installed && locked === target) {
      rows.push({ file, name, expected: target, locked, installed, verified: false, reason: 'optional dependency is not installed on this platform' })
      continue
    }
    if (!target || locked !== target || installed !== target) throw new Error(`${file} ${name}: expected ${target ?? 'unknown'}, lock ${locked ?? 'missing'}, installed ${installed ?? 'missing'}; effective resolution differs, so adoption cannot pass`)
    rows.push({ file, name, expected: target, locked, installed, verified: true })
  }
  return rows
}
