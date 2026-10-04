/** Inspect saved native evidence without purchasing another evaluation.
 * Run: pnpm exec tsx examples/systemone-replay.ts request.json response.json
 * Inputs are the original native request and response, not a new storage format.
 */
import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { parseSystemOneRecordedRequest, parseSystemOneResult } from '../src/systemone-protocol'

export async function inspectSystemOneFiles(requestPath: string, responsePath: string) {
  const [requestJson, responseJson] = await Promise.all([
    readFile(requestPath, 'utf8'),
    readFile(responsePath, 'utf8'),
  ])
  const request = parseSystemOneRecordedRequest(JSON.parse(requestJson))
  // Reuse the real distribution/rubric/usage checks. No model, ledger or alias lookup.
  return parseSystemOneResult(JSON.parse(responseJson), request)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [requestPath, responsePath, ...extra] = process.argv.slice(2)
  if (!requestPath || !responsePath || extra.length) {
    console.error('Usage: pnpm exec tsx examples/systemone-replay.ts request.json response.json')
    process.exitCode = 2
  } else {
    inspectSystemOneFiles(requestPath, responsePath).then(
      (result) => console.log(JSON.stringify(result, null, 2)),
      () => {
        // Input/parser diagnostics may quote private evidence; never print them by default.
        console.error('Recorded System One evidence could not be read or did not match its request')
        process.exitCode = 1
      },
    )
  }
}
