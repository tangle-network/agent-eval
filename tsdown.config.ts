import { defineConfig } from 'tsdown'
import { buildEntries } from './scripts/build-entries.mjs'

export default defineConfig({
  entry: buildEntries,
  format: ['esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  target: 'es2022',
  platform: 'node',
  fixedExtension: false,
  deps: {
    onlyBundle: ['openapi3-ts'],
  },
})
