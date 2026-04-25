/**
 * stdio RPC transport.
 *
 * For batch / cron use without a running server. The Python client falls
 * back to this when no server is reachable.
 *
 * Protocol (line-delimited JSON over stdin/stdout):
 *   IN:  one JSON object on stdin: {"method":"judge","params":{...}}
 *   OUT: one JSON object on stdout: {"result":{...}} or {"error":{...}}
 *
 * One request per process invocation. To pipeline many calls, the client
 * writes JSONL to stdin and reads JSONL from stdout — see batch mode below.
 */
import { handleJudge, handleListRubrics, handleVersion, WireError } from './handlers'
import { JudgeRequestSchema } from './schemas'

interface RpcRequest {
  method: 'judge' | 'listRubrics' | 'version'
  params?: unknown
}

interface RpcSuccess {
  result: unknown
}

interface RpcError {
  error: { code: string; message: string; details?: unknown }
}

export async function dispatchRpc(req: RpcRequest): Promise<RpcSuccess | RpcError> {
  try {
    switch (req.method) {
      case 'judge': {
        const parsed = JudgeRequestSchema.safeParse(req.params)
        if (!parsed.success) {
          return {
            error: {
              code: 'validation_error',
              message: 'params did not match JudgeRequest schema.',
              details: parsed.error.issues,
            },
          }
        }
        return { result: await handleJudge(parsed.data) }
      }
      case 'listRubrics':
        return { result: handleListRubrics() }
      case 'version':
        return { result: handleVersion() }
      default:
        return {
          error: {
            code: 'unknown_method',
            message: `No such method: ${(req as { method: string }).method}`,
          },
        }
    }
  } catch (err) {
    if (err instanceof WireError) {
      return { error: { code: err.code, message: err.message, details: err.details } }
    }
    const message = err instanceof Error ? err.message : String(err)
    return { error: { code: 'internal_error', message } }
  }
}

// ── stdin/stdout driver ─────────────────────────────────────────────

async function readAll(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string))
  }
  return Buffer.concat(chunks).toString('utf-8')
}

/** Read one JSON request from stdin, write one JSON response to stdout. */
export async function runRpcOnce(method?: string): Promise<number> {
  const raw = await readAll(process.stdin)
  let req: RpcRequest
  try {
    const body = JSON.parse(raw)
    req = method ? { method: method as RpcRequest['method'], params: body } : (body as RpcRequest)
  } catch (err) {
    process.stdout.write(
      JSON.stringify({
        error: {
          code: 'parse_error',
          message: `stdin was not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
        },
      }) + '\n',
    )
    return 1
  }
  const out = await dispatchRpc(req)
  process.stdout.write(JSON.stringify(out) + '\n')
  return 'error' in out ? 1 : 0
}

/** Read JSONL requests from stdin, write JSONL responses to stdout. */
export async function runRpcBatch(method?: string): Promise<number> {
  const raw = await readAll(process.stdin)
  const lines = raw.split('\n').filter((l) => l.trim().length > 0)
  let exitCode = 0
  for (const line of lines) {
    let req: RpcRequest
    try {
      const body = JSON.parse(line)
      req = method ? { method: method as RpcRequest['method'], params: body } : (body as RpcRequest)
    } catch (err) {
      process.stdout.write(
        JSON.stringify({
          error: {
            code: 'parse_error',
            message: `line was not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
          },
        }) + '\n',
      )
      exitCode = 1
      continue
    }
    const out = await dispatchRpc(req)
    process.stdout.write(JSON.stringify(out) + '\n')
    if ('error' in out) exitCode = 1
  }
  return exitCode
}
