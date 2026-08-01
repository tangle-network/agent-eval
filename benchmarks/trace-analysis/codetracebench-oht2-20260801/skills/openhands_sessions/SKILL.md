---
name: openhands_sessions
description: >
  Parse OpenHands session-event trajectories at the CodeTraceBench
  annotation granularity: one step per action event with a cause-paired
  observation (run, run_ipython, read, edit, think, recall). Outranks the
  seed openhands skill, which counts only run/run_ipython and undercounts.
fingerprints:
  - "sessions/sessions"
  - "sessions/*.json"
priority: 45
metadata:
  version: "1.0"
  source: agent-eval codetracebench-oht2-20260801
---

# OpenHands Session-Event Parser

## Directory Layout

```
trial_dir/
  results.json
  sessions/
    <session-id>.json            # flat event export (preferred view)
    sessions/
      <session-id>/
        events/0.json, 1.json    # per-event files (second view)
        event_cache/0-25.json    # batched shards (last view)
    agent.cast  agent.log        # recordings (not steps)
```

## Step Convention

- Events come from the first available view: flat export, then events/,
  then event_cache; events sort by id.
- One step per action event whose id some observation event names as its
  `cause` — every action type counts, including read, edit, think, and
  recall. Actions without a paired observation (system, user message,
  finish, cut-off trailing actions) are not steps.
- `run`/`run_ipython` actions render as the raw command or code; `think`
  renders as its thought; other actions render as `action(args)` without
  the thought field. Blank commands render as their JSON literal so the
  step survives non-empty action gates.
- The action's `args.thought` becomes `thinking`; the observation's
  `content` is the observation.
- The first user `message` event is the task description, falling back to
  results.json `instruction`.

This enumeration reproduces the CodeTraceBench annotation `step_count` on
183 of 199 verified terminal-bench OpenHands rows at dataset revision
`aa213b84ffb6690fc37ca15766d6ca174ec36d4d`. The other 16 fail loudly on
the step-count gate: their published views (condensed or partial session
streams) disagree with the annotated count.
