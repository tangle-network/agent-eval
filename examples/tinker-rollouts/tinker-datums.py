"""Construct actual official SDK objects locally; no client or paid operation.

In an existing authorized environment containing the official tinker SDK:
    python examples/tinker-rollouts/tinker-datums.py rows.jsonl
"""
import json
import sys

import tinker

count = 0
with open(sys.argv[1], encoding="utf8") as rows:
    for row in rows:
        if not row.strip():
            continue
        wire = json.loads(row)["datum"]
        datum = tinker.Datum(
            model_input=tinker.ModelInput(**wire["model_input"]),
            loss_fn_inputs={key: tinker.TensorData(**value) for key, value in wire["loss_fn_inputs"].items()},
        )
        if set(datum.loss_fn_inputs) != {"target_tokens", "logprobs", "advantages"}:
            raise ValueError("unexpected RL loss inputs")
        if any(tensor.shape != [datum.model_input.length] for tensor in datum.loss_fn_inputs.values()):
            raise ValueError("unaligned model/loss tensors")
        count += 1
print(json.dumps({"validated_datums": count, "training_calls": 0}))
