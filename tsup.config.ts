import { defineConfig } from 'tsup'

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    control: 'src/control.ts',
    optimization: 'src/optimization.ts',
    reporting: 'src/reporting.ts',
    rl: 'src/rl/index.ts',
    traces: 'src/traces.ts',
    'telemetry/index': 'src/telemetry/index.ts',
    'telemetry/file': 'src/telemetry/sink-file.ts',
    'wire/index': 'src/wire/index.ts',
    'benchmarks/index': 'src/benchmarks/index.ts',
    'pipelines/index': 'src/pipelines/index.ts',
    'meta-eval/index': 'src/meta-eval/index.ts',
    'prm/index': 'src/prm/index.ts',
    'builder-eval/index': 'src/builder-eval/index.ts',
    'governance/index': 'src/governance/index.ts',
    'knowledge/index': 'src/knowledge/index.ts',
    cli: 'src/cli.ts',
  },
  format: ['esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  target: 'es2022',
})
