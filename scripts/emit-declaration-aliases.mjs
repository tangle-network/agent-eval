import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const packageJson = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'))

for (const exportTarget of Object.values(packageJson.exports ?? {})) {
  const typesTarget = exportTarget?.types
  if (typeof typesTarget !== 'string' || !typesTarget.startsWith('./dist/')) continue

  const outputPath = join(repoRoot, typesTarget)
  if (existsSync(outputPath)) continue

  const distRelative = typesTarget.slice('./dist/'.length)
  if (!distRelative.endsWith('.d.ts')) continue

  const aliasBase = distRelative.slice(0, -'.d.ts'.length)
  const sourcePath = join(repoRoot, 'dist', aliasBase, 'index.d.ts')
  if (!existsSync(sourcePath)) continue

  mkdirSync(dirname(outputPath), { recursive: true })
  const sourceModulePath = join(repoRoot, 'dist', aliasBase, 'index')
  const specifier = normalizeDeclarationSpecifier(relative(dirname(outputPath), sourceModulePath))
  writeFileSync(outputPath, `export * from '${specifier}'\n`)
}

function normalizeDeclarationSpecifier(path) {
  const normalized = path.split('\\').join('/')
  return normalized.startsWith('.') ? normalized : `./${normalized}`
}
