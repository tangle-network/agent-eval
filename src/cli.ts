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

import { buildOpenApi } from './wire/openapi'
import { handleVersion } from './wire/handlers'
import { runRpcBatch, runRpcOnce } from './wire/rpc'
import { startServer } from './wire/server'

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
    const tok = rest[i]
    if (tok.startsWith('--')) {
      const key = tok.slice(2)
      const next = rest[i + 1]
      if (next != null && !next.startsWith('--')) {
        flags[key] = next
        i++
      } else {
        flags[key] = 'true'
      }
    } else {
      positional.push(tok)
    }
  }
  return { command: command ?? 'help', positional, flags }
}

const HELP = `agent-eval — wire-protocol entry point.

Commands:
  serve [--port 5005] [--host 127.0.0.1]
        Start the HTTP server. POST /v1/judge, GET /v1/rubrics, GET /v1/version, GET /openapi.json.
  rpc <method>
        Read one JSON object from stdin (the params for <method>), write one
        JSON object to stdout. Method ∈ {judge, listRubrics, version}.
  rpc-batch <method>
        Like 'rpc' but JSONL in / JSONL out.
  openapi [--out openapi.json]
        Write the OpenAPI 3.1 spec.
  version
        Print server + wire-protocol version JSON.

Without arguments, prints this help.`

async function main(): Promise<number> {
  const { command, positional, flags } = parseArgs(process.argv.slice(2))

  switch (command) {
    case 'serve': {
      const port = Number(flags.port ?? 5005)
      const host = flags.host ?? '127.0.0.1'
      const server = startServer({ port, host })
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
      return await runRpcOnce(method)
    }
    case 'rpc-batch': {
      const [method] = positional
      return await runRpcBatch(method)
    }
    case 'openapi': {
      const out = flags.out ?? 'openapi.json'
      const spec = buildOpenApi(handleVersion().version)
      writeFileSync(out, JSON.stringify(spec, null, 2) + '\n', 'utf-8')
      // eslint-disable-next-line no-console
      console.log(`[agent-eval] wrote OpenAPI 3.1 spec to ${out}`)
      return 0
    }
    case 'version': {
      process.stdout.write(JSON.stringify(handleVersion(), null, 2) + '\n')
      return 0
    }
    case 'help':
    case '--help':
    case '-h':
    case '':
      process.stdout.write(HELP + '\n')
      return 0
    default:
      process.stderr.write(`unknown command: ${command}\n${HELP}\n`)
      return 1
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error('[agent-eval] cli error:', err)
    process.exit(1)
  })
