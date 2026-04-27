/**
 * D1ExperimentStore — Cloudflare D1-backed `ExperimentStore`.
 *
 * Workers-safe (uses only the `D1Database` binding the runtime injects). Two
 * tables, no joins, no migrations beyond `ensureSchema()`. Schema designed so
 * a Worker route can both write the row at run start and update it at run end
 * without losing the original config — the row's lifecycle mirrors the
 * `Run.status` field one-to-one.
 *
 * Why this lives next to `InMemoryExperimentStore`:
 *   - bad-app, legal-agent, gtm-agent, film-agent all run as Workers
 *   - Workers cannot use `node:fs`, so `FileSystemExperimentStore` doesn't apply
 *   - Hand-rolling D1 SQL in every consumer is exactly the duplication this
 *     module exists to prevent
 *
 * Schema versioning: the `meta` table records `schema_version` so a future
 * column addition can be detected and migrated additively. Today's schema is
 * v1; bump only on breaking shape changes.
 */

import type { Experiment, ExperimentStore, Run } from './experiment-tracker'

/**
 * Minimal `D1Database` shape we depend on. Avoids pulling in
 * `@cloudflare/workers-types` as a hard dep — consumers that already have
 * those types installed can pass the binding directly.
 */
export interface D1Like {
  prepare(query: string): D1PreparedStatementLike
  batch?(statements: D1PreparedStatementLike[]): Promise<unknown[]>
  exec(query: string): Promise<unknown>
}

export interface D1PreparedStatementLike {
  bind(...values: unknown[]): D1PreparedStatementLike
  first<T = Record<string, unknown>>(): Promise<T | null>
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>
  run(): Promise<unknown>
}

export interface D1ExperimentStoreOptions {
  /** D1 binding from `env`. */
  db: D1Like
  /**
   * Optional table-name prefix so multiple ExperimentStores can share a DB
   * without colliding (e.g. `tax_eval_experiments` vs `legal_eval_experiments`).
   * Default: `agent_eval_`.
   */
  tablePrefix?: string
}

const SCHEMA_VERSION = 1

export class D1ExperimentStore implements ExperimentStore {
  private readonly db: D1Like
  private readonly experimentsTable: string
  private readonly runsTable: string
  private readonly metaTable: string
  private schemaReady = false

  constructor(options: D1ExperimentStoreOptions) {
    this.db = options.db
    const prefix = options.tablePrefix ?? 'agent_eval_'
    this.experimentsTable = `${prefix}experiments`
    this.runsTable = `${prefix}runs`
    this.metaTable = `${prefix}meta`
  }

  /**
   * Idempotent schema setup. Safe to call before every operation; the second
   * call short-circuits via `schemaReady`. Most consumers will call it once
   * during Worker bootstrap.
   */
  async ensureSchema(): Promise<void> {
    if (this.schemaReady) return
    // Single `exec` so D1 batches the DDL.
    const ddl = `
      CREATE TABLE IF NOT EXISTS ${this.experimentsTable} (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        created_at TEXT NOT NULL,
        metadata_json TEXT
      );
      CREATE TABLE IF NOT EXISTS ${this.runsTable} (
        id TEXT PRIMARY KEY,
        experiment_id TEXT NOT NULL,
        name TEXT,
        status TEXT NOT NULL,
        started_at TEXT NOT NULL,
        completed_at TEXT,
        config_json TEXT NOT NULL,
        report_json TEXT,
        error TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_${this.runsTable}_experiment ON ${this.runsTable}(experiment_id);
      CREATE INDEX IF NOT EXISTS idx_${this.runsTable}_started ON ${this.runsTable}(started_at);
      CREATE TABLE IF NOT EXISTS ${this.metaTable} (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      INSERT OR REPLACE INTO ${this.metaTable}(key, value) VALUES ('schema_version', '${SCHEMA_VERSION}');
    `
    await this.db.exec(ddl.trim().replace(/\s+/g, ' '))
    this.schemaReady = true
  }

  async saveExperiment(exp: Experiment): Promise<void> {
    await this.ensureSchema()
    await this.db
      .prepare(
        `INSERT INTO ${this.experimentsTable}(id, name, created_at, metadata_json)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           created_at = excluded.created_at,
           metadata_json = excluded.metadata_json`,
      )
      .bind(exp.id, exp.name, exp.createdAt, exp.metadata ? JSON.stringify(exp.metadata) : null)
      .run()
  }

  async getExperiment(id: string): Promise<Experiment | null> {
    await this.ensureSchema()
    const row = await this.db
      .prepare(
        `SELECT id, name, created_at, metadata_json
         FROM ${this.experimentsTable}
         WHERE id = ?1`,
      )
      .bind(id)
      .first<ExperimentRow>()
    return row ? rowToExperiment(row) : null
  }

  async listExperiments(): Promise<Experiment[]> {
    await this.ensureSchema()
    const { results } = await this.db
      .prepare(
        `SELECT id, name, created_at, metadata_json
         FROM ${this.experimentsTable}
         ORDER BY created_at DESC`,
      )
      .all<ExperimentRow>()
    return results.map(rowToExperiment)
  }

  async saveRun(run: Run): Promise<void> {
    await this.ensureSchema()
    await this.db
      .prepare(
        `INSERT INTO ${this.runsTable}(id, experiment_id, name, status, started_at, completed_at, config_json, report_json, error)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
         ON CONFLICT(id) DO UPDATE SET
           experiment_id = excluded.experiment_id,
           name = excluded.name,
           status = excluded.status,
           started_at = excluded.started_at,
           completed_at = excluded.completed_at,
           config_json = excluded.config_json,
           report_json = excluded.report_json,
           error = excluded.error`,
      )
      .bind(
        run.id,
        run.experimentId,
        run.name ?? null,
        run.status,
        run.startedAt,
        run.completedAt ?? null,
        JSON.stringify(run.config),
        run.report ? JSON.stringify(run.report) : null,
        run.error ?? null,
      )
      .run()
  }

  async getRun(id: string): Promise<Run | null> {
    await this.ensureSchema()
    const row = await this.db
      .prepare(
        `SELECT id, experiment_id, name, status, started_at, completed_at, config_json, report_json, error
         FROM ${this.runsTable}
         WHERE id = ?1`,
      )
      .bind(id)
      .first<RunRow>()
    return row ? rowToRun(row) : null
  }

  async listRuns(experimentId: string): Promise<Run[]> {
    await this.ensureSchema()
    const { results } = await this.db
      .prepare(
        `SELECT id, experiment_id, name, status, started_at, completed_at, config_json, report_json, error
         FROM ${this.runsTable}
         WHERE experiment_id = ?1
         ORDER BY started_at DESC`,
      )
      .bind(experimentId)
      .all<RunRow>()
    return results.map(rowToRun)
  }
}

interface ExperimentRow {
  id: string
  name: string
  created_at: string
  metadata_json: string | null
}

interface RunRow {
  id: string
  experiment_id: string
  name: string | null
  status: string
  started_at: string
  completed_at: string | null
  config_json: string
  report_json: string | null
  error: string | null
}

function rowToExperiment(row: ExperimentRow): Experiment {
  return {
    id: row.id,
    name: row.name,
    createdAt: row.created_at,
    ...(row.metadata_json ? { metadata: JSON.parse(row.metadata_json) as Record<string, unknown> } : {}),
  }
}

function rowToRun(row: RunRow): Run {
  return {
    id: row.id,
    experimentId: row.experiment_id,
    ...(row.name ? { name: row.name } : {}),
    status: row.status as Run['status'],
    startedAt: row.started_at,
    ...(row.completed_at ? { completedAt: row.completed_at } : {}),
    config: JSON.parse(row.config_json),
    ...(row.report_json ? { report: JSON.parse(row.report_json) } : {}),
    ...(row.error ? { error: row.error } : {}),
  }
}
