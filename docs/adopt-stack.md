# Scoped adoption

`scripts/adopt-stack.mjs` exports `plan(root, requested, { consumer })` for a producer adopting packages in one workspace member. `consumer` is a directory relative to the real workspace root, such as `apps/cli`; it must identify an enumerated member and cannot escape the root. Omitting it retains workspace-wide planning.

The selected member's actual importer supplies locked versions and peer context. Unknown selected versions or an unreadable owning lock refuse. Planning still reads the real root manifest, catalog, install constraints and release cohort, and retains publication evidence and holds. Shared policy or cohort edits remain visible in `result.edits`; a producer must review them before applying a plan. Root `$` override references must admit the selected target after planned root/catalog edits; conflicting or unverifiable references refuse for explicit reconciliation.

Pass the result to the existing `writePlan(root, result)` and `install(root, result)`. Only selected member pins become install targets; root policy edits remain root edits. Verify the installed boundary with `resolvedVersions(root, new Map(result.expected), { consumer })` from `scripts/adopt-stack-workspace.mjs`, using the same selector, then run the consumer's maintained acceptance gate. Caller-supplied locks or peer contexts are unsupported.

The CLI accepts `--consumer apps/cli` or `--consumer=apps/cli`; an explicit empty or missing value refuses. The reusable `adopt-stack.yml` workflow exposes the same `consumer` input; its blank default omits the selector. Both paths retain the real root install and apply the same selector to planning and both installed-version checks. Omission keeps workspace-wide behavior.

GitHub operations, including release evidence reads, use the authenticated `gh` CLI. Set `ADOPT_STACK_GH` to an executable path or command name to use an organization's maintained CLI wrapper. It receives argument arrays directly; credentials and identity remain with that command, and a failed read refuses adoption without an anonymous fallback.
