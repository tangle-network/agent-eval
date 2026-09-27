/**
 * Every field that states this package's own version. Prepare Release
 * (`prepare-release.mjs`) rewrites each one. The analyst benchmark's
 * dependency-lock digest (`check-analyst-benchmark-implementation.mjs`) blanks
 * the ones in its files, so a release that changes only the version leaves
 * that digest, and its pin, unchanged.
 */
export const OWN_VERSION_FIELDS = Object.freeze([
  { path: 'package.json', pattern: /^(\s*"version":\s*)"[^"\n]+"/m },
  { path: 'clients/python/pyproject.toml', pattern: /^(version = )"[^"\n]+"/m },
  {
    path: 'clients/python/src/agent_eval_rpc/__init__.py',
    pattern: /^( {4}__version__ = )"[^"\n]+"/m,
  },
  {
    path: 'clients/python/uv.lock',
    pattern: /^(\[\[package\]\]\nname = "agent-eval-rpc"\nversion = )"[^"\n]+"/m,
  },
])

/** `text` with `path`'s own-version field set to `version`; unchanged when
 * `path` has no such field. Throws when the field is missing from the text,
 * so a moved field fails closed instead of being skipped. */
export function withOwnVersion(path, text, version) {
  const field = OWN_VERSION_FIELDS.find((entry) => entry.path === path)
  if (!field) return text
  if (!field.pattern.test(text)) throw new Error(`own version field not found in ${path}`)
  return text.replace(field.pattern, (_match, prefix) => `${prefix}"${version}"`)
}
