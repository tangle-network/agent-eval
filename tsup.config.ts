import { defineConfig } from 'tsup'
import { buildEntries } from './scripts/build-entries.mjs'

export default defineConfig({
  entry: buildEntries,
  format: ['esm'],
  sourcemap: true,
  clean: true,
  target: 'es2022',
})
