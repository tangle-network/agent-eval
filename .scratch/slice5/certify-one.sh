#!/usr/bin/env bash
set -uo pipefail
task=$1
out=$HOME/bench-cache/certify-scale-20260813/slice5
mkdir -p "$out"
benchmarks/trace-repair/tools/certify-task-oracle.sh --out "$out" "$task" >".scratch/slice5/cert-$task.log" 2>&1
echo "$task exit=$?" >> .scratch/slice5/cert.status
