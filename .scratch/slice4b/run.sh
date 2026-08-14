#!/usr/bin/env bash
set -u
cd /home/drew/code/agent-eval/.worktrees/certify-oracles-scale
OUT=$HOME/bench-cache/certify-slice4b
mkdir -p "$OUT"
DEADLINE=$1; shift
CONC=3
run_task() {
  local task="$1" rc v
  [ -f "$OUT/$task.run.log" ] && grep -aq '^VERDICT=' "$OUT/$task.run.log" && return
  # wait up to 5 min for the pinned pull to land
  local waited=0
  while [ ! -f ".scratch/slice4b/pull/$task.done" ]; do
    [ -f ".scratch/slice4b/pull/$task.failed" ] && { echo "$(date -u +%H:%M:%S) $task PULL_FAILED"; return; }
    sleep 10; waited=$((waited+10))
    [ $waited -ge 300 ] && { echo "$(date -u +%H:%M:%S) $task PULL_TIMEOUT"; return; }
  done
  echo "$(date -u +%H:%M:%S) start $task"
  timeout 1500 benchmarks/trace-repair/tools/certify-task-oracle.sh \
    --tb2 "$HOME/bench-cache/terminal-bench-2" --out "$OUT" \
    --determinism 4 --determinism-load 0 "$task" > "$OUT/$task.run.log" 2>&1
  rc=$?
  v=$(grep -a '^VERDICT' "$OUT/$task.run.log" | tail -1)
  echo "$(date -u +%H:%M:%S) end $task rc=$rc ${v:-NO_VERDICT}"
}
n=0
for task in "$@"; do
  [ "$(date +%s)" -ge "$DEADLINE" ] && { echo LAUNCH_DEADLINE; break; }
  run_task "$task" &
  n=$((n+1)); [ $((n % CONC)) -eq 0 ] && wait
done
wait
echo RUNNER_EXIT
