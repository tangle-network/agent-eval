# Recorded Jev evidence and live requests

The existing `/jev/protocol` entrypoint now exports `parseJevRecordedRequest` and its recorded request/question types. It reads historical Tangle observations containing null state or score levels without rewriting them. The same `parseJevResult` validates their answers, distributions, usage and original rubric. It does not certify the source of a saved record.

```ts
import {
  parseJevRecordedRequest,
  parseJevRequest,
  parseJevResult,
} from '@tangle-network/agent-eval/jev/protocol'

const request = parseJevRecordedRequest(observation.request)
const result = parseJevResult(observation.result, request)
// Inspect or re-score result without model execution.

// Re-execution is different: it must meet today's provider contract.
const dispatchable = parseJevRequest(request) // rejects a legacy null state/score level
```

No live validation is relaxed. The shared implementation has one question/result grammar and two explicit admission policies. New inference uses `parseJevRequest`; archive readers use `parseJevRecordedRequest`. Do not replace null with empty text in persisted evidence or hash a rewritten surrogate as the original request. Native JSON order, extension metadata and recorded decimal receipts remain caller-owned and unchanged.

Consumer order: publish the actual package version containing this export, update affected dependency pins/lockfiles, then replace archive-only calls to the live request validator. Do not invent a version or install an unpublished source import. Preserve output-vs-text consistency checks, tenant authorization, served-model policy, receipt ownership and the existing action archive. A historical decoder is not permission to repeat paid work.

`tests/jev-recorded-request.test.ts` writes an observation to disk, reads it twice through the real parsers, rejects contradictory results, and confirms that the live path still rejects historical-only requests. No provider, database, scheduler, migration or new package dependency is added.
