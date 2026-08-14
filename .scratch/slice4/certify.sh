#!/usr/bin/env bash
set -u
cd /home/drew/code/agent-eval/.worktrees/certify-oracles-scale
OUT=~/bench-cache/certify-slice4
mkdir -p "$OUT"
DEADLINE=$1
declare -A done_task
while :; do
  now=$(date +%s)
  [ "$now" -ge "$DEADLINE" ] && { echo "DEADLINE reached"; break; }
  picked=""
  while read -r task; do
    [ -n "${done_task[$task]:-}" ] && continue
    [ -f ".scratch/slice4/pull/$task.done" ] || continue
    picked="$task"; break
  done < .scratch/slice4/tasks.txt
  if [ -z "$picked" ]; then
    remaining=0
    while read -r task; do [ -n "${done_task[$task]:-}" ] || remaining=1; done < .scratch/slice4/tasks.txt
    [ "$remaining" -eq 0 ] && { echo "ALL TASKS ATTEMPTED"; break; }
    [ -f .scratch/slice4/pull/ALLDONE ] && {
      # remaining tasks failed to pull
      while read -r task; do
        [ -n "${done_task[$task]:-}" ] && continue
        echo "$task IMAGE_PULL_FAILED" >> "$OUT/pull-failures.txt"; done_task[$task]=1
      done < .scratch/slice4/tasks.txt
      continue
    }
    sleep 5; continue
  fi
  echo "=== $(date -u +%H:%M:%S) certifying $picked"
  timeout 900 benchmarks/trace-repair/tools/certify-task-oracle.sh \
    --tb2 ~/bench-cache/terminal-bench-2 --out "$OUT" "$picked" > "$OUT/$picked.run.log" 2>&1
  echo "    exit=$? $(grep -h "^VERDICT" "$OUT/$picked.run.log" | tail -1)"
  done_task[$picked]=1
done
echo RUNNER_EXIT
