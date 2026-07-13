# Critical re-audit: measured AgentProfile learning

Score: 6/10.

## Fix plan

1. [HIGH] `src/campaign/proposers/gepa.ts:321` — Reflect on the same incumbent surface being edited.
   Action: Use the measured incumbent outcome supplied with currentSurface.
   Verification: Assert winner evidence is present and later loser evidence is absent.
2. [HIGH] `src/campaign/presets/run-optimization.ts:475` — Reject mixed finite and NaN judge results.
   Action: Make any failed or non-finite score render the cell incomplete.
   Verification: Assert the author is never called for an invalid baseline.
3. [HIGH] `src/campaign/provenance.ts:129` — Persist measured parent and delta data.
   Action: Store and validate parent hash, observed delta, eligibility, and coverage.
   Verification: Round-trip the full receipt and reject invalid numeric data.
4. [HIGH] `src/campaign/presets/run-optimization.ts:276` — Do not label regressions promoted.
   Action: Promote only a complete candidate that beats the global incumbent.
   Verification: Assert a negative-delta candidate remains unpromoted.
5. [MEDIUM] `src/campaign/proposers/llm-policy-edit.ts:490` — Scrub scenario IDs from notes and failure reasons.
   Action: Apply the ID mapping to all author-bound text derived from measured rows.
   Verification: Inspect the serialized author request for the original ID.
6. [MEDIUM] `src/campaign/proposers/llm-policy-edit.ts:504` — Reject pseudonym collisions.
   Action: Enforce one-to-one scenario aliases within a request.
   Verification: Map two raw IDs to one alias and assert a pre-call error.

REQUEST_CHANGES — the proposed edit is typed, but three boundaries still corrupt or lose its measured learning signal.
