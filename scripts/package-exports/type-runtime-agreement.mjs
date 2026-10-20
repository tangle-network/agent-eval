import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { repoRoot } from './repository.mjs'
import { run } from './process.mjs'

// Every typed entry point must ship a d.ts and a js that agree exactly:
// a name the d.ts declares as a value must be a runtime export of the js,
// and a runtime export must be declared as a value in the d.ts. TypeScript
// itself classifies each candidate name (a probe reads it off a namespace
// import, which errors for type-only or undeclared names), so the check
// does not depend on the d.ts generator's formatting.
export function verifyDistTypeRuntimeAgreement(packageJson, appDir) {
  const identifier = /^[A-Za-z_$][A-Za-z0-9_$]*$/
  const entries = Object.entries(packageJson.exports ?? {}).filter(
    ([, target]) =>
      typeof target === 'object' &&
      target !== null &&
      typeof target.types === 'string' &&
      typeof target.import === 'string',
  )
  if (entries.length === 0) throw new Error('package exports contain no typed entry points')
  const packageDir = join(appDir, 'node_modules', '@tangle-network', 'agent-eval')
  const specOf = (subpath) =>
    subpath === '.' ? '@tangle-network/agent-eval' : `@tangle-network/agent-eval/${subpath.slice(2)}`

  const runtimeScript = `
    const entries = ${JSON.stringify(entries.map(([subpath]) => [subpath, specOf(subpath)]))}
    const out = {}
    for (const [subpath, spec] of entries) out[subpath] = Object.keys(await import(spec))
    process.stdout.write(JSON.stringify(out))
  `
  const runtimeKeysBySubpath = JSON.parse(
    run(process.execPath, ['--input-type=module', '--eval', runtimeScript], appDir, {
      timeout: 120_000,
    }),
  )

  const probeDir = join(appDir, 'type-probes')
  mkdirSync(probeDir, { recursive: true })
  const candidatesByEntry = []
  entries.forEach(([subpath, target], index) => {
    const declared = collectDtsExportNames(join(packageDir, target.types))
    const runtimeKeys = runtimeKeysBySubpath[subpath]
    const candidates = [...new Set([...declared, ...runtimeKeys])]
      .filter((name) => name !== 'default')
      .sort()
    for (const name of candidates) {
      if (!identifier.test(name)) {
        throw new Error(`entry ${subpath} exports non-identifier name ${JSON.stringify(name)}`)
      }
    }
    candidatesByEntry.push({ subpath, candidates, runtimeKeys: new Set(runtimeKeys) })
    const lines = [`import * as ns from '${specOf(subpath)}'`]
    for (const name of candidates) lines.push(`const _${name}: unknown = ns.${name}`)
    writeFileSync(join(probeDir, `probe-${index}.ts`), `${lines.join('\n')}\n`)
  })
  writeFileSync(
    join(probeDir, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        target: 'ES2022',
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        strict: true,
        skipLibCheck: true,
        noEmit: true,
      },
      include: ['probe-*.ts'],
    }),
  )
  const tsc = spawnSync(
    join(repoRoot, 'node_modules', '.bin', 'tsc'),
    ['-p', 'tsconfig.json', '--pretty', 'false'],
    { cwd: probeDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 300_000 },
  )
  if (tsc.error) throw tsc.error
  const tscOutput = `${tsc.stdout ?? ''}\n${tsc.stderr ?? ''}`
  // Probe lines are expected to error for type-only names; any other
  // diagnostic means the probe program itself is broken.
  const typeOnlyByEntry = entries.map(() => new Set())
  for (const line of tscOutput.split('\n')) {
    const diagnostic = line.match(/^(.+?)\((\d+),\d+\): error TS\d+/)
    if (!diagnostic) continue
    const probe = diagnostic[1].match(/probe-(\d+)\.ts$/)
    const lineNumber = Number(diagnostic[2])
    if (!probe || lineNumber < 2) {
      throw new Error(`type-runtime agreement probe failed to compile:\n${line}`)
    }
    const entryIndex = Number(probe[1])
    typeOnlyByEntry[entryIndex].add(candidatesByEntry[entryIndex].candidates[lineNumber - 2])
  }

  const mismatches = []
  candidatesByEntry.forEach(({ subpath, candidates, runtimeKeys }, index) => {
    for (const name of candidates) {
      const isDtsValue = !typeOnlyByEntry[index].has(name)
      const isRuntime = runtimeKeys.has(name)
      if (isDtsValue && !isRuntime) {
        mismatches.push(`${subpath}: d.ts declares value ${name} but the js does not export it`)
      } else if (!isDtsValue && isRuntime) {
        mismatches.push(`${subpath}: js exports ${name} but the d.ts does not declare it as a value`)
      }
    }
  })
  if (mismatches.length > 0) {
    throw new Error(`packed d.ts and js disagree:\n${mismatches.join('\n')}`)
  }
}

// Collect every exported name of a d.ts entry, following relative
// `export *` chains. Throws on any export statement it does not
// recognize, so a generator format change cannot silently skip names.
function collectDtsExportNames(dtsPath, seenFiles = new Set()) {
  const resolved = resolve(dtsPath)
  if (seenFiles.has(resolved)) return []
  seenFiles.add(resolved)
  const source = readFileSync(resolved, 'utf8')
  const names = []
  const consumed = new Set()
  const forms = [
    {
      // export { a, b as c, type d } [from './chunk.js']
      pattern: /^export\s+(type\s+)?\{([^}]*)\}(?:\s*from\s*['"][^'"]+['"])?/gm,
      handle(match) {
        for (const item of match[2].split(',')) {
          const cleaned = item.trim().replace(/^type\s+/, '')
          if (!cleaned) continue
          const alias = cleaned.split(/\s+as\s+/)
          names.push((alias[1] ?? alias[0]).trim())
        }
      },
    },
    {
      // export [declare] const/function/class/enum/namespace/interface/type NAME
      pattern:
        /^export\s+(?:declare\s+)?(?:abstract\s+)?(?:const\s+enum|const|function|class|enum|namespace|let|var|interface|type)\s+([A-Za-z_$][A-Za-z0-9_$]*)/gm,
      handle(match) {
        names.push(match[1])
      },
    },
    {
      // export * as NAME from './chunk.js'
      pattern: /^export\s+\*\s+as\s+([A-Za-z_$][A-Za-z0-9_$]*)\s+from\s*['"][^'"]+['"]/gm,
      handle(match) {
        names.push(match[1])
      },
    },
    {
      // export * from './chunk.js'
      pattern: /^export\s+(type\s+)?\*\s+from\s*['"]([^'"]+)['"]/gm,
      handle(match) {
        const spec = match[2]
        if (!spec.startsWith('.')) {
          throw new Error(`${resolved} re-exports a bare specifier: ${spec}`)
        }
        const base = join(dirname(resolved), spec).replace(/\.[cm]?js$/, '')
        const chunk = [`${base}.d.ts`, `${base}.d.mts`, join(base, 'index.d.ts')].find((candidate) =>
          existsSync(candidate),
        )
        if (!chunk) throw new Error(`${resolved} re-exports unresolvable chunk ${spec}`)
        names.push(...collectDtsExportNames(chunk, seenFiles))
      },
    },
  ]
  for (const { pattern, handle } of forms) {
    for (const match of source.matchAll(pattern)) {
      handle(match)
      consumed.add(match.index)
    }
  }
  for (const match of source.matchAll(/^export\b/gm)) {
    if (!consumed.has(match.index)) {
      const lineNumber = source.slice(0, match.index).split('\n').length
      const line = source.split('\n')[lineNumber - 1]
      throw new Error(`${resolved}:${lineNumber} has an unrecognized export statement: ${line}`)
    }
  }
  return names
}

