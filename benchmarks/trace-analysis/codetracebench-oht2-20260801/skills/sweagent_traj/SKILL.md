---
name: sweagent_traj
description: >
  Parse classic SWE-agent .traj trajectories: one step per entry of the
  trajectory array, in order, matching the CodeTraceBench annotation
  convention. No upstream CodeTracer commit ships a SWE-agent parser.
fingerprints:
  - "*.traj"
priority: 60
metadata:
  version: "1.0"
  source: agent-eval codetracebench-oht2-20260801
---

# SWE-agent .traj Parser

## Directory Layout

```
trial_dir/
  <trial>.traj             # JSON: environment, trajectory[], history[], info, context
  <trial>.context.json     # edited/viewed file context (not steps)
  <trial>.patch            # final submission patch
  report.json              # evaluation outcome
```

The run directory must hold exactly one `*.traj` file; zero or several
refuse detection instead of guessing.

## Step Convention

- One step per `trajectory[]` entry, in array order. Every entry counts,
  including entries whose `action` is blank.
- The action is the entry's raw `action`; actions that are blank after
  trimming render as their JSON literal so the step survives non-empty
  action gates losslessly.
- The entry's `observation` passes through unchanged (empty strings stay
  empty strings); a non-string, non-null observation is a parse error.
- The entry's `thought` becomes `thinking` when it is a non-blank string.
- `action_ref` points at `<trial>.traj#trajectory[i]` and embeds the raw
  entry JSON (action, observation, response, state, thought), so the full
  source record stays recoverable per step; `observation_ref` stays null
  because it would duplicate the same entry.
- The task description is the first user `history[]` message that is not
  the interface demonstration (marker: `--- DEMONSTRATION ---`). Both
  published prompt templates (`<pr_description>` upload and `ISSUE:` text)
  sit in that message on all 108 verified rows.

This enumeration reproduces the CodeTraceBench annotation `step_count` on
106 of 108 verified SWE-agent rows at dataset revision
`aa213b84ffb6690fc37ca15766d6ca174ec36d4d`. The other 2 rows
(`keras-team__keras-19775`, `mui__material-ui-11451`) publish a
function-call-style trajectory (45/48 and 92/94 entries with empty
`response`) whose annotated view condensed the run (26 vs 48, 54 vs 94
entries); no published view reproduces those counts, so they fail the
step-count gate loudly instead of importing misaligned labels.
