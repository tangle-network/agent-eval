#!/usr/bin/env bash
set -u
cd /home/drew/code/agent-eval/.worktrees/certify-oracles-scale
OUT=~/bench-cache/certify-slice4
DEADLINE=$1
CONC=${2:-4}
run_task() {
  local task="$1"
  if [ -f "$OUT/$task.run.log" ] && grep -q '^VERDICT=' "$OUT/$task.run.log" 2>/dev/null; then return; fi
  if [ ! -f ".scratch/slice4/pull/$task.done" ]; then echo "$(date -u +%H:%M:%S) $task IMAGE_NOT_PULLED"; return; fi
  echo "$(date -u +%H:%M:%S) certifying $task"
  timeout 780 benchmarks/trace-repair/tools/certify-task-oracle.sh \
    --tb2 "$HOME/bench-cache/terminal-bench-2" --out "$OUT/evidence-$task" "$task" > "$OUT/$task.run.log" 2>&1
  echo "$(date -u +%H:%M:%S) exit=$? $task $(grep -h '^VERDICT' "$OUT/$task.run.log" | tail -1)"
}
n=0
while read -r task; do
  if [ "$(date +%s)" -ge "$DEADLINE" ]; then echo DEADLINE; break; fi
  run_task "$task" &
  n=$((n + 1))
  if [ $((n % CONC)) -eq 0 ]; then wait; fi
done < .scratch/slice4/tasks.txt
wait
echo RUNNER2_EXIT
