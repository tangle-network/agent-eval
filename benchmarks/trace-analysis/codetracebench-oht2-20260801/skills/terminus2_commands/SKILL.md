---
name: terminus2_commands
description: >
  Parse Terminus2 trajectories at command granularity: one step per entry of
  each episode response's commands array, matching the CodeTraceBench
  annotation convention. Outranks the seed terminus2 skill, whose
  episode-level steps do not align with the annotations.
fingerprints:
  - "agent-logs/episode-*/response.txt"
priority: 60
metadata:
  version: "1.0"
  source: agent-eval codetracebench-oht2-20260801
---

# Terminus2 Command-Level Parser

## Directory Layout

```
trial_dir/
  results.json                  # instruction, verifier outcome
  commands.txt
  agent-logs/
    episode-0/
      prompt.txt                # context; holds "New Terminal Output:" tail
      response.txt              # JSON: analysis/plan + commands[]
      debug.json
    episode-1/ ...
  sessions/  panes/             # recordings and final panes (not steps)
```

## Step Convention

- One step per `commands[]` entry across episodes, in episode order then
  array order. Episodes with unparsable response.txt or no commands
  contribute no steps.
- The action is the command's raw `keystrokes`; keystrokes that are blank
  after trimming (bare Enter, empty send) render as their JSON literal so
  the step survives non-empty action gates losslessly.
- Terminal output exists per episode, not per command: the next episode's
  prompt tail after "New Terminal Output:" attaches to the episode's final
  command; earlier commands carry a null observation.
- All steps of one episode share `parallel_group` = episode number.
- The episode's `analysis`/`plan` text becomes `thinking` on its first step.

This enumeration reproduces the CodeTraceBench annotation `step_count` on
220 of 222 verified Terminus2 rows at dataset revision
`aa213b84ffb6690fc37ca15766d6ca174ec36d4d`; the other 2 archives ship empty
trial directories (no agent-logs anywhere).
