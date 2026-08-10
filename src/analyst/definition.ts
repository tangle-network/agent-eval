/**
 * AnalystDefinition — the declarative unit behind an analyst arm.
 *
 * An arm is one way of EXECUTING an analysis question: a one-shot JSON call, a
 * bridge-reached RLM, a recursive engine with trace tools. What the arm SAYS —
 * the question, the task text, the reply grammar, how evidence reaches the
 * model, the repair-turn and budget terms — is protocol, not execution, so it
 * lives here as one inspectable value. `bindAnalyst` (./bind) compiles a
 * definition plus a transport binding into a runnable arm, and the parity
 * suite holds the compiled arm to the byte against the arm's entry point, so a
 * definition cannot drift from what its arm actually sends.
 *
 * Three rules carried over from the repair-arm comparison contract
 * (trace-repair's `repairArmAsymmetries`), made structural here:
 *
 *   one contract    the reply grammar is a `ReplyContract` value on the
 *                   definition, never prose inside a runner body.
 *   one repair turn `analystDefinitionAsymmetries` refuses a set whose
 *                   definitions declare unequal repair turns, because a second
 *                   attempt is a second sample the other arms never got.
 *   declared difference what arms MAY differ in — the evidence projection, the
 *                   reasoning effort, the budget — is declared per definition
 *                   and rendered beside the comparison instead of being
 *                   inferred from two runners' source.
 */

import { createHash } from 'node:crypto'
import type { AgentProfile } from '../agent-profile'
import type { TraceAnalysisStore } from '../trace-analyst/store'
import type { TraceAnalystSpan } from '../trace-analyst/types'
import type { AnalystBenchmarkRunner } from './benchmark'
import type { PublicAnalystBenchmarkModelConfig } from './benchmark-public-types'
import type { TraceAnalystLimits } from './engine'
import { assertEqualDeclarativeTerms } from './equal-terms'
import { primeProtocolSha256 } from './prime-protocol'
import type { ReplyContract } from './reply-contract'
import type { TraceToolGroupName } from './tool-groups'
import type { AnalystFinding, AnalystRunInputs } from './types'

// ── Profile fragment ────────────────────────────────────────────────

/**
 * The slice of the canonical `AgentProfile` an analyst definition carries:
 * model hints (pinned model, reasoning effort) and prompt shaping. Transport
 * bindings that own model selection leave `model.default` unset.
 */
export type AnalystProfileFragment = Pick<AgentProfile, 'model' | 'prompt'>

// ── Evidence projection ─────────────────────────────────────────────

/**
 * How evidence reaches the model. This is the declared affordance axis of an
 * arm: two arms answering the same question through different projections are
 * comparable only with the difference rendered, never silently.
 */
export type EvidenceProjection =
  | {
      readonly mode: 'inline'
      /** Ceiling on serialized evidence characters embedded in one prompt. */
      readonly maxInlineChars: number
      /**
       * Per-attribute byte cap for the reduced refetch when the full
       * projection is oversized. Still oversized after the refetch = refusal,
       * never a silent truncation.
       */
      readonly cappedAttributeBytes: number
    }
  | {
      readonly mode: 'chunked'
      /** Descending per-attribute byte caps tried until the store yields a projection. */
      readonly attributeByteCaps: readonly number[]
    }
  | {
      /** Evidence bound as an engine REPL variable, read through bounded trace tools. */
      readonly mode: 'repl-variable'
      readonly toolGroup: TraceToolGroupName
    }
  | {
      /** Evidence read through agent tool calls only; no REPL. */
      readonly mode: 'agent-tools'
      readonly toolGroup: TraceToolGroupName
    }

// ── Budget and repair declarations ──────────────────────────────────

export interface AnalystBudgetDeclaration {
  /** Deadline for one model exchange. */
  readonly timeoutMs: number
  /** Provider spend ceiling for one analysis, when the transport meters cost. */
  readonly maxCostUsd?: number
  /** Completion-token cap per model call, when the transport enforces one. */
  readonly maxOutputTokens?: number
  /** Recursive-engine iteration limits (repl-variable / agent-tools projections). */
  readonly engineLimits?: TraceAnalystLimits
}

export interface AnalystRepairDeclaration {
  /**
   * Bounded retries a structurally malformed reply earns. Compared definitions
   * must declare the same number: a retry is a second sample.
   */
  readonly turns: number
}

// ── Evidence bindings (typed ports per projection) ──────────────────

export interface AnalystRowExpansion {
  findings: AnalystFinding[]
  /** Arm-specific expansion diagnostics recorded in observation metadata. */
  diagnostics?: unknown
}

export interface ExpandRowsArgs<TRow> {
  /** Evidence subject the case names (e.g. a trajectory id). */
  subject: string
  rows: readonly TRow[]
  store: TraceAnalysisStore
  analystId: string
  producedAt?: string
  /** Model the provider reported serving, when the transport captures it. */
  providerModel?: string
  signal?: AbortSignal
}

/** Ports an inline-projection arm binds: prompt framing plus row expansion. */
export interface InlineEvidenceBinding<TRow> {
  readonly kind: 'inline'
  subjectFromCaseId(caseId: string): string
  /** Base observation metadata (analysis mode, engine label). */
  readonly baseMetadata: Readonly<Record<string, unknown>>
  /**
   * Line introducing the inlined evidence. Throws when the projected spans
   * cannot ground the question (e.g. no assistant step spans).
   */
  header(subject: string, spans: readonly TraceAnalystSpan[]): string
  /** Material appended after the evidence. */
  trailer(subject: string, spans: readonly TraceAnalystSpan[]): string
  expandRows(args: ExpandRowsArgs<TRow>): Promise<AnalystRowExpansion>
}

/** Ports a chunked-projection one-shot arm binds. */
export interface ChunkedEvidenceBinding<TRow> {
  readonly kind: 'chunked'
  subjectFromCaseId(caseId: string): string
  readonly baseMetadata: Readonly<Record<string, unknown>>
  /** Actor name paid calls are attributed to in the cost ledger. */
  readonly costActor: string
  /** Cost-ledger phase paid calls settle under. */
  readonly costPhase: string
  /** Compose the user message around the rendered evidence. */
  userMessage(rendered: string): string
  expandRows(args: ExpandRowsArgs<TRow>): Promise<AnalystRowExpansion>
  /** Ground accepted findings against the store; throws on unresolvable evidence. */
  verifyFindings?(args: {
    subject: string
    findings: readonly AnalystFinding[]
    store: TraceAnalysisStore
    signal?: AbortSignal
  }): Promise<void>
}

/** Majority-vote ports for a multi-sample repl-variable arm. */
export interface ReplVariableConsensusPort<TAssignment, TBlock> {
  /** Vote across per-sample assignments; returns voted blocks plus the decision record. */
  vote(samples: ReadonlyArray<readonly TAssignment[]>): {
    blocks: readonly TBlock[]
    decision: unknown
  }
  /** Expand voted blocks into findings grounded in the store. */
  expand(args: {
    subject: string
    blocks: readonly TBlock[]
    store: TraceAnalysisStore
    analystId: string
    producedAt: string
    signal?: AbortSignal
  }): Promise<AnalystRowExpansion>
  /** Per-sample observation record (accepted blocks, member steps). */
  sampleRecord(assignments: readonly TAssignment[]): Record<string, unknown>
}

/** Ports a repl-variable (recursive engine) arm binds. */
export interface ReplVariableEvidenceBinding<TAssignment = unknown, TBlock = unknown> {
  readonly kind: 'repl-variable'
  /** Identity of the trace-analyst definition the engine runs. */
  readonly traceAnalystId: string
  subjectFromCaseId(caseId: string): string
  readonly baseMetadata: Readonly<Record<string, unknown>>
  /** Metadata stamped on every finding the arm emits. */
  readonly findingBaseMetadata: Readonly<Record<string, unknown>>
  /** Cost-ledger phase paid calls settle under. */
  readonly costPhase: string
  /** Row metadata derived from the finding's subject grammar. */
  metadataFromSubject?(subject: string | undefined): Record<string, unknown> | undefined
  /** Map raw engine rows into scored findings grounded in the store. */
  adapt(args: {
    subject: string
    findings: readonly AnalystFinding[]
    analystId: string
    store: TraceAnalysisStore
    signal?: AbortSignal
  }): Promise<{ findings: AnalystFinding[]; stepBlocks?: TAssignment[]; diagnostics?: unknown }>
  /** Multi-sample majority consensus; required when the arm runs samples > 1. */
  consensus?: ReplVariableConsensusPort<TAssignment, TBlock>
  /** Second-opinion arm invoked when the engine submits no finding at all. */
  abstentionFallback(
    config: PublicAnalystBenchmarkModelConfig,
  ): AnalystBenchmarkRunner<AnalystRunInputs>
}

export type AnalystEvidenceBinding<TRow, TAssignment = unknown, TBlock = unknown> =
  | InlineEvidenceBinding<TRow>
  | ChunkedEvidenceBinding<TRow>
  | ReplVariableEvidenceBinding<TAssignment, TBlock>

// ── The definition ──────────────────────────────────────────────────

export interface AnalystDefinition<TRow = unknown, TAssignment = unknown, TBlock = unknown> {
  /** Arm identity — appears as the runner id and in every finding. */
  readonly id: string
  readonly description: string
  readonly version: string
  /** Finding area the arm's expansion stamps, when uniform per arm. */
  readonly area?: string
  readonly profile: AnalystProfileFragment
  /** User-facing question. Empty when the task text is the whole ask. */
  readonly question: string
  /** Task definition / instruction text sent beside the question. */
  readonly taskDefinition?: string
  readonly projection: EvidenceProjection
  readonly replyContract: ReplyContract<TRow>
  /**
   * Numeric limits the contract states (row caps, width caps). They enter the
   * protocol digest; insertion order is digest-bearing because the digest
   * serializes with `JSON.stringify`.
   */
  readonly contractLimits: Readonly<Record<string, number>>
  readonly budget: AnalystBudgetDeclaration
  readonly repair: AnalystRepairDeclaration
  /**
   * Digest the bound arm stamps on observations. For an inline definition this
   * equals `analystDefinitionProtocolSha256`; benchmark arms that record a
   * shared dataset-level digest carry that digest here instead.
   */
  readonly protocolSha256: string
  readonly binding: AnalystEvidenceBinding<TRow, TAssignment, TBlock>
}

/**
 * Thrown at bind time when a definition asks for something no strategy can
 * compile — an unknown projection × transport pair, a repair-turn count the
 * exchange machinery cannot grant, a reasoning effort the arm cannot map. The
 * message names the construct so an expressiveness gap is a loud, attributable
 * failure instead of a silently narrowed protocol.
 */
export class AnalystExpressivenessError extends Error {}

// ── Protocol identity ───────────────────────────────────────────────

/**
 * Digest of everything a definition can send to its model. An inline
 * definition hashes under the historical prime-protocol domain, so its digest
 * equals the digest its bespoke arm always recorded; other projections hash
 * under the definition domain.
 */
export function analystDefinitionProtocolSha256<TRow, TAssignment, TBlock>(
  definition: AnalystDefinition<TRow, TAssignment, TBlock>,
): string {
  const { projection, replyContract } = definition
  if (projection.mode === 'inline') {
    return primeProtocolSha256({
      question: definition.question,
      ...(definition.taskDefinition === undefined
        ? {}
        : { taskDefinition: definition.taskDefinition }),
      contractLines: replyContract.contractLines,
      repairContractLines: replyContract.repairContractLines,
      limits: {
        ...definition.contractLimits,
        maxInlineTrajectoryChars: projection.maxInlineChars,
        chunkedProjectionAttributeByteCap: projection.cappedAttributeBytes,
      },
    })
  }
  return createHash('sha256')
    .update(
      JSON.stringify({
        kind: 'analyst-definition-protocol',
        mode: projection.mode,
        question: definition.question,
        taskDefinition: definition.taskDefinition ?? null,
        contractLines: replyContract.contractLines,
        repairContractLines: replyContract.repairContractLines,
        limits: definition.contractLimits,
        projection:
          projection.mode === 'chunked'
            ? { attributeByteCaps: projection.attributeByteCaps }
            : { toolGroup: projection.toolGroup },
      }),
    )
    .digest('hex')
}

// ── Equal-terms comparison ──────────────────────────────────────────

/** One definition's declared difference from the compared set. */
export interface AnalystDefinitionAsymmetry {
  readonly id: string
  readonly projectionMode: EvidenceProjection['mode']
  readonly reasoningEffort: NonNullable<AgentProfile['model']>['reasoningEffort'] | null
  readonly timeoutMs: number
  readonly maxCostUsd: number | null
  readonly maxOutputTokens: number | null
  /** The digest the arm records on observations. */
  readonly protocolSha256: string
  /** The definition's own protocol identity. */
  readonly definitionSha256: string
}

export interface AnalystDefinitionAsymmetryReport {
  readonly ids: readonly string[]
  /** Repair turns every compared definition declares. */
  readonly repairTurns: number
  /** The one projection mode all definitions share, or null when they differ. */
  readonly sharedProjectionMode: EvidenceProjection['mode'] | null
  readonly asymmetries: readonly AnalystDefinitionAsymmetry[]
}

/**
 * Refuse a set of definitions that cannot be compared on equal terms, and
 * render what still differs between the ones that can. The hard rule is the
 * repair turn: a malformed reply must earn the same number of retries in every
 * arm, because a retry is a second sample. Projection, reasoning effort, and
 * budget differences are declared and reported, never hidden.
 */
export function analystDefinitionAsymmetries(
  definitions: ReadonlyArray<AnalystDefinition<unknown, unknown, unknown>>,
): AnalystDefinitionAsymmetryReport {
  const { ids, repairTurns } = assertEqualDeclarativeTerms(
    'analyst definition',
    definitions.map((definition) => ({ id: definition.id, repairTurns: definition.repair.turns })),
  )
  const firstMode = definitions[0]!.projection.mode
  const sharedProjectionMode = definitions.every(
    (definition) => definition.projection.mode === firstMode,
  )
    ? firstMode
    : null
  return {
    ids,
    repairTurns,
    sharedProjectionMode,
    asymmetries: definitions.map((definition) => ({
      id: definition.id,
      projectionMode: definition.projection.mode,
      reasoningEffort: definition.profile.model?.reasoningEffort ?? null,
      timeoutMs: definition.budget.timeoutMs,
      maxCostUsd: definition.budget.maxCostUsd ?? null,
      maxOutputTokens: definition.budget.maxOutputTokens ?? null,
      protocolSha256: definition.protocolSha256,
      definitionSha256: analystDefinitionProtocolSha256(definition),
    })),
  }
}
