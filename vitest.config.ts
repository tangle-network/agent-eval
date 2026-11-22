import { configDefaults, defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    maxWorkers: 2,
    testTimeout: 120_000,
    // A hook gets the same patience as a test. The 10 s default failed a release on a loaded runner: an
    // afterEach that removes temp directories ran past it while every assertion had passed.
    hookTimeout: 120_000,
    exclude: [...configDefaults.exclude, '.claude/worktrees/**'],
  },
})
