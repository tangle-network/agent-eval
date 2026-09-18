# Produced state and artifact revisions

`extractProducedState(events)` reduces one emission-ordered event stream to the latest observed artifact and proposal state for completion checking. Keep the original stream for history.

Artifacts use the exact `name`, then `uri`, then `artifactId` as their identity. A later event for that identity replaces its content and type. Distinct output paths remain distinct even when an emitter reuses an artifact ID. No path normalization, rename, or deletion is inferred.

Proposals use `proposalId`. A later rejected or pending observation must not leave an older approval eligible for scoring. Missing content on the latest observation is unknown/empty evidence; it is not filled from an older revision.

This behavior correction prevents an overwritten deliverable from satisfying completion through stale text. Consumers that need every historical version should retain the input stream instead of reading the reduced arrays. First-seen identity order is preserved for deterministic output.

The helper does not verify a provider transaction. Tool-call names are invocations, not successful execution receipts. An agent-written file claiming payment or delivery is not independently observed merchant or fulfillment evidence. Validate those effects through the owning integration and use the existing completion and trace-verification APIs for the required checks.

Input ordering is the caller's responsibility. Do not combine unordered collectors and claim the result is a current snapshot. Unobserved external changes and deletions cannot be reconstructed from this event subset.
