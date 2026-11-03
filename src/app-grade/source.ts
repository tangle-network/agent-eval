/**
 * The submission's own files, read from its workdir, and the quoting rule for
 * app-originated text that enters a SystemOne state.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

/** Scaffold and build output the contestant did not write, and lockfiles. */
const SKIP_DIRS = new Set(['node_modules', '.next', '.git', '.starter-foundry', 'preview'])
const SKIP_FILES = /^(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|tsconfig\.tsbuildinfo|next-env\.d\.ts|\.app-grade-materialize\.json|AGENTS\.md|CLAUDE\.md|llms\.txt|validate-types\.mjs|preview-server\.mjs)$/

export interface SourceFile {
  path: string
  content: string
}

/** Every text file the submission can serve or build from, within `extensions`. */
export function sourceFiles(workdir: string, extensions = /\.(ts|tsx|js|jsx|mjs|cjs)$/): SourceFile[] {
  const files: SourceFile[] = []
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      if (SKIP_DIRS.has(name)) continue
      const full = join(dir, name)
      if (statSync(full).isDirectory()) walk(full)
      else if (extensions.test(name) && !SKIP_FILES.test(name) && statSync(full).size <= 500_000) {
        files.push({ path: relative(workdir, full), content: readFileSync(full, 'utf8') })
      }
    }
  }
  walk(workdir)
  return files
}

/** Files that touch payment or tests first, within a fixed character budget. */
export function codeFiles(workdir: string, budget = 45_000) {
  const files = sourceFiles(workdir).filter((file) => !/^(next|postcss)\.config\./.test(file.path))
  const relevant = (file: SourceFile) =>
    /@base-org\/account|@coinbase\/wallet-sdk|getPaymentStatus|eth_getTransactionReceipt|wallet_sendCalls|eth_sendTransaction/.test(file.content) || /test|spec/.test(file.path)
  const ordered = [...files.filter(relevant), ...files.filter((file) => !relevant(file))]
  const chosen: Array<{ path: string; lines: string; content: string }> = []
  let used = 0
  for (const file of ordered) {
    if (used + file.content.length > budget) continue
    chosen.push({ path: file.path, lines: `1-${file.content.split('\n').length}`, content: file.content })
    used += file.content.length
  }
  return { files: chosen, relevantCount: files.filter(relevant).length, total: files.length }
}

/**
 * Longest app screen and source file any review quotes. The integrity review quotes
 * each passage at least this far, so no review reads app text it did not.
 */
export const SCREEN_CHARS = 20_000
export const SOURCE_FILE_CHARS = 20_000

/** App-originated text enters SystemOne state as quoted, untrusted data with its provenance. */
export function untrusted(source: string, text: string, max = 7_000) {
  return { untrusted: true, source, text: text.length > max ? `${text.slice(0, max)}\n[truncated ${text.length - max} chars]` : text }
}
