import { describe, expect, it } from 'vitest'
import {
  type RuntimeControllerTurnReceipt as RootRuntimeControllerTurnReceipt,
  type RuntimeTraceSessionBinding as RootRuntimeTraceSessionBinding,
  type SupervisorRunNodeRole as RootSupervisorRunNodeRole,
  type SupervisorRunSessionLineage as RootSupervisorRunSessionLineage,
  isRuntimeSupervisorRunDir as rootIsRuntimeSupervisorRunDir,
  readRuntimeSupervisorRun as rootReadRuntimeSupervisorRun,
  runtimeSupervisorRunReader as rootRuntimeSupervisorRunReader,
} from '../index'
import {
  isRuntimeSupervisorRunDir,
  NO_SOURCE_LIMITS,
  type RuntimeControllerTurnReceipt,
  type RuntimeTraceSessionBinding,
  readRuntimeSupervisorRun,
  runtimeSupervisorRunReader,
  type SourceLimits,
  type SupervisorRunNodeRole,
  type SupervisorRunSessionLineage,
  type WorkerLogSource,
} from './index'

describe('supervisor-run public contract', () => {
  it('exports stable identity, recursive role, and explicit token limits', () => {
    const role: SupervisorRunNodeRole = 'supervisor'
    const rootRole: RootSupervisorRunNodeRole = role
    const limits: SourceLimits = NO_SOURCE_LIMITS
    const binding: RuntimeTraceSessionBinding = {
      provider: 'cli-bridge',
      backend: 'pi',
      externalId: 'root',
      nativeSessionId: 'session-root',
      cwd: '/workspace',
      nativePromptCount: 1,
      controllerTurns: [],
    }
    const rootBinding: RootRuntimeTraceSessionBinding = binding
    const turn: RuntimeControllerTurnReceipt = {
      ordinal: 1,
      runId: 'root:turn:1',
      bridgeRequestDigest: `sha256:${'a'.repeat(64)}`,
      promptSha256: `sha256:${'b'.repeat(64)}`,
      startedAt: 1_000,
      endedAt: 2_000,
    }
    const rootTurn: RootRuntimeControllerTurnReceipt = turn
    const lineage: SupervisorRunSessionLineage = {
      nodeId: binding.externalId,
      parentNodeId: null,
      depth: 0,
      childNodeIds: [],
      providerSession: { ...binding, controllerTurns: [turn] },
    }
    const rootLineage: RootSupervisorRunSessionLineage = lineage
    const worker: WorkerLogSource = {
      workerId: 'worker-1',
      label: 'same human label',
      events: null,
      inbox: null,
      patchBytes: null,
    }

    expect(rootRole).toBe('supervisor')
    expect(rootBinding.nativeSessionId).toBe('session-root')
    expect(rootTurn.ordinal).toBe(1)
    expect(rootLineage.depth).toBe(0)
    expect(worker.workerId).toBe('worker-1')
    expect(limits).toMatchObject({ managerTokens: null, workerTokens: null })
    expect(typeof readRuntimeSupervisorRun).toBe('function')
    expect(typeof runtimeSupervisorRunReader).toBe('function')
    expect(typeof isRuntimeSupervisorRunDir).toBe('function')
    expect(rootReadRuntimeSupervisorRun).toBe(readRuntimeSupervisorRun)
    expect(rootRuntimeSupervisorRunReader).toBe(runtimeSupervisorRunReader)
    expect(rootIsRuntimeSupervisorRunDir).toBe(isRuntimeSupervisorRunDir)
  })
})
