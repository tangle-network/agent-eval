import { describe, expect, it } from 'vitest'
import type { SupervisorRunNodeRole as RootSupervisorRunNodeRole } from '../index'
import {
  NO_SOURCE_LIMITS,
  type SourceLimits,
  type SupervisorRunNodeRole,
  type WorkerLogSource,
} from './index'

describe('supervisor-run public contract', () => {
  it('exports stable identity, recursive role, and explicit token limits', () => {
    const role: SupervisorRunNodeRole = 'supervisor'
    const rootRole: RootSupervisorRunNodeRole = role
    const limits: SourceLimits = NO_SOURCE_LIMITS
    const worker: WorkerLogSource = {
      workerId: 'worker-1',
      label: 'same human label',
      events: null,
      inbox: null,
      patchBytes: null,
    }

    expect(rootRole).toBe('supervisor')
    expect(worker.workerId).toBe('worker-1')
    expect(limits).toMatchObject({ managerTokens: null, workerTokens: null })
  })
})
