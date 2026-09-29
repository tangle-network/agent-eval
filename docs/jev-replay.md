# Inspect recorded Jev evidence without new inference

The historical decoder from #897 is already the protocol owner. This example
uses that implementation; it adds no parser, SDK, ledger, database or replay
policy.

From a repository checkout with dependencies installed:

```sh
pnpm exec tsx examples/jev-replay.ts request.json response.json
```

Supply the original native request and response as separate JSON files. The
command validates the saved request, then checks the response's question names,
answer kinds, distributions, rubric legend and usage against it. Successful
output is the preserved response serialized as JSON, including extension
metadata such as generation IDs and decimal receipt strings. Neither input file
is rewritten. This is offline inspection, not replay of a paid provider request.

Historical null state and null score levels remain readable through
`parseJevRecordedRequest`. They are still invalid for new paid calls through
`parseJevRequest`. Do not cast a historical request to the live type, or change
its stored rubric just to satisfy today's admission schema.

A mismatch, unreadable file or malformed record returns exit code 1 with a
redacted diagnostic. Incorrect command-line arguments return exit code 2. The
successful response may contain private trace evidence; select an appropriate
terminal or output destination and retain its existing access controls.

The same helper is importable from the example:

```ts
import { inspectJevFiles } from './examples/jev-replay'

const observation = await inspectJevFiles('request.json', 'response.json')
// Apply an application-owned deterministic mapping to the retained answers.
```

Decoding does not authenticate the source, prove a model produced the result,
validate customer wallet settlement, authorize external actions, or grant
permission to issue another inference request. It also does not establish
served-model alias policy. Those decisions remain with the existing execution,
identity, billing and evidence owners. A different mapping may be evaluated
without paying for inference again; changed execution behavior needs its own
independent outcome check.

Run the normal example typecheck and existing recorded-protocol compatibility
suite before merge. The original implementation bundle recorded successful
execution against an archived fixture in a restored dependency tree; that is
not a replacement for current-head CI or live model-quality evidence.
