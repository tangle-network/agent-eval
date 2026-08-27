import { build } from 'tsup'
import { buildEntries } from './build-entries.mjs'

for (const [name, source] of Object.entries(buildEntries)) {
  await build({
    entry: { [name]: source },
    format: ['esm'],
    target: 'es2022',
    outDir: 'dist',
    clean: false,
    silent: true,
    dts: { only: true },
  })
}
