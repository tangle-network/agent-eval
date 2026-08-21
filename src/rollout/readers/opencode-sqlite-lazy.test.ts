/** `node:module` is mocked so `createRequire` can report the native SQLite
 *  binding as absent. The lazy-load refusal cannot be reached otherwise on a
 *  machine where the binding is installed. */
import { createRequire } from 'node:module'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('node:module', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:module')>()
  return {
    ...actual,
    createRequire: vi.fn(actual.createRequire),
  }
})

afterEach(() => {
  vi.clearAllMocks()
  vi.resetModules()
})

describe('opencode sqlite loading', () => {
  it('does not initialize node:sqlite while importing the reader', async () => {
    const reader = await import('./opencode-sqlite')

    expect(createRequire).not.toHaveBeenCalled()

    await expect(reader.openOpencodeDb('/missing/opencode.db')).resolves.toBeNull()
    expect(createRequire).toHaveBeenCalledOnce()
  })
})
