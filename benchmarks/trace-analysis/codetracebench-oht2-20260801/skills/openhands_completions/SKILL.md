---
name: openhands_completions
description: >
  Parse OpenHands trajectories published as per-call LiteLLM completion logs
  (<model>-<timestamp>.json files with messages/response/kwargs/cost), the
  layout of CodeTraceBench's swe_raw OpenHands trials. Reads the call file
  whose messages hold the most tool-call steps (history condensation can
  truncate later views) and emits one step per non-finish assistant tool call.
fingerprints:
  - "*.json"
priority: 30
metadata:
  version: "1.0"
  source: agent-eval codetracebench-oht2-20260801
---

# OpenHands Completion-Log Parser

## Directory Layout

```
run_dir/
  gpt-5-1769100378.2144506.json          # one file per LLM call
  tensorblock__gpt-5-1768834567.17.json  # model prefix varies by provider
  openhands_output.json                  # harness output (ignored)
  *_result.json / *_metrics.json         # harness reports (ignored)
```

Each call file is a LiteLLM completion log: `messages` (the full request
context), `response` (the completion), `kwargs`, `timestamp`, `cost`.

## Step Convention

- The trajectory view is the call file whose `messages` contain the most
  assistant tool calls excluding `finish` (ties keep the earliest file).
  The final call's view can be shorter because OpenHands condenses history.
- One step per non-finish assistant tool call, in message order.
- Observations pair by `tool_call_id` within the same view; only the final
  step may lack a result (a cut-off run).
- Assistant text content becomes `thinking` on the message's first step.
- `execute_bash` / `execute_ipython_cell` actions are the raw command or
  code; other tools render as `name(arguments)`.

This enumeration reproduces the CodeTraceBench annotation `step_count` on
all 313 verified swe_raw OpenHands rows at dataset revision
`aa213b84ffb6690fc37ca15766d6ca174ec36d4d`.
