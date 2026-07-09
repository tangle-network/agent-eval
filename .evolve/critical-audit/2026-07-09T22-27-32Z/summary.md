# Immutable CodeSurface critical audit

## Findings

No remaining correctness, security, architecture, or public-contract findings in the scoped diff.

The pre-audit hardening pass found one real repository-redirection path through inherited `GIT_DIR`, `GIT_WORK_TREE`, and `GIT_CONFIG_*` variables.
The implementation now removes repository-routing Git variables and disables filesystem-monitor and untracked-cache shortcuts during verification; the real-Git adversarial test proves a wrong locator still fails while those variables point at the expected repository.

## Open assumptions and residual risk

- `verifyCodeSurface` is a point-in-time identity check, not a filesystem lease.
  Sealed evaluation must consume the returned patch bytes in an isolated checkout, verify the resulting tree, and avoid executing the mutable proposal worktree.
- Candidate symlink and path-containment policy belongs to that materializer.
  This package proves Git content identity; it does not declare an arbitrary repository safe to execute.
- Binary-patch bytes are capped at 256 MiB and generated with pinned diff options.
  Larger candidates fail instead of weakening verification.

## Review scores

- Correctness and security: 8/10.
- Architecture and maintainability: 8/10.
- Standards and real-system coverage: 8/10.
- Overall: 8/10.

## Checks

- `pnpm typecheck`
- `pnpm lint` (four pre-existing warnings, zero errors)
- `pnpm test -- --reporter=dot`
- `pnpm build`
- `pnpm verify:package`

APPROVE — content identity is path-independent, byte-verifiable, fail-closed, and covered by real Git repositories; the sealed materializer remains the required consumer-side boundary.
