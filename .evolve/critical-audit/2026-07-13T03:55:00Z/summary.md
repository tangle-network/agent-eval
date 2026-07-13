# Critical audit: typed AgentProfile policy author

Score: 7/10.

## Fix plan

1. [HIGH] `src/campaign/presets/run-optimization.ts:245` — Preserve the exact edit beside every measured candidate.
   Action: Carry a validated candidate record through history and provenance.
   Verification: Prove a second generation sees the first generation's exact edit and result.
2. [HIGH] `src/campaign/proposers/llm-policy-edit.ts:356` — Stop model forecasts from deciding their own admission.
   Action: Make evidence-only admission the default and predictions an explicit opt-in filter.
   Verification: Exercise low-confidence and high-risk cited edits in both modes.
3. [HIGH] `src/campaign/presets/run-optimization.ts:221` — Prevent partial denominators from winning.
   Action: Require full designed-cell coverage for selection without inventing zero penalties.
   Verification: Reproduce the one-of-two-cell 0.90 exploit against a complete 0.50 baseline.
4. [HIGH] `src/campaign/presets/run-optimization.ts:185` — Mutate the global complete incumbent, not a known loser.
   Action: Anchor every generation to the best complete result across the run.
   Verification: Assert a regressing child is never handed back as currentSurface.
5. [MEDIUM] `src/campaign/proposers/llm-policy-edit.ts:387` — Preserve informative failures in bounded history.
   Action: Stratify retained non-promoted candidates across outcome extremes.
   Verification: Assert promoted, high, and low candidates survive a three-row cap.
6. [MEDIUM] `src/campaign/proposers/llm-policy-edit.ts:337` — Put the candidate cap in the provider schema.
   Action: Set dynamic maxItems and retain local validation.
   Verification: Inspect the actual provider request schema.

REQUEST_CHANGES — four correctness defects can produce false learning or destroy credit assignment.
