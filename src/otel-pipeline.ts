/**
 * Pipeline-level OTEL integration — auto-attaches an OTEL exporter when
 * OTEL_EXPORTER_OTLP_ENDPOINT is set. Pipelines call `withOtelPipeline()`
 * to get a configured exporter + shutdown handle without manual wiring.
 *
 * Used by: runEvalCampaign, runProductionLoop, runAgentMatrix.
 */

import { createOtelExporter, type OtelExporter, type OtelExportConfig } from './trace/otel-export'

export interface OtelPipelineHandle {
  /** The active exporter, or undefined if no endpoint is configured. */
  exporter: OtelExporter | undefined
  /** Call at pipeline end to flush + shutdown. Safe to call even if exporter is undefined. */
  shutdown(): Promise<void>
}

export interface OtelPipelineOptions {
  /** Override OTEL config. */
  otelConfig?: OtelExportConfig
  /** Pipeline-specific resource attributes. */
  pipelineKind?: string
  pipelineId?: string
}

/**
 * Create an OTEL exporter scoped to a pipeline run. Auto-reads
 * OTEL_EXPORTER_OTLP_ENDPOINT from env when no explicit config is passed.
 *
 * Returns a handle with `exporter` (possibly undefined) and `shutdown()`.
 */
export function withOtelPipeline(opts?: OtelPipelineOptions): OtelPipelineHandle {
  const config: OtelExportConfig = {
    ...opts?.otelConfig,
    resourceAttributes: {
      ...(opts?.pipelineKind ? { 'pipeline.kind': opts.pipelineKind } : {}),
      ...(opts?.pipelineId ? { 'pipeline.id': opts.pipelineId } : {}),
      ...opts?.otelConfig?.resourceAttributes,
    },
  }

  const exporter = createOtelExporter(config)

  return {
    exporter,
    async shutdown() {
      if (exporter) await exporter.shutdown()
    },
  }
}

/**
 * Check if OTEL export is configured (endpoint is set).
 */
export function isOtelConfigured(): boolean {
  return !!(typeof process !== 'undefined' && process.env.OTEL_EXPORTER_OTLP_ENDPOINT)
}
