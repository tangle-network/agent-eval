#!/usr/bin/env bash
# Second pass over the slice-3 tasks that had not started when the wall-clock bound
# tightened. Phase C runs the script's default 3 idle + 2 contended re-grades per state:
# fewer replicates than the first pass, which the recorded evidence states, because the
# verdict is re-derived from the replicates a reader can count.
set -uo pipefail
cd /home/drew/code/agent-eval/.worktrees/certify-oracles-scale
S=/home/drew/code/agent-eval/.worktrees/certify-oracles-scale/.scratch/slice3

run_one() {
  local task=$1
  cd /home/drew/code/agent-eval/.worktrees/certify-oracles-scale
  local s=/home/drew/code/agent-eval/.worktrees/certify-oracles-scale/.scratch/slice3
  benchmarks/trace-repair/tools/certify-task-oracle.sh --out "$HOME/bench-cache/certify-slice3" \
    --determinism 3 --determinism-load 2 "$task" > "$s/$task.log" 2>&1
  echo "$task done rc=$?" >> "$s/status"
}
export -f run_one

printf '%s\n' git-multibranch make-mips-interpreter prove-plus-comm query-optimize sam-cell-seg torch-pipeline-parallelism |
  xargs -P 3 -n 1 bash -c 'run_one "$@"' _
echo ALLDONE2 >> "$S/status"
