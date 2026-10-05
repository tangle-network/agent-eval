# LLM retry delay and request pacing

Fleet item it-fd64863571. Source: tangle-network/ops-board#882.

The OpenAI-compatible transport accepts `minIntervalMs`, defaulting to `0`
(disabled). It spaces **physical request starts**, including transient retries,
schema negotiation and temperature fallback. Share one client for a key across
a campaign; the internal `callLlm` and `callLlmJson` functions instead share state
when passed the same options object. Independent options objects and processes
do not coordinate quotas. Credentials are not stored in a global key registry.

```ts
const chat = createChatClient({
  transport: 'openai-compatible',
  baseUrl,
  apiKey,
  minIntervalMs: Math.ceil(60_000 / requestsPerMinute),
})
```

Concurrent callers recheck the interval after waking, so overdue waiters do not
create a catch-up burst. Responses may overlap. Per-call overrides on an internal
`LlmClient` retain its shared pacing state. Pacing is outside the HTTP-attempt
timeout, but inside the operation deadline, and cancellation interrupts waits.
A cancelled waiter does not reserve a future request slot. The raw request
event is written after the wait, at the claimed start, so a call cancelled or
expired while queued leaves no raw request or error event.

`Retry-After` already took precedence over the capped exponential backoff. The
regression suite now checks a full 30-second delay followed by a paced call
through all five raw/JSON/client/public transport paths, plus HTTP-date headers.
Long delays are split into timer-safe chunks instead of overflowing the timer's
signed 32-bit limit. Invalid numeric delays fall back to exponential backoff.
When an explicit operation deadline is shorter than `Retry-After`, the operation
ends without issuing an early retry.

The default `maximumAttempts` is now **6 total physical requests** (was 3), not
six retries. Explicit `maximumAttempts` and `TANGLE_LLM_MAXIMUM_ATTEMPTS` still
win. `maximumChargeForLlmRequest` uses the same default, so increased retry
headroom also increases the conservative cost reservation. No `maxRetries`
alias or second retry loop is introduced.

## Validation

Run the repository's existing Vitest suite:

```sh
pnpm test -- tests/llm-pacing.test.ts tests/llm-physical-attempts.test.ts src/llm-client.test.ts src/analyst/chat-client-openai-compatible.test.ts
pnpm typecheck
pnpm exec biome check src/llm-client.ts src/analyst/chat-client.ts tests/llm-pacing.test.ts
```

The new tests use a mocked fetch transport and fake timers; no provider calls,
credentials or real 30-second sleeps are required. They also cover concurrent
starts, delayed raw sinks, fallback pacing, cancellation, deadlines, independent
options, disabled/invalid intervals, and the shared retry/cost allowance.
