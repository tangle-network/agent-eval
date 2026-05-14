/**
 * Build an OpenAPI spec from the wire schemas.
 *
 * The spec is the contract that other-language clients (Python, Rust,
 * Go, …) generate from. There is no hand-written client — clients are
 * derived artifacts of this file plus `schemas.ts`.
 *
 * Run `pnpm openapi` (defined in package.json) to write the spec to
 * `dist/openapi.json`. CI uses that file to regenerate the Python
 * client and gate the dual-publish workflow.
 */
import { OpenAPIRegistry, OpenApiGeneratorV31 } from '@asteasolutions/zod-to-openapi'
import type { OpenAPIObject } from 'openapi3-ts/oas31'

import {
  ErrorResponseSchema,
  HealthResponseSchema,
  JudgeRequestSchema,
  JudgeResultSchema,
  ListRubricsResponseSchema,
  VersionResponseSchema,
  WIRE_VERSION,
} from './schemas'

export function buildOpenApi(packageVersion: string): OpenAPIObject {
  const registry = new OpenAPIRegistry()

  // Components — each schema becomes a $ref-able component
  registry.register('JudgeRequest', JudgeRequestSchema)
  registry.register('JudgeResult', JudgeResultSchema)
  registry.register('ListRubricsResponse', ListRubricsResponseSchema)
  registry.register('VersionResponse', VersionResponseSchema)
  registry.register('HealthResponse', HealthResponseSchema)
  registry.register('ErrorResponse', ErrorResponseSchema)

  // Routes
  registry.registerPath({
    method: 'post',
    path: '/v1/judge',
    summary: 'Score a piece of content against a rubric',
    description:
      'Runs the judging LLM with the named (or inline) rubric and returns dimension scores, detected failure modes, wins, and a composite score in 0..1.',
    request: {
      body: {
        content: {
          'application/json': { schema: JudgeRequestSchema },
        },
      },
    },
    responses: {
      200: {
        description: 'Successful judgement',
        content: { 'application/json': { schema: JudgeResultSchema } },
      },
      400: {
        description: 'Validation error',
        content: { 'application/json': { schema: ErrorResponseSchema } },
      },
      404: {
        description: 'Rubric not found',
        content: { 'application/json': { schema: ErrorResponseSchema } },
      },
      500: {
        description: 'Judge error',
        content: { 'application/json': { schema: ErrorResponseSchema } },
      },
    },
  })

  registry.registerPath({
    method: 'get',
    path: '/v1/rubrics',
    summary: 'List built-in rubrics',
    description:
      'Returns every rubric registered server-side, with their dimensions and stable rubricVersion hash.',
    responses: {
      200: {
        description: 'Listing',
        content: { 'application/json': { schema: ListRubricsResponseSchema } },
      },
    },
  })

  registry.registerPath({
    method: 'get',
    path: '/v1/version',
    summary: 'Server and wire-protocol version',
    description: 'Match your client version to `version`; check `wireVersion` for compatibility.',
    responses: {
      200: {
        description: 'Version info',
        content: { 'application/json': { schema: VersionResponseSchema } },
      },
    },
  })

  registry.registerPath({
    method: 'get',
    path: '/healthz',
    summary: 'Liveness check',
    responses: {
      200: {
        description: 'OK',
        content: { 'application/json': { schema: HealthResponseSchema } },
      },
    },
  })

  const generator = new OpenApiGeneratorV31(registry.definitions)
  const doc = generator.generateDocument({
    openapi: '3.1.0',
    info: {
      title: '@tangle-network/agent-eval — wire protocol',
      version: packageVersion,
      description: `HTTP and stdio RPC interface to agent-eval. The TypeScript runtime is the source of truth; this spec is the contract that cross-language clients (Python, Rust, Go) generate from.

Wire-protocol version: ${WIRE_VERSION}. Bumps on breaking changes to request/response schemas.`,
      contact: { name: 'Tangle Network', url: 'https://github.com/tangle-network/agent-eval' },
      license: { name: 'MIT' },
    },
    servers: [{ url: 'http://localhost:5005', description: 'Local agent-eval serve' }],
  })
  const rubricRef = { $ref: '#/components/schemas/Rubric' } as const
  const commonJudgeFields = {
    content: { type: 'string', minLength: 1 },
    context: { type: 'object', additionalProperties: true },
    model: { type: 'string' },
  } as const
  doc.components ??= {}
  doc.components.schemas ??= {}
  doc.components.schemas.JudgeRequest = {
    oneOf: [
      {
        type: 'object',
        additionalProperties: false,
        required: ['rubricName', 'content'],
        properties: {
          rubricName: { type: 'string', minLength: 1 },
          ...commonJudgeFields,
        },
      },
      {
        type: 'object',
        additionalProperties: false,
        required: ['rubric', 'content'],
        properties: {
          rubric: rubricRef,
          ...commonJudgeFields,
        },
      },
    ],
    description: 'Judge request. Provide exactly one of rubricName or rubric.',
  }
  return doc
}
