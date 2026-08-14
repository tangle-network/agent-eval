#!/usr/bin/env bash
set -u
cd /home/drew/code/agent-eval/.worktrees/certify-oracles-scale
OUT=$HOME/bench-cache/certify-slice4
LAUNCH_DEADLINE=$1
TASK_TIMEOUT=$2
CONC=$3
run_task() {
  local task="$1" rc
  if [ -f "$OUT/$task.run.log" ] && grep -aq '^VERDICT=' "$OUT/$task.run.log" 2>/dev/null; then return; fi
  if [ ! -f ".scratch/slice4/pull/$task.done" ]; then echo "$(date -u +%H:%M:%S) $task IMAGE_NOT_PULLED"; return; fi
  echo "$(date -u +%H:%M:%S) start $task"
  timeout "$TASK_TIMEOUT" benchmarks/trace-repair/tools/certify-task-oracle.sh \
    --tb2 "$HOME/bench-cache/terminal-bench-2" --out "$OUT/evidence-$task" "$task" > "$OUT/$task.run.log" 2>&1
  rc=$?
  local v
  v=$(grep -a '^VERDICT' "$OUT/$task.run.log" | tail -1)
  echo "$(date -u +%H:%M:%S) end $task rc=$rc ${v:-NO_VERDICT_TIMED_OUT}"
}
n=0
while read -r task; do
  if [ "$(date +%s)" -ge "$LAUNCH_DEADLINE" ]; then echo LAUNCH_DEADLINE_REACHED; break; fi
  run_task "$task" &
  n=$((n + 1))
  if [ $((n % CONC)) -eq 0 ]; then wait; fi
done < .scratch/slice4/order2.txt
wait
echo RUNNER3_EXIT
