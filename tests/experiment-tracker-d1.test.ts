import { describe, expect, it } from 'vitest'
import type { BenchmarkReport, D1Like, D1PreparedStatementLike } from '../src/index'
import { D1ExperimentStore, ExperimentTracker } from '../src/index'

/**
 * Tiny in-memory D1 fake. Implements only the methods D1ExperimentStore
 * actually calls — `prepare(...).bind(...).first|all|run`, plus `exec` for
 * DDL. Storage is per-table maps; bind args are positional `?N`.
 */
function makeFakeD1(): D1Like & { tables: Map<string, Map<string, Record<string, unknown>>> } {
  const tables = new Map<string, Map<string, Record<string, unknown>>>()
  function table(name: string): Map<string, Record<string, unknown>> {
    let t = tables.get(name)
    if (!t) {
      t = new Map()
      tables.set(name, t)
    }
    return t
  }
  function detectTable(query: string): string {
    const m = query.match(/(?:INTO|FROM|UPDATE|TABLE\s+IF\s+NOT\s+EXISTS|TABLE)\s+([a-zA-Z0-9_]+)/i)
    return m ? m[1]! : ''
  }
  function buildStmt(query: string, args: unknown[] = []): D1PreparedStatementLike {
    return {
      bind(...newArgs: unknown[]): D1PreparedStatementLike {
        return buildStmt(query, [...args, ...newArgs])
      },
      async first<T = Record<string, unknown>>(): Promise<T | null> {
        const tname = detectTable(query)
        const t = table(tname)
        const idMatch = query.match(/WHERE\s+id\s*=\s*\?1/i)
        const expIdMatch = query.match(/WHERE\s+experiment_id\s*=\s*\?1/i)
        if (idMatch) {
          const id = String(args[0])
          const row = t.get(id)
          return (row as T | undefined) ?? null
        }
        if (expIdMatch) {
          const expId = String(args[0])
          const rows = [...t.values()].filter((r) => r.experiment_id === expId)
          return (rows[0] as T | undefined) ?? null
        }
        return null
      },
      async all<T = Record<string, unknown>>(): Promise<{ results: T[] }> {
        const tname = detectTable(query)
        const t = table(tname)
        const expIdMatch = query.match(/WHERE\s+experiment_id\s*=\s*\?1/i)
        let rows = [...t.values()]
        if (expIdMatch) {
          const expId = String(args[0])
          rows = rows.filter((r) => r.experiment_id === expId)
        }
        if (/ORDER BY created_at DESC/i.test(query)) {
          rows.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
        } else if (/ORDER BY started_at DESC/i.test(query)) {
          rows.sort((a, b) => String(b.started_at).localeCompare(String(a.started_at)))
        }
        return { results: rows as T[] }
      },
      async run(): Promise<unknown> {
        const tname = detectTable(query)
        if (!tname) return {}
        const t = table(tname)
        if (/^INSERT/i.test(query.trim())) {
          // Args order matches the column list in the SQL — naive but sufficient for the
          // two known shapes the store emits.
          if (tname.endsWith('experiments')) {
            const [id, name, created_at, metadata_json] = args
            t.set(String(id), { id, name, created_at, metadata_json })
          } else if (tname.endsWith('runs')) {
            const [
              id,
              experiment_id,
              name,
              status,
              started_at,
              completed_at,
              config_json,
              report_json,
              error,
            ] = args
            t.set(String(id), {
              id,
              experiment_id,
              name,
              status,
              started_at,
              completed_at,
              config_json,
              report_json,
              error,
            })
          }
        }
        return {}
      },
    }
  }
  return {
    tables,
    prepare(query: string): D1PreparedStatementLike {
      return buildStmt(query)
    },
    async exec(_query: string): Promise<unknown> {
      // DDL is a no-op for the fake — tables are created lazily on first use.
      return {}
    },
  }
}

function fakeReport(overall: number): BenchmarkReport {
  return {
    summary: {
      overallAvg: overall,
      totalScenarios: 1,
      passRate: overall,
      totalCost: 0,
      totalLatencyMs: 0,
      totalTokens: 0,
    },
    results: [
      {
        scenarioId: 's1',
        overallScore: overall,
        passed: true,
        turns: [],
        artifacts: { artifacts: [] },
        judgeScores: [],
        cost: 0,
        latencyMs: 0,
        tokens: { prompt: 0, completion: 0 },
      },
    ],
    metadata: { startedAt: '', completedAt: '', model: 'test', driver: 'test' },
  } as unknown as BenchmarkReport
}

describe('D1ExperimentStore', () => {
  it('round-trips experiments and runs through the binding', async () => {
    const db = makeFakeD1()
    const store = new D1ExperimentStore({ db })
    const tracker = new ExperimentTracker(store)
    const exp = await tracker.startExperiment('e1', { tag: 'a' })
    const run = await tracker.startRun({
      experimentId: exp.id,
      model: 'gpt-5.4',
      metadata: { rep: 1 },
    })
    await tracker.completeRun(run.id, fakeReport(8.2))

    expect((await store.getExperiment(exp.id))?.metadata).toEqual({ tag: 'a' })
    const loaded = await store.getRun(run.id)
    expect(loaded?.status).toBe('completed')
    expect(loaded?.config.metadata).toEqual({ rep: 1 })
    expect(loaded?.report?.summary.overallAvg).toBe(8.2)
  })

  it('listRuns returns rows scoped by experiment_id', async () => {
    const db = makeFakeD1()
    const store = new D1ExperimentStore({ db })
    const tracker = new ExperimentTracker(store)
    const a = await tracker.startExperiment('a')
    const b = await tracker.startExperiment('b')
    await tracker.startRun({ experimentId: a.id })
    await tracker.startRun({ experimentId: a.id })
    await tracker.startRun({ experimentId: b.id })

    expect((await store.listRuns(a.id)).length).toBe(2)
    expect((await store.listRuns(b.id)).length).toBe(1)
  })

  it('uses the configured tablePrefix so two stores share one DB', async () => {
    const db = makeFakeD1()
    const taxStore = new D1ExperimentStore({ db, tablePrefix: 'tax_' })
    const legalStore = new D1ExperimentStore({ db, tablePrefix: 'legal_' })
    const taxT = new ExperimentTracker(taxStore)
    const legalT = new ExperimentTracker(legalStore)

    const taxExp = await taxT.startExperiment('tax-only')
    const legalExp = await legalT.startExperiment('legal-only')

    // Each store sees only its own data.
    expect(await taxStore.getExperiment(legalExp.id)).toBeNull()
    expect(await legalStore.getExperiment(taxExp.id)).toBeNull()
    expect((await taxStore.listExperiments()).length).toBe(1)
    expect((await legalStore.listExperiments()).length).toBe(1)
  })

  it('updates the same row when saveRun is called twice', async () => {
    const db = makeFakeD1()
    const store = new D1ExperimentStore({ db })
    const tracker = new ExperimentTracker(store)
    const exp = await tracker.startExperiment('e1')
    const run = await tracker.startRun({ experimentId: exp.id })
    await tracker.failRun(run.id, 'broken')

    const loaded = await store.getRun(run.id)
    expect(loaded?.status).toBe('failed')
    expect(loaded?.error).toBe('broken')

    // Only one row in the runs table — the second saveRun should have updated, not appended.
    const runsTable = db.tables.get('agent_eval_runs')
    expect(runsTable?.size).toBe(1)
  })
})
