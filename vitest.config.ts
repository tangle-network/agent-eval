import { configDefaults, defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    maxWorkers: 2,
    testTimeout: 120_000,
    exclude: [...configDefaults.exclude, '.claude/worktrees/**'],
  },
})
