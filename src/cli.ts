#!/usr/bin/env node
/**
 * agent-eval CLI.
 *
 *   agent-eval serve [--port 5005] [--host 127.0.0.1]
 *   agent-eval rpc <method>          # one request from stdin → one response on stdout
 *   agent-eval rpc-batch <method>    # JSONL stdin → JSONL stdout
 *   agent-eval openapi [--out path]  # write OpenAPI spec
 *   agent-eval version
 *
 * <method> is one of: judge, listRubrics, version. When omitted, the
 * stdin payload must be a full {method, params} envelope.
 */
import { writeFileSync } from 'node:fs'
import { resolveCliLlmConfig } from './cli-config'
import { runRolloutReleaseCli } from './rollout/release/hf-dataset'
import { handleVersion } from './wire/handlers'
import { buildOpenApi } from './wire/openapi'
import { runRpcBatch, runRpcOnce } from './wire/rpc'
import { startServerAsync } from './wire/server'

interface Args {
  command: string
  positional: string[]
  flags: Record<string, string>
}

function parseArgs(argv: string[]): Args {
  const [command, ...rest] = argv
  const positional: string[] = []
  const flags: Record<string, string> = {}
  for (let i = 0; i < rest.length; i++) {
    const tok = rest[i]!
    if (tok.startsWith('--')) {
      const raw = tok.slice(2)
      const equalsAt = raw.indexOf('=')
      if (equalsAt >= 0) {
        flags[raw.slice(0, equalsAt)] = raw.slice(equalsAt + 1)
        continue
      }
      const key = raw
      if (key === 'help') {
        flags[key] = 'true'
        continue
      }
      const next = rest[i + 1]
      if (next != null && !next.startsWith('--')) {
        flags[key] = next
        i++
      } else {
        flags[key] = 'true'
      }
    } else if (tok === '-h') {
      flags.help = 'true'
    } else {
      positional.push(tok)
    }
  }
  return { command: command ?? 'help', positional, flags }
}

const HELP = `agent-eval: evaluation RPC and HTTP server.

Commands:
  serve [--port 5005] [--host 127.0.0.1]
        Start the HTTP server. POST /v1/judge, GET /v1/rubrics, GET /v1/version, GET /openapi.json.
  rpc <method>
        Read one JSON object from stdin (the params for <method>), write one
        JSON object to stdout. Methods: judge, listRubrics, version.
  rpc-batch <method>
        Like 'rpc' but JSONL in / JSONL out.
  openapi [--out openapi.json]
        Write the OpenAPI 3.1 spec.
  rollout-release <ledger.jsonl...> --out <dir> [--formats sft,verifiers,rft,raw] [--include-proposers] [--push <org/name>]
        Build a HuggingFace-ready dataset dir from tangle.rollout.v1 ledgers:
        validate, fail-closed split filter, scrub, export formats + card.
  version
        Print server + wire-protocol version JSON.

Judge provider:
  Set AGENT_EVAL_LLM_BASE_URL, AGENT_EVAL_LLM_API_KEY, and AGENT_EVAL_LLM_MODEL.
  OPENAI_* and TANGLE_* equivalents are also accepted.

Without arguments, prints this help.`

async function main(): Promise<number> {
  const { command, positional, flags } = parseArgs(process.argv.slice(2))
  assertKnownFlags(command, flags)

  if (flags.help === 'true') {
    process.stdout.write(`${HELP}\n`)
    return 0
  }

  switch (command) {
    case 'serve': {
      const port = parsePort(flags.port ?? '5005')
      const host = flags.host ?? '127.0.0.1'
      const llm = resolveCliLlmConfig()
      const { server } = await startServerAsync({
        port,
        host,
        llm: llm.client,
        judgeModel: llm.model,
        llmRouteRequirements: { requireExplicitBaseUrl: true },
      })
      // Keep process alive on SIGINT/SIGTERM
      const shutdown = (sig: string) => {
        // eslint-disable-next-line no-console
        console.log(`[agent-eval] received ${sig}, shutting down`)
        server.close(() => process.exit(0))
        // Force exit after 5s if close hangs
        setTimeout(() => process.exit(1), 5000).unref()
      }
      process.on('SIGINT', () => shutdown('SIGINT'))
      process.on('SIGTERM', () => shutdown('SIGTERM'))
      // Block forever
      await new Promise(() => {})
      return 0
    }
    case 'rpc': {
      const [method] = positional
      const llm = resolveCliLlmConfig()
      return await runRpcOnce(method, {
        llm: llm.client,
        judgeModel: llm.model,
        llmRouteRequirements: { requireExplicitBaseUrl: true },
      })
    }
    case 'rpc-batch': {
      const [method] = positional
      const llm = resolveCliLlmConfig()
      return await runRpcBatch(method, {
        llm: llm.client,
        judgeModel: llm.model,
        llmRouteRequirements: { requireExplicitBaseUrl: true },
      })
    }
    case 'openapi': {
      const out = flags.out ?? 'openapi.json'
      const spec = buildOpenApi(handleVersion().version)
      writeFileSync(out, `${JSON.stringify(spec, null, 2)}\n`, 'utf-8')
      // eslint-disable-next-line no-console
      console.log(`[agent-eval] wrote OpenAPI 3.1 spec to ${out}`)
      return 0
    }
    case 'rollout-release': {
      // The subcommand owns its own flag grammar (multi-value --formats,
      // boolean --include-proposers) — pass raw argv through untouched.
      return await runRolloutReleaseCli(process.argv.slice(3))
    }
    case 'version': {
      process.stdout.write(`${JSON.stringify(handleVersion(), null, 2)}\n`)
      return 0
    }
    case '--version': {
      process.stdout.write(`${handleVersion().version}\n`)
      return 0
    }
    case 'help':
    case '--help':
    case '-h':
    case '':
      process.stdout.write(`${HELP}\n`)
      return 0
    default:
      process.stderr.write(`unknown command: ${command}\n${HELP}\n`)
      return 1
  }
}

const FLAGS_BY_COMMAND: Record<string, ReadonlySet<string>> = {
  serve: new Set(['help', 'host', 'port']),
  rpc: new Set(['help']),
  'rpc-batch': new Set(['help']),
  openapi: new Set(['help', 'out']),
  version: new Set(['help']),
  help: new Set(),
  '--help': new Set(),
  '-h': new Set(),
  '--version': new Set(),
  '': new Set(),
}

function assertKnownFlags(command: string, flags: Record<string, string>): void {
  // rollout-release parses its own argv (multi-value flags).
  if (command === 'rollout-release') return
  const allowed = FLAGS_BY_COMMAND[command]
  if (!allowed) return
  const unknown = Object.keys(flags).filter((flag) => !allowed.has(flag))
  if (unknown.length > 0) {
    throw new Error(`unknown flag for ${command || 'help'}: --${unknown[0]}`)
  }
}

function parsePort(raw: string): number {
  const port = Number(raw)
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error(`--port must be an integer from 0 to 65535; received ${JSON.stringify(raw)}`)
  }
  return port
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error('[agent-eval] cli error:', err)
    process.exit(1)
  })
