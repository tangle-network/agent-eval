import { isDeepStrictEqual } from 'node:util'
import type {
  ExternalOptimizerResumeMode,
  ExternalOptimizerRunnerCommand,
} from './external-optimizer-contracts'
import { isRecord } from './external-optimizer-contracts'
import {
  assertExternalOptimizerPackageSource,
  type ExternalOptimizerPackageSource,
  observedExternalOptimizerPackageSource,
} from './external-optimizer-source'
import { runExternalOptimizerProcess } from './external-optimizer-subprocess'
import type {
  OptimizationModuleSource,
  OptimizationPackageSource,
  OptimizationPythonRuntime,
} from './presets/compare-optimization-methods'

export interface ExternalOptimizerRuntimeIdentity<TPackage extends string> {
  python: OptimizationPythonRuntime
  bridge: ExternalOptimizerPackageSource<'agent-eval-rpc'>
  optimizer: ExternalOptimizerPackageSource<TPackage>
  engineModules: OptimizationModuleSource[]
}

export interface ObservedExternalOptimizerRuntime {
  source: OptimizationPackageSource
  bridge: OptimizationPackageSource
  modules: OptimizationModuleSource[]
  python: OptimizationPythonRuntime
}

export async function inspectExternalOptimizerRuntime<TPackage extends string>(args: {
  label: string
  package: TPackage
  module: string
  engineModules?: readonly string[]
  runner?: ExternalOptimizerRunnerCommand
  timeoutMs: number
}): Promise<ExternalOptimizerRuntimeIdentity<TPackage>> {
  const result = await runExternalOptimizerProcess<{ runtime: unknown }>({
    label: `${args.label} source inspection`,
    tempPrefix: `agent-eval-${args.package}-inspect-`,
    module: args.module,
    input: {
      operation: 'inspect',
      engineModules: [...(args.engineModules ?? [])],
    },
    ...(args.runner ? { runner: args.runner } : {}),
    timeoutMs: args.timeoutMs,
  })
  assertExternalOptimizerRuntimeIdentity(result.runtime, args.package, args.label)
  return result.runtime
}

export function observedExternalOptimizerRuntime(
  runtime: ExternalOptimizerRuntimeIdentity<string>,
): ObservedExternalOptimizerRuntime {
  return {
    source: observedExternalOptimizerPackageSource(runtime.optimizer),
    bridge: observedExternalOptimizerPackageSource(runtime.bridge),
    modules: runtime.engineModules.map((module) => ({ ...module })),
    python: { ...runtime.python },
  }
}

export function assertExternalOptimizerRunBinding<TPackage extends string>(args: {
  label: string
  runtime: ExternalOptimizerRuntimeIdentity<TPackage>
  returnedSource: ExternalOptimizerPackageSource<TPackage>
  compatibleRunId: string
  runId: string
  returnedRunId: string
  resume: ExternalOptimizerResumeMode
  resumed: boolean
}): void {
  if (!isDeepStrictEqual(args.returnedSource, args.runtime.optimizer)) {
    throw new Error(`${args.label}: optimizer package changed after source inspection`)
  }
  if (args.returnedRunId !== args.runId) {
    throw new Error(`${args.label}: bridge returned a different run ID`)
  }
  if (args.resume === 'never' && args.resumed) {
    throw new Error(`${args.label}: fresh run reported restored state`)
  }
  if (args.resume === 'required' && !args.resumed) {
    throw new Error(`${args.label}: required resume did not restore state`)
  }
  if (!args.runId.startsWith(args.compatibleRunId)) {
    throw new Error(`${args.label}: run ID is not bound to its compatible identity`)
  }
}

export function assertExternalOptimizerRuntimeIdentity<TPackage extends string>(
  value: unknown,
  expectedPackage: TPackage,
  label: string,
): asserts value is ExternalOptimizerRuntimeIdentity<TPackage> {
  if (!isRecord(value)) {
    throw new Error(`${label}: source inspection returned no runtime identity`)
  }
  assertExternalOptimizerPackageSource(value.bridge, 'agent-eval-rpc', label, 'bridge')
  assertExternalOptimizerPackageSource(value.optimizer, expectedPackage, label, expectedPackage)
  if (!value.bridge.sourceSha256 || !value.optimizer.sourceSha256) {
    throw new Error(`${label}: source inspection omitted package source hashes`)
  }
  if (
    !isRecord(value.python) ||
    typeof value.python.implementation !== 'string' ||
    value.python.implementation.length === 0 ||
    value.python.implementation !== value.python.implementation.trim() ||
    typeof value.python.version !== 'string' ||
    value.python.version.length === 0 ||
    value.python.version !== value.python.version.trim()
  ) {
    throw new Error(`${label}: source inspection returned an invalid Python runtime`)
  }
  if (
    !Array.isArray(value.engineModules) ||
    value.engineModules.some(
      (module) =>
        !isRecord(module) ||
        typeof module.module !== 'string' ||
        module.module.length === 0 ||
        module.module !== module.module.trim() ||
        typeof module.sourceSha256 !== 'string' ||
        !/^[0-9a-f]{64}$/.test(module.sourceSha256),
    )
  ) {
    throw new Error(`${label}: source inspection returned invalid engine modules`)
  }
}
