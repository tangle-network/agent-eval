# Redaction and share safety

`@tangle-network/agent-eval/traces` owns the one redaction core for the Tangle agent stack.
agent-runtime, traces and run-capsule import it instead of keeping their own patterns.
The source is `src/trace/redact.ts`.

## Redact a value

```ts
import { redact, redactText } from '@tangle-network/agent-eval/traces'

const { value, report } = redact(spanAttributes, { profile: 'share' })
const message = redactText(error.message, { knownSecrets: [process.env.ROUTER_KEY ?? ''] })
```

`redact` returns a deep copy and a report.
It never mutates its input and never throws on the value's shape.
Cycles, binary data and nesting past 64 levels become markers.
The report lists the JSON Pointer, category and detector of each change, never the removed value.

| Profile | Removes | String cap |
|---|---|---|
| `default` | Credentials by field name and value shape; email, card, SSN and phone values | 1 MiB |
| `share` | Also phone, IP and postal-address fields; pseudonymizes user, account, tenant, session and request ids | 64 KiB |
| `strict` | Also prompt, completion, message, tool payload and other raw-content fields, and `data:` media | 4 KiB |

A string that holds a credential shape is replaced whole with `[REDACTED:<detector>]`.
Personal data inside prose is replaced in place.
Pass `knownSecrets` to remove exact values in any form: as written, base64, base64url or URL-encoded.
Each occurrence is cut out where it stands, so an error message that contains the key keeps the rest of its text.
A whole-string base64 payload that holds a known secret at any byte offset is replaced whole.

## Field names

`classifyKey` normalizes camelCase, kebab-case and dotted names to snake_case before it matches them.
`apiKey`, `x-api-key`, `client.secret`, `refreshToken` and `OPENAI_API_KEY` are credentials.
Token counts and model limits are not: `inputTokens`, `outputTokens`, `max_tokens`, `token_count`, `gen_ai.usage.input_tokens` and `next_page_token` survive.
`author`, `auth_type`, `secret_name` and `content_type` also survive, because they name or describe a value instead of holding it.

agent-interface's `looksLikeCredential` stays the candidate schemas' refusal check, and the core does not call it.
On 629,707 strings from real sessions and VerticalBench runs, it flagged 280 strings the core passes, and all 280 were `Bearer ${token}`-style code or placeholders.
The core flagged 39 credentials that `looksLikeCredential` passes.
A number under a credential name survives, because it is a limit or a count.

## Share-safety verdict

`assessShareSafety(value, { profile })` reads a value without changing it.
`redactForShare(value, { profile })` redacts it and then assesses the redacted output, so a detector gap appears as UNSAFE instead of a leak.

| Status | Meaning | Share allowed |
|---|---|---|
| `SAFE` | No finding | Yes |
| `SAFE_WITH_WARNINGS` | Only warnings, such as raw content under `default` or identifiers under `share` | Yes |
| `UNSAFE` | A credential, or personal data under `share` or `strict`, remains | No |
| `UNKNOWN` | Part of the value could not be read: a cycle, binary data, or nesting past 64 levels | No |

`shareAllowed(verdict)` is the gate.
`traces verify-safe`, `traces upload` and run-capsule's opted-in upload refuse UNSAFE and UNKNOWN.

## Corpus

`scripts/redaction-corpus.json` holds the must-flag and must-not-flag cases.
`pnpm redaction:corpus` runs the core over every case and exits 1 on any miss.
Add a case whenever a real trace shows a false positive or a leak.
The corpus includes the agent-inspect safety corpus (MIT, commit 3c3cbeda) with its notice.
