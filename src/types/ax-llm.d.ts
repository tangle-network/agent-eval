// Minimal ambient types for the @ax-llm/ax surface used by agent-eval.
declare module '@ax-llm/ax' {
  export function ai(config: Record<string, unknown>): AxAIService
  export function ax(signature: string, options?: Record<string, unknown>): unknown
  export class AxGEPA {
    constructor(options?: Record<string, unknown>)
    compile(
      program: unknown,
      train: unknown,
      metricFn: unknown,
      options?: Record<string, unknown>,
    ): Promise<unknown>
  }

  // ─── trace-analyst surface ─────────────────────────────────────────

  /** Concrete shape is owned by @ax-llm/ax; agent-eval passes it through. */
  export interface AxAIService {}

  /** Registered tool definition produced by @ax-llm/ax. */
  export interface AxFunction {}

  /** Field-builder DSL. We only declare the shapes the trace-analyst
   *  uses; @ax-llm/ax exposes a much larger surface. */
  export interface AxFieldType {
    optional(): AxFieldType
    array(): AxFieldType
  }

  export interface FluentField {
    string(description?: string): AxFieldType
    number(description?: string): AxFieldType
    boolean(description?: string): AxFieldType
    json(description?: string): AxFieldType
    input(name: string, type: AxFieldType): FluentField
    output(name: string, type: AxFieldType): FluentField
    build(): unknown
  }

  /** `f` is both a callable that produces a builder and a record of
   *  type constructors. Mirror the runtime shape minimally. */
  export const f: {
    (): FluentField
    string(description?: string): AxFieldType
    number(description?: string): AxFieldType
    boolean(description?: string): AxFieldType
    json(description?: string): AxFieldType
  }

  export interface FunctionBuilder<
    TArgs extends Record<string, unknown> = Record<string, unknown>,
  > {
    description(text: string): FunctionBuilder<TArgs>
    namespace(name: string): FunctionBuilder<TArgs>
    arg<K extends string>(name: K, type: AxFieldType): FunctionBuilder<TArgs & Record<K, unknown>>
    returns(type: AxFieldType): FunctionBuilder<TArgs>
    handler(fn: (args: TArgs) => unknown | Promise<unknown>): FunctionBuilder<TArgs>
    example(example: { title: string; code: string }): FunctionBuilder<TArgs>
    build(): AxFunction
  }

  export function fn(name: string): FunctionBuilder

  export interface AxAgentInstance<IN, OUT> {
    forward(parentAi: AxAIService, values: IN, options?: Record<string, unknown>): Promise<OUT>
    getUsage(): { actor: unknown[]; responder: unknown[] }
    getChatLog(): { actor: unknown[]; responder: unknown[] }
    resetUsage(): void
  }

  export interface AxAgentConfig {
    agentIdentity?: { name: string; description: string; namespace?: string }
    contextFields?: ReadonlyArray<string | { field: string; promptMaxChars?: number }>
    runtime?: unknown
    mode?: 'simple' | 'advanced'
    maxTurns?: number
    maxRuntimeChars?: number
    maxSubAgentCalls?: number
    maxBatchedLlmQueryConcurrency?: number
    promptLevel?: 'default' | 'detailed'
    contextPolicy?: { preset?: string; budget?: string }
    summarizerOptions?: Record<string, unknown>
    actorOptions?: Record<string, unknown>
    responderOptions?: Record<string, unknown>
    actorModelPolicy?: ReadonlyArray<{
      model: string
      aboveErrorTurns?: number
      namespaces?: string[]
    }>
    recursionOptions?: { maxDepth?: number; inheritDiscovery?: boolean }
    functions?: {
      local?: AxFunction[] | unknown[]
      shared?: AxFunction[] | unknown[]
      globallyShared?: AxFunction[] | unknown[]
      excluded?: string[]
      discovery?: boolean
    }
    actorTurnCallback?: (turn: AxActorTurn) => void | Promise<void>
    agentStatusCallback?: (message: string, status: 'success' | 'failed') => void | Promise<void>
    bubbleErrors?: ReadonlyArray<abstract new (...args: never) => Error>
  }

  export interface AxActorTurn {
    turn: number
    actionLogEntryCount: number
    guidanceLogEntryCount: number
    actorResult: Record<string, unknown>
    code: string
    result: unknown
    output: string
    isError: boolean
    thought?: string
  }

  export function agent<IN = Record<string, unknown>, OUT = Record<string, unknown>>(
    signature: string,
    options: AxAgentConfig,
  ): AxAgentInstance<IN, OUT>

  export class AxJSRuntime {
    constructor(options?: {
      permissions?: AxJSRuntimePermission[]
      blockDynamicImport?: boolean
      allowedModules?: readonly string[]
      freezeIntrinsics?: boolean
      blockShadowRealm?: boolean
      lockWorkerIPC?: boolean
      preventGlobalThisExtensions?: boolean
      useNodePermissionModel?: boolean | 'auto'
      nodePermissionAllowlist?: {
        fsRead?: string[]
        fsWrite?: string[]
        childProcess?: string[]
        addons?: string[]
        wasi?: boolean
      }
      resourceLimits?: Record<string, number>
      allowDenoRemoteImport?: boolean
      allowUnsafeNodeHostAccess?: boolean
    })
  }
  export enum AxJSRuntimePermission {
    NETWORK = 'NETWORK',
    STORAGE = 'STORAGE',
    CODE_LOADING = 'CODE_LOADING',
    COMMUNICATION = 'COMMUNICATION',
    TIMING = 'TIMING',
    WORKERS = 'WORKERS',
    FILESYSTEM = 'FILESYSTEM',
    CHILD_PROCESS = 'CHILD_PROCESS',
  }

  export class AxAgentClarificationError extends Error {
    readonly question: string
    readonly clarification: unknown
    getState(): unknown
  }
}
