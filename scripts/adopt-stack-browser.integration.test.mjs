import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'
import { preparePlaywrightBrowsers } from './adopt-stack-workspace.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const helper = join(here, 'adopt-stack-workspace.mjs')
const save = (root, file, data) => {
  mkdirSync(dirname(join(root, file)), { recursive: true })
  writeFileSync(join(root, file), typeof data === 'string' ? data : JSON.stringify(data, null, 2) + '\n')
}

test('a caller without Playwright performs no install or browser preparation', () => {
  const root = mkdtempSync(join(tmpdir(), 'adopt-no-browser-'))
  try {
    save(root, 'package.json', { name: 'no-browser-fixture', private: true })
    expect(preparePlaywrightBrowsers(root)).toEqual([])
    expect(existsSync(join(root, 'node_modules'))).toBe(false)
    expect(existsSync(join(root, 'package-lock.json'))).toBe(false)
    expect(existsSync(join(root, 'pnpm-lock.yaml'))).toBe(false)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('an importer-owned locked CLI repairs an isolated missing cache; a real download refusal stops preparation', () => {
  const root = mkdtempSync(join(tmpdir(), 'adopt-browser-cache-'))
  const cwd = join(root, 'apps', 'browser')
  // Reuse the existing recorded caller fixture's spec; there is no browser
  // version catalog or registry-latest lookup in the adopter or this proof.
  const recorded = JSON.parse(readFileSync(join(here, '..', 'tests', 'fixtures', 'adopt-stack', 'agent-app', 'package.json'), 'utf8'))
  const packageManager = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8')).packageManager
  const prepare = `import { preparePlaywrightBrowsers } from ${JSON.stringify(helper)}; console.log('PREPARED=' + JSON.stringify(preparePlaywrightBrowsers(process.argv[1])))`
  const launch = `import { createRequire } from 'node:module'; const require = createRequire(process.cwd() + '/package.json'); const { chromium } = createRequire(require.resolve('@playwright/test/package.json'))('playwright'); const browser = await chromium.launch({ headless: true }); try { const page = await browser.newPage(); await page.setContent('<title>actual locked browser</title>'); console.log('BROWSER_GREEN=' + JSON.stringify({ version: browser.version(), title: await page.title() })); } finally { await browser.close() }`
  const run = (source, env, dir = root, args = []) => spawnSync(process.execPath, ['--input-type=module', '-e', source, ...args], { cwd: dir, encoding: 'utf8', env: { ...process.env, ...env }, timeout: 120_000, maxBuffer: 4 * 1024 * 1024 })
  try {
    save(root, 'package.json', { name: 'browser-workspace-fixture', private: true, packageManager })
    save(root, 'pnpm-workspace.yaml', "packages:\n  - 'apps/*'\n")
    for (const name of ['browser', 'same-browser']) save(root, `apps/${name}/package.json`, { name: `fixture-${name}`, private: true, devDependencies: { '@playwright/test': recorded.devDependencies.playwright } })
    execFileSync('pnpm', ['install', '--lockfile-only', '--ignore-scripts'], { cwd: root, stdio: 'pipe' })
    execFileSync('pnpm', ['install', '--frozen-lockfile'], { cwd: root, stdio: 'pipe' })
    const locked = readFileSync(join(root, 'pnpm-lock.yaml'), 'utf8')
    const version = execFileSync(process.execPath, ['-p', "require('@playwright/test/package.json').version"], { cwd, encoding: 'utf8' }).trim()
    const env = { PLAYWRIGHT_BROWSERS_PATH: join(root, 'isolated-browser-cache') }
    const red = run(launch, env, cwd)
    expect(red.status, red.stderr).not.toBe(0)
    expect(red.stderr).toMatch(/Executable doesn't exist/)
    console.log(`BROWSER_BASELINE_RED importer=apps/browser installed=${version} isolatedCache=missing`)

    const refused = run(prepare, { PLAYWRIGHT_BROWSERS_PATH: join(root, 'refused-browser-cache'), PLAYWRIGHT_DOWNLOAD_HOST: 'http://127.0.0.1:1', PLAYWRIGHT_DOWNLOAD_CONNECTION_TIMEOUT: '1000' }, root, [root])
    expect(refused.status, refused.stdout + refused.stderr).not.toBe(0)
    expect(refused.stdout + refused.stderr).toMatch(/ECONNREFUSED|Failed to download|Failed to install browsers/)
    expect(refused.stdout).not.toContain('PREPARED=')
    console.log('BROWSER_DOWNLOAD_REFUSAL_GREEN preparation stopped before returning success')

    const fixed = run(prepare, env, root, [root])
    expect(fixed.status, fixed.stdout + fixed.stderr).toBe(0)
    const prepared = JSON.parse(fixed.stdout.split('\n').find(line => line.startsWith('PREPARED=')).slice('PREPARED='.length))
    expect(prepared).toHaveLength(1)
    expect(prepared[0]).toMatchObject({ file: 'apps/browser/package.json', name: '@playwright/test', version })
    expect(readFileSync(join(root, 'pnpm-lock.yaml'), 'utf8')).toBe(locked)
    const green = run(launch, env, cwd)
    expect(green.status, green.stderr).toBe(0)
    expect(green.stdout).toContain('BROWSER_GREEN=')
    expect(green.stdout).toContain('actual locked browser')
    console.log(green.stdout.trim())
  } finally { rmSync(root, { recursive: true, force: true }) }
}, 180_000)

test('distinct locked packages sharing the playwright bin each prepare their own revision', () => {
  const root = mkdtempSync(join(tmpdir(), 'adopt-dual-browser-'))
  const recorded = JSON.parse(readFileSync(join(here, '..', 'tests', 'fixtures', 'adopt-stack', 'agent-app', 'package.json'), 'utf8'))
  const spec = recorded.devDependencies.playwright
  const floor = /\d+\.\d+\.\d+/.exec(spec)[0]
  const packageManager = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8')).packageManager
  const run = source => spawnSync(process.execPath, ['--input-type=module', '-e', source, root], { cwd: root, encoding: 'utf8', env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: join(root, 'isolated-dual-cache') }, timeout: 120_000, maxBuffer: 4 * 1024 * 1024 })
  const prepare = path => `import { preparePlaywrightBrowsers } from ${JSON.stringify(path)}; console.log('PREPARED=' + JSON.stringify(preparePlaywrightBrowsers(process.argv[1])))`
  try {
    save(root, 'package.json', { name: 'dual-browser-fixture', private: true, packageManager, devDependencies: { playwright: spec, '@playwright/test': floor } })
    execFileSync('pnpm', ['install', '--lockfile-only', '--ignore-scripts'], { cwd: root, stdio: 'pipe' })
    execFileSync('pnpm', ['install', '--frozen-lockfile'], { cwd: root, stdio: 'pipe' })
    const lock = readFileSync(join(root, 'pnpm-lock.yaml'), 'utf8')
    const versions = JSON.parse(execFileSync(process.execPath, ['-p', "JSON.stringify(['playwright', '@playwright/test'].map(name => require(name + '/package.json').version))"], { cwd: root, encoding: 'utf8' }))
    expect(versions[0]).not.toBe(versions[1])
    const baselineRef = process.env.ADOPT_STACK_BROWSER_BASELINE_REF
    if (baselineRef) {
      const baseline = join(root, 'retained-workspace.mjs')
      writeFileSync(baseline, execFileSync('git', ['show', `${baselineRef}:scripts/adopt-stack-workspace.mjs`], { cwd: join(here, '..') }))
      const red = run(prepare(baseline))
      expect(red.status, red.stdout + red.stderr).not.toBe(0)
      expect(red.stderr).toMatch(/expected Playwright .+, CLI reported Version /)
      console.log(`BROWSER_DUAL_BASELINE_RED installed=${versions.join(',')} sharedBinCannotRepresentBoth=true`)
    }
    const fixed = run(prepare(helper))
    expect(fixed.status, fixed.stdout + fixed.stderr).toBe(0)
    const prepared = JSON.parse(fixed.stdout.split('\n').find(line => line.startsWith('PREPARED=')).slice('PREPARED='.length))
    expect(prepared.map(row => row.version).sort()).toEqual([...versions].sort())
    expect(new Set(prepared.map(row => row.cli)).size).toBe(2)
    expect(readFileSync(join(root, 'pnpm-lock.yaml'), 'utf8')).toBe(lock)
    const green = run(`import { createRequire } from 'node:module'; const require = createRequire(process.cwd() + '/package.json'); const libraries = [['playwright', require('playwright')], ['@playwright/test', createRequire(require.resolve('@playwright/test/package.json'))('playwright')]]; const results = []; for (const [name, { chromium }] of libraries) { const browser = await chromium.launch({ headless: true }); try { const page = await browser.newPage(); await page.setContent('<title>both locked CLIs</title>'); results.push({ name, version: browser.version(), title: await page.title() }); } finally { await browser.close() } } console.log('BROWSER_DUAL_GREEN=' + JSON.stringify(results))`)
    expect(green.status, green.stderr).toBe(0)
    const results = JSON.parse(green.stdout.split('\n').find(line => line.startsWith('BROWSER_DUAL_GREEN=')).slice('BROWSER_DUAL_GREEN='.length))
    expect(results.map(row => row.name)).toEqual(['playwright', '@playwright/test'])
    for (const row of results) expect(row.title).toBe('both locked CLIs')
    console.log(green.stdout.trim())
  } finally { rmSync(root, { recursive: true, force: true }) }
}, 180_000)
