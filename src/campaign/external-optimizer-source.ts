import { isRecord } from './external-optimizer-process'
import type { OptimizationPackageSource } from './presets/compare-optimization-methods'

export interface ExternalOptimizerPackageSource<TPackage extends string> {
  package: TPackage
  version: string
  sourceUrl?: string
  revision?: string
  sourceSha256?: string
}

export function assertExternalOptimizerPackageSource<TPackage extends string>(
  value: unknown,
  expectedPackage: TPackage,
  name: string,
  optimizer: string,
): asserts value is ExternalOptimizerPackageSource<TPackage> {
  assertExternalOptimizerPackageIdentity(value, expectedPackage, name, optimizer)
  assertExternalOptimizerSourceDetails(value, name, optimizer)
}

export function assertExternalOptimizerPackageIdentity<TPackage extends string>(
  value: unknown,
  expectedPackage: TPackage,
  name: string,
  optimizer: string,
): asserts value is ExternalOptimizerPackageSource<TPackage> {
  if (
    !isRecord(value) ||
    value.package !== expectedPackage ||
    typeof value.version !== 'string' ||
    value.version.length === 0 ||
    value.version !== value.version.trim()
  ) {
    throw new Error(`${name}: ${optimizer} bridge returned invalid upstream package provenance`)
  }
}

export function assertExternalOptimizerSourceDetails(
  value: ExternalOptimizerPackageSource<string>,
  name: string,
  optimizer: string,
): void {
  if (
    value.sourceUrl !== undefined &&
    (typeof value.sourceUrl !== 'string' ||
      value.sourceUrl.length === 0 ||
      value.sourceUrl !== value.sourceUrl.trim())
  ) {
    throw new Error(`${name}: ${optimizer} bridge returned an invalid upstream sourceUrl`)
  }
  if (
    value.revision !== undefined &&
    (typeof value.revision !== 'string' ||
      value.revision.length === 0 ||
      value.revision !== value.revision.trim())
  ) {
    throw new Error(`${name}: ${optimizer} bridge returned an invalid upstream revision`)
  }
  if (
    value.sourceSha256 !== undefined &&
    (typeof value.sourceSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(value.sourceSha256))
  ) {
    throw new Error(`${name}: ${optimizer} bridge returned an invalid upstream sourceSha256`)
  }
}

export function observedExternalOptimizerPackageSource(
  value: ExternalOptimizerPackageSource<string>,
): OptimizationPackageSource {
  return {
    kind: 'package',
    evidence: 'observed',
    package: value.package,
    version: value.version,
    ...(value.sourceUrl ? { sourceUrl: value.sourceUrl } : {}),
    ...(value.revision ? { revision: value.revision } : {}),
    ...(value.sourceSha256 ? { sourceSha256: value.sourceSha256 } : {}),
  }
}
