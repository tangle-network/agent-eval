#!/usr/bin/env bash
# Pull one pinned image by manifest digest and apply the published tag the certifier resolves.
set -uo pipefail
task=$1; pinned=$2; tagged=$3
log=.scratch/slice5/pull-$task.log
if docker image inspect "$tagged" >/dev/null 2>&1; then echo "PRESENT $task" >>.scratch/slice5/pulls.status; exit 0; fi
if ! docker pull "$pinned" >"$log" 2>&1; then echo "PULL_FAILED $task" >>.scratch/slice5/pulls.status; exit 1; fi
id=$(docker image inspect --format '{{.Id}}' "$pinned" 2>/dev/null)
[ -n "$id" ] || { echo "PULL_ABSENT $task" >>.scratch/slice5/pulls.status; exit 1; }
docker tag "$id" "$tagged" || { echo "TAG_FAILED $task" >>.scratch/slice5/pulls.status; exit 1; }
echo "PULLED $task" >>.scratch/slice5/pulls.status
