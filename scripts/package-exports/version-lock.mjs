import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { repoRoot } from './repository.mjs'

export function verifyVersionLock() {
  const npmVersion = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')).version
  const pyproject = readFileSync(join(repoRoot, 'clients/python/pyproject.toml'), 'utf8')
  const pythonSource = readFileSync(
    join(repoRoot, 'clients/python/src/agent_eval_rpc/__init__.py'),
    'utf8',
  )
  const uvLock = readFileSync(join(repoRoot, 'clients/python/uv.lock'), 'utf8')
  const pythonPackageVersion = matchVersion(
    pyproject,
    /^version\s*=\s*"([^"]+)"$/m,
    'clients/python/pyproject.toml',
  )
  const pythonFallbackVersion = matchVersion(
    pythonSource,
    /except PackageNotFoundError:\s*\n\s*__version__ = "([^"]+)"/,
    'clients/python/src/agent_eval_rpc/__init__.py',
  )
  const uvRootVersion = matchVersion(
    uvLock,
    /\[\[package\]\]\s*\nname = "agent-eval-rpc"\s*\nversion = "([^"]+)"/,
    'clients/python/uv.lock',
  )
  const versions = {
    npm: npmVersion,
    pythonPackage: pythonPackageVersion,
    pythonFallback: pythonFallbackVersion,
    uvRoot: uvRootVersion,
  }
  const mismatched = Object.entries(versions).filter(([, version]) => version !== npmVersion)
  if (mismatched.length > 0) {
    throw new Error(
      `release version mismatch: ${Object.entries(versions)
        .map(([name, version]) => `${name}=${version}`)
        .join(', ')}`,
    )
  }
}

function matchVersion(source, pattern, path) {
  const match = source.match(pattern)
  if (!match?.[1]) throw new Error(`could not read release version from ${path}`)
  return match[1]
}
