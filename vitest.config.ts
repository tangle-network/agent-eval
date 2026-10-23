import { configDefaults, defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Integration default: 4× the observed ~30s default-bearing tail under load.
    testTimeout: 120_000,
    exclude: [...configDefaults.exclude, '.claude/worktrees/**'],
  },
})
