import { configDefaults, defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Integration I/O under load: 2× p99 upper, rounded up; explicit long cases keep own limits.
    testTimeout: 28_000,
    exclude: [...configDefaults.exclude, '.claude/worktrees/**'],
  },
})
