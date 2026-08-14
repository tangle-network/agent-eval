#!/usr/bin/env bash
set -u
cd /home/drew/code/agent-eval/.worktrees/certify-oracles-scale
mkdir -p .scratch/slice4/pull
pull_one() {
  local task="$1" pin="$2" ref="$3"
  if docker image inspect "$ref" >/dev/null 2>&1; then echo "already $task" > .scratch/slice4/pull/$task.done; return; fi
  if docker pull "$pin" > .scratch/slice4/pull/$task.log 2>&1; then
    docker tag "$pin" "$ref" && echo ok > .scratch/slice4/pull/$task.done
  else
    echo fail > .scratch/slice4/pull/$task.fail
  fi
}
n=0
while read -r task pin ref; do
  pull_one "$task" "$pin" "$ref" &
  n=$((n+1))
  if [ $((n % 4)) -eq 0 ]; then wait; fi
done < .scratch/slice4/pins.txt
wait
echo ALLDONE > .scratch/slice4/pull/ALLDONE
