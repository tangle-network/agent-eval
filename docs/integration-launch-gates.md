# Integration Launch Gates

Use these gates when a product lets generated apps or agents use user-owned
connections through an integration hub.

The eval should wrap the real product path:

```txt
user prompt
  -> product emits IntegrationManifest
  -> platform resolves connections and grants
  -> sandbox receives capability bundle
  -> generated app invokes integration action
  -> platform enforces policy, approval, idempotency, audit
```

## Deterministic Gates

- The generated app declares an integration manifest before sandbox launch.
- Manifest validation passes.
- Required connections and scopes are present before execution.
- Sandbox environment contains a capability bundle, not raw provider tokens.
- Reads invoke through the platform bridge.
- Writes return `approval_required` unless product policy explicitly allows
  them.
- Approved writes are bound to the same action, input hash, connection, and
  subject.
- Revoked grants or expired capabilities stop invocation.
- Resumed or long-running sandboxes receive a refreshed bundle before expiry.
- Audit includes grant creation, capability issue, invoke success/failure,
  approval resolution, and revoke events.

## Failure Classes

`agent-eval` classifies integration failures separately from prompt/tool
failures:

- `bad_integration_manifest`
- `missing_integration_connection`
- `missing_integration_scope`
- `integration_approval_required`
- `integration_auth_expired`
- `integration_provider_failure`
- `unsafe_integration_write_denied`

Use the helper payload builders and eval builders so products emit the same
trace evidence:

```ts
const gate = {
  connectorId: 'google-calendar',
  actionId: 'events.create',
  valid: true,
  missingConnections: [],
  missingScopes: ['calendar.events.write'],
}

const evals = integrationGateEvals(gate)

await emitter.emit({
  kind: 'custom',
  payload: integrationManifestResolvedPayload(gate),
})

await emitter.emit({
  kind: 'custom',
  payload: integrationInvokeFailedPayload({
    connectorId: 'google-calendar',
    actionId: 'events.create',
    code: 'scope_denied',
    message: 'calendar.events.write was not granted',
  }),
})
```

The classifier then reports the real missing surface instead of burying the
failure under `tool_recovery_failure` or `unknown`.
