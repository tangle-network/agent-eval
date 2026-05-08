import { defineConfig } from 'tsup'

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    control: 'src/control.ts',
    optimization: 'src/optimization.ts',
    reporting: 'src/reporting.ts',
    traces: 'src/traces.ts',
    'telemetry/index': 'src/telemetry/index.ts',
    'telemetry/file': 'src/telemetry/sink-file.ts',
    'wire/index': 'src/wire/index.ts',
    'benchmarks/index': 'src/benchmarks/index.ts',
    cli: 'src/cli.ts',
  },
  format: ['esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  target: 'es2022',
})
