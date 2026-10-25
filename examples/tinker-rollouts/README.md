# Tinker rollout sink and scripted Harbor dry run

This recipe consumes the existing canonical rollout ledger. Tinker owns sampling,
`forward_backward` and `optim_step`; the caller owns environment execution and its
verifier. Eval adds neither a model client nor a training loop.

`toTinkerDatumRows` projects one captured model step into Tinker's text Datum. Supply
an offline decoder for the exact captured model and an explicit advantage callback.
The prompt is masked and shifted by one position; only completion positions carry
sampling logprobs and advantages. Construct the official SDK
`ModelInput` and `TensorData` objects from `row.datum`, then build its `Datum`,
as shown in the independently authorized Python consumer. The supplied `tinker-datums.py`
only validates objects with the official installed SDK; it creates no client and
calls no service. Keep row attribution locally with
its original canonical ledger. This example never calls Tinker.

```ts
import { readRolloutLedger, toTinkerDatumRows } from '@tangle-network/agent-eval/rollout'

const lines = await readRolloutLedger(ledgerPath)
const rows = toTinkerDatumRows(lines, {
  model: capturedModel,
  decodeTokens: tokens => capturedTokenizer.decode([...tokens]),
  advantageOf: line => groupAdvantages.get(line.rollout_id)!,
})
```

Tokens and sampling logprobs must be captured from that policy, not reconstructed
from text. Unknown rewards remain unknown; complete honest zero/negative rewards
can carry caller-supplied negative advantages. Realness-gated, incomplete, lossy,
error and nontraining-split rows are excluded. Held-out use requires the same
explicit consent as existing exporters. Copied context without a token mask,
missing/misaligned tokens/logprobs and model mismatch refuse the batch.

The existing scrub/share-safety owners check transcript and decoded tokens.
Unsafe token text is refused rather than redacted while leaving secret token IDs
unchanged. Decode with the actual matching tokenizer offline; this callback is an
execution-owner responsibility, not proof from a model-name string. No credential
is discovered or read by the sink.

`scripted-dry-run.ts` composes `createHarborBenchmarkAdapter` and a caller's existing
`execute(item, 'scripted', signal)` callback. The callback returns the canonical
`RolloutLine` and retains its exact environment/base/head/verifier artifacts. Its
Harbor grade callback must run the task's real deterministic verifier. Loading a
task directory proves neither a runnable image nor a green verifier. The recipe
requires exactly20 tasks and records every returned attempt in `writeRolloutLedger`;
unknown verifier results fail, never become zero. While the verifier runs, the
persisted attempt has reward `null`; only its returned score and verifier identity
are admitted into the canonical reward fields. Scripted actions do not have
model sampling logprobs, so this dry run emits no trainable Datums and does not
fabricate them as zeros.

Current cleanup intake has **zero verified runnable environments**. Thus the real
20-environment dry run is **blocked**, not completed by20 PR metadata rows or
synthetic rewards. The recipe is prepared for the separately owned Harbor task
writer/executor once exact environment identities, resource admission and trusted
verification are available. No sandbox, provider request or training has run.

Official sources reviewed for this adapter:

- [Tinker loss layout and accepted RL tensors](https://tinker-docs.thinkingmachines.ai/tinker/losses/)
- [Datum](https://tinker-docs.thinkingmachines.ai/tinker/api-reference/types/datum/)
- [ModelInput](https://tinker-docs.thinkingmachines.ai/tinker/api-reference/types/modelinput/)
- [TensorData](https://tinker-docs.thinkingmachines.ai/tinker/api-reference/types/tensordata/)
- [Cookbook environment lifecycle](https://tinker-docs.thinkingmachines.ai/tutorials/cookbook-abstractions/env-and-envgroupbuilder/)

These sources define the external format; current client qualification remains
required before any paid operation. No Tinker SDK dependency, paid request,
`forward_backward`, `optim_step`, weight update or model sampling is performed.
