#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 4 ]]; then
  printf 'usage: %s <labels.json> <normalized-dir> <codetracer-bin> <new-output-dir>\n' "$0" >&2
  exit 64
fi

: "${CODETRACER_API_KEY:?CODETRACER_API_KEY is required}"
: "${CODETRACER_API_BASE:?CODETRACER_API_BASE is required}"

labels=$(realpath "$1")
normalized=$(realpath "$2")
codetracer=$(realpath "$3")
root=$(realpath -m "$4")
script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
config="$script_dir/codetracer-no-memory.yaml"
model=${CODETRACER_MODEL:-glm-5.2}
repetitions=${CODETRACER_REPETITIONS:-2}
concurrency=${CODETRACER_CONCURRENCY:-6}
timeout_seconds=${CODETRACER_TIMEOUT_SECONDS:-600}
cost_limit=${CODETRACER_COST_LIMIT_USD:-1.50}

for value in "$repetitions" "$concurrency" "$timeout_seconds"; do
  if [[ ! "$value" =~ ^[1-9][0-9]*$ ]]; then
    printf 'repetitions, concurrency, and timeout must be positive integers\n' >&2
    exit 64
  fi
done
if [[ ! "$cost_limit" =~ ^[0-9]+([.][0-9]+)?$ ]] ||
  ! jq -en --arg value "$cost_limit" '$value | tonumber | . > 0' >/dev/null; then
  printf 'cost limit must be a positive number\n' >&2
  exit 64
fi
if [[ ! -x "$codetracer" ]]; then
  printf 'CodeTracer executable is not executable: %s\n' "$codetracer" >&2
  exit 66
fi
if ! jq -e '
  type == "array"
  and length > 0
  and all(.[]; (.traj_id | type == "string" and test("^[A-Za-z0-9._-]+$")))
  and ([.[].traj_id] | unique | length) == length
' "$labels" >/dev/null; then
  printf 'labels must be a non-empty array with unique path-safe traj_id values\n' >&2
  exit 65
fi
while IFS= read -r id; do
  if [[ ! -d "$normalized/$id" ]]; then
    printf 'missing normalized trajectory: %s\n' "$id" >&2
    exit 66
  fi
done < <(jq -r '.[].traj_id' "$labels")
if [[ -e "$root" ]]; then
  printf 'refusing existing output path: %s\n' "$root" >&2
  exit 73
fi
mkdir -p "$root/cases" "$root/config" "$root/logs" "$root/status" "$root/time"

run_one() {
  local repetition=$1
  local id=$2
  local key="r${repetition}--${id}"
  local case_dir="$root/cases/$key"
  local config_dir="$root/config/$key"
  local status_file="$root/status/$key.json"
  local temporary="$status_file.tmp-$$"
  local exit_code=0
  local state=failed

  mkdir "$case_dir" "$config_dir"
  cp -a "$normalized/$id/." "$case_dir/"
  env XDG_CONFIG_HOME="$config_dir" CODETRACER_API_KEY="$CODETRACER_API_KEY" \
    /usr/bin/time -f 'wall_seconds=%e\npeak_rss_kb=%M' -o "$root/time/$key.txt" \
    timeout "$timeout_seconds" "$codetracer" analyze "$case_dir" \
      --model "$model" \
      --api-base "$CODETRACER_API_BASE" \
      --config "$config" \
      --profile tracebench \
      --skip-discovery \
      --skip-sandbox \
      --cost-limit "$cost_limit" \
      --output "$case_dir/codetracer_labels.json" \
      >"$root/logs/$key.log" 2>&1 || exit_code=$?

  if [[ "$exit_code" -eq 0 ]] &&
    [[ -f "$case_dir/codetracer_labels.json" ]] &&
    [[ -f "$case_dir/codetracer_labels.traj.json" ]] &&
    jq -e 'type == "array"' "$case_dir/codetracer_labels.json" >/dev/null 2>&1; then
    state=ok
  elif [[ "$exit_code" -eq 0 ]]; then
    state=invalid-output
  fi

  jq -n \
    --arg state "$state" \
    --arg id "$id" \
    --argjson repetition "$repetition" \
    --argjson exitCode "$exit_code" \
    '{state:$state, trajectoryId:$id, repetition:$repetition, exitCode:$exitCode}' \
    >"$temporary"
  mv "$temporary" "$status_file"
  printf '%s\t%s\n' "$key" "$state"
}

export -f run_one
export root normalized codetracer config model timeout_seconds cost_limit
export CODETRACER_API_KEY CODETRACER_API_BASE

for ((repetition = 0; repetition < repetitions; repetition += 1)); do
  jq -r --arg repetition "$repetition" '.[] | [$repetition, .traj_id] | @tsv' "$labels"
done | xargs -r -P "$concurrency" -n 2 bash -c 'run_one "$1" "$2"' _

jq -s 'group_by(.state) | map({state:.[0].state, count:length})' "$root"/status/*.json
