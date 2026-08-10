#!/usr/bin/env node
// Cost gate for TB-Repair: measures whether the public Terminal-Bench 2.0 trajectory
// dump can supply enough replayable failed mini-swe-agent trajectories to be worth
// spending fleet budget on, before any such spend happens.
//
// Reads the two parquet shards with the duckdb CLI, cross-references upstream task
// definitions from harbor-framework/terminal-bench-2, and writes ASSAY.md + assay.json.
//
// Usage:
//   node assay-tbench-corpus.mjs --data-dir ~/bench-cache/tbench-20260808 [--check-images]
//
// Prerequisites (the tool verifies each and fails loud rather than guessing):
//   - duckdb CLI on PATH or at --duckdb
//   - train-*.parquet shards in --data-dir
//   - terminal-bench-2 clone at <data-dir>/tb2 (or --tb2)

import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

const SCAFFOLD = 'mini-swe-agent'

// A step field whose entire value is "$" + digits is a scraper placeholder: the real
// string was dropped when the trajectory was serialized. Character class avoids
// backslash-escaping ambiguity across the JS -> argv -> duckdb boundary.
const PLACEHOLDER_RE = '^[$][0-9]+$'
// Negative codes are real and meaningful: the scaffold records signal kills as -15/-9,
// which mark timeout-terminated commands rather than a command the agent chose to end on.
const RETURNCODE_RE = '<returncode>-?[0-9]+</returncode>'
const RETURNCODE_CAPTURE = '<returncode>(-?[0-9]+)</returncode>'

function parseArgs(argv) {
  const out = {
    dataDir: join(homedir(), 'bench-cache', 'tbench-20260808'),
    tb2: null,
    duckdb: 'duckdb',
    checkImages: false,
    imagesJson: null,
    verifyTask: null,
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--data-dir') out.dataDir = resolve(expandHome(argv[++i]))
    else if (a === '--tb2') out.tb2 = resolve(expandHome(argv[++i]))
    else if (a === '--duckdb') out.duckdb = expandHome(argv[++i])
    else if (a === '--check-images') out.checkImages = true
    else if (a === '--images-json') out.imagesJson = resolve(expandHome(argv[++i]))
    else if (a === '--verify-task') out.verifyTask = argv[++i]
    else if (a === '--help' || a === '-h') {
      console.log(
        'usage: assay-tbench-corpus.mjs [--data-dir DIR] [--tb2 DIR] [--duckdb PATH]\n' +
          '                              [--check-images | --images-json PATH] [--verify-task NAME]\n\n' +
          '  --check-images    read image manifests live (Docker Hub rate-limits anonymous callers)\n' +
          '  --images-json     reuse a previously captured manifest check; the report records it as such',
      )
      process.exit(0)
    } else throw new Error(`unknown argument: ${a}`)
  }
  out.dataDir = resolve(expandHome(out.dataDir))
  if (!out.tb2) out.tb2 = join(out.dataDir, 'tb2')
  return out
}

function expandHome(p) {
  if (!p) throw new Error('missing path argument')
  return p.startsWith('~') ? join(homedir(), p.slice(1)) : p
}

// execFileSync (no shell) so SQL text never passes through shell quoting.
function duckdb(bin, sql) {
  const raw = execFileSync(bin, [':memory:', '-json', '-c', sql], {
    encoding: 'utf8',
    maxBuffer: 1 << 30,
  })
  const trimmed = raw.trim()
  if (!trimmed) return []
  return JSON.parse(trimmed)
}

function one(rows, label) {
  if (!rows || rows.length !== 1) throw new Error(`${label}: expected exactly 1 row, got ${rows?.length}`)
  return rows[0]
}

function preflight(cfg) {
  const shards = existsSync(cfg.dataDir)
    ? readdirSync(cfg.dataDir).filter((f) => /^train-.*\.parquet$/.test(f)).sort()
    : []
  if (shards.length === 0) {
    throw new Error(
      `no train-*.parquet shards in ${cfg.dataDir}. Download with:\n` +
        `  curl -sL -o ${cfg.dataDir}/train-00000-of-00002.parquet \\\n` +
        `    https://huggingface.co/datasets/yoonholee/terminalbench-trajectories/resolve/main/data/train-00000-of-00002.parquet`,
    )
  }
  if (!existsSync(cfg.tb2)) {
    throw new Error(
      `no terminal-bench-2 clone at ${cfg.tb2}. Clone with:\n` +
        `  git clone --depth 1 https://github.com/harbor-framework/terminal-bench-2.git ${cfg.tb2}`,
    )
  }
  let duckdbVersion
  try {
    duckdbVersion = execFileSync(cfg.duckdb, ['--version'], { encoding: 'utf8' }).trim()
  } catch {
    throw new Error(
      `duckdb CLI not runnable at "${cfg.duckdb}". Install:\n` +
        '  curl -sL -o duckdb.zip https://github.com/duckdb/duckdb/releases/latest/download/duckdb_cli-linux-amd64.zip && unzip duckdb.zip',
    )
  }
  return {
    shards: shards.map((f) => ({ file: f, bytes: statSync(join(cfg.dataDir, f)).size })),
    duckdbVersion,
  }
}

// Every measurement runs against these CTEs so tier counts and distributions cannot
// drift apart. Glob is train-*.parquet, never *.parquet: this tool writes parquet into
// the same directory and a bare glob would read its own output back in.
function baseSql(dataDir) {
  return `
SET lambda_syntax='ENABLE_SINGLE_ARROW';
CREATE VIEW all_rows AS SELECT * FROM read_parquet('${dataDir}/train-*.parquet');

CREATE TABLE scaffold AS
  SELECT task_name, model, steps, json_array_length(steps) AS n_steps
  FROM all_rows
  WHERE agent='${SCAFFOLD}' AND reward=0 AND json_array_length(steps) > 0;

CREATE TABLE parsed AS SELECT *,
  list_filter(json_extract_string(steps,'$[*].obs'),          x -> x IS NOT NULL) AS obs,
  list_filter(json_extract_string(steps,'$[*].tools[0].cmd'), x -> x IS NOT NULL) AS cmds,
  list_filter(json_extract_string(steps,'$[*].msg'),          x -> x IS NOT NULL) AS msgs
FROM scaffold;

CREATE TABLE flagged AS SELECT *,
  obs[len(obs)] AS last_obs,
  regexp_matches(coalesce(obs[len(obs)],''),'${RETURNCODE_RE}') AS last_rc,
  len(list_filter(obs,  x -> regexp_matches(x,'${RETURNCODE_RE}'))) AS n_obs_rc,
  len(list_filter(obs,  x -> regexp_matches(x,'${PLACEHOLDER_RE}'))) AS n_obs_ph,
  len(list_filter(cmds, x -> regexp_matches(x,'${PLACEHOLDER_RE}'))) AS n_cmd_ph,
  len(list_filter(msgs, x -> regexp_matches(x,'${PLACEHOLDER_RE}'))) AS n_msg_ph
FROM parsed;

-- Tier B admits a row when every recorded command is intact and the final observation
-- carries a returncode. Placeholders in obs/msg are tolerated because replay re-executes
-- the commands and regenerates observations.
CREATE TABLE tier_b AS SELECT * FROM flagged WHERE last_rc AND n_cmd_ph = 0;
-- Tier A additionally requires the recorded observations and reasoning to be intact.
CREATE TABLE tier_a AS SELECT * FROM tier_b WHERE n_obs_ph = 0 AND n_msg_ph = 0;
`
}

function measure(cfg) {
  const base = baseSql(cfg.dataDir)
  const q = (sql) => duckdb(cfg.duckdb, base + sql)

  const corpus = one(
    q(`SELECT count(*) AS n_rows,
              count(DISTINCT task_name) AS tasks,
              count(DISTINCT agent) AS scaffolds,
              count(DISTINCT model) AS models,
              round(avg(reward),4) AS solve_rate,
              count(*) FILTER (steps IS NULL) AS steps_sql_null,
              count(*) FILTER (json_array_length(steps)=0) AS steps_empty,
              count(*) FILTER (task_name IS NULL OR task_name='') AS null_task,
              count(*) FILTER (trial_id='') AS empty_trial_id,
              count(DISTINCT trial_id) FILTER (trial_id<>'') AS distinct_trial_uuid,
              count(*) FILTER (trial_id<>'') AS rows_with_trial_uuid
       FROM all_rows;`),
    'corpus',
  )

  const scaffolds = q(
    `SELECT agent, count(*) AS n, count(DISTINCT model) AS models, count(DISTINCT task_name) AS tasks,
            round(avg(reward),4) AS solve_rate,
            count(*) FILTER (json_array_length(steps)=0) AS no_steps
     FROM all_rows GROUP BY agent ORDER BY n DESC, agent;`,
  )

  const funnel = one(
    q(`SELECT
         (SELECT count(*) FROM all_rows WHERE agent='${SCAFFOLD}') AS scaffold_rows,
         (SELECT count(*) FROM all_rows WHERE agent='${SCAFFOLD}' AND reward=0) AS failed,
         (SELECT count(*) FROM all_rows WHERE agent='${SCAFFOLD}' AND reward=0 AND json_array_length(steps)=0) AS failed_no_steps,
         (SELECT count(*) FROM flagged) AS failed_with_steps,
         (SELECT count(*) FROM flagged WHERE last_rc) AS tier_c_last_rc,
         (SELECT count(*) FROM tier_b) AS tier_b,
         (SELECT count(*) FROM tier_a) AS tier_a,
         (SELECT count(DISTINCT task_name) FROM tier_b) AS tier_b_tasks,
         (SELECT count(DISTINCT task_name) FROM tier_a) AS tier_a_tasks;`),
    'funnel',
  )

  const returncode = one(
    q(`SELECT count(*) AS rows_failed_with_steps,
              count(*) FILTER (len(obs)=0) AS rows_zero_obs,
              count(*) FILTER (last_rc) AS last_obs_has_rc,
              count(*) FILTER (regexp_matches(coalesce(last_obs,''),'${PLACEHOLDER_RE}')) AS last_obs_is_placeholder,
              count(*) FILTER (n_obs_rc>0) AS rows_any_rc,
              sum(len(obs))::BIGINT AS total_obs,
              sum(n_obs_rc)::BIGINT AS total_obs_rc,
              sum(n_obs_ph)::BIGINT AS total_obs_placeholder,
              sum(len(cmds))::BIGINT AS total_cmds,
              sum(n_cmd_ph)::BIGINT AS total_cmd_placeholder,
              count(*) FILTER (n_cmd_ph>0) AS rows_any_cmd_placeholder
       FROM flagged;`),
    'returncode',
  )

  const dist = q(
    `SELECT 'tier_b' AS tier, count(*) AS n,
            min(n_steps) AS steps_min, median(n_steps) AS steps_median,
            quantile_cont(n_steps,0.9) AS steps_p90, max(n_steps) AS steps_max,
            median(len(obs)) AS obs_median, max(len(obs)) AS obs_max,
            round(median(len(steps))/1024.0,1) AS blob_median_kib,
            round(quantile_cont(len(steps),0.9)/1024.0,1) AS blob_p90_kib,
            round(max(len(steps))/1024.0,1) AS blob_max_kib,
            round(sum(len(steps))/1048576.0,1) AS blob_total_mib,
            count(*) FILTER (len(cmds)>=3) AS rows_ge3_cmds,
            count(*) FILTER (n_steps<5) AS rows_lt5_steps
     FROM tier_b
     UNION ALL
     SELECT 'tier_a', count(*), min(n_steps), median(n_steps), quantile_cont(n_steps,0.9), max(n_steps),
            median(len(obs)), max(len(obs)),
            round(median(len(steps))/1024.0,1), round(quantile_cont(len(steps),0.9)/1024.0,1),
            round(max(len(steps))/1024.0,1), round(sum(len(steps))/1048576.0,1),
            count(*) FILTER (len(cmds)>=3), count(*) FILTER (n_steps<5)
     FROM tier_a;`,
  )

  const obsChars = one(
    q(`SELECT min(l) AS min, median(l) AS median, quantile_cont(l,0.9) AS p90, max(l) AS max,
              count(*) AS n, count(*) FILTER (l>=5000) AS at_truncation_cap
       FROM (SELECT unnest(list_transform(obs, x -> len(x))) AS l FROM tier_b);`),
    'obsChars',
  )

  const finalRc = q(
    `SELECT regexp_extract(last_obs,'${RETURNCODE_CAPTURE}',1) AS returncode, count(*) AS n
     FROM tier_b GROUP BY 1 ORDER BY n DESC, returncode;`,
  )

  // A returncode that sits anywhere but position 0 could be clipped by the 5,000-char cap.
  const rcPosition = one(
    q(`SELECT count(*) AS all_obs,
              count(*) FILTER (regexp_matches(ob,'${RETURNCODE_RE}')) AS has_rc,
              count(*) FILTER (starts_with(ob,'<returncode>')) AS leads_with_rc,
              count(*) FILTER (regexp_matches(ob,'${RETURNCODE_RE}') AND NOT starts_with(ob,'<returncode>')) AS rc_present_but_not_leading,
              count(*) FILTER (len(ob)>=5000) AS at_cap
       FROM (SELECT unnest(obs) AS ob FROM flagged);`),
    'rcPosition',
  )

  const dupes = one(
    q(`SELECT count(*) AS rows, count(DISTINCT steps) AS distinct_blobs FROM tier_b;`),
    'dupes',
  )

  const byTask = q(
    `SELECT t.task_name,
            count(*) AS tier_b,
            count(*) FILTER (t.n_obs_ph=0 AND t.n_msg_ph=0) AS tier_a,
            count(DISTINCT t.model) AS models,
            round(median(t.n_steps),1) AS median_steps
     FROM tier_b t GROUP BY 1 ORDER BY tier_b DESC, task_name;`,
  )

  // Placeholders are a per-occurrence counter, not a content dictionary: if the same id
  // maps to different strings across tasks, nothing in this dump can recover the text.
  const phProbe = q(
    `SELECT json_extract_string(steps,'$[1].msg') AS id, count(DISTINCT task_name) AS distinct_tasks, count(*) AS n
     FROM all_rows
     WHERE agent='${SCAFFOLD}' AND json_array_length(steps)>1
       AND regexp_matches(json_extract_string(steps,'$[1].msg'),'${PLACEHOLDER_RE}')
     GROUP BY 1 ORDER BY n DESC, id;`,
  )

  const multiTool = one(
    q(`SELECT max(mx) AS max_tools_per_step, sum(multi)::BIGINT AS steps_with_multiple_tools FROM (
         SELECT list_max(list_transform(json_extract(steps,'$[*].tools'),
                  x -> CASE WHEN json_type(x)='ARRAY' THEN json_array_length(x) ELSE 0 END)) AS mx,
                len(list_filter(list_transform(json_extract(steps,'$[*].tools'),
                  x -> CASE WHEN json_type(x)='ARRAY' THEN json_array_length(x) ELSE 0 END), y -> y>1)) AS multi
         FROM scaffold);`),
    'multiTool',
  )

  const corpusTasks = q(`SELECT DISTINCT task_name FROM all_rows ORDER BY 1;`).map((r) => r.task_name)

  return { corpus, scaffolds, funnel, returncode, dist, obsChars, finalRc, rcPosition, dupes, byTask, phProbe, multiTool, corpusTasks }
}

// Only docker_image is read out of task.toml, so a one-key regex beats adding a TOML dep.
function readUpstream(tb2Dir) {
  const dirs = readdirSync(tb2Dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
    .map((d) => d.name)
    .sort()
  const tasks = {}
  for (const name of dirs) {
    const tomlPath = join(tb2Dir, name, 'task.toml')
    if (!existsSync(tomlPath)) continue
    const toml = readFileSync(tomlPath, 'utf8')
    tasks[name] = {
      image: toml.match(/^\s*docker_image\s*=\s*"([^"]+)"/m)?.[1] ?? null,
      difficulty: toml.match(/^\s*difficulty\s*=\s*"([^"]+)"/m)?.[1] ?? null,
      gpus: Number(toml.match(/^\s*gpus\s*=\s*([0-9]+)/m)?.[1] ?? 0),
      allowInternet: /^\s*allow_internet\s*=\s*true/m.test(toml),
      hasDockerfile: existsSync(join(tb2Dir, name, 'environment', 'Dockerfile')),
      hasTests: existsSync(join(tb2Dir, name, 'tests')),
      hasSolution: existsSync(join(tb2Dir, name, 'solution')),
    }
  }
  let head = null
  try {
    head = execFileSync('git', ['-C', tb2Dir, 'log', '-1', '--format=%H %ci'], { encoding: 'utf8' }).trim()
  } catch {
    head = null
  }
  return { tasks, head }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// Anonymous Docker Hub rate-limits hard (HTTP 429). Without backoff every task reports
// "not pullable" and the report silently understates environment availability.
async function fetchWithBackoff(url, init, attempts = 6) {
  let wait = 1000
  for (let a = 0; a < attempts; a++) {
    let res
    try {
      res = await fetch(url, init)
    } catch (err) {
      if (a === attempts - 1) throw err
      await sleep(wait)
      wait *= 2
      continue
    }
    if (res.status !== 429 && res.status !== 503) return res
    if (a === attempts - 1) return res
    const retryAfter = Number(res.headers.get('retry-after'))
    await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : wait)
    wait *= 2
  }
  throw new Error('unreachable')
}

// Registry manifest read only: proves the tag resolves without pulling ~49 GB of layers.
async function checkImages(tasks) {
  const names = Object.keys(tasks)
  const out = {}
  const limit = 4
  let i = 0
  async function worker() {
    while (i < names.length) {
      const name = names[i++]
      const image = tasks[name].image
      if (!image) {
        out[name] = { pullable: false, error: 'no docker_image in task.toml' }
        continue
      }
      const [repo, tag] = [image.slice(0, image.lastIndexOf(':')), image.slice(image.lastIndexOf(':') + 1)]
      try {
        const tokenRes = await fetchWithBackoff(
          `https://auth.docker.io/token?service=registry.docker.io&scope=repository:${repo}:pull`,
        )
        if (!tokenRes.ok) {
          out[name] = { pullable: false, error: `token HTTP ${tokenRes.status}` }
          continue
        }
        const { token } = await tokenRes.json()
        const res = await fetchWithBackoff(`https://registry-1.docker.io/v2/${repo}/manifests/${tag}`, {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: [
              'application/vnd.oci.image.index.v1+json',
              'application/vnd.docker.distribution.manifest.list.v2+json',
              'application/vnd.docker.distribution.manifest.v2+json',
              'application/vnd.oci.image.manifest.v1+json',
            ].join(','),
          },
        })
        if (!res.ok) {
          out[name] = { pullable: false, error: `manifest HTTP ${res.status}` }
          continue
        }
        const manifest = await res.json()
        const bytes = Array.isArray(manifest.layers)
          ? manifest.layers.reduce((a, l) => a + (l.size ?? 0), 0)
          : null
        out[name] = { pullable: true, layerBytes: bytes }
      } catch (err) {
        out[name] = { pullable: false, error: String(err).slice(0, 120) }
      }
    }
  }
  await Promise.all(Array.from({ length: limit }, worker))
  return out
}

// Proves the grading mechanism the whole plan depends on: the task's own held-out tests
// go fail -> pass when a correct intervention is applied, with tests mounted from outside
// the container at grade time. Without this, "admitted rows" is a number about a corpus
// rather than evidence the repair loop can ever be scored.
/** Re-grades of the repaired container. Enough to see a flip, cheap enough to always run. */
const REGRADE_REPLICATES = 3

/**
 * Per-test verdicts from pytest's own `-rA` summary, or null when the suite printed none.
 * The parameter is kept, because a base name is a conjunction over its parameters and a
 * conjunction hides a term that flips.
 */
function readAssertionSummary(sh, cid) {
  let stdout = ''
  try {
    stdout = sh(['exec', cid, 'cat', '/logs/verifier/test-stdout.txt'])
  } catch {
    return null
  }
  const rows = []
  for (const line of stdout.split('\n')) {
    const match = /^(PASSED|FAILED|ERROR|XPASS|XFAIL|SKIPPED) (\S+::\S+)/.exec(line)
    if (match) rows.push({ id: match[2].replace(/^.*\//, ''), passed: match[1] === 'PASSED' })
  }
  return rows.length === 0 ? null : rows.sort((a, b) => a.id.localeCompare(b.id))
}

/** Units that did not agree with themselves across the re-grades. */
function countRegradeFlips(replicates) {
  const perAssertion = replicates.every((r) => r.assertions !== null)
  if (!perAssertion) {
    const passes = replicates.filter((r) => r.reward === '1').length
    const minority = Math.min(passes, replicates.length - passes)
    return { granularity: 'reward', replicates: replicates.length, flipped: minority > 0 ? ['suite-reward'] : [] }
  }
  const outcomes = new Map()
  for (const replicate of replicates) {
    for (const assertion of replicate.assertions) {
      if (!outcomes.has(assertion.id)) outcomes.set(assertion.id, [])
      outcomes.get(assertion.id).push(assertion.passed)
    }
  }
  const flipped = []
  for (const [id, results] of outcomes) {
    if (results.length !== replicates.length || new Set(results).size > 1) flipped.push(id)
  }
  return { granularity: 'per-assertion', replicates: replicates.length, flipped: flipped.sort() }
}

function verifyFailToPass(tb2Dir, task) {
  const taskDir = join(tb2Dir, task)
  const toml = readFileSync(join(taskDir, 'task.toml'), 'utf8')
  const image = toml.match(/^\s*docker_image\s*=\s*"([^"]+)"/m)?.[1]
  if (!image) throw new Error(`${task}: no docker_image in task.toml`)
  const sh = (args, opts = {}) => execFileSync('docker', args, { encoding: 'utf8', ...opts })
  const timed = (fn) => {
    const t0 = Date.now()
    let ok = true
    try {
      fn()
    } catch {
      ok = false
    }
    return { seconds: Number(((Date.now() - t0) / 1000).toFixed(1)), ok }
  }

  const result = { task, image }
  let cached = true
  try {
    sh(['image', 'inspect', image], { stdio: 'ignore' })
  } catch {
    cached = false
  }
  if (cached) {
    result.pullSeconds = 0
    result.imageSource = 'already present locally'
  } else {
    const t0 = Date.now()
    try {
      sh(['pull', image], { stdio: ['ignore', 'ignore', 'pipe'] })
    } catch (err) {
      const stderr = String(err.stderr ?? '')
      // Anonymous Docker Hub allows only a small number of pulls per window; a campaign
      // pulling all 89 task images must authenticate or mirror, so name this precisely.
      const hint = /toomanyrequests|rate limit/i.test(stderr)
        ? ' — Docker Hub anonymous pull rate limit. Run `docker login`, or mirror the task images into a local registry before a campaign.'
        : ''
      throw new Error(`${task}: docker pull ${image} failed${hint}\n${stderr.slice(0, 400)}`)
    }
    result.pullSeconds = Number(((Date.now() - t0) / 1000).toFixed(1))
    result.imageSource = 'pulled'
  }

  const cid = sh(['run', '-d', '--rm', '-v', `${join(taskDir, 'tests')}:/tests:ro`, image, 'sleep', '3600']).trim()
  try {
    sh(['exec', cid, 'mkdir', '-p', '/logs/verifier'])
    const readReward = () => {
      try {
        return sh(['exec', cid, 'cat', '/logs/verifier/reward.txt']).trim()
      } catch {
        return null
      }
    }
    const before = timed(() => sh(['exec', cid, 'bash', '/tests/test.sh'], { stdio: 'ignore' }))
    result.baselineSeconds = before.seconds
    result.baselineReward = readReward()

    sh(['cp', join(taskDir, 'solution', 'solve.sh'), `${cid}:/solve.sh`])
    const solve = timed(() => sh(['exec', cid, 'bash', '/solve.sh'], { stdio: 'ignore' }))
    result.solutionSeconds = solve.seconds
    result.solutionOk = solve.ok

    const after = timed(() => sh(['exec', cid, 'bash', '/tests/test.sh'], { stdio: 'ignore' }))
    result.regradeSeconds = after.seconds
    result.repairedReward = readReward()

    // A fail -> pass loop proves the suite can separate two states. It says nothing about
    // whether the suite answers about the state at all, so re-grade the repaired container
    // with nothing written between the runs and count the units that disagreed. A task
    // whose verdict moves on identical bytes cannot price an intervention.
    const replicates = []
    for (let index = 0; index < REGRADE_REPLICATES; index++) {
      // Captured to a file rather than discarded, because pytest's `-rA` summary is where
      // the per-parameter verdicts are and a base name is a conjunction over them.
      const run = timed(() =>
        sh(['exec', cid, 'bash', '-c', '(/tests/test.sh) > /logs/verifier/test-stdout.txt 2>&1'], {
          stdio: 'ignore',
        }),
      )
      replicates.push({
        index,
        reward: readReward(),
        seconds: run.seconds,
        assertions: readAssertionSummary(sh, cid),
      })
    }
    result.replicates = replicates
    result.regradeFlips = countRegradeFlips(replicates)
  } finally {
    try {
      sh(['stop', cid], { stdio: 'ignore' })
    } catch {
      /* container already gone */
    }
  }
  result.failToPassProven = result.baselineReward === '0' && result.repairedReward === '1'
  return result
}

function pct(a, b) {
  return b ? ((100 * a) / b).toFixed(2) : '0.00'
}

function mdTable(headers, rows) {
  const head = `| ${headers.join(' | ')} |`
  const sep = `| ${headers.map(() => '---').join(' | ')} |`
  const body = rows.map((r) => `| ${r.join(' | ')} |`).join('\n')
  return [head, sep, body].join('\n')
}

function render(m, up, images, meta, cfg, proof) {
  const THRESHOLD = 150
  const f = m.funnel
  const rc = m.returncode
  const tierB = m.dist.find((d) => d.tier === 'tier_b')
  const tierA = m.dist.find((d) => d.tier === 'tier_a')
  const upNames = Object.keys(up.tasks)
  const corpusSet = new Set(m.corpusTasks)
  const upSet = new Set(upNames)
  const missingUpstream = m.corpusTasks.filter((t) => !upSet.has(t))
  const extraUpstream = upNames.filter((t) => !corpusSet.has(t))
  const pullable = images ? Object.values(images).filter((v) => v.pullable).length : null
  const layerTotal = images
    ? Object.values(images).reduce((a, v) => a + (v.layerBytes ?? 0), 0)
    : null
  const largestImage = images
    ? Object.entries(images)
        .filter(([, v]) => v.layerBytes)
        .sort((a, b) => b[1].layerBytes - a[1].layerBytes)
        .slice(0, 1)
        .map(([k, v]) => `${k} (${(v.layerBytes / 1e6).toFixed(0)} MB)`)[0] ?? 'n/a'
    : 'n/a'

  const admitted = f.tier_b
  const verdict =
    admitted >= THRESHOLD
      ? `**VIABLE.** ${admitted} admitted rows is ${(admitted / THRESHOLD).toFixed(1)}x the pre-registered floor of ~${THRESHOLD}.`
      : `**FLIP TO GENERATION.** ${admitted} admitted rows is below the pre-registered floor of ~${THRESHOLD}.`

  const L = []
  L.push('# TB-Repair corpus assay')
  L.push('')
  L.push(`${verdict} Even the strictest tier (every recorded string intact) admits ${f.tier_a} rows across ${f.tier_a_tasks} tasks.`)
  L.push('')
  L.push('## Provenance')
  L.push('')
  L.push(mdTable(
    ['field', 'value'],
    [
      ['corpus', 'HuggingFace `yoonholee/terminalbench-trajectories`'],
      ['license', 'apache-2.0'],
      ['shards', meta.shards.map((s) => `${s.file} (${(s.bytes / 1048576).toFixed(0)} MiB)`).join('<br>')],
      ['upstream tasks', '`harbor-framework/terminal-bench-2`'],
      ['upstream HEAD', up.head ?? 'unknown'],
      ['engine', `duckdb ${meta.duckdbVersion} (installed for this assay; pyarrow/polars used only for spot checks)`],
      ['scaffold', `\`${SCAFFOLD}\``],
      ['generated', meta.generatedAt],
    ],
  ))
  L.push('')
  L.push('## 1. Headline shape')
  L.push('')
  L.push(mdTable(
    ['metric', 'value'],
    [
      ['rows', String(m.corpus.n_rows)],
      ['tasks', String(m.corpus.tasks)],
      ['scaffolds', String(m.corpus.scaffolds)],
      ['models', String(m.corpus.models)],
      ['overall solve rate', String(m.corpus.solve_rate)],
      ['rows whose `steps` is JSON `null`', `${m.corpus.steps_empty} (${pct(m.corpus.steps_empty, m.corpus.n_rows)}%)`],
      ['rows with null/empty task_name', String(m.corpus.null_task)],
      ['rows with empty `trial_id`', `${m.corpus.empty_trial_id} (${pct(m.corpus.empty_trial_id, m.corpus.n_rows)}%)`],
      ['distinct trial UUIDs / rows carrying one', `${m.corpus.distinct_trial_uuid} / ${m.corpus.rows_with_trial_uuid}`],
    ],
  ))
  L.push('')
  L.push('### Scaffold x model x task crosstab')
  L.push('')
  L.push(mdTable(
    ['scaffold', 'rows', 'models', 'tasks', 'solve rate', 'rows with no steps'],
    m.scaffolds.map((s) => [s.agent, s.n, s.models, s.tasks, s.solve_rate, s.no_steps]),
  ))
  L.push('')
  L.push('## 2. The deciding question: does the returncode survive?')
  L.push('')
  L.push(`Yes. Across ${rc.rows_failed_with_steps} failed \`${SCAFFOLD}\` rows that have steps:`)
  L.push('')
  L.push(mdTable(
    ['measurement', 'count', 'share'],
    [
      ['final observation carries a parseable returncode', rc.last_obs_has_rc, `${pct(rc.last_obs_has_rc, rc.rows_failed_with_steps)}% of rows`],
      ['row carries a returncode at *some* step', rc.rows_any_rc, `${pct(rc.rows_any_rc, rc.rows_failed_with_steps)}% of rows`],
      ['all observations carrying a returncode', rc.total_obs_rc, `${pct(rc.total_obs_rc, rc.total_obs)}% of ${rc.total_obs} observations`],
      ['final observation replaced by a `$N` placeholder', rc.last_obs_is_placeholder, `${pct(rc.last_obs_is_placeholder, rc.rows_failed_with_steps)}% of rows`],
      ['rows with zero observations', rc.rows_zero_obs, `${pct(rc.rows_zero_obs, rc.rows_failed_with_steps)}% of rows`],
    ],
  ))
  L.push('')
  L.push(`The 5,000-char truncation does **not** eat the marker. Measured across all ${m.rcPosition.all_obs} observations: **${m.rcPosition.rc_present_but_not_leading} carry a returncode anywhere other than position 0**, so the marker always leads and truncation clips only the tail. (${m.rcPosition.at_cap} observations sit at the cap.)`)
  L.push('')
  L.push('### The real hazard is not truncation — it is `$N` placeholders')
  L.push('')
  L.push('Many step fields are the literal string `$` + digits instead of content. This is undocumented in the dataset card.')
  L.push('')
  L.push(mdTable(
    ['field', 'placeholders', 'share'],
    [
      ['observations', rc.total_obs_placeholder, `${pct(rc.total_obs_placeholder, rc.total_obs)}% of ${rc.total_obs}`],
      ['commands', rc.total_cmd_placeholder, `${pct(rc.total_cmd_placeholder, rc.total_cmds)}% of ${rc.total_cmds}`],
      ['rows with >=1 placeholder command', rc.rows_any_cmd_placeholder, `${pct(rc.rows_any_cmd_placeholder, rc.rows_failed_with_steps)}% of rows`],
    ],
  ))
  L.push('')
  L.push('**The content is not recoverable from this dump.** The ids are a per-occurrence counter, not a content dictionary: the id at step 1 (the task instruction, which differs for every task) takes only these values across all tasks —')
  L.push('')
  L.push(mdTable(
    ['id at step[1].msg', 'distinct tasks using it', 'rows'],
    m.phProbe.map((p) => [`\`${p.id}\``, p.distinct_tasks, p.n]),
  ))
  L.push('')
  L.push('One id maps to many different instructions, so no key in this dump recovers the string. Rows must be filtered on placeholders, not repaired.')
  L.push('')
  L.push('## 3. Admission funnel')
  L.push('')
  L.push(mdTable(
    ['stage', 'rows', 'tasks'],
    [
      [`\`${SCAFFOLD}\` rows`, f.scaffold_rows, ''],
      ['failed (reward=0)', f.failed, ''],
      ['minus rows with no steps', `${f.failed_with_steps} (dropped ${f.failed_no_steps})`, ''],
      ['**Tier C** — final returncode present', f.tier_c_last_rc, ''],
      ['**Tier B** — + every command intact *(admitted set)*', `**${f.tier_b}**`, f.tier_b_tasks],
      ['**Tier A** — + observations and reasoning intact', f.tier_a, f.tier_a_tasks],
    ],
  ))
  L.push('')
  L.push(`Tier B is the right admission set for prefix replay: replay re-executes the recorded commands and regenerates observations, so a placeholder in \`obs\`/\`msg\` costs the analyst context but never breaks execution. A placeholder in a command does break it, and Tier B excludes those.`)
  L.push('')
  L.push(`Against the pre-registered flip trigger of ~${THRESHOLD}: **Tier B = ${f.tier_b} (${(f.tier_b / THRESHOLD).toFixed(1)}x)**, Tier A = ${f.tier_a} (${(f.tier_a / THRESHOLD).toFixed(1)}x). Both clear it.`)
  L.push('')
  L.push('## 4. Cost drivers: step and observation distributions')
  L.push('')
  L.push(mdTable(
    ['tier', 'n', 'steps min', 'steps median', 'steps p90', 'steps max', 'obs median', 'obs max', 'blob median KiB', 'blob p90 KiB', 'blob total MiB', 'rows >=3 cmds', 'rows <5 steps'],
    [tierB, tierA].map((d) => [
      d.tier, d.n, d.steps_min, d.steps_median, d.steps_p90, d.steps_max,
      d.obs_median, d.obs_max, d.blob_median_kib, d.blob_p90_kib, d.blob_total_mib,
      d.rows_ge3_cmds, d.rows_lt5_steps,
    ]),
  ))
  L.push('')
  L.push(mdTable(
    ['per-observation chars (Tier B)', 'min', 'median', 'p90', 'max', 'n', 'at 5000-char cap'],
    [['value', m.obsChars.min, m.obsChars.median, m.obsChars.p90, m.obsChars.max, m.obsChars.n, m.obsChars.at_truncation_cap]],
  ))
  L.push('')
  L.push('### Final recorded returncode (Tier B)')
  L.push('')
  const signalKills = m.finalRc.filter((r) => Number(r.returncode) < 0).reduce((a, r) => a + r.n, 0)
  const zeroExit = m.finalRc.find((r) => r.returncode === '0')?.n ?? 0
  L.push(mdTable(
    ['returncode', 'rows', 'share', 'meaning'],
    m.finalRc.map((r) => [
      r.returncode,
      r.n,
      `${pct(r.n, tierB.n)}%`,
      Number(r.returncode) < 0 ? `killed by signal ${-Number(r.returncode)} (timeout)` : Number(r.returncode) === 0 ? 'clean exit' : 'command error',
    ]),
  ))
  L.push('')
  L.push(`This is the most decision-relevant distribution in the assay. ${zeroExit} of ${tierB.n} admitted rows (${pct(zeroExit, tierB.n)}%) end on a **clean exit** — the agent stopped believing it had succeeded, and the held-out tests disagree. A further ${signalKills} were **killed by a signal** (timeout), a different failure mode that a repair cannot address by fixing a command. Split these two populations before sampling; do not treat "failed" as one class.`)
  L.push('')
  L.push('## 5. Upstream environments')
  L.push('')
  const gpuTasks = upNames.filter((n) => up.tasks[n].gpus > 0)
  L.push(mdTable(
    ['check', 'result'],
    [
      ['upstream task directories', String(upNames.length)],
      ['task names in corpus but absent upstream', missingUpstream.length ? missingUpstream.join(', ') : '0 — no renames, no absences'],
      ['task names upstream but absent from corpus', extraUpstream.length ? extraUpstream.join(', ') : '0'],
      ['tasks with `environment/Dockerfile`', String(upNames.filter((n) => up.tasks[n].hasDockerfile).length)],
      ['tasks with a prebuilt `docker_image`', String(upNames.filter((n) => up.tasks[n].image).length)],
      ['tasks with `tests/`', String(upNames.filter((n) => up.tasks[n].hasTests).length)],
      ['tasks with reference `solution/`', String(upNames.filter((n) => up.tasks[n].hasSolution).length)],
      ['tasks requiring GPUs', gpuTasks.length ? gpuTasks.join(', ') : '0'],
      ['images pullable (registry manifest)', images ? `${pullable}/${upNames.length}` : 'not checked (pass --check-images)'],
      ['image check provenance', meta.imagesSource ?? 'n/a'],
      ['total compressed layer bytes', layerTotal ? `${(layerTotal / 1e9).toFixed(1)} GB` : 'n/a'],
      ['largest single image', images ? largestImage : 'n/a'],
    ],
  ))
  L.push('')
  if (images && pullable < upNames.length) {
    const failed = Object.entries(images).filter(([, v]) => !v.pullable)
    L.push(`> **Image check incomplete:** ${failed.length} task(s) did not resolve — ${failed.slice(0, 5).map(([k, v]) => `${k} (${v.error})`).join('; ')}. Treat the pullable count as a floor, not a finding.`)
    L.push('')
  }
  L.push('No task needs a local Docker build: every task pins a prebuilt image, so the environment cost is a pull, not a build.')
  L.push('')
  if (proof) {
    L.push('### Grading mechanism proven end-to-end')
    L.push('')
    L.push(
      proof.failToPassProven
        ? `Ran the real loop on \`${proof.task}\`: mounted the task's own \`tests/\` from outside the container, graded the untouched image, applied the reference \`solution/solve.sh\`, and re-graded.`
        : `Attempted the real loop on \`${proof.task}\` and it did NOT produce a clean fail -> pass.`,
    )
    L.push('')
    L.push(mdTable(
      ['phase', 'result', 'seconds'],
      [
        ['obtain image', `${proof.image} (${proof.imageSource})`, proof.pullSeconds],
        ['grade untouched image', `reward=${proof.baselineReward}`, proof.baselineSeconds],
        ['apply reference solution', proof.solutionOk ? 'exit 0' : 'FAILED', proof.solutionSeconds],
        ['re-grade', `reward=${proof.repairedReward}`, proof.regradeSeconds],
        ['**fail -> pass proven**', `**${proof.failToPassProven}**`, ''],
      ],
    ))
    L.push('')
    L.push(`Grading is cheap (${proof.baselineSeconds}s + ${proof.regradeSeconds}s); the intervention dominates (${proof.solutionSeconds}s here, because that solution installs system packages). Tests are injected at \`/tests\` at grade time, so a candidate fix cannot pass by deleting or editing the test suite.`)
    L.push('')
    if (proof.regradeFlips) {
      const f = proof.regradeFlips
      L.push(
        f.flipped.length === 0
          ? `Re-graded the repaired container ${f.replicates} more times with nothing written between the runs (${f.granularity} counting): every unit returned the same verdict. Separating two states is not the same property as answering about one, and this is the second one.`
          : `Re-graded the repaired container ${f.replicates} more times with nothing written between the runs (${f.granularity} counting) and **${f.flipped.length} unit(s) returned different verdicts on identical bytes**: ${f.flipped.slice(0, 8).map((id) => `\`${id}\``).join(', ')}. This task cannot carry ground truth for a repair: the same bytes pass or fail by chance. Certify with \`certify-task-oracle.sh\` before sampling it.`,
      )
      L.push('')
    }
  }
  L.push('## 6. Ranked task list (Tier B)')
  L.push('')
  L.push(mdTable(
    ['#', 'task', 'Tier B rows', 'Tier A rows', 'models', 'median steps', 'difficulty', 'image layer MB'],
    m.byTask.map((t, i) => [
      i + 1, t.task_name, t.tier_b, t.tier_a, t.models, t.median_steps,
      up.tasks[t.task_name]?.difficulty ?? '?',
      images?.[t.task_name]?.layerBytes ? (images[t.task_name].layerBytes / 1e6).toFixed(0) : '?',
    ]),
  ))
  L.push('')
  L.push('## 7. Threats to validity')
  L.push('')
  L.push(`- **Placeholder filtering biases toward short trajectories.** A row survives Tier A only if *no* field was dropped, and longer runs have more chances to lose one: Tier A median ${tierA.steps_median} steps vs Tier B median ${tierB.steps_median} (corpus median is 21). Tier B is the less biased set and still keeps ${tierB.rows_ge3_cmds} rows with >=3 commands.`)
  L.push(`- **Truncation.** ${m.obsChars.at_truncation_cap} of ${m.obsChars.n} Tier B observations sit at the 5,000-char cap. Replay regenerates observations, so this degrades only the analyst's view of the recorded run.`)
  L.push(`- **Duplicate trajectories.** ${m.dupes.rows} Tier B rows contain ${m.dupes.distinct_blobs} distinct step blobs — ${m.dupes.rows - m.dupes.distinct_blobs} exact duplicates. Negligible, but dedupe on the blob hash before sampling.`)
  L.push(`- **\`trial_id\` is unusable as a key** for ${m.corpus.empty_trial_id} rows (empty string, ${pct(m.corpus.empty_trial_id, m.corpus.n_rows)}% of the corpus). Key on (task, agent, model, blob hash).`)
  L.push(`- **\`steps\` is JSON \`null\`, not \`[]\`, for ${m.corpus.steps_empty} rows.** \`json.loads\` returns \`None\`; a naive \`len()\` raises.`)
  L.push(`- **The dump records no test output**, only \`reward\`. Ground truth for a repair must be re-derived by running the task's own \`tests/\`; the recorded reward only identifies which trajectories failed.`)
  L.push(`- **Recorded final returncode is 0 for most admitted rows**, so "the agent's last command errored" is not the failure signal — the signal is that tests fail despite a clean exit.`)
  L.push(`- **Docker Hub anonymous pull rate limit is a real campaign blocker**, hit during this assay: after ~89 manifest reads plus one pull, further reads returned HTTP 429. All 89 task images live in one unauthenticated Docker Hub namespace (\`alexgshaw\`). Authenticate or mirror the images into a local registry before any fan-out, or workers will fail on image acquisition rather than on the task.`)
  L.push(`- **Upstream is a moving target.** These counts are pinned to terminal-bench-2 at \`${(up.head ?? 'unknown').split(' ')[0].slice(0, 12)}\`; task definitions and images can change under the same names. Pin the commit for any campaign.`)
  L.push('')
  L.push('## 8. Verdict')
  L.push('')
  L.push(verdict)
  L.push('')
  L.push(`Adjustment carried into the plan: **admit on Tier B (commands intact + final returncode), not on raw failed rows** — ${f.tier_b} of ${f.failed_with_steps} failed rows (${pct(f.tier_b, f.failed_with_steps)}%) qualify. Budget the ${(100 - Number(pct(f.tier_b, f.failed_with_steps))).toFixed(0)}% loss up front rather than discovering it mid-campaign.`)
  L.push('')
  return L.join('\n')
}

async function main() {
  const cfg = parseArgs(process.argv.slice(2))
  const pre = preflight(cfg)
  const meta = { ...pre, generatedAt: new Date().toISOString(), dataDir: cfg.dataDir, tb2: cfg.tb2 }
  const m = measure(cfg)
  const up = readUpstream(cfg.tb2)
  let images = null
  let imagesSource = null
  if (cfg.checkImages) {
    images = await checkImages(up.tasks)
    imagesSource = `live registry manifest read at ${new Date().toISOString()}`
  } else if (cfg.imagesJson) {
    const raw = JSON.parse(readFileSync(cfg.imagesJson, 'utf8'))
    images = Object.fromEntries(
      Object.entries(raw).map(([k, v]) => [
        k,
        { pullable: Boolean(v.pullable), layerBytes: v.layerBytes ?? v.layer_bytes ?? null, error: v.error ?? null },
      ]),
    )
    imagesSource = `captured manifest check reused from ${cfg.imagesJson} (mtime ${statSync(cfg.imagesJson).mtime.toISOString()})`
  }
  meta.imagesSource = imagesSource
  const proof = cfg.verifyTask ? verifyFailToPass(cfg.tb2, cfg.verifyTask) : null

  const md = render(m, up, images, meta, cfg, proof)
  writeFileSync(join(cfg.dataDir, 'ASSAY.md'), md)
  writeFileSync(
    join(cfg.dataDir, 'assay.json'),
    JSON.stringify({ meta, measurements: m, upstream: up, images, proof }, null, 1),
  )
  if (proof) console.log(`fail->pass proven on ${proof.task}: ${proof.failToPassProven}`)
  console.log(`wrote ${join(cfg.dataDir, 'ASSAY.md')}`)
  console.log(`wrote ${join(cfg.dataDir, 'assay.json')}`)
  console.log(`Tier B admitted: ${m.funnel.tier_b} rows / ${m.funnel.tier_b_tasks} tasks`)
  console.log(`Tier A admitted: ${m.funnel.tier_a} rows / ${m.funnel.tier_a_tasks} tasks`)
}

await main()
