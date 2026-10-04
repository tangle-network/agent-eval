# System One is provider-neutral

The Jev surface is renamed to System One, because the same typed decision protocol is now served by
TypeSafe (Jev), Cloudflare Workers AI (Clef, Clef-flash) and Perplexity (pplx-decider). The wire
format does not change, so recorded requests and answers stay readable. There are no aliases: each
consumer renames in the pull request that bumps its pin.

| Before | After |
| --- | --- |
| `@tangle-network/agent-eval/jev`, `/jev/protocol` | `/systemone`, `/systemone/protocol` |
| `Jev*` types (`JevRequest`, `JevResult`, `JevQuestions`, `JevRecordedRequest`, ...) | `SystemOne*` |
| `parseJev{Request,RecordedRequest,Questions,Result}`, `jevUsage` | `parseSystemOne*`, `systemOneUsage` |
| `JevResponseError` (message prefix `Jev:`) | `SystemOneResponseError` (prefix `System One:`) |
| `jevEvaluator`, `jevJudge`, `jevAnalyst`, `normalizedJevScore` | `systemOneEvaluator`, `systemOneJudge`, `systemOneAnalyst`, `normalizedSystemOneScore` |
| `prepareJevReview`, `assessJevReview`, `jevReviewFindings` | `prepareSystemOneReview`, `assessSystemOneReview`, `systemOneReviewFindings` |
| `claimIntegrityJev{Questions,Review}`, `jevSignal`, signal id `jev`, version prefix `claim-integrity-jev-` | `claimIntegritySystemOne*`, `systemOneSignal`, id `systemone`, prefix `claim-integrity-systemone-` |

Historical records keep their old signal ids and versions; a reader that filters on `jev` must also
accept `systemone`.

New in `/systemone/protocol`:

- `normalizeSystemOneResult(raw, request, profile)` removes a provider's declared rounding before
  the strict parser and gives every provider the same `confidence`. The route owner supplies the
  profile (`{ decimals?, confidence: canonical | provider-defined }`). Answers that already pass
  the strict checks are unchanged.
- `systemOneConfidence(answer)` is that one definition, TypeSafe's published formulas.

New in `/meta-eval`: `brierScore(pairs)`. Equal-mass ECE and the reliability table already come from
`calibrationFromPairs(pairs, ..., { binning: equal-frequency, range: { lo: 0, hi: 1 } })`.

Without normalization the strict parser refuses a recorded TypeSafe score answer whose rounded score
is not the expectation of its rounded probabilities (8.79 against 8.86), so a transport that passes
TypeSafe bytes straight to `parseSystemOneResult` should normalize with `{ decimals: 2, confidence:
canonical }`. See [System One evaluations](../systemone.md#providers-rounding-and-confidence) for
the recorded provider profiles.
