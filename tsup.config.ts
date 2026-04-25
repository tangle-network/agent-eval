import { defineConfig } from 'tsup'

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'telemetry/index': 'src/telemetry/index.ts',
    'telemetry/file': 'src/telemetry/sink-file.ts',
  },
  format: ['esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  target: 'es2022',
})
